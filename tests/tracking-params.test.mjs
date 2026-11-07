import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTrackingParamRule,
  stripTrackingParams,
  TRACKING_PARAM_RULE_ID,
  TRACKING_QUERY_PARAMS
} from "../lib/tracking-params.mjs";

test("lists the known click and campaign parameters, frozen", () => {
  assert.ok(TRACKING_QUERY_PARAMS.includes("utm_source"));
  assert.ok(TRACKING_QUERY_PARAMS.includes("fbclid"));
  assert.ok(TRACKING_QUERY_PARAMS.includes("s_kwcid"));
  assert.ok(Object.isFrozen(TRACKING_QUERY_PARAMS));
  assert.equal(new Set(TRACKING_QUERY_PARAMS).size, TRACKING_QUERY_PARAMS.length);
});

test("strips tracking parameters and keeps every other parameter", () => {
  const cleaned = stripTrackingParams("https://shop.example.com/item?utm_source=news&keep=1&fbclid=abc&page=2");
  assert.equal(cleaned, "https://shop.example.com/item?keep=1&page=2");
});

test("keeps the fragment and the path untouched", () => {
  assert.equal(
    stripTrackingParams("https://example.com/a/b/?gclid=123&x=1#section-2"),
    "https://example.com/a/b/?x=1#section-2"
  );
});

test("removes the query delimiter when nothing meaningful is left", () => {
  assert.equal(stripTrackingParams("https://example.com/?utm_campaign=spring&msclkid=z"), "https://example.com/");
  assert.equal(stripTrackingParams("https://example.com/page?utm_id=9#top"), "https://example.com/page#top");
});

test("removes repeated tracking parameters entirely", () => {
  assert.equal(
    stripTrackingParams("https://example.com/?utm_source=a&utm_source=b&keep=1"),
    "https://example.com/?keep=1"
  );
});

test("leaves a URL with no tracking parameters byte-for-byte unchanged", () => {
  const url = "https://example.com/search?q=privacy&lang=en#results";
  assert.equal(stripTrackingParams(url), url);
});

test("returns invalid and non-http input unchanged", () => {
  for (const value of ["not a url", "/relative/path?utm_source=x", "chrome-extension://abc/page.html?utm_source=x", "ftp://example.com/?utm_source=x", "", null, undefined, 7]) {
    assert.equal(stripTrackingParams(value), value);
  }
});

test("builds the redirect rule with the agreed defaults", () => {
  const rule = buildTrackingParamRule();
  assert.equal(rule.id, 950);
  assert.equal(rule.id, TRACKING_PARAM_RULE_ID);
  assert.equal(rule.priority, 1, "allowlist rules at priority 10 must outrank it");
  assert.deepEqual(rule.action, {
    type: "redirect",
    redirect: { transform: { queryTransform: { removeParams: [...TRACKING_QUERY_PARAMS] } } }
  });
  assert.equal(rule.condition.urlFilter, "*");
  assert.deepEqual(rule.condition.resourceTypes, ["main_frame", "sub_frame"]);
  assert.equal(rule.condition.excludedRequestDomains, undefined);
  assert.equal(rule.condition.excludedInitiatorDomains, undefined);
});

test("excludes allowlisted domains from both request and initiator matching", () => {
  const rule = buildTrackingParamRule({ excludedDomains: ["example.com", "example.com", ""] });
  // A top-level navigation has no initiator, so excluding only the initiator would
  // keep redirecting an allowlisted site.
  assert.deepEqual(rule.condition.excludedRequestDomains, ["example.com"]);
  assert.deepEqual(rule.condition.excludedInitiatorDomains, ["example.com"]);
});

test("accepts a custom rule id and tolerates a bad exclusion list", () => {
  assert.equal(buildTrackingParamRule({ id: 77 }).id, 77);
  const rule = buildTrackingParamRule({ excludedDomains: "example.com" });
  assert.equal(rule.condition.excludedRequestDomains, undefined);
});

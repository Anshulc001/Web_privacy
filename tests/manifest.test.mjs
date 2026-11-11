import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));

test("uses a Chrome Manifest V3 popup and module service worker", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.action.default_popup, "popup/popup.html");
  assert.deepEqual(manifest.background, {
    service_worker: "background/service-worker.js",
    type: "module"
  });
});

test("uses only the approved permissions", () => {
  assert.deepEqual(manifest.permissions, [
    "storage", "alarms", "webNavigation", "scripting", "activeTab", "cookies",
    "declarativeNetRequest", "webRequest", "contentSettings"
  ]);
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
});

test("keeps a strict extension-page CSP", () => {
  assert.equal(manifest.content_security_policy.extension_pages,
    "script-src 'self'; object-src 'self'; base-uri 'self';");
});

test("registers the isolated content scripts for supported web pages", () => {
  assert.deepEqual(manifest.content_scripts, [
    { matches: ["<all_urls>"], js: ["content/cosmetic-filter.js"], run_at: "document_start" },
    // The bridge must be listening before the page-world observer can report.
    { matches: ["<all_urls>"], js: ["content/permission-bridge.js"], run_at: "document_start" },
    { matches: ["<all_urls>"], js: ["content/permission-observer.js"], run_at: "document_start", world: "MAIN" },
    { matches: ["<all_urls>"], js: ["content/content-script.js"], run_at: "document_idle" }
  ]);
});

test("exposes only the cosmetic filter rules to the page's content script", () => {
  // The content script imports these modules, so Chrome only hands them over if
  // they are declared; nothing else may become reachable from a page.
  assert.deepEqual(manifest.web_accessible_resources, [{
    resources: [
      "lib/cosmetic-rules.mjs",
      "lib/host-match.mjs",
      "data/cosmetic-generic.css",
      "data/cosmetic-rules.json"
    ],
    matches: ["<all_urls>"]
  }]);
});

test("requires the Chrome version that can hold the downloaded rule list", () => {
  // Up to 30,000 safe dynamic rules exist only from Chrome 121; earlier versions
  // cap the combined dynamic budget at 5,000, so the downloaded host list would
  // be rejected and the daily update would silently never apply.
  assert.ok(Number(manifest.minimum_chrome_version) >= 121,
    `minimum_chrome_version must be 121 or newer, got ${manifest.minimum_chrome_version}`);
});

test("declares a valid bundled static DNR ruleset", async () => {
  assert.deepEqual(manifest.declarative_net_request.rule_resources, [{
    id: "ad_tracker_rules", enabled: true, path: "data/ad-tracker-rules.json"
  }]);
  const rules = JSON.parse(await readFile(new URL("../data/ad-tracker-rules.json", import.meta.url), "utf8"));
  // Chrome guarantees 30,000 static rules per extension; a ruleset over that can
  // be rejected outright, which would leave the extension with no blocking at all.
  assert.ok(rules.length > 0 && rules.length <= 30_000, `unexpected rule count ${rules.length}`);
  assert.deepEqual(rules[0].action, { type: "block" });
  const filters = rules.map((rule) => rule.condition.urlFilter);
  assert.ok(filters.some((filter) => /^\|\|[^/]+\^$/.test(filter)), "host-anchored rules must be present");
  assert.ok(filters.some((filter) => /^\|\|[^/]+\//.test(filter)), "path-anchored rules must be present");
  assert.deepEqual(filters, [...new Set(filters)], "a repeated filter wastes a rule slot");
});

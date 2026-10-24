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
    "declarativeNetRequest", "webRequest"
  ]);
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
});

test("keeps a strict extension-page CSP", () => {
  assert.equal(manifest.content_security_policy.extension_pages,
    "script-src 'self'; object-src 'self'; base-uri 'self';");
});

test("registers the isolated content script for supported web pages", () => {
  assert.deepEqual(manifest.content_scripts, [{
    matches: ["<all_urls>"], js: ["content/content-script.js"], run_at: "document_idle"
  }]);
});

test("declares a valid bundled static DNR ruleset", async () => {
  assert.deepEqual(manifest.declarative_net_request.rule_resources, [{
    id: "ad_tracker_rules", enabled: true, path: "data/ad-tracker-rules.json"
  }]);
  const rules = JSON.parse(await readFile(new URL("../data/ad-tracker-rules.json", import.meta.url), "utf8"));
  assert.equal(rules.length, 25_000);
  assert.deepEqual(rules[0].action, { type: "block" });
});

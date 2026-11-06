import assert from "node:assert/strict";
import test from "node:test";
import { createBlockingManager } from "../background/blocking-manager.mjs";

function fakeDnr() {
  const calls = [];
  return { calls, async updateEnabledRulesets(value) { calls.push(["static", value]); }, async getDynamicRules() { return [{ id: 1_000_001 }, { id: 2_000_001 }, { id: 5 }]; }, async updateDynamicRules(value) { calls.push(["dynamic", value]); } };
}

test("toggles the bundled static ruleset and persists its setting", async () => {
  const dnr = fakeDnr(); let saved;
  const manager = createBlockingManager(dnr, { async save(value) { saved = value; return value; } });
  await manager.setEnabled(false);
  assert.deepEqual(dnr.calls[0], ["static", { disableRulesetIds: ["ad_tracker_rules"] }]);
  assert.deepEqual(saved, { blockingEnabled: false });
});

test("turning blocking off also clears the downloaded dynamic rules", async () => {
  const dnr = fakeDnr();
  const manager = createBlockingManager(dnr, { async save() {} }, async () => ["tracker.test"]);
  await manager.setEnabled(false);

  // updateEnabledRulesets leaves dynamic rules alone, so without this the toggle
  // switched the bundled list off while downloaded rules kept blocking.
  const dynamic = dnr.calls.find((call) => call[0] === "dynamic");
  assert.ok(dynamic, "the dynamic rules must be updated");
  assert.deepEqual(dynamic[1].removeRuleIds, [1_000_001]);
  assert.deepEqual(dynamic[1].addRules, []);
});

test("turning blocking back on restores the downloaded dynamic rules", async () => {
  const dnr = fakeDnr();
  const manager = createBlockingManager(dnr, { async save() {} }, async () => ["tracker.test"]);
  await manager.setEnabled(true);
  const dynamic = dnr.calls.find((call) => call[0] === "dynamic");
  assert.equal(dynamic[1].addRules.length, 1);
  assert.equal(dynamic[1].addRules[0].condition.urlFilter, "||tracker.test^");
});

test("replaces only WebGuard remote rules and creates safe host blocks", async () => {
  const dnr = fakeDnr();
  const manager = createBlockingManager(dnr, { async save() {} });
  await manager.applyRemoteHosts(["tracker.test", "bad host!"], true);
  const update = dnr.calls[0][1];
  assert.deepEqual(update.removeRuleIds, [1_000_001]);
  assert.equal(update.addRules[0].condition.urlFilter, "||tracker.test^");
});

test("allowlist rules match the document itself and include resourceTypes", async () => {
  const dnr = fakeDnr();
  const manager = createBlockingManager(dnr, { async save() {} });
  await manager.setAllowlist(["allowed.test"]);
  const update = dnr.calls[0][1];

  // Chrome rejects allowAllRequests without resourceTypes, which silently breaks
  // the allowlist, so this is a hard requirement rather than a style choice.
  assert.deepEqual(update.removeRuleIds, [2_000_001]);
  const documentRule = update.addRules.find((rule) => rule.action.type === "allowAllRequests");
  assert.ok(documentRule, "the document rule must still be created");
  // allowAllRequests only covers requests the rule matches, and a top-level
  // navigation has no initiator domain, so the rule must match the URL itself.
  assert.equal(documentRule.condition.urlFilter, "||allowed.test^");
  assert.equal(documentRule.condition.initiatorDomains, undefined);
  assert.ok(documentRule.priority > 1, "the allow rule must outrank blocking rules");
  // Chrome permits only main_frame and sub_frame here; anything else makes the
  // whole update fail and silently disables the allowlist.
  assert.deepEqual(documentRule.condition.resourceTypes, ["main_frame", "sub_frame"]);
});

test("allowlist also allows the page's subresources by initiator", async () => {
  const dnr = fakeDnr();
  const manager = createBlockingManager(dnr, { async save() {} });
  await manager.setAllowlist(["edition.cnn.com"]);
  const update = dnr.calls[0][1];

  // Without this rule the document loads but its XHRs and images stay blocked.
  const resourceRule = update.addRules.find((rule) => rule.action.type === "allow");
  assert.ok(resourceRule, "a subresource allow rule must be created");
  assert.ok(resourceRule.priority > 1);
  // The registrable domain extends the allow to sibling subdomains.
  assert.deepEqual(resourceRule.condition.initiatorDomains, ["edition.cnn.com", "cnn.com"]);
  assert.ok(resourceRule.condition.resourceTypes.includes("xmlhttprequest"));
  assert.ok(resourceRule.condition.resourceTypes.includes("image"));
  assert.ok(!resourceRule.condition.resourceTypes.includes("main_frame"));
});

test("allowlist normalizes duplicates and drops invalid hosts", async () => {
  const dnr = fakeDnr();
  let saved;
  const manager = createBlockingManager(dnr, { async save(value) { saved = value; return value; } });
  await manager.setAllowlist(["b.test", "a.test", "b.test", "bad host!"]);
  assert.deepEqual(saved.siteAllowlist, ["a.test", "b.test"]);
  // Each host gets a document rule plus a subresource rule.
  assert.equal(dnr.calls[0][1].addRules.length, 4);
  assert.equal(new Set(dnr.calls[0][1].addRules.map((rule) => rule.id)).size, 4, "rule ids must be unique");
});

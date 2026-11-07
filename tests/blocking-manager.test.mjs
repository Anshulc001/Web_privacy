import assert from "node:assert/strict";
import test from "node:test";
import { createBlockingManager } from "../background/blocking-manager.mjs";
import { TRACKING_PARAM_RULE_ID } from "../lib/tracking-params.mjs";

function fakeDnr() {
  const calls = [];
  return { calls, async updateEnabledRulesets(value) { calls.push(["static", value]); }, async getDynamicRules() { return [{ id: 1_000_001 }, { id: 2_000_001 }, { id: 5 }]; }, async updateDynamicRules(value) { calls.push(["dynamic", value]); } };
}

function fakeSettings(overrides = {}) {
  const state = { ...overrides };
  return {
    state,
    async load() { return { blockingEnabled: true, siteAllowlist: [], ...state }; },
    async save(value) { Object.assign(state, value); return { blockingEnabled: true, siteAllowlist: [], ...state }; }
  };
}

/** The tracking-parameter rule is added by its own updateDynamicRules call. */
function trackingRuleCall(dnr) {
  return dnr.calls.filter((call) => call[0] === "dynamic").map((call) => call[1])
    .find((update) => update.addRules.some((rule) => rule.id === TRACKING_PARAM_RULE_ID));
}

test("toggles the bundled static ruleset and persists its setting", async () => {
  const dnr = fakeDnr();
  let saved;
  const manager = createBlockingManager(dnr, { async load() { return { siteAllowlist: [] }; }, async save(value) { saved = value; return value; } });
  await manager.setEnabled(false);
  assert.deepEqual(dnr.calls[0], ["static", { disableRulesetIds: ["ad_tracker_rules"] }]);
  assert.deepEqual(saved, { blockingEnabled: false });
});

test("turning blocking off also clears the downloaded dynamic rules", async () => {
  const dnr = fakeDnr();
  const manager = createBlockingManager(dnr, fakeSettings(), async () => ["tracker.test"]);
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
  const manager = createBlockingManager(dnr, fakeSettings(), async () => ["tracker.test"]);
  await manager.setEnabled(true);
  const dynamic = dnr.calls.find((call) => call[0] === "dynamic");
  assert.equal(dynamic[1].addRules.length, 1);
  assert.equal(dynamic[1].addRules[0].condition.urlFilter, "||tracker.test^");
});

test("blocking on installs the tracking-parameter redirect, and off removes it", async () => {
  const dnr = fakeDnr();
  const manager = createBlockingManager(dnr, fakeSettings());

  await manager.setEnabled(true);
  const added = trackingRuleCall(dnr);
  assert.ok(added, "the redirect rule must be added while blocking is on");
  const rule = added.addRules.find((entry) => entry.id === TRACKING_PARAM_RULE_ID);
  assert.equal(rule.priority, 1, "priority-10 allowlist rules must outrank it");
  assert.equal(rule.action.type, "redirect");
  assert.ok(rule.action.redirect.transform.queryTransform.removeParams.includes("utm_source"));
  // The id is always removed first, because Chrome rejects re-adding one that exists.
  assert.deepEqual(added.removeRuleIds, [TRACKING_PARAM_RULE_ID]);

  const callsBefore = dnr.calls.length;
  // Once installed, Chrome reports the rule back; switching off must remove it.
  dnr.getDynamicRules = async () => [{ id: TRACKING_PARAM_RULE_ID }];
  await manager.setEnabled(false);
  const after = dnr.calls.slice(callsBefore).filter((call) => call[0] === "dynamic").map((call) => call[1]);
  const removal = after.find((update) => update.removeRuleIds.includes(TRACKING_PARAM_RULE_ID));
  assert.ok(removal, "turning blocking off must remove the redirect rule");
  assert.equal(removal.addRules.length, 0);
});

test("replaces only WebGuard remote rules and creates safe host blocks", async () => {
  const dnr = fakeDnr();
  const manager = createBlockingManager(dnr, fakeSettings());
  await manager.applyRemoteHosts(["tracker.test", "bad host!"], true);
  const update = dnr.calls[0][1];
  assert.deepEqual(update.removeRuleIds, [1_000_001]);
  assert.equal(update.addRules[0].condition.urlFilter, "||tracker.test^");
  // Applying the downloaded list must not disturb the tracking-parameter rule,
  // which lives outside the remote-rule id range.
  assert.ok(!update.removeRuleIds.includes(TRACKING_PARAM_RULE_ID));
});

test("allowlist rules match the document itself and include resourceTypes", async () => {
  const dnr = fakeDnr();
  const manager = createBlockingManager(dnr, fakeSettings());
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
  const manager = createBlockingManager(dnr, fakeSettings());
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

test("allowlist excludes its sites from the tracking-parameter redirect", async () => {
  const dnr = fakeDnr();
  const manager = createBlockingManager(dnr, fakeSettings());
  await manager.setAllowlist(["edition.cnn.com"]);
  const update = dnr.calls[0][1];

  const rule = update.addRules.find((entry) => entry.id === TRACKING_PARAM_RULE_ID);
  assert.ok(rule, "the redirect must be rewritten with the new exclusions");
  // Both halves matter: excludedRequestDomains covers the address-bar navigation,
  // excludedInitiatorDomains covers the page's own frames.
  assert.deepEqual(rule.condition.excludedRequestDomains, ["cnn.com", "edition.cnn.com"]);
  assert.deepEqual(rule.condition.excludedInitiatorDomains, ["cnn.com", "edition.cnn.com"]);
});

test("an existing tracking rule is removed in the same allowlist update", async () => {
  const dnr = fakeDnr();
  dnr.getDynamicRules = async () => [{ id: TRACKING_PARAM_RULE_ID }, { id: 2_000_002 }];
  const manager = createBlockingManager(dnr, fakeSettings());
  await manager.setAllowlist(["allowed.test"]);
  // Otherwise the stale redirect lives on next to the new one and Chrome rejects
  // the duplicate rule id.
  assert.deepEqual(dnr.calls[0][1].removeRuleIds.sort(), [TRACKING_PARAM_RULE_ID, 2_000_002].sort());
});

test("allowlist normalizes duplicates and drops invalid hosts", async () => {
  const dnr = fakeDnr();
  const settings = fakeSettings();
  const manager = createBlockingManager(dnr, settings);
  await manager.setAllowlist(["b.test", "a.test", "b.test", "bad host!"]);
  assert.deepEqual(settings.state.siteAllowlist, ["a.test", "b.test"]);
  // Each host gets a document rule plus a subresource rule, and blocking is on, so
  // the tracking-parameter redirect rides along in the same update.
  assert.equal(dnr.calls[0][1].addRules.length, 5);
  assert.equal(new Set(dnr.calls[0][1].addRules.map((rule) => rule.id)).size, 5, "rule ids must be unique");
});

test("no tracking-parameter rule is added while blocking is off", async () => {
  const dnr = fakeDnr();
  const manager = createBlockingManager(dnr, fakeSettings({ blockingEnabled: false }));
  await manager.setAllowlist(["allowed.test"]);
  assert.ok(!dnr.calls[0][1].addRules.some((rule) => rule.id === TRACKING_PARAM_RULE_ID));
});

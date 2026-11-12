import assert from "node:assert/strict";
import test from "node:test";
import {
  DATA_URL_BASE,
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  createSettingsStore,
  normalizeSettings,
  resolveSiteMode
} from "../lib/storage-settings.mjs";

test("normalizes missing and invalid settings to privacy-safe defaults", () => {
  assert.deepEqual(normalizeSettings(), { ...DEFAULT_SETTINGS });
  assert.deepEqual(normalizeSettings({ historyRetentionHours: 1, autoDomainLookup: "yes", siteAllowlist: ["ok", 4] }), {
    ...DEFAULT_SETTINGS
  });
  assert.strictEqual(DEFAULT_SETTINGS.autoDomainLookup, true, "registry data should load without a second click");
});

test("keeps valid settings and removes duplicate allowlist entries", () => {
  assert.deepEqual(normalizeSettings({
    historyRetentionHours: 168,
    historyPaused: true,
    blockingEnabled: false,
    autoDomainLookup: false,
    siteAllowlist: ["allowed.test", "allowed.test"]
  }), {
    historyRetentionHours: 168,
    historyPaused: true,
    blockingEnabled: false,
    autoDomainLookup: false,
    siteAllowlist: ["allowed.test"],
    strictSites: []
  });
});

test("loads defaults when storage has no settings", async () => {
  const store = createSettingsStore({
    get: async () => ({}),
    set: async () => {}
  });
  assert.deepEqual(await store.load(), { ...DEFAULT_SETTINGS });
});

test("wraps storage read and write failures", async () => {
  const readFailure = createSettingsStore({
    get: async () => { throw new Error("read denied"); },
    set: async () => {}
  });
  await assert.rejects(readFailure.load(), /Could not read WebGuard settings/);

  const writeFailure = createSettingsStore({
    get: async () => ({ [SETTINGS_KEY]: {} }),
    set: async () => { throw new Error("write denied"); }
  });
  await assert.rejects(writeFailure.save({ historyPaused: true }), /Could not save WebGuard settings/);
});

test("does not lose a setting when two updates overlap", async () => {
  const state = {};
  const store = createSettingsStore({
    async get() { return { [SETTINGS_KEY]: state[SETTINGS_KEY] }; },
    async set(patch) { Object.assign(state, structuredClone(patch)); }
  });

  // Both read the same snapshot before either writes, which is what the dashboard
  // does when a user changes two controls in quick succession.
  await Promise.all([
    store.save({ historyPaused: true }),
    store.save({ historyRetentionHours: 72 })
  ]);

  assert.equal(state[SETTINGS_KEY].historyPaused, true);
  assert.equal(state[SETTINGS_KEY].historyRetentionHours, 72);
});

test("uses one HTTPS data URL base", () => {
  assert.equal(DATA_URL_BASE, "https://raw.githubusercontent.com/Anshulc001/Web_privacy/main/data/");
});

test("the default allowlist cannot be mutated through a fallback", () => {
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS.siteAllowlist), true);
  const fallback = normalizeSettings("not a settings object");
  assert.equal(Object.isFrozen(fallback.siteAllowlist), true, "invalid input returns the frozen default");
  assert.throws(() => fallback.siteAllowlist.push("evil.test"), TypeError);
  assert.deepEqual(DEFAULT_SETTINGS.siteAllowlist, [], "the defaults must stay empty");
});

test("strict sites are normalised, de-duplicated and default to none", () => {
  const settings = normalizeSettings({ strictSites: [" Ads.Test ", "ads.test", "B.test"] });
  assert.deepEqual(settings.strictSites, ["ads.test", "b.test"]);
  // Same rule as the allowlist: one non-string entry invalidates the list rather
  // than being dropped silently, so a corrupt write cannot half-apply.
  assert.deepEqual(normalizeSettings({ strictSites: ["ok.com", 42] }).strictSites, []);
  assert.deepEqual(normalizeSettings({}).strictSites, []);
  assert.deepEqual(normalizeSettings({ strictSites: "not-a-list" }).strictSites, []);
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS.strictSites), true, "the default list cannot be mutated");
});

test("resolveSiteMode reports off, strict or basic, and off always wins", () => {
  // Real TLDs on purpose: a reserved name like `x.test` has no registrable domain
  // in host-match, so subdomain coverage is exact-match there and would hide the
  // behaviour this test is about.
  const settings = { siteAllowlist: ["plain.com"], strictSites: ["strict.com", "plain.com"] };
  assert.equal(resolveSiteMode("www.plain.com", settings), "off", "the allowlist covers subdomains too");
  assert.equal(resolveSiteMode("strict.com", settings), "strict");
  assert.equal(resolveSiteMode("news.strict.com", settings), "strict", "a subdomain inherits the mode");
  assert.equal(resolveSiteMode("other.com", settings), "basic");
  assert.equal(resolveSiteMode("", settings), "basic");
  assert.equal(resolveSiteMode("x.test", null), "basic");
});

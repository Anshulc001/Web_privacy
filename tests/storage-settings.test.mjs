import assert from "node:assert/strict";
import test from "node:test";
import {
  DATA_URL_BASE,
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  createSettingsStore,
  normalizeSettings
} from "../lib/storage-settings.mjs";

test("normalizes missing and invalid settings to privacy-safe defaults", () => {
  assert.deepEqual(normalizeSettings(), { ...DEFAULT_SETTINGS });
  assert.deepEqual(normalizeSettings({ historyRetentionHours: 1, expectedSites: ["ok", 4] }), {
    ...DEFAULT_SETTINGS
  });
});

test("keeps valid settings and removes duplicate expected sites", () => {
  assert.deepEqual(normalizeSettings({
    historyRetentionHours: 168,
    historyPaused: true,
    blockingEnabled: false,
    expectedSites: ["example.com", "example.com"],
    siteAllowlist: ["allowed.test"]
  }), {
    historyRetentionHours: 168,
    historyPaused: true,
    blockingEnabled: false,
    expectedSites: ["example.com"],
    siteAllowlist: ["allowed.test"]
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

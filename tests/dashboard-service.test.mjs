import assert from "node:assert/strict";
import test from "node:test";
import { createDashboardService } from "../background/dashboard-service.mjs";
import { BLOCKING_COUNTS_KEY } from "../background/blocking-counter.mjs";
import { BLOCKING_DATA_KEY, LAST_SYNC_KEY } from "../background/data-sync.mjs";
import { BREACH_DATA_KEY } from "../lib/breach-checker.mjs";
import { THREAT_DATA_KEY } from "../lib/threat-checker.mjs";
import { DOMAIN_CACHE_KEY } from "../lib/domain-info.mjs";
import { DEFAULT_SETTINGS, createSettingsStore } from "../lib/storage-settings.mjs";

function createStorage(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(key) { return { [key]: values[key] }; },
    async set(update) { Object.assign(values, structuredClone(update)); }
  };
}

function createHistory(records = []) {
  return {
    records,
    read: async () => records,
    prune: async () => records,
    clear: async () => { records.length = 0; }
  };
}

function createObservations(entries = {}) {
  return { async get(host) { return entries[host] ?? null; } };
}

function createService(overrides = {}) {
  const storageArea = overrides.storageArea ?? createStorage();
  const historyStore = overrides.historyStore ?? createHistory();
  const observationStore = overrides.observationStore ?? createObservations();
  const settingsStore = overrides.settingsStore ?? createSettingsStore(storageArea);
  return createDashboardService({
    storageArea,
    settingsStore,
    historyStore,
    observationStore,
    cookiesApi: overrides.cookiesApi ?? { async getAll() { return []; }, async remove() { return {}; } },
    tabsApi: overrides.tabsApi ?? { async query() { return []; }, async get() { return null; }, async sendMessage() { return null; } },
    contentSettings: overrides.contentSettings ?? null,
    blockingManager: overrides.blockingManager ?? null,
    blockingCounter: overrides.blockingCounter ?? null
  });
}

test("overview reports empty, unavailable and unknown data honestly", async () => {
  const service = createService();
  const overview = await service.overview();

  assert.deepEqual(overview.settings, DEFAULT_SETTINGS);
  assert.deepEqual(overview.history.days, []);
  assert.equal(overview.history.retentionHours, 168);
  assert.equal(overview.history.paused, false);
  assert.equal(overview.blocking.today, 0);
  assert.equal(overview.blocking.series.length, 7);
  assert.deepEqual(overview.blocking.sites, []);
  assert.deepEqual(overview.blocking.topHosts, []);
  assert.deepEqual(overview.blocking.allowlist, []);

  const byKey = Object.fromEntries(overview.data.map((entry) => [entry.key, entry]));
  assert.equal(byKey.blocking.status, "unknown", "bundled rules are usable but have no sync date yet");
  assert.equal(byKey.breach.status, "unavailable");
  assert.equal(byKey.threat.status, "unavailable");
});

test("overview tolerates corrupt stored counts and only surfaces chartable days", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const storageArea = createStorage({
    [BLOCKING_COUNTS_KEY]: {
      days: "not-a-map",
      dayHosts: { [today]: { "ads.test": 2 } },
      sites: {
        "news.test": { days: { [today]: 2, "2020-01-01": 99 }, dayHosts: { [today]: { "ads.test": 2 } } },
        "empty.test": { days: {}, dayHosts: {} }
      },
      hosts: { "ads.test": 2 }
    }
  });
  const service = createService({ storageArea });
  const overview = await service.overview();

  assert.equal(overview.blocking.today, 0, "a corrupt day map must read as zero, not throw");
  assert.deepEqual(overview.blocking.sites.map((entry) => entry.host), ["news.test"], "a site with no in-window day is dropped");
  assert.deepEqual(overview.blocking.sites[0].days, { [today]: 2 }, "out-of-window days are not sent to the UI");
  assert.deepEqual(overview.blocking.topHosts, [{ host: "ads.test", count: 2 }]);
});

test("overview uses the newest sync time and marks stale files outdated", async () => {
  const storageArea = createStorage({
    [LAST_SYNC_KEY]: {
      blocking: { at: "2026-11-10T00:00:00Z", ok: true },
      breach: { at: "2026-09-01T00:00:00Z", ok: false }
    },
    [BREACH_DATA_KEY]: { buildDate: "2026-11-10T00:00:00Z" }
  });
  const service = createService({ storageArea });
  const byKey = Object.fromEntries((await service.overview()).data.map((entry) => [entry.key, entry]));

  assert.equal(byKey.blocking.status, "fresh");
  assert.equal(byKey.breach.status, "outdated", "the last successful sync controls the age");
  assert.equal(byKey.threat.status, "unavailable");
});

test("targets filters non-web tabs, bounds titles and survives a tab query failure", async () => {
  const service = createService({
    tabsApi: {
      async query() {
        return [
          { id: 1, url: "https://Example.com/a", title: "x".repeat(300) },
          { id: 2, url: "chrome://extensions", title: "internal" },
          { id: 3, url: "not a url", title: "bad" },
          { id: 4, url: "http://127.0.0.1:9/", title: 42 }
        ];
      }
    }
  });
  const { tabs } = await service.targets();
  assert.deepEqual(tabs.map((tab) => tab.tabId), [1, 4]);
  assert.equal(tabs[0].title.length, 120);
  assert.equal(tabs[1].title, "");

  const failing = createService({ tabsApi: { async query() { throw new Error("tabs unavailable"); }, async get() { return null; } } });
  assert.deepEqual(await failing.targets(), { tabs: [] });
});

test("siteReport rejects missing input and a tab that is gone", async () => {
  const service = createService();
  assert.deepEqual(await service.siteReport({}), { status: "unavailable", reason: "A hostname is required." });
  assert.deepEqual(await service.siteReport({ hostname: "bad host!" }), {
    status: "unavailable",
    reason: "A hostname is required."
  });
  assert.deepEqual(await service.siteReport({ tabId: 7 }), {
    status: "unavailable",
    reason: "That tab is no longer available."
  });
});

test("siteReport keeps the other sections when cookies fail and shares the allowlist rule", async () => {
  const service = createService({
    observationStore: createObservations({
      "www.example.com": { thirdPartyHosts: ["tracker.test"], requestedPermissions: ["camera"] }
    }),
    cookiesApi: {
      async getAll() { throw new Error("cookies denied"); },
      async remove() { return {}; }
    },
    blockingCounter: {
      async siteSummary() { return { days: { "2026-11-12": 3 }, dayHosts: {}, hosts: [{ host: "ads.test", count: 3 }], total: 3 }; }
    },
    storageArea: createStorage({
      settings: {
        historyRetentionHours: 168,
        historyPaused: false,
        blockingEnabled: true,
        autoDomainLookup: true,
        siteAllowlist: ["example.com"]
      }
    })
  });

  const report = await service.siteReport({ hostname: "www.example.com" });
  assert.equal(report.status, "ok");
  assert.equal(report.cookies.status, "unavailable");
  assert.deepEqual(report.cookies.cookies, []);
  assert.equal(report.allowlisted, true, "a parent-domain entry covers the site exactly as DNR does");
  assert.equal(report.blocking.total, 3);
  assert.equal(report.suspicious.isHttps, true, "a hostname-only report uses an https stand-in URL");
  assert.equal(report.suspicious.score, 0);
  assert.equal(report.permissions.camera, "unavailable", "no live page could be probed");
});

test("sitePermissions reports an explicit empty set instead of a default list", async () => {
  const service = createService();
  assert.equal((await service.sitePermissions({})).status, "unavailable");
  const ok = await service.sitePermissions({ hostname: "example.com" });
  assert.equal(ok.status, "ok");
  assert.deepEqual(ok.requestedPermissions, []);
  assert.deepEqual(ok.permissions, {});
});

test("clearSiteCookies counts removals and reports API failures", async () => {
  const ok = createService({
    cookiesApi: {
      async getAll({ domain }) {
        return domain === "example.com" ? [{ name: "a", domain: ".example.com", path: "/" }] : [];
      },
      async remove() { return { name: "a" }; }
    }
  });
  assert.deepEqual(await ok.clearSiteCookies("example.com"), { ok: true, removed: 1 });
  assert.deepEqual(await ok.clearSiteCookies("bad host!"), {
    ok: false,
    removed: 0,
    reason: "A hostname is required."
  });

  const failing = createService({ cookiesApi: { async getAll() { throw new Error("denied"); }, async remove() { return {}; } } });
  const result = await failing.clearSiteCookies("example.com");
  assert.equal(result.ok, false);
  assert.equal(result.removed, 0);
  assert.match(result.reason, /denied/);
});

test("updateSettings ignores unknown keys and applies engine-side effects", async () => {
  const storageArea = createStorage();
  const historyCalls = [];
  const counterCalls = [];
  const managerCalls = [];
  const service = createService({
    storageArea,
    historyStore: { ...createHistory(), async prune(hours) { historyCalls.push(hours); } },
    blockingManager: {
      async setEnabled(enabled) { managerCalls.push(["enabled", enabled]); },
      async setAllowlist(hosts) { managerCalls.push(["allowlist", hosts]); }
    },
    blockingCounter: {
      async prune(hours) { counterCalls.push(hours); },
      async clear() { counterCalls.push("clear"); },
      async siteSummary() { return { days: {}, dayHosts: {}, hosts: [], total: 0 }; }
    }
  });

  await assert.rejects(service.updateSettings(null), /must be an object/);
  await assert.rejects(service.updateSettings([]), /must be an object/);

  const settings = await service.updateSettings({
    historyRetentionHours: 72,
    blockingEnabled: false,
    unexpected: "ignored"
  });
  assert.equal(settings.historyRetentionHours, 72);
  assert.equal(settings.blockingEnabled, false);
  assert.equal("unexpected" in settings, false);
  assert.deepEqual(historyCalls, [72]);
  assert.deepEqual(counterCalls, [72]);
  assert.deepEqual(managerCalls, [["enabled", false]]);
});

test("clearHistory and clearAllData reset every stored surface", async () => {
  const storageArea = createStorage({
    [DOMAIN_CACHE_KEY]: { "example.com": { at: 1, value: {} } },
    siteObservations: { "example.com": { thirdPartyHosts: [] } },
    settings: { siteAllowlist: ["example.com"], historyPaused: true }
  });
  const historyStore = createHistory([{ hostname: "example.com", timestamp: 1 }]);
  const managerCalls = [];
  const counterCalls = [];
  const service = createService({
    storageArea,
    historyStore,
    blockingManager: {
      async setEnabled(enabled) { managerCalls.push(["enabled", enabled]); },
      async setAllowlist(hosts) { managerCalls.push(["allowlist", hosts]); }
    },
    blockingCounter: {
      async prune() {},
      async clear() { counterCalls.push("clear"); },
      async siteSummary() { return { days: {}, dayHosts: {}, hosts: [], total: 0 }; }
    }
  });

  assert.deepEqual(await service.clearHistory(), { cleared: true, at: new Date().toISOString().slice(0, 10) });
  assert.deepEqual(historyStore.records, []);

  await service.clearAllData();
  assert.deepEqual(historyStore.records, []);
  assert.deepEqual(counterCalls, ["clear"]);
  assert.deepEqual(storageArea.values[DOMAIN_CACHE_KEY], {});
  assert.deepEqual(storageArea.values.siteObservations, {});
  assert.deepEqual(managerCalls, [["allowlist", []], ["enabled", true]]);
  assert.equal(storageArea.values.settings.historyPaused, DEFAULT_SETTINGS.historyPaused);
  assert.deepEqual(storageArea.values.settings.siteAllowlist, []);
});

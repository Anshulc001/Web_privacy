import assert from "node:assert/strict";
import test from "node:test";
import {
  createDataSync,
  isSyncDue,
  BREACH_DATA_URL,
  THREAT_DATA_URL,
  DATA_SYNC_INTERVAL_MS,
  DATA_SYNC_RETRY_MS
} from "../background/data-sync.mjs";
import { canonicalizeBreaches } from "../lib/breach-checker.mjs";
import { canonicalizeThreatHosts } from "../lib/threat-checker.mjs";
import { canonicalBlockingPayload, sha256 } from "../lib/data-integrity.mjs";

const noopBlocking = { async applyRemoteHosts() { throw new Error("should not apply"); } };
const noopSettings = { async load() { return { blockingEnabled: true }; } };

async function makeBreachFile() {
  const breaches = canonicalizeBreaches({
    "adobe.com": [{ title: "Adobe", breachDate: "2013-10-04", pwnCount: 1, dataClasses: ["Email addresses"], description: "Text", disclosureUrl: null, flags: {} }]
  });
  return {
    version: "1.0.0",
    buildDate: new Date().toISOString(),
    checksum: await sha256(JSON.stringify(breaches)),
    source: "Have I Been Pwned",
    data: { breaches }
  };
}

function memoryStorage(initial = {}) {
  const state = { ...initial };
  return {
    state,
    async get(key) { return { [key]: state[key] }; },
    async set(patch) { Object.assign(state, patch); }
  };
}

test("keeps the last good data and reports outdated when a download fails", async () => {
  const fallback = { version: "old" };
  const sync = createDataSync(async () => ({ ok: false, status: 503 }), {
    async get() { return { blockingData: fallback }; }, async set() { throw new Error("should not save"); }
  }, noopBlocking, noopSettings);
  const result = await sync.syncBlockingData();
  const recorded = await result;
  assert.equal(result.status, "outdated");
  assert.equal(result.data, fallback);
  assert.ok(recorded.error.includes("503"));
});

test("syncs and validates breach data on success", async () => {
  const file = await makeBreachFile();
  const storage = memoryStorage();
  const sync = createDataSync(async () => ({ ok: true, status: 200, async json() { return file; } }), storage, noopBlocking, noopSettings);
  const result = await sync.syncBreachData();
  assert.equal(result.status, "updated");
  assert.equal(Object.keys(result.data.data.breaches).length, 1);
  assert.ok(storage.state.breachData, "validated breach data must be stored");
  const status = await sync.readSyncStatus();
  assert.equal(status.breach.ok, true);
});

test("keeps the last good breach copy when the download fails", async () => {
  const previous = { version: "old-breach" };
  const storage = memoryStorage({ breachData: previous });
  const sync = createDataSync(async () => ({ ok: false, status: 500 }), storage, noopBlocking, noopSettings);
  const result = await sync.syncBreachData();
  assert.equal(result.status, "outdated");
  assert.equal(result.data, previous);
  const status = await sync.readSyncStatus();
  assert.equal(status.breach.ok, false);
});

test("rejects a corrupt breach download instead of storing it", async () => {
  const storage = memoryStorage({ breachData: { version: "good" } });
  const corrupt = { version: "1", buildDate: new Date().toISOString(), checksum: "sha256:nope", data: { breaches: { "adobe.com": [] } } };
  const sync = createDataSync(async () => ({ ok: true, status: 200, async json() { return corrupt; } }), storage, noopBlocking, noopSettings);
  const result = await sync.syncBreachData();
  assert.equal(result.status, "outdated");
  assert.equal(storage.state.breachData.version, "good");
});

test("does not overwrite existing breach data when seeding from the bundle", async () => {
  const storage = memoryStorage({ breachData: { version: "existing" } });
  const sync = createDataSync(async () => { throw new Error("should not fetch"); }, storage, noopBlocking, noopSettings);
  const result = await sync.seedBreachDataFromBundle();
  assert.equal(result.status, "present");
  assert.equal(storage.state.breachData.version, "existing");
});

test("seeds from the bundled file on a fresh install", async () => {
  const file = await makeBreachFile();
  const storage = memoryStorage();
  const sync = createDataSync(async () => ({ ok: true, status: 200, async json() { return file; } }), storage, noopBlocking, noopSettings);
  const result = await sync.seedBreachDataFromBundle();
  assert.equal(result.status, "seeded");
  assert.ok(storage.state.breachData);
  assert.equal(storage.state.breachDataSource, "bundled");
});

test("reports unavailable when neither the bundle nor a download is usable", async () => {
  const storage = memoryStorage();
  const sync = createDataSync(async () => ({ ok: false, status: 404 }), storage, noopBlocking, noopSettings);
  const result = await sync.seedBreachDataFromBundle();
  assert.equal(result.status, "unavailable");
});

async function makeBlockingFile(hosts = ["tracker.test"]) {
  const normalized = [...new Set(hosts)].sort();
  return {
    version: "1.0.0",
    buildDate: new Date().toISOString(),
    checksum: await sha256(JSON.stringify(normalized)),
    source: "EasyList+EasyPrivacy",
    data: { hosts: normalized }
  };
}

test("skips re-applying host rules when the downloaded checksum is unchanged", async () => {
  const file = await makeBlockingFile();
  let applied = 0;
  const blocking = { async applyRemoteHosts() { applied += 1; } };
  const storage = memoryStorage({ blockingData: { ...file } });
  const sync = createDataSync(async () => ({ ok: true, status: 200, async json() { return file; } }), storage, blocking, noopSettings);
  const result = await sync.syncBlockingData();
  // Rebuilding ~25,000 dynamic rules for an identical list is the expensive part
  // of a sync, so an unchanged checksum must not reach the DNR layer at all.
  assert.equal(result.status, "unchanged");
  assert.equal(applied, 0);
  assert.equal((await sync.readSyncStatus()).blocking.ok, true);
});

// The downloaded file is the only way an existing profile gets the option-qualified
// rules, and nothing in the live Chrome suite covers it (the published copy still has
// none). This is the seam where they would silently be dropped on the floor.
test("passes the downloaded option-qualified rules through to the DNR layer", async () => {
  const hosts = ["ads.test"];
  const hostRules = [{ host: "pixel.test", condition: { resourceTypes: ["script"], domainType: "thirdParty" } }];
  const file = {
    version: "1.1.0",
    buildDate: new Date().toISOString(),
    checksum: await sha256(canonicalBlockingPayload({ hosts, hostRules })),
    source: "test",
    data: { hosts, hostRules }
  };
  const calls = [];
  const blocking = { async applyRemoteHosts(...args) { calls.push(args); } };
  const sync = createDataSync(async () => ({ ok: true, status: 200, async json() { return file; } }), memoryStorage(), blocking, noopSettings);
  const result = await sync.syncBlockingData();
  assert.equal(result.status, "updated");
  assert.deepEqual(calls[0][0], ["ads.test"]);
  assert.deepEqual(calls[0][2], hostRules, "a sync that drops hostRules silently weakens blocking");
});

test("applies host rules when the downloaded checksum changed", async () => {
  const file = await makeBlockingFile(["tracker.test", "ads.test"]);
  let applied = 0;
  const blocking = { async applyRemoteHosts() { applied += 1; } };
  const storage = memoryStorage({ blockingData: { checksum: "sha256:previous" } });
  const sync = createDataSync(async () => ({ ok: true, status: 200, async json() { return file; } }), storage, blocking, noopSettings);
  const result = await sync.syncBlockingData();
  assert.equal(result.status, "updated");
  assert.equal(applied, 1);
});

function syncEntry(age, ok = true) {
  return { at: new Date(Date.now() - age).toISOString(), ok };
}

test("a fresh successful sync is not repeated on the next worker start", () => {
  assert.equal(isSyncDue({ blocking: syncEntry(60_000) }, "blocking"), false);
  assert.equal(isSyncDue({ blocking: syncEntry(DATA_SYNC_INTERVAL_MS - 60_000) }, "blocking"), false);
});

test("a success older than the interval is due again", () => {
  assert.equal(isSyncDue({ blocking: syncEntry(DATA_SYNC_INTERVAL_MS + 60_000) }, "blocking"), true);
});

test("a failure is retried sooner than a success", () => {
  assert.equal(isSyncDue({ breach: syncEntry(60_000, false) }, "breach"), false);
  assert.equal(isSyncDue({ breach: syncEntry(DATA_SYNC_RETRY_MS + 60_000, false) }, "breach"), true);
  assert.ok(DATA_SYNC_RETRY_MS < DATA_SYNC_INTERVAL_MS);
});

test("missing, unreadable or future sync records are always due", () => {
  assert.equal(isSyncDue(undefined, "threat"), true);
  assert.equal(isSyncDue({}, "threat"), true);
  assert.equal(isSyncDue({ threat: { at: "not a date", ok: true } }, "threat"), true);
  assert.equal(isSyncDue({ threat: { at: new Date(Date.now() + 60_000).toISOString(), ok: true } }, "threat"), true);
});

test("breach data URL is built from the single data base constant", () => {
  assert.ok(BREACH_DATA_URL.endsWith("/data/breach-data.json"));
  assert.ok(BREACH_DATA_URL.startsWith("https://raw.githubusercontent.com/"));
});

async function makeThreatFile() {
  const hosts = canonicalizeThreatHosts(["bad.example", "phish.test"]);
  return {
    version: "1.0.0",
    buildDate: new Date().toISOString(),
    checksum: await sha256(JSON.stringify(hosts)),
    source: "Phishing.Database",
    data: { hosts }
  };
}

test("syncs and validates threat data on success", async () => {
  const file = await makeThreatFile();
  const storage = memoryStorage();
  const sync = createDataSync(async () => ({ ok: true, status: 200, async json() { return file; } }), storage, noopBlocking, noopSettings);
  const result = await sync.syncThreatData();
  assert.equal(result.status, "updated");
  assert.deepEqual(result.data.data.hosts, ["bad.example", "phish.test"]);
  assert.ok(storage.state.threatData);
  assert.equal((await sync.readSyncStatus()).threat.ok, true);
});

test("keeps the last good threat copy when the download fails", async () => {
  const storage = memoryStorage({ threatData: { version: "old-threat" } });
  const sync = createDataSync(async () => ({ ok: false, status: 502 }), storage, noopBlocking, noopSettings);
  const result = await sync.syncThreatData();
  assert.equal(result.status, "outdated");
  assert.equal(result.data.version, "old-threat");
  assert.equal((await sync.readSyncStatus()).threat.ok, false);
});

test("seeds threat data from the bundle only when nothing is stored", async () => {
  const file = await makeThreatFile();
  const fresh = memoryStorage();
  const seeding = createDataSync(async () => ({ ok: true, status: 200, async json() { return file; } }), fresh, noopBlocking, noopSettings);
  assert.equal((await seeding.seedThreatDataFromBundle()).status, "seeded");
  assert.equal(fresh.state.threatDataSource, "bundled");

  const existing = memoryStorage({ threatData: { version: "kept" } });
  const skip = createDataSync(async () => { throw new Error("should not fetch"); }, existing, noopBlocking, noopSettings);
  assert.equal((await skip.seedThreatDataFromBundle()).status, "present");
  assert.equal(existing.state.threatData.version, "kept");
});

test("threat data URL is built from the single data base constant", () => {
  assert.ok(THREAT_DATA_URL.endsWith("/data/threat-list.json"));
});

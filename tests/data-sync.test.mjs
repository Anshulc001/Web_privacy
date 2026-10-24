import assert from "node:assert/strict";
import test from "node:test";
import { createDataSync, BREACH_DATA_URL, THREAT_DATA_URL } from "../background/data-sync.mjs";
import { canonicalizeBreaches } from "../lib/breach-checker.mjs";
import { canonicalizeThreatHosts } from "../lib/threat-checker.mjs";
import { sha256 } from "../lib/data-integrity.mjs";

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

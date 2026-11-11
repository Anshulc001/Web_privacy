import assert from "node:assert/strict";
import test from "node:test";
import {
  createHistoryStore,
  createNavigationRecorder,
  hostnameFromUrl,
  normalizeHostname,
  normalizeHistory,
  pruneHistory,
  retentionMilliseconds
} from "../background/history-store.mjs";

function createStorage(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(key) { return { [key]: values[key] }; },
    async set(update) { Object.assign(values, structuredClone(update)); }
  };
}

test("extracts only a hostname from supported web URLs", () => {
  assert.equal(hostnameFromUrl("https://User:secret@Sub.Example.com:8443/a?token=1#section"), "sub.example.com");
  assert.equal(hostnameFromUrl("chrome://extensions"), null);
  assert.equal(hostnameFromUrl("not a url"), null);
});

test("normalizes through the single shared hostname validator", () => {
  assert.equal(normalizeHostname("Example.COM."), "example.com");
  assert.equal(normalizeHostname("bad host"), null);
  assert.equal(normalizeHostname(42), null);
});

test("removes corrupt records and prunes exactly at the retention boundary", () => {
  const now = 200_000_000;
  const day = retentionMilliseconds(24);
  assert.deepEqual(pruneHistory([
    { hostname: "keep.example", timestamp: now - day },
    { hostname: "old.example", timestamp: now - day - 1 },
    { hostname: "future.example", timestamp: now + 1 },
    { hostname: "bad host!", timestamp: now }
  ], now, 24), [{ hostname: "keep.example", timestamp: now - day }]);
  assert.deepEqual(normalizeHistory("not-an-array"), []);
});

test("records hostname and timestamp only", async () => {
  const storage = createStorage();
  const store = createHistoryStore(storage, () => 5_000);
  const result = await store.recordUrl("https://user:secret@Example.com/path?private=yes#fragment", 48);
  assert.equal(result.recorded, true);
  assert.deepEqual(storage.values.historyEvents, [{ hostname: "example.com", timestamp: 5_000 }]);
  assert.equal(JSON.stringify(storage.values.historyEvents).includes("secret"), false);
  assert.equal(JSON.stringify(storage.values.historyEvents).includes("private"), false);
});

test("paused history still prunes but does not record a new hostname", async () => {
  const storage = createStorage({
    historyEvents: [{ hostname: "expired.example", timestamp: 0 }]
  });
  const store = createHistoryStore(storage, () => retentionMilliseconds(48) + 1);
  const result = await store.recordHostname("new.example", 48, true);
  assert.equal(result.recorded, false);
  assert.deepEqual(storage.values.historyEvents, []);
});

test("rejects invalid retention and storage failures", async () => {
  assert.throws(() => retentionMilliseconds(169), /between 24 and 168/);
  const failingStore = createHistoryStore({
    async get() { throw new Error("read failed"); },
    async set() {}
  });
  await assert.rejects(failingStore.prune(48), /Could not read WebGuard history/);
});

test("skips subframes and incognito tabs before reading or storing history", async () => {
  let tabLookups = 0;
  let recorded = 0;
  const recorder = createNavigationRecorder({
    async get() { tabLookups += 1; return { incognito: true }; }
  }, {
    async recordUrl() { recorded += 1; }
  }, {
    async load() { return { historyRetentionHours: 48, historyPaused: false }; }
  });

  assert.deepEqual(await recorder({ frameId: 1, tabId: 4, url: "https://subframe.test" }), {
    recorded: false, ignored: true
  });
  assert.deepEqual(await recorder({ frameId: 0, tabId: 4, url: "https://private.test" }), {
    recorded: false, ignored: true
  });
  assert.equal(tabLookups, 1);
  assert.equal(recorded, 0);
});

test("records concurrent navigations without losing either", async () => {
  const values = {};
  const store = createHistoryStore({
    async get(key) {
      // Chrome storage answers asynchronously, so two commits can overlap.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { [key]: values[key] };
    },
    async set(update) { Object.assign(values, structuredClone(update)); }
  }, () => 5_000);

  await Promise.all([
    store.recordHostname("one.example", 48),
    store.recordHostname("two.example", 48)
  ]);

  assert.deepEqual(
    values.historyEvents.map((record) => record.hostname).sort(),
    ["one.example", "two.example"],
    "both navigations must survive the read-modify-write"
  );
});

test("a clear queued behind a record cannot be resurrected by it", async () => {
  const values = {};
  const store = createHistoryStore({
    async get(key) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { [key]: values[key] };
    },
    async set(update) { Object.assign(values, structuredClone(update)); }
  }, () => 5_000);

  const recording = store.recordHostname("late.example", 48);
  const clearing = store.clear();
  await Promise.all([recording, clearing]);

  assert.deepEqual(values.historyEvents, [], "the clear must be the last write");
});

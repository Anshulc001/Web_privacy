import assert from "node:assert/strict";
import test from "node:test";
import { createBlockingCounter, isBlockedByClient } from "../background/blocking-counter.mjs";

test("counts only ERR_BLOCKED_BY_CLIENT requests by tab, day, and host", async () => {
  const values = {};
  const counter = createBlockingCounter({ async get(key) { return { [key]: values[key] }; }, async set(update) { Object.assign(values, update); } }, () => Date.parse("2026-10-25T12:00:00Z"));
  assert.equal(await counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 3, url: "https://ads.test/a" }), true);
  assert.deepEqual(await counter.summary(3), { tab: 1, today: 1, topHosts: [["ads.test", 1]], blockingDataLastSync: null });
  assert.equal(isBlockedByClient({ error: "other", tabId: 3, url: "https://ads.test" }), false);
});

test("carries the last successful blocklist sync into the popup summary", async () => {
  const storage = {
    async get(key) {
      if (key === "dataLastSync") return { dataLastSync: { blocking: { at: "2026-10-24T00:00:00.000Z", ok: true } } };
      return {};
    },
    async set() {}
  };
  const counter = createBlockingCounter(storage, () => Date.parse("2026-10-25T12:00:00Z"));
  assert.equal((await counter.summary(1)).blockingDataLastSync, "2026-10-24T00:00:00.000Z");
});

test("resets a tab's count on a new page but keeps the daily and host totals", async () => {
  const values = {};
  const counter = createBlockingCounter({
    async get(key) { return { [key]: values[key] }; },
    async set(update) { Object.assign(values, update); }
  }, () => Date.parse("2026-10-25T12:00:00Z"));

  await counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 7, url: "https://ads.test/a" });
  await counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 7, url: "https://track.test/b" });
  assert.deepEqual((await counter.summary(7)).tab, 2);

  assert.equal(await counter.resetTab(7), true);
  const after = await counter.summary(7);
  assert.equal(after.tab, 0, "per-tab count must restart for the new page");
  assert.equal(after.today, 2, "daily total must survive navigation");
  assert.deepEqual(after.topHosts, [["ads.test", 1], ["track.test", 1]]);
});

test("resetTab ignores an invalid or unknown tab", async () => {
  const values = {};
  const counter = createBlockingCounter({
    async get(key) { return { [key]: values[key] }; },
    async set(update) { Object.assign(values, update); }
  });
  assert.equal(await counter.resetTab(-1), false);
  assert.equal(await counter.resetTab("7"), false);
  assert.equal(await counter.resetTab(99), false);
});

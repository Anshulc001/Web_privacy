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

test("counts concurrent blocked requests without losing writes", async () => {
  const values = {};
  const counter = createBlockingCounter({
    async get(key) {
      // Chrome storage answers asynchronously, so several records can overlap.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { [key]: values[key] };
    },
    async set(update) { Object.assign(values, update); }
  }, () => Date.parse("2026-10-25T12:00:00Z"));

  const urls = ["https://ads.test/a", "https://tracker.test/b", "https://beacon.test/c"];
  await Promise.all(urls.map((url) => counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 3, url })));

  const summary = await counter.summary(3);
  assert.equal(summary.tab, 3, "every blocked request must be counted in the tab");
  assert.equal(summary.today, 3, "every blocked request must be counted for the day");
  assert.deepEqual(summary.topHosts.map(([host]) => host).sort(), ["ads.test", "beacon.test", "tracker.test"]);
});

test("attributes blocked requests to the page that made them", async () => {
  const values = {};
  const counter = createBlockingCounter({
    async get(key) { return { [key]: values[key] }; },
    async set(update) { Object.assign(values, update); }
  }, () => Date.parse("2026-10-25T12:00:00Z"));

  await counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 4, url: "https://ads.test/a", initiator: "https://www.news.test/story" });
  await counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 4, url: "https://ads.test/b", initiator: "https://www.news.test/story" });
  await counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 5, url: "https://track.test/c", initiator: "https://shop.test/" });
  // A request without an initiator still counts for the browser.
  await counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 5, url: "https://beacon.test/d" });

  const news = await counter.siteSummary("www.news.test");
  assert.strictEqual(news.total, 2);
  assert.deepStrictEqual(news.hosts, [{ host: "ads.test", count: 2 }]);
  assert.deepStrictEqual(news.days, { "2026-10-25": 2 });
  assert.strictEqual((await counter.siteSummary("shop.test")).total, 1);
  assert.strictEqual((await counter.siteSummary("unknown.test")).total, 0);
  assert.strictEqual((await counter.summary(4)).today, 4, "the browser total still includes every request");
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

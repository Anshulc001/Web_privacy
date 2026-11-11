import assert from "node:assert/strict";
import test from "node:test";
import { createBlockingCounter, isBlockedByClient, MAX_BLOCKS_PER_PAGE, shouldCountBlockedRequest } from "../background/blocking-counter.mjs";

test("counts only ERR_BLOCKED_BY_CLIENT requests by tab, day, and host", async () => {
  const values = {};
  const counter = createBlockingCounter({ async get(key) { return { [key]: values[key] }; }, async set(update) { Object.assign(values, update); } }, () => Date.parse("2026-10-25T12:00:00Z"));
  assert.equal(await counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 3, url: "https://ads.test/a" }), true);
  assert.deepEqual(await counter.summary(3), {
    tab: 1,
    today: 1,
    tabHosts: [{ host: "ads.test", count: 1 }]
  });
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
  assert.deepEqual(summary.tabHosts.map((entry) => entry.host).sort(), ["ads.test", "beacon.test", "tracker.test"]);
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
  assert.deepEqual(after.tabHosts, [], "the live per-page list starts empty for the new page");

  // The same blocked URL after a reload counts for the new page (popup) but not
  // again for the stored dashboard day/host/site buckets.
  await counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 7, url: "https://ads.test/a" });
  assert.equal((await counter.summary(7)).tab, 1, "a reload starts a fresh live count");
  assert.equal((await counter.summary(7)).today, 2, "a reload must not double the stored day total");
  assert.deepEqual((await counter.summary(7)).tabHosts, [{ host: "ads.test", count: 1 }], "only the new page's block is listed");
});

test("counts a retry storm once per page", async () => {
  const values = {};
  const counter = createBlockingCounter({
    async get(key) { return { [key]: values[key] }; },
    async set(update) { Object.assign(values, update); }
  }, () => Date.parse("2026-10-25T12:00:00Z"));

  // A blocked request that retries in a loop must not inflate the counters.
  const url = "https://cdn-media.brightline.tv/config/v3/1018.json";
  for (let index = 0; index < 500; index += 1) {
    await counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 9, url, initiator: "https://edition.cnn.com/" });
  }
  assert.equal((await counter.summary(9)).tab, 1, "500 retries of one request count once");
  assert.equal((await counter.summary(9)).today, 1);
  assert.equal((await counter.siteSummary("edition.cnn.com")).total, 1);
  assert.deepEqual((await counter.summary(9)).tabHosts, [{ host: "cdn-media.brightline.tv", count: 1 }]);

  // A different request path on the same page is a separate block.
  await counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 9, url: "https://cdn-media.brightline.tv/config/v3/1019.json", initiator: "https://edition.cnn.com/" });
  assert.equal((await counter.summary(9)).tab, 2);

  // A new document starts a new page, so the live popup count starts over.
  await counter.resetTab(9);
  await counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 9, url, initiator: "https://edition.cnn.com/" });
  assert.equal((await counter.summary(9)).tab, 1, "the live dedupe set resets with the page");
  // The stored record is per site, day and URL, so a reload does not add the
  // same blocked request to the dashboard again.
  assert.equal((await counter.summary(9)).today, 2, "a reload must not double the stored total");
  assert.equal((await counter.siteSummary("edition.cnn.com")).total, 2);
});

test("caps a single page at the per-page ceiling", async () => {
  const values = {};
  const counter = createBlockingCounter({
    async get(key) { return { [key]: values[key] }; },
    async set(update) { Object.assign(values, update); }
  }, () => Date.parse("2026-10-25T12:00:00Z"));

  for (let index = 0; index < MAX_BLOCKS_PER_PAGE + 20; index += 1) {
    await counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 4, url: `https://ads.test/path-${index}` });
  }
  assert.equal((await counter.summary(4)).tab, MAX_BLOCKS_PER_PAGE);
});

test("clear runs inside the write queue and resets every bucket", async () => {
  const values = {};
  const counter = createBlockingCounter({
    async get(key) { return { [key]: values[key] }; },
    async set(update) { Object.assign(values, update); }
  }, () => Date.parse("2026-10-25T12:00:00Z"));

  // Start writes, then clear: the clear must win and the in-flight writes must
  // not resurrect the buckets afterwards.
  const pending = [
    counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 1, url: "https://ads.test/a", initiator: "https://news.test/" }),
    counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 1, url: "https://ads.test/b", initiator: "https://news.test/" })
  ];
  const cleared = counter.clear();
  await Promise.all([...pending, cleared]);

  assert.deepEqual(values.blockingCounts, { tabs: {}, tabHosts: {}, days: {}, dayHosts: {}, hosts: {}, sites: {}, seen: {} });
  assert.strictEqual((await counter.siteSummary("news.test")).total, 0);
  // The page already contributed these requests; a retry firing right after a
  // clear must not resurrect them. A genuinely new request still counts.
  assert.equal(await counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 1, url: "https://ads.test/a" }), false);
  assert.equal(await counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 1, url: "https://ads.test/c" }), true);
});

test("prunes day buckets outside the retention window", async () => {
  const values = {};
  const day1 = Date.parse("2026-10-25T12:00:00Z");
  const first = createBlockingCounter({
    async get(key) { return { [key]: values[key] }; },
    async set(update) { Object.assign(values, update); }
  }, () => day1);
  await first.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 1, url: "https://ads.test/a", initiator: "https://news.test/" });

  const later = createBlockingCounter({
    async get(key) { return { [key]: values[key] }; },
    async set(update) { Object.assign(values, update); }
  }, () => day1 + 3 * 86_400_000);
  assert.equal(await later.prune(24), true, "the old day must be reported as pruned");
  assert.deepEqual(values.blockingCounts.days, {});
  assert.deepEqual(values.blockingCounts.dayHosts, {});
  assert.deepEqual(values.blockingCounts.seen, {});
  assert.deepEqual(values.blockingCounts.sites["news.test"].days, {});
  assert.deepEqual(values.blockingCounts.sites["news.test"].dayHosts, {});
  // All-time host totals are intentionally not pruned.
  assert.deepEqual(values.blockingCounts.hosts, { "ads.test": 1 });
});

test("does not count blocked requests while paused or allowlisted", async () => {
  assert.equal(shouldCountBlockedRequest({ blockingEnabled: false, siteAllowlist: [] }, "news.test"), false);
  assert.equal(shouldCountBlockedRequest({ blockingEnabled: true, siteAllowlist: ["news.test"] }, "news.test"), false);
  // The allowlist rule covers the registrable domain, so the counter must agree.
  assert.equal(shouldCountBlockedRequest({ blockingEnabled: true, siteAllowlist: ["edition.cnn.com"] }, "www.cnn.com"), false);
  assert.equal(shouldCountBlockedRequest({ blockingEnabled: true, siteAllowlist: ["other.test"] }, "news.test"), true);
  assert.equal(shouldCountBlockedRequest({ blockingEnabled: true, siteAllowlist: [] }, null), true);
});

test("returns every source for the active tab so the popup list adds up", async () => {
  const values = {};
  const counter = createBlockingCounter({
    async get(key) { return { [key]: values[key] }; },
    async set(update) { Object.assign(values, update); }
  }, () => Date.parse("2026-10-25T12:00:00Z"));

  for (let index = 0; index < 12; index += 1) {
    await counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 5, url: `https://tracker-${index}.test/ad.js` });
  }
  const summary = await counter.summary(5);
  assert.equal(summary.tab, 12);
  assert.equal(summary.tabHosts.length, 12, "no source may be truncated away");
  assert.equal(summary.tabHosts.reduce((sum, entry) => sum + entry.count, 0), summary.tab, "source rows must add up to the popup total");
});

test("re-visiting a site counts for the popup but never twice for the dashboard", async () => {
  const values = {};
  const counter = createBlockingCounter({
    async get(key) { return { [key]: values[key] }; },
    async set(update) { Object.assign(values, update); }
  }, () => Date.parse("2026-10-25T12:00:00Z"));
  const blocked = (tabId, url, initiator) => counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId, url, initiator });

  await blocked(1, "https://ads.test/a", "https://abc.test/");
  await counter.resetTab(1);
  await blocked(1, "https://ads.test/a", "https://abc.test/");
  assert.equal((await counter.summary(1)).tab, 1, "the popup counts this visit");
  assert.equal((await counter.summary(1)).today, 1, "the dashboard must not double-count the reload");
  assert.equal((await counter.siteSummary("abc.test")).total, 1);

  // A different blocked URL on the same site and day is new.
  await blocked(1, "https://ads.test/b", "https://abc.test/");
  assert.equal((await counter.summary(1)).today, 2);
  assert.equal((await counter.siteSummary("abc.test")).total, 2);

  // The same URL on a different site is a separate stored record.
  await blocked(2, "https://ads.test/a", "https://other.test/");
  assert.equal((await counter.summary(2)).today, 3);
  assert.equal((await counter.siteSummary("other.test")).total, 1);

  // Requests with no initiator use the page the tab is showing.
  await counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 3, url: "https://ads.test/a" }, "abc.test");
  assert.equal((await counter.summary(3)).tab, 1);
  assert.equal((await counter.summary(3)).today, 3, "the fallback page is deduplicated too");

  const counts = values.blockingCounts;
  assert.deepEqual(counts.dayHosts["2026-10-25"], { "ads.test": 3 });
  assert.deepEqual(counts.sites["abc.test"].dayHosts["2026-10-25"], { "ads.test": 2 });
  assert.equal(
    Object.values(counts.dayHosts["2026-10-25"]).reduce((sum, value) => sum + value, 0),
    counts.days["2026-10-25"],
    "per-day source counts must add up to the day total"
  );
  assert.equal(
    Object.values(counts.sites["abc.test"].dayHosts["2026-10-25"]).reduce((sum, value) => sum + value, 0),
    counts.sites["abc.test"].days["2026-10-25"],
    "per-site per-day source counts must add up to the site day total"
  );
});

test("attributes a third-party iframe request to the page the tab is showing", async () => {
  const values = {};
  const counter = createBlockingCounter({
    async get(key) { return { [key]: values[key] }; },
    async set(update) { Object.assign(values, update); }
  }, () => Date.parse("2026-10-25T12:00:00Z"));

  // The tab is showing edition.cnn.com. One of its blocked requests came from
  // inside a Stripe iframe, so the request's initiator is the iframe host.
  await counter.record(
    { error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 12, url: "https://m.stripe.network/inner.html", initiator: "https://m.stripe.network/" },
    "edition.cnn.com"
  );
  await counter.record(
    { error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 12, url: "https://smetrics.cnn.com/b/ss/cnn", initiator: "https://edition.cnn.com/" },
    "edition.cnn.com"
  );

  assert.equal((await counter.summary(12)).tab, 2);
  assert.equal((await counter.siteSummary("edition.cnn.com")).total, 2, "both blocks belong to the visited site");
  assert.equal(
    (await counter.siteSummary("m.stripe.network")).total,
    0,
    "an iframe host must not become a website the user visited"
  );
  assert.deepEqual(
    Object.keys(values.blockingCounts.sites),
    ["edition.cnn.com"],
    "the dashboard must see one website, not the iframe host"
  );

  // The initiator is still used when the tab's page is unknown, so blocks are
  // never dropped just because no navigation event has arrived yet.
  await counter.record(
    { error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 13, url: "https://ads.test/late", initiator: "https://late.test/story" },
    undefined
  );
  assert.equal((await counter.siteSummary("late.test")).total, 1);
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

test("serializes resetTab behind an in-flight record so a navigation cannot wipe a new count", async () => {
  const values = {};
  const writes = [];
  const counter = createBlockingCounter({
    async get(key) {
      // A storage read that takes long enough for a navigation reset to be queued
      // while the record is still in flight.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { [key]: values[key] };
    },
    async set(update) {
      writes.push(JSON.stringify(update.blockingCounts.tabs));
      Object.assign(values, update);
    }
  }, () => Date.parse("2026-10-25T12:00:00Z"));

  const recorded = counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 12, url: "https://ads.test/a" });
  const reset = counter.resetTab(12);
  await Promise.all([recorded, reset]);

  assert.deepEqual(writes, ['{"12":1}', "{}"], "the record must land before the reset, never after it");
  assert.equal((await counter.summary(12)).tab, 0, "the navigation reset must be the last write");
  assert.equal((await counter.summary(12)).today, 1, "the stored day total is unaffected by a tab reset");

  // Requests that arrive after the reset belong to the new page and count again.
  await counter.record({ error: "net::ERR_BLOCKED_BY_CLIENT", tabId: 12, url: "https://ads.test/a" });
  assert.equal((await counter.summary(12)).tab, 1);
});

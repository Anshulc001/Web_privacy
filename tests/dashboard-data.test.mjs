import { describe, it } from "node:test";
import assert from "node:assert";
import {
  groupHistoryByDay,
  selectableDays,
  eventsForDay,
  blockingSeries,
  topBlockedHosts,
  dataAgeDays,
  describeData,
  MAX_CHART_DAYS
} from "../lib/dashboard-data.mjs";
import { barChartModel, horizontalBarModel, sparklinePath, niceMax } from "../dashboard/charts.mjs";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const HOUR = 3_600_000;

describe("groupHistoryByDay", () => {
  it("buckets events per day and drops anything outside retention", () => {
    const events = [
      { hostname: "a.example", timestamp: NOW - HOUR },
      { hostname: "a.example", timestamp: NOW - 2 * HOUR },
      { hostname: "b.example", timestamp: NOW - 30 * HOUR },
      { hostname: "old.example", timestamp: NOW - 100 * HOUR }
    ];
    const days = groupHistoryByDay(events, 48, NOW);
    assert.strictEqual(days.length, 2);
    assert.strictEqual(days[0].date, "2026-10-24");
    assert.deepStrictEqual(days[1].hosts[0], { host: "a.example", count: 2 });
    assert.strictEqual(days.reduce((total, day) => total + day.count, 0), 3);
  });

  it("ignores malformed events", () => {
    assert.deepStrictEqual(groupHistoryByDay([null, {}, { hostname: 5, timestamp: NOW }], 48, NOW), []);
    assert.deepStrictEqual(groupHistoryByDay("nope", 48, NOW), []);
  });
});

describe("selectableDays", () => {
  it("offers only days inside the retention window", () => {
    assert.deepStrictEqual(selectableDays(48, NOW), ["2026-10-25", "2026-10-24"]);
    assert.strictEqual(selectableDays(168, NOW).length, 7);
  });
});

describe("eventsForDay", () => {
  it("returns events for one date only and rejects bad dates", () => {
    const events = [{ hostname: "a.example", timestamp: NOW - HOUR }];
    assert.strictEqual(eventsForDay(events, "2026-10-25").length, 1);
    assert.strictEqual(eventsForDay(events, "2026-10-01").length, 0);
    assert.deepStrictEqual(eventsForDay(events, "yesterday"), []);
  });
});

describe("blockingSeries", () => {
  it("fills missing days with zero, oldest first", () => {
    const series = blockingSeries({ days: { "2026-10-25": 4 } }, NOW, 3);
    assert.strictEqual(series.length, 3);
    assert.strictEqual(series[2].count, 4);
    assert.strictEqual(series[0].count, 0);
  });

  it("ignores corrupt counts", () => {
    assert.strictEqual(blockingSeries(null, NOW).length, MAX_CHART_DAYS);
    assert.deepStrictEqual(blockingSeries({ days: "x" }, NOW, 2).map((day) => day.count), [0, 0]);
  });
});

describe("topBlockedHosts", () => {
  it("sorts by count and bounds the list", () => {
    const top = topBlockedHosts({ hosts: { a: 1, b: 9, c: 5 } }, 2);
    assert.deepStrictEqual(top, [{ host: "b", count: 9 }, { host: "c", count: 5 }]);
  });

  it("ignores invalid entries", () => {
    assert.deepStrictEqual(topBlockedHosts({ hosts: { a: -1, b: "x" } }), []);
    assert.deepStrictEqual(topBlockedHosts(null), []);
  });
});

describe("describeData", () => {
  it("reports unavailable, outdated and fresh states", () => {
    assert.strictEqual(describeData({ key: "b", label: "Blocklist", available: false }, NOW).status, "unavailable");
    const stale = describeData({ key: "b", label: "Blocklist", lastSync: "2026-10-01T00:00:00Z", available: true }, NOW);
    assert.strictEqual(stale.status, "outdated");
    const fresh = describeData({ key: "b", label: "Blocklist", lastSync: "2026-10-25T00:00:00Z", available: true }, NOW);
    assert.strictEqual(fresh.status, "fresh");
    assert.ok(fresh.text.includes("updated today"));
  });

  it("computes age in whole days and rejects bad dates", () => {
    assert.strictEqual(dataAgeDays("2026-10-24T12:00:00Z", NOW), 1);
    assert.strictEqual(dataAgeDays("nope", NOW), null);
    assert.strictEqual(dataAgeDays(undefined, NOW), null);
  });
});

describe("barChartModel", () => {
  it("places bars inside the plot area and never inverts a positive height", () => {
    const model = barChartModel([{ label: "a", value: 10 }, { label: "b", value: 0 }], { width: 400, height: 200 });
    assert.strictEqual(model.bars.length, 2);
    for (const bar of model.bars) {
      assert.ok(bar.x >= model.plot.x);
      assert.ok(bar.x + bar.width <= model.plot.x + model.plot.width + 1);
      assert.ok(bar.height >= 0);
    }
    assert.strictEqual(model.bars[1].height, 0);
  });

  it("handles an empty series without dividing by zero", () => {
    const model = barChartModel([], { width: 300, height: 150 });
    assert.deepStrictEqual(model.bars, []);
    assert.strictEqual(model.max, 1);
  });

  it("picks a rounded maximum", () => {
    assert.strictEqual(niceMax([3]), 5);
    assert.strictEqual(niceMax([37]), 50);
    assert.strictEqual(niceMax([]), 1);
  });
});

describe("horizontalBarModel", () => {
  it("keeps long host labels in their own column and scales the bars", () => {
    const model = horizontalBarModel([
      { label: "pubads.g.doubleclick.net", value: 29 },
      { label: "pagead2.googlesyndication.com", value: 12 },
      { label: "quiet.test", value: 0 }
    ], { width: 640 });
    assert.strictEqual(model.bars.length, 3);
    for (const bar of model.bars) assert.strictEqual(bar.x, model.labelWidth, "labels never sit under a bar");
    assert.ok(model.bars[0].width > model.bars[1].width, "a larger count must draw a longer bar");
    assert.strictEqual(model.bars[2].width, 0, "a zero count draws no bar");
    assert.ok(model.bars[0].width <= model.plotWidth, "bars stay inside the plot area");
  });

  it("handles an empty host list", () => {
    const model = horizontalBarModel([], { width: 640 });
    assert.deepStrictEqual(model.bars, []);
    assert.strictEqual(model.max, 1);
  });
});

describe("sparklinePath", () => {
  it("builds a path from values and handles empty input", () => {
    const path = sparklinePath([0, 5, 10], { width: 100, height: 50 });
    assert.ok(path.startsWith("M0,50"));
    assert.ok(path.includes("L100,0"));
    assert.strictEqual(sparklinePath([], {}), "");
  });
});

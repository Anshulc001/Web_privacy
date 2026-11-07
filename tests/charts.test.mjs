import assert from "node:assert/strict";
import test from "node:test";
import { barChartModel, chartTicks } from "../dashboard/charts.mjs";

test("labels small maxima with one tick per unit instead of repeating rounded values", () => {
  assert.deepEqual(chartTicks(1), [1, 0]);
  assert.deepEqual(chartTicks(2), [2, 1, 0]);
  assert.deepEqual(chartTicks(3), [3, 2, 1, 0]);
  // A max of 1 used to draw 1, 1, 1, 0, 0 and a max of 2 drew 2, 2, 1, 1, 0.
  for (const max of [1, 2, 3]) assert.equal(new Set(chartTicks(max)).size, max + 1);
});

test("rounds larger maxima up to four whole-number steps", () => {
  assert.deepEqual(chartTicks(4), [4, 3, 2, 1, 0]);
  assert.deepEqual(chartTicks(5), [8, 6, 4, 2, 0]);
  assert.deepEqual(chartTicks(11), [12, 9, 6, 3, 0]);
  assert.deepEqual(chartTicks(100), [100, 75, 50, 25, 0]);
});

test("always returns distinct whole numbers from the scale top down to zero", () => {
  for (let max = 1; max <= 40; max += 1) {
    const ticks = chartTicks(max);
    assert.equal(ticks.at(-1), 0, `max ${max} must end at zero`);
    assert.equal(ticks.length, new Set(ticks).size, `max ${max} must not repeat a label`);
    assert.ok(ticks.every((tick) => Number.isInteger(tick)), `max ${max} must use whole numbers`);
    assert.deepEqual(ticks, [...ticks].sort((a, b) => b - a), `max ${max} must descend`);
    assert.ok(ticks[0] >= max, `max ${max} must keep every bar inside the scale`);
  }
  // A chart without data still gets a readable scale.
  assert.deepEqual(chartTicks(0), [1, 0]);
  assert.deepEqual(chartTicks(-4), [1, 0]);
  assert.deepEqual(chartTicks(NaN), [1, 0]);
});

test("bar geometry uses the same whole-number scale as its tick labels", () => {
  const single = barChartModel([{ label: "11-06", value: 1 }]);
  assert.deepEqual(single.ticks.map((tick) => tick.value), [1, 0]);
  assert.equal(single.bars[0].height, single.plot.height, "the tallest bar fills the scale");
  assert.equal(single.ticks[0].y, single.plot.y, "the top tick sits on the plot top");
  assert.equal(single.ticks.at(-1).y, single.axisY);

  // niceMax(5) is 5, which rounds the labelled scale up to 8.
  const five = barChartModel([{ label: "11-06", value: 5 }]);
  assert.deepEqual(five.ticks.map((tick) => tick.value), [8, 6, 4, 2, 0]);
  assert.ok(five.bars[0].height < five.plot.height, "a value below the rounded top leaves headroom");
  assert.ok(five.ticks.every((tick, index, list) => index === 0 || tick.y > list[index - 1].y), "tick labels must not overlap");
});

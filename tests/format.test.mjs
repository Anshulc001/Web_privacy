import assert from "node:assert/strict";
import test from "node:test";
import { formatBadgeCount, formatCount } from "../lib/format.mjs";

test("compact counts keep small numbers exact and shorten large ones", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(999), "999");
  assert.equal(formatCount(1_200), "1.2k");
  assert.equal(formatCount(1_450), "1.5k");
  assert.equal(formatCount(1_000), "1k");
  assert.equal(formatCount(55_000), "55k");
  assert.equal(formatCount(9_949), "9.9k");
  assert.equal(formatCount(-5), "0");
  assert.equal(formatCount(Number.NaN), "0");
});

test("badge text is empty at zero and capped at 999+", () => {
  assert.equal(formatBadgeCount(0), "");
  assert.equal(formatBadgeCount(-3), "");
  assert.equal(formatBadgeCount(17), "17");
  assert.equal(formatBadgeCount(999), "999");
  // Chrome clips longer text, so the badge must not rely on it fitting.
  assert.equal(formatBadgeCount(5_902), "999+");
});

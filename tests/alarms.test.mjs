import assert from "node:assert/strict";
import test from "node:test";
import { HISTORY_PRUNE_ALARM, createAlarmManager } from "../background/alarms.mjs";

function createAlarms(existing = null) {
  const listeners = [];
  const created = [];
  return {
    created,
    onAlarm: { addListener(listener) { listeners.push(listener); } },
    async get() { return existing; },
    async create(name, options) { created.push({ name, options }); },
    fire(alarm) { listeners.forEach((listener) => listener(alarm)); }
  };
}

test("creates an hourly history alarm only when it is missing", async () => {
  const alarms = createAlarms();
  const manager = createAlarmManager(alarms, { async prune() {} }, { async load() { return { historyRetentionHours: 48 }; } });
  await manager.ensureHistoryPruneAlarm();
  assert.deepEqual(alarms.created, [{
    name: HISTORY_PRUNE_ALARM,
    options: { periodInMinutes: 60, persistAcrossSessions: true }
  }]);
});

test("does not replace an existing cleanup alarm and ignores unrelated alarms", async () => {
  const alarms = createAlarms({ name: HISTORY_PRUNE_ALARM });
  let prunes = 0;
  const manager = createAlarmManager(alarms, { async prune() { prunes += 1; } }, { async load() { return { historyRetentionHours: 48 }; } });
  await manager.ensureHistoryPruneAlarm();
  alarms.fire({ name: "unrelated" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(alarms.created, []);
  assert.equal(prunes, 0);
});

test("prunes blocking-count day buckets alongside history", async () => {
  const alarms = createAlarms();
  let prunedHours = null;
  const manager = createAlarmManager(
    alarms,
    { async prune() {} },
    { async load() { return { historyRetentionHours: 72 }; } },
    { async prune(hours) { prunedHours = hours; } }
  );
  await manager.pruneHistory();
  assert.equal(prunedHours, 72, "blocking counts share the history retention window");
});

test("surfaces an alarm API failure", async () => {
  const manager = createAlarmManager({
    onAlarm: { addListener() {} },
    async get() { throw new Error("alarms unavailable"); },
    async create() {}
  }, { async prune() {} }, { async load() { return { historyRetentionHours: 48 }; } });
  await assert.rejects(manager.ensureHistoryPruneAlarm(), /alarms unavailable/);
});

test("still prunes history when blocking-count cleanup fails", async () => {
  const alarms = createAlarms();
  let historyPrunes = 0;
  const manager = createAlarmManager(
    alarms,
    { async prune() { historyPrunes += 1; return [{ hostname: "keep.example", timestamp: 1 }]; } },
    { async load() { return { historyRetentionHours: 48 }; } },
    { async prune() { throw new Error("counter storage failed"); } }
  );

  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args);
  try {
    const records = await manager.pruneHistory();
    assert.equal(historyPrunes, 1, "history cleanup must run even when the counter fails");
    assert.deepEqual(records, [{ hostname: "keep.example", timestamp: 1 }]);
    assert.equal(logged.length, 1, "the counter failure is reported, not hidden");
  } finally {
    console.error = originalError;
  }
});

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

test("surfaces an alarm API failure", async () => {
  const manager = createAlarmManager({
    onAlarm: { addListener() {} },
    async get() { throw new Error("alarms unavailable"); },
    async create() {}
  }, { async prune() {} }, { async load() { return { historyRetentionHours: 48 }; } });
  await assert.rejects(manager.ensureHistoryPruneAlarm(), /alarms unavailable/);
});

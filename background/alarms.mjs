export const HISTORY_PRUNE_ALARM = "webguard-history-prune";

export function createAlarmManager(alarms, historyStore, settingsStore, blockingCounter = null) {
  if (!alarms || typeof alarms.get !== "function" || typeof alarms.create !== "function" || !alarms.onAlarm?.addListener) {
    throw new TypeError("A Chrome-compatible alarms API is required.");
  }

  async function pruneHistory() {
    const settings = await settingsStore.load();
    // Blocking counts keep their own day buckets, which historyStore.prune does
    // not touch, so they have to expire on the same schedule. The two cleanups
    // are independent: the alarm only fires hourly, so a counter failure must
    // not be allowed to leave history records alive forever.
    try {
      if (blockingCounter) await blockingCounter.prune(settings.historyRetentionHours);
    } catch (error) {
      console.error("WebGuard blocking-count cleanup failed.", error);
    }
    return historyStore.prune(settings.historyRetentionHours);
  }

  alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === HISTORY_PRUNE_ALARM) {
      void pruneHistory().catch((error) => console.error("WebGuard history cleanup failed.", error));
    }
  });

  return {
    async ensureHistoryPruneAlarm() {
      const existing = await alarms.get(HISTORY_PRUNE_ALARM);
      if (!existing) {
        await alarms.create(HISTORY_PRUNE_ALARM, {
          periodInMinutes: 60,
          persistAcrossSessions: true
        });
      }
    },
    pruneHistory
  };
}

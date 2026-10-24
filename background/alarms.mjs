export const HISTORY_PRUNE_ALARM = "webguard-history-prune";

export function createAlarmManager(alarms, historyStore, settingsStore) {
  if (!alarms || typeof alarms.get !== "function" || typeof alarms.create !== "function" || !alarms.onAlarm?.addListener) {
    throw new TypeError("A Chrome-compatible alarms API is required.");
  }

  async function pruneHistory() {
    const settings = await settingsStore.load();
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

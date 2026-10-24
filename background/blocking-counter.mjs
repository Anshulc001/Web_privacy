import { hostnameFromUrl } from "./history-store.mjs";
import { LAST_SYNC_KEY } from "./data-sync.mjs";

export const BLOCKING_COUNTS_KEY = "blockingCounts";

export function isBlockedByClient(details) {
  return details?.error === "net::ERR_BLOCKED_BY_CLIENT" && Number.isInteger(details.tabId) && details.tabId >= 0 && Boolean(hostnameFromUrl(details.url));
}

export function createBlockingCounter(storageArea, now = () => Date.now()) {
  return {
    async record(details) {
      if (!isBlockedByClient(details)) return false;
      const host = hostnameFromUrl(details.url);
      const day = new Date(now()).toISOString().slice(0, 10);
      const stored = await storageArea.get(BLOCKING_COUNTS_KEY);
      const counts = stored?.[BLOCKING_COUNTS_KEY] && typeof stored[BLOCKING_COUNTS_KEY] === "object" ? stored[BLOCKING_COUNTS_KEY] : { tabs: {}, days: {}, hosts: {} };
      counts.tabs[details.tabId] = (counts.tabs[details.tabId] ?? 0) + 1;
      counts.days[day] = (counts.days[day] ?? 0) + 1;
      counts.hosts[host] = (counts.hosts[host] ?? 0) + 1;
      await storageArea.set({ [BLOCKING_COUNTS_KEY]: counts });
      return true;
    },
    /** A tab's count belongs to the page it is showing, so a new page starts at zero. */
    async resetTab(tabId) {
      if (!Number.isInteger(tabId) || tabId < 0) return false;
      const stored = await storageArea.get(BLOCKING_COUNTS_KEY);
      const counts = stored?.[BLOCKING_COUNTS_KEY];
      if (!counts || typeof counts !== "object" || !counts.tabs || !(tabId in counts.tabs)) return false;
      delete counts.tabs[tabId];
      await storageArea.set({ [BLOCKING_COUNTS_KEY]: counts });
      return true;
    },

    async summary(tabId) {
      const stored = await storageArea.get(BLOCKING_COUNTS_KEY);
      const counts = stored?.[BLOCKING_COUNTS_KEY] ?? { tabs: {}, days: {}, hosts: {} };
      // The popup states how fresh the blocklist is, so the last successful sync
      // has to travel with the counts. Without it the popup always said
      // "unavailable" even after a successful download.
      const sync = (await storageArea.get(LAST_SYNC_KEY))?.[LAST_SYNC_KEY];
      const lastSync = sync?.blocking?.at;
      return {
        tab: counts.tabs?.[tabId] ?? 0,
        today: counts.days?.[new Date(now()).toISOString().slice(0, 10)] ?? 0,
        topHosts: Object.entries(counts.hosts ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 10),
        blockingDataLastSync: typeof lastSync === "string" ? lastSync : null
      };
    }
  };
}

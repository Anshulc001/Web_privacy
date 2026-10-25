import { hostnameFromUrl, normalizeHostname } from "./history-store.mjs";
import { LAST_SYNC_KEY } from "./data-sync.mjs";

export const BLOCKING_COUNTS_KEY = "blockingCounts";

export function isBlockedByClient(details) {
  return details?.error === "net::ERR_BLOCKED_BY_CLIENT" && Number.isInteger(details.tabId) && details.tabId >= 0 && Boolean(hostnameFromUrl(details.url));
}

export function createBlockingCounter(storageArea, now = () => Date.now()) {
  // A page fires several blocked requests at once, and every record() is a
  // read-modify-write of the same storage key. Overlapping writes lose counts
  // (the popup said "1" for three blocked trackers), so run the writers in order.
  let queue = Promise.resolve();
  function serialized(task) {
    const result = queue.then(task, task);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    record(details) {
      return serialized(async () => {
        if (!isBlockedByClient(details)) return false;
        const host = hostnameFromUrl(details.url);
        const day = new Date(now()).toISOString().slice(0, 10);
        const stored = await storageArea.get(BLOCKING_COUNTS_KEY);
        const counts = stored?.[BLOCKING_COUNTS_KEY] && typeof stored[BLOCKING_COUNTS_KEY] === "object" ? stored[BLOCKING_COUNTS_KEY] : { tabs: {}, days: {}, hosts: {}, sites: {} };
        counts.tabs[details.tabId] = (counts.tabs[details.tabId] ?? 0) + 1;
        counts.days[day] = (counts.days[day] ?? 0) + 1;
        counts.hosts[host] = (counts.hosts[host] ?? 0) + 1;
        // The page that made the request is what lets the dashboard show one
        // site's blocks instead of only browser-wide totals. Requests without an
        // initiator (some extension and browser traffic) stay in the global totals.
        const site = normalizeHostname(details.initiator ? hostnameFromUrl(details.initiator) : null);
        if (site && site !== host) {
          counts.sites = counts.sites && typeof counts.sites === "object" ? counts.sites : {};
          const bucket = counts.sites[site] ?? { hosts: {}, days: {} };
          bucket.hosts[host] = (bucket.hosts[host] ?? 0) + 1;
          bucket.days[day] = (bucket.days[day] ?? 0) + 1;
          counts.sites[site] = bucket;
        }
        await storageArea.set({ [BLOCKING_COUNTS_KEY]: counts });
        return true;
      });
    },
    /** A tab's count belongs to the page it is showing, so a new page starts at zero. */
    resetTab(tabId) {
      return serialized(async () => {
        if (!Number.isInteger(tabId) || tabId < 0) return false;
        const stored = await storageArea.get(BLOCKING_COUNTS_KEY);
        const counts = stored?.[BLOCKING_COUNTS_KEY];
        if (!counts || typeof counts !== "object" || !counts.tabs || !(tabId in counts.tabs)) return false;
        delete counts.tabs[tabId];
        await storageArea.set({ [BLOCKING_COUNTS_KEY]: counts });
        return true;
      });
    },

    /** Blocked requests attributed to one page, for the dashboard's site view. */
    async siteSummary(hostname) {
      const host = normalizeHostname(hostname);
      const stored = await storageArea.get(BLOCKING_COUNTS_KEY);
      const bucket = host ? stored?.[BLOCKING_COUNTS_KEY]?.sites?.[host] : null;
      const hosts = Object.entries(bucket?.hosts ?? {})
        .filter(([name, count]) => typeof name === "string" && Number.isFinite(count) && count > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, count]) => ({ host: name, count }));
      return {
        days: bucket?.days && typeof bucket.days === "object" ? { ...bucket.days } : {},
        hosts,
        total: hosts.reduce((sum, entry) => sum + entry.count, 0)
      };
    },

    async summary(tabId) {
      const stored = await storageArea.get(BLOCKING_COUNTS_KEY);
      const counts = stored?.[BLOCKING_COUNTS_KEY] ?? { tabs: {}, days: {}, hosts: {}, sites: {} };
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

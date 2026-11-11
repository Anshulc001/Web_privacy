import { hostnameFromUrl, normalizeHostname } from "./history-store.mjs";
import { dayKey } from "../lib/dashboard-data.mjs";
import { hostCoveredBy } from "../lib/host-match.mjs";

export const BLOCKING_COUNTS_KEY = "blockingCounts";

// A blocked request can be retried hundreds of times a second: blocked video
// players and beacons loop without backoff. Counting every retry is what
// produced six-figure "blocked" totals, so a page adds each host+path once and
// never more than this many entries.
export const MAX_BLOCKS_PER_PAGE = 999;
// A page that keeps requesting new paths must not grow the dedupe set forever.
const MAX_TRACKED_REQUESTS_PER_TAB = 2_000;
// The stored (dashboard) dedupe keeps one hash per blocked URL, site and day.
// Beyond this many distinct URLs on one site in one day, stop recording rather
// than risk re-counting everything on the next reload.
const MAX_STORED_KEYS_PER_SITE_DAY = 2_000;

export function isBlockedByClient(details) {
  return details?.error === "net::ERR_BLOCKED_BY_CLIENT" && Number.isInteger(details.tabId) && details.tabId >= 0 && Boolean(hostnameFromUrl(details.url));
}

/** True when a blocked request should be counted at all for these settings. */
export function shouldCountBlockedRequest(settings, siteHost) {
  if (!settings || settings.blockingEnabled !== true) return false;
  if (!siteHost) return true;
  return !hostCoveredBy(siteHost, settings.siteAllowlist ?? []);
}

function requestKey(url, host) {
  try {
    const parsed = new URL(url);
    return `${host}${parsed.pathname}`;
  } catch {
    return host;
  }
}

/**
 * A short, stable fingerprint for a blocked URL. The dashboard remembers what it
 * has already counted per site and day, and storing full URLs would multiply the
 * size of the stored counts for no benefit.
 */
function requestFingerprint(key) {
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${second.toString(36)}${first.toString(36)}`;
}

function objectOr(value, fallback) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function emptyCounts() {
  return { tabs: {}, tabHosts: {}, days: {}, dayHosts: {}, hosts: {}, sites: {}, seen: {} };
}

/** Reads stored counts into the current shape, tolerating older records. */
function normalizeCounts(raw) {
  const counts = objectOr(raw, {});
  return {
    tabs: objectOr(counts.tabs, {}),
    tabHosts: objectOr(counts.tabHosts, {}),
    days: objectOr(counts.days, {}),
    dayHosts: objectOr(counts.dayHosts, {}),
    hosts: objectOr(counts.hosts, {}),
    sites: objectOr(counts.sites, {}),
    seen: objectOr(counts.seen, {})
  };
}

function siteBucket(counts, site) {
  const existing = counts.sites[site];
  const bucket = objectOr(existing, {});
  bucket.hosts = objectOr(bucket.hosts, {});
  bucket.days = objectOr(bucket.days, {});
  bucket.dayHosts = objectOr(bucket.dayHosts, {});
  counts.sites[site] = bucket;
  return bucket;
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

  // In-memory only: what this page has already been counted for, and how many
  // entries it has contributed. Both reset when the tab loads a new document.
  // This is the live scope behind the popup and the toolbar badge.
  const seenByTab = new Map();
  const countedByTab = new Map();

  function resetTabMemory(tabId) {
    seenByTab.delete(tabId);
    countedByTab.delete(tabId);
  }

  return {
    /**
     * Counts one blocked request. `site` is the page the tab is showing and is the
     * attribution for the stored records; the request's own initiator is only a
     * fallback for when that page is unknown.
     *
     * Two dedupe scopes are kept apart on purpose: the tab (live, resets on every
     * navigation) and the stored per-site/day record (dashboard, survives reloads
     * so visiting the same site twice does not count the same URL twice).
     */
    record(details, site) {
      return serialized(async () => {
        if (!isBlockedByClient(details)) return false;
        const host = hostnameFromUrl(details.url);
        if (!host) return false;
        const tabId = details.tabId;

        // One blocked request that retries in a loop must only count once.
        let seen = seenByTab.get(tabId);
        if (!seen) {
          seen = new Set();
          seenByTab.set(tabId, seen);
        }
        const key = requestKey(details.url, host);
        if (seen.has(key)) return false;

        const counted = countedByTab.get(tabId) ?? 0;
        if (counted >= MAX_BLOCKS_PER_PAGE) return false;

        if (seen.size < MAX_TRACKED_REQUESTS_PER_TAB) seen.add(key);
        countedByTab.set(tabId, counted + 1);

        const stored = await storageArea.get(BLOCKING_COUNTS_KEY);
        const counts = normalizeCounts(stored?.[BLOCKING_COUNTS_KEY]);
        const day = dayKey(now());

        // Live scope: this page visit only.
        counts.tabs[tabId] = (counts.tabs[tabId] ?? 0) + 1;
        const tabHosts = objectOr(counts.tabHosts[tabId], {});
        tabHosts[host] = (tabHosts[host] ?? 0) + 1;
        counts.tabHosts[tabId] = tabHosts;

        // Stored scope: this site, this day, this blocked URL, once. The page the
        // tab is showing always wins: a request blocked inside a third-party
        // iframe still happened on the visited page, and trusting its initiator
        // would list the iframe host as a second "website" on the dashboard.
        const attributed = normalizeHostname(site ?? null)
          ?? normalizeHostname(details.initiator ? hostnameFromUrl(details.initiator) : null);
        const siteKey = attributed ?? "";
        const seenDays = objectOr(counts.seen[siteKey], {});
        const seenList = Array.isArray(seenDays[day]) ? seenDays[day] : [];
        const fingerprint = requestFingerprint(key);
        const alreadyStored = seenList.includes(fingerprint);
        // At the per-site/day ceiling the stored counts keep what they have:
        // re-counting every reload would be worse than undercounting a long tail.
        if (!alreadyStored && seenList.length < MAX_STORED_KEYS_PER_SITE_DAY) {
          seenList.push(fingerprint);
          seenDays[day] = seenList;
          counts.seen[siteKey] = seenDays;

          counts.days[day] = (counts.days[day] ?? 0) + 1;
          const dayHosts = objectOr(counts.dayHosts[day], {});
          dayHosts[host] = (dayHosts[host] ?? 0) + 1;
          counts.dayHosts[day] = dayHosts;
          counts.hosts[host] = (counts.hosts[host] ?? 0) + 1;

          if (attributed) {
            const bucket = siteBucket(counts, attributed);
            bucket.days[day] = (bucket.days[day] ?? 0) + 1;
            const siteDayHosts = objectOr(bucket.dayHosts[day], {});
            siteDayHosts[host] = (siteDayHosts[host] ?? 0) + 1;
            bucket.dayHosts[day] = siteDayHosts;
            bucket.hosts[host] = (bucket.hosts[host] ?? 0) + 1;
          }
        }

        await storageArea.set({ [BLOCKING_COUNTS_KEY]: counts });
        return true;
      });
    },

    /** A tab's count belongs to the page it is showing, so a new page starts at zero. */
    resetTab(tabId) {
      return serialized(async () => {
        if (!Number.isInteger(tabId) || tabId < 0) return false;
        resetTabMemory(tabId);
        const stored = await storageArea.get(BLOCKING_COUNTS_KEY);
        const counts = stored?.[BLOCKING_COUNTS_KEY];
        if (!counts || typeof counts !== "object" || !counts.tabs || !(tabId in counts.tabs)) return false;
        delete counts.tabs[tabId];
        if (counts.tabHosts && typeof counts.tabHosts === "object") delete counts.tabHosts[tabId];
        await storageArea.set({ [BLOCKING_COUNTS_KEY]: counts });
        return true;
      });
    },

    /**
     * Runs inside the same queue as record(), so a clear cannot be overwritten by
     * a write that was already in flight.
     */
    clear() {
      return serialized(async () => {
        // The live dedupe memory deliberately survives: a page with a retry storm
        // is still running, and forgetting what it already contributed would let
        // the next retry re-add a count seconds after the user cleared everything.
        // It is per-page state that is dropped on navigation anyway. The per-page
        // ceiling is reset so genuinely new requests can still be counted. The
        // stored dedupe is wiped with the rest, so a fresh visit counts again.
        countedByTab.clear();
        await storageArea.set({ [BLOCKING_COUNTS_KEY]: emptyCounts() });
        return true;
      });
    },

    /** Drops day buckets older than the history retention window. */
    prune(retentionHours) {
      return serialized(async () => {
        const hours = Number.isInteger(retentionHours) && retentionHours > 0 ? retentionHours : 48;
        const days = Math.max(1, Math.ceil(hours / 24));
        const allowedDays = new Set();
        const current = now();
        for (let offset = 0; offset < days; offset += 1) allowedDays.add(dayKey(current - offset * 86_400_000));

        const stored = await storageArea.get(BLOCKING_COUNTS_KEY);
        const counts = stored?.[BLOCKING_COUNTS_KEY];
        if (!counts || typeof counts !== "object") return false;

        let changed = false;
        const pruneMap = (map) => {
          for (const key of Object.keys(map ?? {})) {
            if (allowedDays.has(key)) continue;
            delete map[key];
            changed = true;
          }
        };

        pruneMap(counts.days);
        pruneMap(counts.dayHosts);
        for (const bucket of Object.values(counts.sites ?? {})) {
          if (!bucket || typeof bucket !== "object") continue;
          pruneMap(bucket.days);
          pruneMap(bucket.dayHosts);
        }
        for (const [siteKey, byDay] of Object.entries(counts.seen ?? {})) {
          if (!byDay || typeof byDay !== "object") continue;
          for (const key of Object.keys(byDay)) {
            if (allowedDays.has(key)) continue;
            delete byDay[key];
            changed = true;
          }
          if (Object.keys(byDay).length === 0) {
            delete counts.seen[siteKey];
            changed = true;
          }
        }

        if (changed) await storageArea.set({ [BLOCKING_COUNTS_KEY]: counts });
        return changed;
      });
    },

    /** Blocked requests attributed to one page, for the dashboard's site view. */
    async siteSummary(hostname) {
      const host = normalizeHostname(hostname);
      const stored = await storageArea.get(BLOCKING_COUNTS_KEY);
      const counts = normalizeCounts(stored?.[BLOCKING_COUNTS_KEY]);
      const bucket = host ? counts.sites[host] : null;
      const hosts = Object.entries(objectOr(bucket?.hosts, {}))
        .filter(([name, count]) => typeof name === "string" && Number.isFinite(count) && count > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, count]) => ({ host: name, count }));
      return {
        days: bucket?.days && typeof bucket.days === "object" ? { ...bucket.days } : {},
        dayHosts: bucket?.dayHosts && typeof bucket.dayHosts === "object" ? { ...bucket.dayHosts } : {},
        hosts,
        total: hosts.reduce((sum, entry) => sum + entry.count, 0)
      };
    },

    async summary(tabId) {
      const stored = await storageArea.get(BLOCKING_COUNTS_KEY);
      const counts = normalizeCounts(stored?.[BLOCKING_COUNTS_KEY]);
      // The popup's expanded list describes the page whose count it shows, and
      // every source is returned: slicing here made the rows add up to less than
      // the hero number. The popup scrolls instead.
      const tabHosts = Object.entries(objectOr(counts.tabHosts?.[tabId], {}))
        .filter(([host, count]) => typeof host === "string" && Number.isFinite(count) && count > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([host, count]) => ({ host, count }));
      return {
        tab: counts.tabs?.[tabId] ?? 0,
        today: counts.days?.[dayKey(now())] ?? 0,
        tabHosts
      };
    }
  };
}

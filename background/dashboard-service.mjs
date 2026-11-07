import { BLOCKING_COUNTS_KEY } from "./blocking-counter.mjs";
import { BLOCKING_DATA_KEY, LAST_SYNC_KEY } from "./data-sync.mjs";
import { normalizeHostname, hostnameFromUrl } from "./history-store.mjs";
import { BREACH_DATA_KEY, checkHostForBreaches } from "../lib/breach-checker.mjs";
import { clearCookiesForHost } from "../lib/cookie-insights.mjs";
import { inspectSiteCookies } from "../lib/cookie-inspector.mjs";
import {
  blockingSeries,
  describeData,
  eventsForDay,
  groupHistoryByDay,
  selectableDays,
  topBlockedHosts,
  todayKey
} from "../lib/dashboard-data.mjs";
import { scoreRisk } from "../lib/risk-score.mjs";
import { THREAT_DATA_KEY, checkHostForThreats } from "../lib/threat-checker.mjs";
import { inspectUrl } from "../lib/url-checks.mjs";
import { auditPermissions } from "./permission-auditor.mjs";
import { DEFAULT_SETTINGS } from "../lib/storage-settings.mjs";
import { DOMAIN_CACHE_KEY, cachedDomainInfo } from "../lib/domain-info.mjs";

const MAX_RECENT_HOSTS = 25;

/** Keeps only the dates the dashboard can chart, so the payload stays small. */
function pickDays(map, dates) {
  const picked = {};
  for (const date of dates) {
    if (map && Object.prototype.hasOwnProperty.call(map, date)) picked[date] = map[date];
  }
  return picked;
}

export function createDashboardService({ storageArea, settingsStore, historyStore, observationStore, cookiesApi, tabsApi, blockingManager = null, blockingCounter = null }) {
  async function safeGet(key) {
    try {
      const stored = await storageArea.get(key);
      return stored?.[key];
    } catch {
      return undefined;
    }
  }

  return {
    async overview() {
      const settings = await settingsStore.load();
      const events = await historyStore.read();
      const counts = (await safeGet(BLOCKING_COUNTS_KEY)) ?? { tabs: {}, tabHosts: {}, days: {}, hosts: {}, sites: {} };
      const blockingData = await safeGet(BLOCKING_DATA_KEY);
      const breachData = await safeGet(BREACH_DATA_KEY);
      const threatData = await safeGet(THREAT_DATA_KEY);
      const sync = (await safeGet(LAST_SYNC_KEY)) ?? {};

      const days = groupHistoryByDay(events, settings.historyRetentionHours);
      const series = blockingSeries(counts);
      const seriesDates = series.map((day) => day.date);

      return {
        settings,
        history: {
          totalEvents: events.length,
          days,
          selectableDays: selectableDays(settings.historyRetentionHours),
          retentionHours: settings.historyRetentionHours,
          paused: settings.historyPaused
        },
        blocking: {
          enabled: settings.blockingEnabled,
          today: series[series.length - 1]?.count ?? 0,
          series,
          // Per-day source maps are what let the dashboard filter the breakdown by
          // the frame picker instead of showing all-time host totals.
          dayHosts: pickDays(counts.dayHosts, seriesDates),
          sites: Object.entries(counts.sites ?? {})
            .map(([host, bucket]) => ({
              host,
              days: pickDays(bucket?.days, seriesDates),
              dayHosts: pickDays(bucket?.dayHosts, seriesDates)
            }))
            .filter((entry) => Object.keys(entry.days).length > 0 || Object.keys(entry.dayHosts).length > 0),
          topHosts: topBlockedHosts(counts),
          allowlist: settings.siteAllowlist
        },
        data: [
          describeData({
            key: "blocking",
            label: "Ad and tracker rules",
            lastSync: sync.blocking?.at ?? blockingData?.buildDate,
            // The ruleset ships inside the package, so it is always usable even
            // when no download has succeeded yet.
            available: true
          }),
          describeData({
            key: "breach",
            label: "Breach data",
            lastSync: sync.breach?.at ?? breachData?.buildDate,
            available: Boolean(breachData)
          }),
          describeData({
            key: "threat",
            label: "Phishing blocklist",
            lastSync: sync.threat?.at ?? threatData?.buildDate,
            available: Boolean(threatData)
          })
        ]
      };
    },

    async targets() {
      let tabs = [];
      try {
        const openTabs = await tabsApi.query({});
        tabs = (Array.isArray(openTabs) ? openTabs : [])
          .map((tab) => ({ tabId: tab.id, hostname: hostnameFromUrl(tab.url), title: typeof tab.title === "string" ? tab.title.slice(0, 120) : "" }))
          .filter((tab) => tab.hostname)
          .slice(0, 40);
      } catch {
        tabs = [];
      }
      const events = await historyStore.read();
      const recent = [];
      for (let index = events.length - 1; index >= 0 && recent.length < MAX_RECENT_HOSTS; index -= 1) {
        const host = normalizeHostname(events[index]?.hostname);
        if (host && !recent.includes(host)) recent.push(host);
      }
      return { tabs, recentHosts: recent };
    },

    async siteReport({ hostname, tabId } = {}) {
      let host = normalizeHostname(hostname);
      let pageUrl = null;
      if (!host && Number.isInteger(tabId)) {
        try {
          const tab = await tabsApi.get(tabId);
          host = hostnameFromUrl(tab?.url);
          pageUrl = typeof tab?.url === "string" ? tab.url : null;
        } catch {
          return { status: "unavailable", reason: "That tab is no longer available." };
        }
      }
      if (!host) return { status: "unavailable", reason: "A hostname is required." };

      const settings = await settingsStore.load();
      const observation = await observationStore.get(host);

      let cookies;
      try {
        cookies = { status: "ok", cookies: await inspectSiteCookies(cookiesApi, host, observation?.thirdPartyHosts ?? []) };
      } catch (error) {
        cookies = { status: "unavailable", reason: String(error.message ?? error), cookies: [] };
      }

      const audit = auditPermissions(host, observation?.permissionStates, settings.expectedSites);
      const inspected = inspectUrl(pageUrl ?? `https://${host}/`);
      const threat = checkHostForThreats(host, await safeGet(THREAT_DATA_KEY));
      const domainInfo = await cachedDomainInfo(storageArea, host);
      const risk = scoreRisk({ urlFindings: inspected.ok ? inspected.findings : [], threat, domainInfo });
      const breach = checkHostForBreaches(host, await safeGet(BREACH_DATA_KEY));
      const blocking = blockingCounter
        ? await blockingCounter.siteSummary(host)
        : { days: {}, dayHosts: {}, hosts: [], total: 0 };

      return {
        status: "ok",
        hostname: host,
        blocking,
        cookies,
        permissions: audit.states,
        permissionAlerts: audit.alerts,
        expected: audit.expected,
        suspicious: { ...risk, isHttps: inspected.ok ? inspected.isHttps : null, urlFindings: inspected.ok ? inspected.findings : [] },
        threat,
        breach,
        domainInfo,
        allowlisted: settings.siteAllowlist.includes(host)
      };
    },

    /**
     * Deletes the cookies the site can see. Cookie values are never read, so the
     * answer is a count, not a list of what was there.
     */
    async clearSiteCookies(hostname) {
      const host = normalizeHostname(hostname);
      if (!host) return { ok: false, removed: 0, reason: "A hostname is required." };
      try {
        const { removed } = await clearCookiesForHost(cookiesApi, host);
        return { ok: true, removed };
      } catch (error) {
        return { ok: false, removed: 0, reason: String(error?.message ?? error) };
      }
    },

    async historyFor(date) {
      const settings = await settingsStore.load();
      const allowed = selectableDays(settings.historyRetentionHours);
      if (typeof date !== "string" || !allowed.includes(date)) {
        return { status: "unavailable", reason: "That date is outside the retention window.", events: [], hosts: [] };
      }
      const events = eventsForDay(await historyStore.read(), date);
      const hosts = new Map();
      for (const event of events) hosts.set(event.hostname, (hosts.get(event.hostname) ?? 0) + 1);
      return {
        status: "ok",
        date,
        events,
        hosts: [...hosts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([host, count]) => ({ host, count }))
      };
    },

    async updateSettings(patch) {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new TypeError("Settings updates must be an object.");
      }
      const allowed = {};
      if ("historyRetentionHours" in patch) allowed.historyRetentionHours = patch.historyRetentionHours;
      if ("historyPaused" in patch) allowed.historyPaused = patch.historyPaused;
      if ("blockingEnabled" in patch) allowed.blockingEnabled = patch.blockingEnabled;
      const settings = await settingsStore.save(allowed);
      if ("historyRetentionHours" in allowed) {
        await historyStore.prune(settings.historyRetentionHours);
        if (blockingCounter) await blockingCounter.prune(settings.historyRetentionHours);
      }
      // Storing the flag is not enough: blocking lives in Chrome's rule engine, so
      // the switch does nothing unless the rules are updated too.
      if ("blockingEnabled" in allowed && blockingManager) {
        await blockingManager.setEnabled(allowed.blockingEnabled);
      }
      return settings;
    },

    async clearHistory() {
      await historyStore.clear();
      return { cleared: true, at: todayKey() };
    },

    async clearAllData() {
      await historyStore.clear();
      // Goes through the counter's queue: writing storage directly left in-flight
      // record() calls to resurrect the counts seconds later, and forgot `sites`.
      if (blockingCounter) await blockingCounter.clear();
      else await storageArea.set({ [BLOCKING_COUNTS_KEY]: { tabs: {}, tabHosts: {}, days: {}, dayHosts: {}, hosts: {}, sites: {}, seen: {} } });
      await storageArea.set({
        [DOMAIN_CACHE_KEY]: {},
        siteObservations: {}
      });
      // "Clear all data" used to leave the allowlist, the expected sites and every
      // other preference behind, which is a list of the sites you care about.
      if (blockingManager) {
        await blockingManager.setAllowlist([]);
        await blockingManager.setEnabled(DEFAULT_SETTINGS.blockingEnabled);
      }
      await settingsStore.save({ ...DEFAULT_SETTINGS });
      return { cleared: true };
    }
  };
}

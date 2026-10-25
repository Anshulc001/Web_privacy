import { BLOCKING_COUNTS_KEY } from "./blocking-counter.mjs";
import { BLOCKING_DATA_KEY, LAST_SYNC_KEY } from "./data-sync.mjs";
import { normalizeHostname, hostnameFromUrl } from "./history-store.mjs";
import { BREACH_DATA_KEY, checkHostForBreaches } from "../lib/breach-checker.mjs";
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

const DOMAIN_CACHE_KEY = "domainInfoCache";
const MAX_RECENT_HOSTS = 25;

export function createDashboardService({ storageArea, settingsStore, historyStore, observationStore, cookiesApi, tabsApi, blockingManager = null, blockingCounter = null }) {
  async function safeGet(key) {
    try {
      const stored = await storageArea.get(key);
      return stored?.[key];
    } catch {
      return undefined;
    }
  }

  async function cachedDomainInfo(hostname) {
    const cache = await safeGet(DOMAIN_CACHE_KEY);
    const entry = cache && typeof cache === "object" ? cache[hostname] : null;
    if (!entry || typeof entry !== "object" || !Number.isFinite(entry.at)) return null;
    if (Date.now() - entry.at > 86_400_000) return null;
    return entry.value ?? null;
  }

  return {
    async overview() {
      const settings = await settingsStore.load();
      const events = await historyStore.read();
      const counts = (await safeGet(BLOCKING_COUNTS_KEY)) ?? { tabs: {}, days: {}, hosts: {} };
      const blockingData = await safeGet(BLOCKING_DATA_KEY);
      const breachData = await safeGet(BREACH_DATA_KEY);
      const threatData = await safeGet(THREAT_DATA_KEY);
      const sync = (await safeGet(LAST_SYNC_KEY)) ?? {};

      const days = groupHistoryByDay(events, settings.historyRetentionHours);
      const series = blockingSeries(counts);

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
      const domainInfo = await cachedDomainInfo(host);
      const risk = scoreRisk({ urlFindings: inspected.ok ? inspected.findings : [], threat, domainInfo });
      const breach = checkHostForBreaches(host, await safeGet(BREACH_DATA_KEY));
      const blocking = blockingCounter
        ? await blockingCounter.siteSummary(host)
        : { days: {}, hosts: [], total: 0 };

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
      if ("historyRetentionHours" in allowed) await historyStore.prune(settings.historyRetentionHours);
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
      await storageArea.set({
        [BLOCKING_COUNTS_KEY]: { tabs: {}, days: {}, hosts: {} },
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

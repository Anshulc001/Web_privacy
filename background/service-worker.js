import { createAlarmManager } from "./alarms.mjs";
import { createBlockingManager } from "./blocking-manager.mjs";
import { createBlockingCounter } from "./blocking-counter.mjs";
import { BLOCKING_DATA_KEY, createDataSync } from "./data-sync.mjs";
import { BREACH_DATA_KEY, checkHostForBreaches } from "../lib/breach-checker.mjs";
import { inspectSiteCookies } from "../lib/cookie-inspector.mjs";
import { createDashboardService } from "./dashboard-service.mjs";
import { createBootstrapStore, IANA_BOOTSTRAP_URL, lookupDomain, TLS_LIMITATION } from "../lib/domain-info.mjs";
import { scoreRisk } from "../lib/risk-score.mjs";
import { THREAT_DATA_KEY, checkHostForThreats } from "../lib/threat-checker.mjs";
import { inspectUrl } from "../lib/url-checks.mjs";
import { createHistoryStore, createNavigationRecorder, hostnameFromUrl } from "./history-store.mjs";
import { createObservationStore, validateSiteObservation } from "./messages.mjs";
import { auditPermissions, setExpectedSite } from "./permission-auditor.mjs";
import { createSettingsStore } from "../lib/storage-settings.mjs";

const historyStore = createHistoryStore(chrome.storage.local);
const settingsStore = createSettingsStore(chrome.storage.local);
const alarmManager = createAlarmManager(chrome.alarms, historyStore, settingsStore);
const recordTopLevelNavigation = createNavigationRecorder(chrome.tabs, historyStore, settingsStore);
const observationStore = createObservationStore(chrome.storage.local);
const remoteBlockingHosts = async () => {
  const stored = await chrome.storage.local.get(BLOCKING_DATA_KEY);
  const hosts = stored?.[BLOCKING_DATA_KEY]?.data?.hosts;
  return Array.isArray(hosts) ? hosts : [];
};
const blockingManager = createBlockingManager(chrome.declarativeNetRequest, settingsStore, remoteBlockingHosts);
const dataSync = createDataSync(fetch, chrome.storage.local, blockingManager, settingsStore);
const blockingCounter = createBlockingCounter(chrome.storage.local);
const DATA_SYNC_ALARM = "webguard-data-sync";

const bootstrapStore = createBootstrapStore(chrome.storage.local);
const dashboardService = createDashboardService({
  storageArea: chrome.storage.local,
  settingsStore,
  historyStore,
  observationStore,
  cookiesApi: chrome.cookies,
  tabsApi: chrome.tabs,
  blockingManager
});

async function cachedDomainInfo(hostname) {
  const stored = await chrome.storage.local.get("domainInfoCache");
  const cache = stored?.domainInfoCache && typeof stored.domainInfoCache === "object" ? stored.domainInfoCache : {};
  const entry = cache[hostname];
  if (!entry || typeof entry !== "object" || typeof entry.at !== "number") return null;
  // RDAP answers change slowly; keep them for a day so repeat views stay local.
  if (Date.now() - entry.at > 86_400_000) return null;
  return entry.value ?? null;
}

async function storeDomainInfo(hostname, value) {
  try {
    const stored = await chrome.storage.local.get("domainInfoCache");
    const cache = stored?.domainInfoCache && typeof stored.domainInfoCache === "object" ? stored.domainInfoCache : {};
    const entries = Object.entries(cache).slice(-50);
    const next = Object.fromEntries(entries);
    next[hostname] = { at: Date.now(), value };
    await chrome.storage.local.set({ domainInfoCache: next });
  } catch (error) {
    console.error("WebGuard could not cache domain info.", error);
  }
}

async function suspiciousInfo(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new TypeError("A valid tab ID is required.");
  const tab = await chrome.tabs.get(tabId);
  const url = typeof tab?.url === "string" ? tab.url : "";
  const inspected = inspectUrl(url);
  if (!inspected.ok) {
    return { status: "unavailable", reason: inspected.reason, findings: [], hostname: null };
  }
  const stored = await chrome.storage.local.get(THREAT_DATA_KEY);
  const threat = checkHostForThreats(inspected.hostname, stored?.[THREAT_DATA_KEY]);
  const domainInfo = await cachedDomainInfo(inspected.hostname);
  const risk = scoreRisk({ urlFindings: inspected.findings, threat, domainInfo });
  return {
    status: "ok",
    hostname: inspected.hostname,
    isHttps: inspected.isHttps,
    urlFindings: inspected.findings,
    threat,
    domainInfo,
    risk,
    tlsNote: TLS_LIMITATION
  };
}

async function rdapLookup({ tabId, hostname: requestedHost } = {}) {
  let hostname = null;
  if (typeof requestedHost === "string") {
    hostname = requestedHost.trim().toLowerCase();
  } else if (Number.isInteger(tabId) && tabId >= 0) {
    const tab = await chrome.tabs.get(tabId);
    hostname = hostnameFromUrl(tab?.url);
  }
  if (!hostname) return { status: "unavailable", reason: "Only web pages can be looked up." };
  let bootstrap = await bootstrapStore.read();
  if (!bootstrap) {
    // Fetch and cache the real bootstrap. Saving a placeholder here would leave a
    // poisoned cache that makes every later lookup report "unsupported".
    try {
      const response = await fetch(IANA_BOOTSTRAP_URL, { cache: "no-store" });
      if (response.ok) {
        const fetched = await response.json();
        if (Array.isArray(fetched?.services)) bootstrap = await bootstrapStore.save(fetched);
      }
    } catch (error) {
      console.error("WebGuard could not cache the RDAP bootstrap.", error);
    }
  }

  const result = await lookupDomain(hostname, { bootstrap: bootstrap ?? undefined });
  if (result.status === "ok") await storeDomainInfo(hostname, result);
  return result;
}

async function breachInfo(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new TypeError("A valid tab ID is required.");
  const tab = await chrome.tabs.get(tabId);
  const hostname = hostnameFromUrl(tab?.url);
  if (!hostname) return { status: "unavailable", reason: "Only web pages can be checked.", matches: [] };
  const stored = await chrome.storage.local.get(BREACH_DATA_KEY);
  return { hostname, ...checkHostForBreaches(hostname, stored?.[BREACH_DATA_KEY]) };
}

async function currentSitePrivacy(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new TypeError("A valid tab ID is required.");
  const tab = await chrome.tabs.get(tabId);
  const hostname = hostnameFromUrl(tab?.url);
  if (!hostname) throw new TypeError("Only web pages have site privacy details.");
  const observation = await observationStore.get(hostname);
  const cookies = await inspectSiteCookies(chrome.cookies, hostname, observation?.thirdPartyHosts ?? []);
  const audit = auditPermissions(hostname, observation?.permissionStates, (await settingsStore.load()).expectedSites);
  const settings = await settingsStore.load();
  return { hostname, cookies, permissions: audit.states, permissionAlerts: audit.alerts, expected: audit.expected, blocking: await blockingCounter.summary(tabId), blockingEnabled: settings.blockingEnabled, allowlisted: settings.siteAllowlist.includes(hostname) };
}

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details?.frameId === 0) {
    void blockingCounter
      .resetTab(details.tabId)
      .then(() => updateBadge(details.tabId))
      .catch((error) => console.error("WebGuard could not reset a tab count.", error));
  }
  void recordTopLevelNavigation(details).catch((error) => {
    console.error("WebGuard could not record a navigation.", error);
  });
});
async function updateBadge(tabId) {
  try {
    const { tab } = await blockingCounter.summary(tabId);
    await chrome.action.setBadgeText({ tabId, text: tab > 0 ? String(tab) : "" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#1f6feb" });
  } catch {
    // The tab may already be gone; a missing badge is not an error worth surfacing.
  }
}

chrome.webRequest.onErrorOccurred.addListener((details) => {
  void blockingCounter
    .record(details)
    .then((recorded) => (recorded ? updateBadge(details.tabId) : undefined))
    .catch((error) => console.error("WebGuard could not count a blocked request.", error));
}, { urls: ["<all_urls>"] });

chrome.runtime.onMessage.addListener(async (message, sender) => {
  const observation = validateSiteObservation(message, sender, chrome.runtime.id);
  if (observation) {
    await observationStore.save(observation);
    return { ok: true };
  }
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("")) || !message || typeof message !== "object") return undefined;
  if (message.type === "webguard.currentSitePrivacy") return currentSitePrivacy(message.tabId);
  if (message.type === "webguard.setExpectedSite") return setExpectedSite(settingsStore, message.hostname, message.expected);
  if (message.type === "webguard.setBlockingEnabled") return blockingManager.setEnabled(message.enabled);
  if (message.type === "webguard.setAllowlist") return blockingManager.setAllowlist(message.hosts);
  if (message.type === "webguard.toggleAllowlist") {
    const settings = await settingsStore.load();
    const hosts = new Set(settings.siteAllowlist);
    if (message.allowlisted) hosts.add(message.hostname); else hosts.delete(message.hostname);
    return blockingManager.setAllowlist([...hosts]);
  }
  if (message.type === "webguard.blockingSummary") return blockingCounter.summary(message.tabId ?? undefined);
  if (message.type === "webguard.breachInfo") return breachInfo(message.tabId);
  if (message.type === "webguard.suspiciousInfo") return suspiciousInfo(message.tabId);
  if (message.type === "webguard.rdapLookup" || message.type === "webguard.lookupDomain") {
    return rdapLookup({ tabId: message.tabId, hostname: message.hostname });
  }
  if (message.type === "webguard.dashboardOverview") return dashboardService.overview();
  if (message.type === "webguard.dashboardTargets") return dashboardService.targets();
  if (message.type === "webguard.siteReport") return dashboardService.siteReport({ hostname: message.hostname, tabId: message.tabId });
  if (message.type === "webguard.historyFor") return dashboardService.historyFor(message.date);
  if (message.type === "webguard.updateSettings") return dashboardService.updateSettings(message.patch);
  if (message.type === "webguard.clearHistory") return dashboardService.clearHistory();
  if (message.type === "webguard.clearAllData") return dashboardService.clearAllData();
  return undefined;
});

function runAllDataSyncs() {
  void dataSync.syncBlockingData().catch((error) => console.error("WebGuard blocking data sync failed.", error));
  void dataSync.syncBreachData().catch((error) => console.error("WebGuard breach data sync failed.", error));
  void dataSync.syncThreatData().catch((error) => console.error("WebGuard threat data sync failed.", error));
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === DATA_SYNC_ALARM) runAllDataSyncs();
});

void chrome.alarms.create(DATA_SYNC_ALARM, { periodInMinutes: 1_440, persistAcrossSessions: true }).catch((error) => {
  console.error("WebGuard could not schedule data sync.", error);
});
void Promise.all([
  dataSync.seedBreachDataFromBundle().catch((error) => console.error("WebGuard could not seed bundled breach data.", error)),
  dataSync.seedThreatDataFromBundle().catch((error) => console.error("WebGuard could not seed bundled threat data.", error))
]).then(runAllDataSyncs);

void alarmManager.ensureHistoryPruneAlarm().catch((error) => {
  console.error("WebGuard could not schedule history cleanup.", error);
});

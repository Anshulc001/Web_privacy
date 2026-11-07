import { createAlarmManager } from "./alarms.mjs";
import { createBlockingManager } from "./blocking-manager.mjs";
import { createBlockingCounter, isBlockedByClient, shouldCountBlockedRequest } from "./blocking-counter.mjs";
import { BLOCKING_DATA_KEY, createDataSync } from "./data-sync.mjs";
import { BREACH_DATA_KEY, checkHostForBreaches } from "../lib/breach-checker.mjs";
import { inspectSiteCookies } from "../lib/cookie-inspector.mjs";
import { createDashboardService } from "./dashboard-service.mjs";
import {
  cachedDomainInfo,
  createBootstrapStore,
  IANA_BOOTSTRAP_URL,
  lookupDomain,
  saveDomainInfo,
  TLS_LIMITATION
} from "../lib/domain-info.mjs";
import { formatBadgeCount } from "../lib/format.mjs";
import { scoreRisk } from "../lib/risk-score.mjs";
import { THREAT_DATA_KEY, checkHostForThreats } from "../lib/threat-checker.mjs";
import { TRACKING_PARAM_RULE_ID } from "../lib/tracking-params.mjs";
import { inspectUrl } from "../lib/url-checks.mjs";
import { createHistoryStore, createNavigationRecorder, hostnameFromUrl } from "./history-store.mjs";
import { createObservationStore, validateSiteObservation } from "./messages.mjs";
import { auditPermissions, setExpectedSite } from "./permission-auditor.mjs";
import { createSettingsStore } from "../lib/storage-settings.mjs";

const historyStore = createHistoryStore(chrome.storage.local);
const settingsStore = createSettingsStore(chrome.storage.local);
const blockingCounter = createBlockingCounter(chrome.storage.local);
const alarmManager = createAlarmManager(chrome.alarms, historyStore, settingsStore, blockingCounter);
const recordTopLevelNavigation = createNavigationRecorder(chrome.tabs, historyStore, settingsStore);
const observationStore = createObservationStore(chrome.storage.local);
const remoteBlockingHosts = async () => {
  const stored = await chrome.storage.local.get(BLOCKING_DATA_KEY);
  const hosts = stored?.[BLOCKING_DATA_KEY]?.data?.hosts;
  return Array.isArray(hosts) ? hosts : [];
};
const blockingManager = createBlockingManager(chrome.declarativeNetRequest, settingsStore, remoteBlockingHosts);
const dataSync = createDataSync(fetch, chrome.storage.local, blockingManager, settingsStore);
const DATA_SYNC_ALARM = "webguard-data-sync";

// A blocked-request storm fires thousands of events, so the hot path must not
// read storage for every one. The cache is dropped whenever settings change.
let settingsCache = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes?.settings) settingsCache = null;
});
async function activeSettings() {
  if (!settingsCache) settingsCache = await settingsStore.load();
  return settingsCache;
}

// The page each tab is showing, kept from navigation events: reading tabs.get()
// for every blocked request would be worse than the storm it is guarding.
const tabSites = new Map();
chrome.tabs.onRemoved.addListener((tabId) => tabSites.delete(tabId));

/**
 * A tab's blocked count belongs to the document it is showing. The reset runs on
 * the main-frame request rather than on commit or `tabs.onUpdated`: a fast page
 * can have its subresources blocked before the commit event reaches the worker,
 * and resetting afterwards wiped counts that had just been recorded.
 */
function resetPage(tabId, url) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  tabSites.set(tabId, hostnameFromUrl(url));
  void blockingCounter
    .resetTab(tabId)
    .then(() => updateBadge(tabId))
    .catch((error) => console.error("WebGuard could not reset a tab count.", error));
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details?.type !== "main_frame" || !Number.isInteger(details.tabId) || details.tabId < 0) return;
    resetPage(details.tabId, details.url);
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

// A new tab is the earliest warning that a page is coming: it arrives before the
// navigation's main-frame request, so the worker that this event starts has its
// listeners in place by the time the page asks for anything. Without it the
// worker can be started by the page's own requests, which is already too late for
// the ones that woke it.
chrome.tabs.onCreated.addListener(() => {
  void activeSettings().catch(() => {});
});

// Fallback for a main-frame change the request listener did not see (a worker
// waking up late, or a tab moved by something other than a new request). A late
// update can still carry a non-web URL such as about:blank while a real page is
// loading; resetting for that would wipe the counts it had just recorded.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (typeof info?.url !== "string") return;
  const host = hostnameFromUrl(info.url);
  if (!host || tabSites.get(tabId) === host) return;
  resetPage(tabId, info.url);
});

const bootstrapStore = createBootstrapStore(chrome.storage.local);
const dashboardService = createDashboardService({
  storageArea: chrome.storage.local,
  settingsStore,
  historyStore,
  observationStore,
  cookiesApi: chrome.cookies,
  tabsApi: chrome.tabs,
  blockingManager,
  blockingCounter
});

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
  const domainInfo = await cachedDomainInfo(chrome.storage.local, inspected.hostname);
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

  // null tells the lib not to repeat the download this worker just attempted.
  const result = await lookupDomain(hostname, { bootstrap: bootstrap ?? null });
  // Keyed by registrable domain inside the lib, so edition.cnn.com and cnn.com
  // share one cache entry and the dashboard finds it for either.
  if (result.status === "ok") await saveDomainInfo(chrome.storage.local, hostname, result);
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

/**
 * The content script reports what the page loaded after document_idle. A popup
 * opened immediately can therefore miss it; frame hostnames recovered from the
 * browser's own navigation records are a fast, local stand-in for third-party
 * hosts until the real observation arrives.
 */
async function observationFor(tabId, hostname) {
  const observation = await observationStore.get(hostname);
  if (observation) return observation;
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    const thirdPartyHosts = [...new Set((Array.isArray(frames) ? frames : [])
      .map((frame) => hostnameFromUrl(frame?.url))
      .filter((host) => host && host !== hostname))];
    if (thirdPartyHosts.length > 0) return { thirdPartyHosts, permissionStates: {} };
  } catch {
    // Frame records are a nicety; without them the cookie list is just first-party.
  }
  return null;
}

async function currentSitePrivacy(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new TypeError("A valid tab ID is required.");
  const tab = await chrome.tabs.get(tabId);
  const hostname = hostnameFromUrl(tab?.url);
  if (!hostname) throw new TypeError("Only web pages have site privacy details.");
  const observation = await observationFor(tabId, hostname);
  const settings = await activeSettings();
  const cookies = await inspectSiteCookies(chrome.cookies, hostname, observation?.thirdPartyHosts ?? []);
  const audit = auditPermissions(hostname, observation?.permissionStates, settings.expectedSites);
  const reported = audit.states && typeof audit.states === "object"
    ? Object.entries(audit.states).filter(([, state]) => state && state !== "unavailable")
    : [];
  const stored = await chrome.storage.local.get(BREACH_DATA_KEY);
  return {
    hostname,
    cookies,
    permissions: audit.states,
    permissionAlerts: audit.alerts,
    expected: audit.expected,
    permissionStatesAvailable: reported.length > 0,
    blocking: await blockingCounter.summary(tabId),
    blockingEnabled: settings.blockingEnabled,
    allowlisted: settings.siteAllowlist.includes(hostname),
    // Sent with the site details so the popup does not need a second round-trip.
    breach: { hostname, ...checkHostForBreaches(hostname, stored?.[BREACH_DATA_KEY]) }
  };
}

chrome.webNavigation.onCommitted.addListener((details) => {
  void recordTopLevelNavigation(details).catch((error) => {
    console.error("WebGuard could not record a navigation.", error);
  });
});
async function updateBadge(tabId) {
  try {
    const settings = await activeSettings();
    let text = "";
    if (settings.blockingEnabled) {
      const tab = await chrome.tabs.get(tabId);
      const site = tabSites.get(tabId) ?? hostnameFromUrl(tab?.url);
      if (shouldCountBlockedRequest(settings, site)) {
        const { tab: count } = await blockingCounter.summary(tabId);
        text = formatBadgeCount(count);
      }
    }
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#1f6feb" });
  } catch {
    // The tab may already be gone; a missing badge is not an error worth surfacing.
  }
}

chrome.webRequest.onErrorOccurred.addListener((details) => {
  void (async () => {
    if (!isBlockedByClient(details)) return;
    const settings = await activeSettings();
    // A request can be blocked before the page is known (the main-frame reset may
    // still be queued), so fall back to the initiator instead of dropping it.
    const site = tabSites.get(details.tabId) ?? hostnameFromUrl(details.initiator);
    // A paused or allowlisted site must not keep inflating the count.
    if (!shouldCountBlockedRequest(settings, site)) return;
    const recorded = await blockingCounter.record(details, site);
    if (recorded) await updateBadge(details.tabId);
  })().catch((error) => console.error("WebGuard could not count a blocked request.", error));
}, { urls: ["<all_urls>"] });

chrome.runtime.onMessage.addListener(async (message, sender) => {
  // The cosmetic filter pings this worker at document_start, and that message is
  // what makes the first page after a browser restart countable: it starts the
  // worker while the page is still being parsed, so the webRequest listeners are
  // registered before the requests they must count are dispatched. The ping also
  // names the page, and warms the settings the first block will need.
  if (message?.type === "webguard.ping") {
    if (sender?.id !== chrome.runtime.id) return undefined;
    const tabId = sender.tab?.id;
    if (Number.isInteger(tabId) && tabId >= 0 && !tabSites.has(tabId)) {
      tabSites.set(tabId, hostnameFromUrl(sender.tab.url));
    }
    void activeSettings().catch(() => {});
    return { ok: true };
  }
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
  if (message.type === "webguard.clearSiteCookies") return dashboardService.clearSiteCookies(message.hostname);
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

// Chrome starts an extension worker at browser launch only when it has a reason
// to, and a worker that starts on the first navigation is already too late: the
// requests of that page are dispatched before these listeners exist, so its
// blocked counts are lost. The startup hook starts the worker while the browser
// is still opening, and warms the settings cache the first requests will need.
chrome.runtime.onStartup.addListener(() => {
  void ensureTrackingParamRule().catch((error) => console.error("WebGuard could not load settings on startup.", error));
});

// A fresh profile has never switched the blocking toggle or edited the allowlist,
// so nothing has installed the tracking-parameter redirect yet and it would never
// run for a user who leaves the defaults alone. Installing it on worker start makes
// the default state the working state.
//
// The rule is only rewritten when it disagrees with the settings: a worker wakes
// for every page, and rewriting identical dynamic rules on each wake would fight
// with a toggle the user is clicking at that very moment.
async function ensureTrackingParamRule() {
  const settings = await activeSettings();
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const installed = rules.some((rule) => rule.id === TRACKING_PARAM_RULE_ID);
  if (installed !== settings.blockingEnabled) {
    await blockingManager.syncTrackingParamRule(settings.blockingEnabled, settings.siteAllowlist);
  }
}

void ensureTrackingParamRule().catch((error) => console.error("WebGuard could not install the tracking-parameter rule.", error));

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

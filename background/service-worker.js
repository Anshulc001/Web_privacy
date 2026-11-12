import { createAlarmManager } from "./alarms.mjs";
import { createBlockingManager } from "./blocking-manager.mjs";
import { createBlockingCounter, isBlockedByClient, shouldCountBlockedRequest } from "./blocking-counter.mjs";
import { BLOCKING_DATA_KEY, createDataSync, isSyncDue } from "./data-sync.mjs";
import { BREACH_DATA_KEY, checkHostForBreaches } from "../lib/breach-checker.mjs";
import { hostSelectorsFor } from "../lib/cosmetic-rules.mjs";
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
import { createHistoryStore, createNavigationRecorder, hostnameFromUrl, normalizeHostname } from "./history-store.mjs";
import { hostCoveredBy, toggleAllowlistEntry } from "../lib/host-match.mjs";
import { createObservationStore, validatePermissionRequest, validateSiteObservation } from "./messages.mjs";
import { ensurePermissionRulesVersion, setSitePermission } from "./permission-settings.mjs";
import { probeTabPermissionStates } from "./site-probe.mjs";
import { normalizePermissionStates, normalizeRequestedPermissions } from "./permission-auditor.mjs";
import { createSettingsStore, resolveSiteMode } from "../lib/storage-settings.mjs";
import { createBlockingIndex, explainBlockedHost } from "../lib/blocking-explain.mjs";

const historyStore = createHistoryStore(chrome.storage.local);
const settingsStore = createSettingsStore(chrome.storage.local);
const blockingCounter = createBlockingCounter(chrome.storage.local);
const alarmManager = createAlarmManager(chrome.alarms, historyStore, settingsStore, blockingCounter);
const recordTopLevelNavigation = createNavigationRecorder(chrome.tabs, historyStore, settingsStore);
const observationStore = createObservationStore(chrome.storage.local);
// The stored blocking data carries two rule lists: hosts blocked outright and
// hosts blocked only under the condition their list asked for. Both are returned
// so re-installing after a toggle restores the same policy, not a wider one.
const remoteBlockingHosts = async () => {
  const stored = await chrome.storage.local.get(BLOCKING_DATA_KEY);
  const data = stored?.[BLOCKING_DATA_KEY]?.data;
  return {
    hosts: Array.isArray(data?.hosts) ? data.hosts : [],
    hostRules: Array.isArray(data?.hostRules) ? data.hostRules : []
  };
};
const blockingManager = createBlockingManager(chrome.declarativeNetRequest, settingsStore, remoteBlockingHosts);

// The downloaded list is what makes "why was this blocked" answerable, and it only
// changes when a sync lands. One index per checksum, rebuilt on the next popup open
// after an update.
let blockingIndexCache = { checksum: null, index: null };
async function blockingIndex() {
  try {
    const stored = await chrome.storage.local.get(BLOCKING_DATA_KEY);
    const data = stored?.[BLOCKING_DATA_KEY];
    if (!data) return null;
    if (blockingIndexCache.checksum === data.checksum) return blockingIndexCache.index;
    const index = createBlockingIndex(data);
    blockingIndexCache = { checksum: data.checksum ?? null, index };
    return index;
  } catch {
    return null;
  }
}

async function enrichBlockingSummary(summary) {
  const index = await blockingIndex();
  const hosts = Array.isArray(summary?.tabHosts) ? summary.tabHosts : [];
  return {
    ...summary,
    dataVersion: index?.version ?? null,
    tabHosts: hosts.map((entry) => ({ ...entry, explain: explainBlockedHost(entry.host, index) }))
  };
}
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
  contentSettings: chrome.contentSettings,
  blockingManager,
  blockingCounter,
  explainHost: async (host) => explainBlockedHost(host, await blockingIndex())
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
    if (thirdPartyHosts.length > 0) return { thirdPartyHosts, requestedPermissions: [] };
  } catch {
    // Frame records are a nicety; without them the cookie list is just first-party.
  }
  return null;
}

/**
 * One control, three states: Off (allowlisted), Basic (the shipped list) and Strict
 * (also block every third party this page starts). The two lists are kept disjoint
 * by removing any entry that covers the host before setting the new mode.
 */
async function setSiteMode(hostname, mode) {
  const host = normalizeHostname(hostname);
  if (!host) throw new TypeError("A hostname is required.");
  if (mode !== "off" && mode !== "basic" && mode !== "strict") throw new TypeError("Unknown site mode.");
  const settings = await settingsStore.load();
  const allowlist = toggleAllowlistEntry(settings.siteAllowlist, host, mode === "off");
  const strictSites = settings.strictSites.filter((entry) => !hostCoveredBy(host, [entry]));
  if (mode === "strict") strictSites.push(host);
  await blockingManager.setAllowlist(allowlist);
  await blockingManager.setStrictSites(strictSites);
  return settingsStore.save({ siteAllowlist: allowlist, strictSites });
}

async function currentSitePrivacy(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new TypeError("A valid tab ID is required.");
  const tab = await chrome.tabs.get(tabId);
  const hostname = hostnameFromUrl(tab?.url);
  if (!hostname) throw new TypeError("Only web pages have site privacy details.");
  const observation = await observationFor(tabId, hostname);
  const settings = await activeSettings();
  const cookies = await inspectSiteCookies(chrome.cookies, hostname, observation?.thirdPartyHosts ?? []);
  // Only what this site asked for, and only its live state: the stored names
  // were recorded at request time, the state is read from the page now.
  const requestedPermissions = normalizeRequestedPermissions(observation?.requestedPermissions ?? []);
  const permissionStates = normalizePermissionStates(
    await probeTabPermissionStates(chrome.tabs, tabId, requestedPermissions),
    requestedPermissions
  );
  const reported = Object.entries(permissionStates).filter(([, state]) => state && state !== "unavailable");
  const stored = await chrome.storage.local.get(BREACH_DATA_KEY);
  return {
    hostname,
    cookies,
    permissions: permissionStates,
    requestedPermissions,
    permissionStatesAvailable: reported.length > 0,
    blocking: await blockingCounter.summary(tabId),
    blockingEnabled: settings.blockingEnabled,
    // Matches the DNR allow rules (host plus registrable domain), so the popup and
    // the dashboard agree with what blocking actually does for this site.
    allowlisted: hostCoveredBy(hostname, settings.siteAllowlist),
    // Off beats strict: a site the reader allowlisted stays untouched even if it
    // was also marked strict. One function decides, so the popup cannot disagree
    // with the rules Chrome is running.
    siteMode: resolveSiteMode(hostname, settings),
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

/**
 * The compiled element-hiding rules are a few hundred kilobytes of JSON, so the
 * worker reads them once and answers each page with just its own selectors. A
 * page that fetched the whole map would pay for every other site's rules.
 */
let cosmeticDataset = null;
let cosmeticDatasetLoading = null;
let cosmeticDatasetFailed = false;

async function cosmeticRulesFor(url) {
  const hostname = hostnameFromUrl(url);
  if (!hostname) return { hostname: null, selectors: [] };
  if (!cosmeticDataset && !cosmeticDatasetLoading && !cosmeticDatasetFailed) {
    cosmeticDatasetLoading = fetch(chrome.runtime.getURL("data/cosmetic-rules.json"))
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)
      .then((data) => {
        cosmeticDataset = data;
        cosmeticDatasetLoading = null;
        // A missing or broken data file will not repair itself within this
        // worker's lifetime; retrying it on every page would only cost time.
        cosmeticDatasetFailed = data === null;
        return data;
      });
  }
  if (cosmeticDatasetLoading) await cosmeticDatasetLoading;
  return { hostname, selectors: hostSelectorsFor(cosmeticDataset, hostname) };
}

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
  if (message?.type === "webguard.cosmeticRules") {
    if (sender?.id !== chrome.runtime.id) return undefined;
    return cosmeticRulesFor(sender.url ?? sender.tab?.url);
  }
  const observation = validateSiteObservation(message, sender, chrome.runtime.id);
  if (observation) {
    await observationStore.save(observation);
    return { ok: true };
  }
  const permissionRequest = validatePermissionRequest(message, sender, chrome.runtime.id);
  if (permissionRequest) {
    await observationStore.recordPermissions(permissionRequest.hostname, permissionRequest.names);
    return { ok: true };
  }
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("")) || !message || typeof message !== "object") return undefined;
  if (message.type === "webguard.currentSitePrivacy") return currentSitePrivacy(message.tabId);
  if (message.type === "webguard.setBlockingEnabled") return blockingManager.setEnabled(message.enabled);
  if (message.type === "webguard.setAllowlist") return blockingManager.setAllowlist(message.hosts);
  if (message.type === "webguard.setSiteMode") return setSiteMode(message.hostname, message.mode);
  if (message.type === "webguard.toggleAllowlist") {
    const settings = await settingsStore.load();
    // Removal drops the registrable-domain entry that covers this host too, so the
    // button that says "Remove from allowlist" cannot silently do nothing.
    return blockingManager.setAllowlist(
      toggleAllowlistEntry(settings.siteAllowlist, message.hostname, message.allowlisted === true)
    );
  }
  if (message.type === "webguard.blockingSummary") return enrichBlockingSummary(await blockingCounter.summary(message.tabId ?? undefined));
  if (message.type === "webguard.refreshData") {
    await runAllDataSyncs({ force: true });
    return dashboardService.overview();
  }
  if (message.type === "webguard.breachInfo") return breachInfo(message.tabId);
  if (message.type === "webguard.suspiciousInfo") return suspiciousInfo(message.tabId);
  if (message.type === "webguard.rdapLookup" || message.type === "webguard.lookupDomain") {
    return rdapLookup({ tabId: message.tabId, hostname: message.hostname });
  }
  if (message.type === "webguard.dashboardOverview") return dashboardService.overview();
  if (message.type === "webguard.dashboardTargets") return dashboardService.targets();
  if (message.type === "webguard.siteReport") return dashboardService.siteReport({ hostname: message.hostname, tabId: message.tabId });
  if (message.type === "webguard.sitePermissions") return dashboardService.sitePermissions(message);
  if (message.type === "webguard.setPermission") {
    return setSitePermission(chrome.contentSettings, message.hostname, message.permission, message.setting, {
      storageArea: chrome.storage.local
    });
  }
  if (message.type === "webguard.updateSettings") return dashboardService.updateSettings(message.patch);
  if (message.type === "webguard.clearSiteCookies") return dashboardService.clearSiteCookies(message.hostname);
  if (message.type === "webguard.clearHistory") return dashboardService.clearHistory();
  if (message.type === "webguard.clearAllData") return dashboardService.clearAllData();
  return undefined;
});

/**
 * The worker starts for every page, and this used to run on each start: three
 * downloads plus a full reinstall of ~25,000 dynamic rules before the page could
 * be served. A fresh last-sync record now makes a worker wake cheap; the daily
 * alarm still forces a refresh so data cannot silently age out.
 */
async function runAllDataSyncs({ force = false } = {}) {
  let status = {};
  try {
    status = await dataSync.readSyncStatus();
  } catch {
    status = {};
  }
  const tasks = [];
  if (force || isSyncDue(status, "blocking")) tasks.push(dataSync.syncBlockingData());
  if (force || isSyncDue(status, "breach")) tasks.push(dataSync.syncBreachData());
  if (force || isSyncDue(status, "threat")) tasks.push(dataSync.syncThreatData());
  await Promise.all(tasks.map((task) => task.catch((error) => console.error("WebGuard data sync failed.", error))));
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === DATA_SYNC_ALARM) void runAllDataSyncs({ force: true });
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

// Earlier builds wrote "ask" rules for a site, which kept it prompting and
// outranked the reader's answer in Chrome's prompt. Release those rules once.
void ensurePermissionRulesVersion(chrome.contentSettings, chrome.storage.local).catch((error) => {
  console.error("WebGuard could not reset the previous permission rules.", error);
});

void chrome.alarms.create(DATA_SYNC_ALARM, { periodInMinutes: 1_440, persistAcrossSessions: true }).catch((error) => {
  console.error("WebGuard could not schedule data sync.", error);
});
void Promise.all([
  dataSync.seedBreachDataFromBundle().catch((error) => console.error("WebGuard could not seed bundled breach data.", error)),
  dataSync.seedThreatDataFromBundle().catch((error) => console.error("WebGuard could not seed bundled threat data.", error))
]).then(() => runAllDataSyncs());

void alarmManager.ensureHistoryPruneAlarm().catch((error) => {
  console.error("WebGuard could not schedule history cleanup.", error);
});

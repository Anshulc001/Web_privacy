import { hostnameFromUrl } from "./history-store.mjs";

/**
 * Asks one tab's content script for the page's current permission state. The
 * stored observation is written once at document_idle, so a permission the
 * reader granted afterwards would otherwise stay stale until a page reload.
 */
export async function probeTabPermissionStates(tabsApi, tabId, fallback = null) {
  if (!Number.isInteger(tabId) || tabId < 0) return fallback;
  try {
    const answer = await tabsApi.sendMessage(tabId, { type: "webguard.probePermissions" });
    const states = answer?.permissionStates;
    return states && typeof states === "object" ? states : fallback;
  } catch {
    // Restricted pages have no content script; the stored observation is all we get.
    return fallback;
  }
}

/** The first open tab whose page belongs to this host, or null. */
export async function findTabForHost(tabsApi, host) {
  try {
    const tabs = await tabsApi.query({});
    if (!Array.isArray(tabs)) return null;
    return tabs.find((tab) => Number.isInteger(tab?.id) && tab.id >= 0 && hostnameFromUrl(tab?.url) === host) ?? null;
  } catch {
    return null;
  }
}

/**
 * Probes an open tab for this host and returns both the tab (whose URL gives the
 * exact origin for a content-setting read) and the fresh permission states.
 */
export async function probePagePermissions(tabsApi, host, fallback = null) {
  const tab = await findTabForHost(tabsApi, host);
  if (!tab) return { tab: null, permissionStates: fallback };
  return { tab, permissionStates: await probeTabPermissionStates(tabsApi, tab.id, fallback) };
}

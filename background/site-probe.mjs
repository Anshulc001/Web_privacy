import { hostnameFromUrl } from "./history-store.mjs";

/**
 * Asks one tab's content script for the current state of the given permission
 * names. The names come from what the page itself requested, so the probe never
 * invents a permission the site never mentioned.
 */
export async function probeTabPermissionStates(tabsApi, tabId, names = []) {
  if (!Number.isInteger(tabId) || tabId < 0 || names.length === 0) return null;
  try {
    const answer = await tabsApi.sendMessage(tabId, { type: "webguard.probePermissions", names });
    const states = answer?.permissionStates;
    return states && typeof states === "object" ? states : null;
  } catch {
    // Restricted pages have no content script; the caller reports "unavailable".
    return null;
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
export async function probePagePermissions(tabsApi, host, names = []) {
  const tab = await findTabForHost(tabsApi, host);
  if (!tab) return { tab: null, permissionStates: null };
  return { tab, permissionStates: await probeTabPermissionStates(tabsApi, tab.id, names) };
}

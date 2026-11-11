import { hostnameFromUrl, normalizeHostname } from "./history-store.mjs";

/**
 * The four permissions the dashboard exposes, mapped from the page's permission
 * name to the chrome.contentSettings type. Geolocation is called "location" by
 * the browser API, which is the only name that differs.
 */
export const SITE_PERMISSION_TYPES = Object.freeze({
  camera: "camera",
  microphone: "microphone",
  geolocation: "location",
  notifications: "notifications"
});

export const SITE_PERMISSION_SETTINGS = Object.freeze(["allow", "ask", "block"]);

function normalizeSetting(value) {
  return value === "allow" || value === "block" ? value : "ask";
}

/**
 * Reads Chrome's own per-site setting for every exposed permission. These are
 * the persisted "allow / ask / block" values, not the transient granted/denied
 * state the page reported.
 */
export async function readSitePermissionSettings(contentSettings, hostname, { primaryUrl = null } = {}) {
  const host = normalizeHostname(hostname);
  const settings = {};
  if (!host) {
    return { status: "unavailable", reason: "A hostname is required.", hostname: null, settings };
  }
  if (!contentSettings) {
    return { status: "unavailable", reason: "Permission settings are unavailable.", hostname: host, settings };
  }
  // The page's own URL keeps the scheme and port Chrome used when it created the
  // exception; a synthetic https URL would miss an http site's rule.
  const url = typeof primaryUrl === "string" && hostnameFromUrl(primaryUrl) === host
    ? primaryUrl
    : `https://${host}/`;
  for (const [name, type] of Object.entries(SITE_PERMISSION_TYPES)) {
    try {
      const answer = await contentSettings[type].get({ primaryUrl: url });
      settings[name] = normalizeSetting(answer?.setting);
    } catch {
      settings[name] = "unavailable";
    }
  }
  return { status: "ok", hostname: host, settings };
}

/**
 * Applies one setting to one site. A wildcard scheme keeps http and https in a
 * single rule, so Chrome's per-site list does not gain a duplicate entry.
 */
export async function setSitePermission(contentSettings, hostname, permission, setting) {
  const host = normalizeHostname(hostname);
  if (!host) return { status: "unavailable", reason: "A hostname is required." };
  const type = SITE_PERMISSION_TYPES[permission];
  if (!type) return { status: "unavailable", reason: "Unknown permission." };
  if (!SITE_PERMISSION_SETTINGS.includes(setting)) {
    return { status: "unavailable", reason: "Setting must be allow, ask or block." };
  }
  if (!contentSettings?.[type]) {
    return { status: "unavailable", reason: "Permission settings are unavailable." };
  }
  try {
    await contentSettings[type].set({ primaryPattern: `*://${host}/*`, setting });
    return { status: "ok", hostname: host, permission, setting };
  } catch (error) {
    return { status: "unavailable", reason: String(error?.message ?? error) };
  }
}

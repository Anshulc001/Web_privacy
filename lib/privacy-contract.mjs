import { IANA_BOOTSTRAP_URL, RDAP_AGGREGATOR_BASE, RDAP_BASE_BY_TLD } from "./domain-info.mjs";
import { DATA_URL_BASE } from "./storage-settings.mjs";

/**
 * The complete outbound network surface of the extension, in one place.
 *
 * `tests/privacy-contract.test.mjs` fails when a shipped file starts using a
 * network primitive that is not declared here, or when a hardcoded host is not
 * part of a declared endpoint. `dashboard.js` renders this list in Settings, so
 * the promise in the README and the panel can never drift from the code.
 */

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function hostsOf(urls) {
  return [...new Set(urls.map(hostOf).filter(Boolean))].sort();
}

export const OUTBOUND_ENDPOINTS = Object.freeze([
  {
    id: "lists",
    label: "Blocklist downloads",
    hosts: hostsOf([DATA_URL_BASE]),
    when: "At most once a day, and on the first run after install.",
    detail: "Downloads the public ad/tracker, breach and phishing lists from the project's GitHub repository. No identifier, account or page data is sent."
  },
  {
    id: "rdap",
    label: "Registry lookups (RDAP)",
    hosts: hostsOf([IANA_BOOTSTRAP_URL, ...Object.values(RDAP_BASE_BY_TLD), RDAP_AGGREGATOR_BASE]),
    when: "For the site you select in the dashboard, automatically or when you press the button.",
    detail: "Sends that site's hostname (never the page URL) to the domain's public registry, or to rdap.org when the registry publishes no RDAP service."
  }
]);

/**
 * Hosts that appear only as attribution links in the UI. The extension never
 * requests them; a reader may click one to open it in a normal tab.
 */
export const DISPLAYED_LINK_HOSTS = Object.freeze([
  "github.com",
  "haveibeenpwned.com",
  "monitor.mozilla.org",
  "passwords.google.com",
  "www.malwarebytes.com",
  "xposedornot.com"
]);

/** Files allowed to make an outbound request, and which endpoint they use. */
export const NETWORK_FILES = Object.freeze({
  "background/data-sync.mjs": ["lists"],
  // Downloads the IANA RDAP bootstrap, then the registry answers itself come
  // from lib/domain-info.mjs.
  "background/service-worker.js": ["rdap"],
  "lib/domain-info.mjs": ["rdap"]
});

/** Every permission the extension asks for, with the reason it needs it. */
export const PRIVACY_PERMISSIONS = Object.freeze([
  { name: "storage", why: "Keeps settings, hostnames, counts and cached answers on this device." },
  { name: "alarms", why: "Schedules the daily blocklist download." },
  { name: "webNavigation", why: "Records which site a tab is showing, so counts and the dashboard site list belong to the right site." },
  { name: "scripting", why: "Reads permission states and third-party hosts for the current page." },
  { name: "activeTab", why: "Acts on the page in the tab you are viewing when the popup asks." },
  { name: "cookies", why: "Lists and clears the current site's cookies. Cookie values are never read." },
  { name: "declarativeNetRequest", why: "Blocks ad and tracker requests from the bundled ruleset." },
  { name: "webRequest", why: "Counts requests the browser blocked; it cannot read their content." },
  { name: "contentSettings", why: "Reads and changes this site's camera, microphone, location and notification setting when you use the Permissions control." }
]);

/** What is stored locally. Retention is applied to visit records and counts only. */
export const STORED_DATA = Object.freeze([
  { label: "Settings", detail: "Retention, the blocking switch, the automatic-lookup switch and your allowlist." },
  { label: "Visit records", detail: "Hostnames only, with a day key, used to list the sites visited in the selected frame and to show visit totals. Never full URLs, query strings or page content; pruned after the retention window." },
  { label: "Blocked counts", detail: "How many requests were blocked per site, day and tracker host. Hostnames only." },
  { label: "Site observations", detail: "The four permission states and third-party hostnames for the current tab." },
  { label: "Site permission rules", detail: "Allow, Ask or Block for this site's camera, microphone, location and notifications, stored by Chrome in its own per-site settings." },
  { label: "Registry cache", detail: "The last RDAP answers, plus the public IANA bootstrap file, so a repeat lookup does not ask again." },
  { label: "Downloaded lists", detail: "The public blocklist, breach and phishing data, and when each was last synced." }
]);

/** Network primitives the privacy test looks for in shipped code. */
export const NETWORK_PRIMITIVES = Object.freeze([
  "fetch(",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "sendBeacon",
  "importScripts("
]);

/** A fetch of a bundled file never leaves the device. */
export const LOCAL_FETCH_PATTERN = /chrome\.runtime\.getURL|import\.meta\.url|new URL\(`\.\.\/data\//;

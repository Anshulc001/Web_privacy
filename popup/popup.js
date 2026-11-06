import { formatCount } from "../lib/format.mjs";

const status = document.getElementById("status");
const cookieTotal = document.getElementById("cookie-total");
const cookieUnit = document.getElementById("cookie-unit");
const cookieEmpty = document.getElementById("cookie-empty");
const cookieSummary = document.getElementById("cookie-summary");
const cookiesPanel = document.getElementById("cookies-panel");
const seeCookies = document.getElementById("see-cookies");
const cookiesList = document.getElementById("cookies");
const cookieMore = document.getElementById("cookie-more");
const permissionsSection = document.getElementById("permissions-heading").parentElement;
const permissionsList = document.getElementById("permissions");
const blockingToggle = document.getElementById("blocking-toggle");
const allowlistToggle = document.getElementById("allowlist-toggle");
const tabCount = document.getElementById("tab-count");
const heroFigure = document.querySelector(".hero-figure");
const heroCard = document.getElementById("hero");
const blockSub = document.getElementById("block-sub");
const breachCard = document.getElementById("breach-card");
const breachChip = document.getElementById("breach-chip");
const seeBlocked = document.getElementById("see-blocked");
const blockedPanel = document.getElementById("blocked-panel");
const blockedList = document.getElementById("blocked-list");
const blockedSource = document.getElementById("blocked-source");

const PERMISSION_LABELS = {
  camera: "Camera",
  microphone: "Microphone",
  geolocation: "Location",
  notifications: "Notifications"
};

// A popup is 320px wide, so a long cookie list would be a scroll wall. The
// dashboard shows the complete list.
const MAX_COOKIE_ROWS = 8;

// The popup for the tab it is showing. Clicking a control reloads the details, so
// keep the last report and let the controls act from it.
let current = null;
// Only the newest load may paint, otherwise two loads started close together both
// append rows and the lists end up duplicated.
let loadToken = 0;
// The cookie list is collapsed behind its count, like the blocked-request list.
let cookiesOpen = false;

function addListItem(list, value) {
  const item = document.createElement("li");
  item.textContent = value;
  list.append(item);
}

function render(details, summary) {
  status.textContent = `Current site: ${details.hostname}`;
  heroFigure.hidden = details.blocking === undefined;
  heroCard.hidden = details.blocking === undefined;
  blockSub.hidden = details.blocking === undefined;

  const blocking = details.blocking ?? { tab: 0, today: 0 };
  const tabTotal = Number.isFinite(blocking.tab) ? blocking.tab : 0;
  tabCount.textContent = formatCount(tabTotal);
  tabCount.title = `${tabTotal} blocked request(s) on this page`;

  blockingToggle.hidden = false;
  blockingToggle.textContent = details.blockingEnabled ? "WebGuard on" : "WebGuard off";
  blockingToggle.setAttribute("aria-pressed", String(Boolean(details.blockingEnabled)));
  blockingToggle.classList.toggle("on", Boolean(details.blockingEnabled));
  blockingToggle.classList.toggle("off", !details.blockingEnabled);

  allowlistToggle.hidden = false;
  allowlistToggle.textContent = details.allowlisted ? "Remove from allowlist" : "Allowlist this site";

  renderBlocked(summary);
  renderBreach(details.breach);
  renderCookies(details.cookies);
  renderPermissions(details);
}

function renderBlocked(summary) {
  // Not summary.topHosts: that is the browser-wide top ten, while the number
  // above counts this page only. Two different scopes for one panel was the bug.
  const hosts = Array.isArray(summary?.tabHosts) ? summary.tabHosts : [];
  const total = Number.isFinite(summary?.tab) ? summary.tab : 0;
  const sources = hosts.length;
  blockSub.textContent = total === 0
    ? "No requests blocked on this page yet"
    : `blocked requests from ${sources} source${sources === 1 ? "" : "s"} on this page`;

  blockedList.textContent = "";
  if (hosts.length === 0) {
    addListItem(blockedList, "No requests have been blocked on this page yet.");
    blockedSource.textContent = "Counts cover this page only. Page URLs are never stored.";
    return;
  }

  for (const entry of hosts) {
    const host = entry?.host;
    const count = entry?.count;
    if (typeof host !== "string" || !host) continue;
    const item = document.createElement("li");
    item.className = "blocked-row";

    const name = document.createElement("span");
    name.className = "blocked-host";
    name.textContent = host;
    const badge = document.createElement("span");
    badge.className = "blocked-count";
    badge.textContent = formatCount(Number.isFinite(count) ? count : 0);
    badge.title = `${Number.isFinite(count) ? count : 0} blocked request(s)`;

    item.append(name, badge);
    blockedList.append(item);
  }

  blockedSource.textContent = "Every source blocked on this page, most frequent first; the counts add up to the number above. Not a full request log, and page URLs are never stored.";
}

/** Breaches are a dashboard topic; the popup only advertises a match. */
function renderBreach(breach) {
  if (!breach || breach.status !== "match" || !Array.isArray(breach.matches) || breach.matches.length === 0) {
    breachCard.hidden = true;
    breachChip.textContent = "";
    return;
  }
  const count = breach.matches.length;
  breachCard.hidden = false;
  breachChip.textContent = `⚠ ${count} known breach${count === 1 ? "" : "es"} for this site — view in Dashboard`;
}

function setCookiesOpen(open) {
  cookiesOpen = open;
  cookiesPanel.hidden = !open;
  seeCookies.textContent = open ? "Hide cookies" : "See cookies";
  seeCookies.setAttribute("aria-expanded", String(open));
}

function renderCookies(cookies) {
  const list = Array.isArray(cookies) ? cookies : [];
  cookiesList.textContent = "";
  cookieSummary.textContent = "";
  cookieEmpty.hidden = true;
  cookieEmpty.textContent = "";
  cookieMore.hidden = true;

  if (list.length === 0) {
    cookieTotal.hidden = true;
    cookieUnit.hidden = true;
    seeCookies.hidden = true;
    setCookiesOpen(false);
    cookieEmpty.hidden = false;
    cookieEmpty.textContent = "No cookies stored by this site in your browser.";
    return;
  }

  cookieTotal.hidden = false;
  cookieUnit.hidden = false;
  cookieTotal.textContent = String(list.length);
  cookieUnit.textContent = list.length === 1 ? "cookie" : "cookies";
  seeCookies.hidden = false;

  const firstParty = list.filter((cookie) => cookie.party === "first-party").length;
  const thirdParty = list.length - firstParty;
  const persistent = list.filter((cookie) => cookie.expiry !== "Session").length;
  cookieSummary.textContent = `This site is saving ${list.length} cookie${list.length === 1 ? "" : "s"} on your device: ${firstParty} set by the site itself${thirdParty ? `, ${thirdParty} set by other companies` : ""}. ${persistent ? `${persistent} ${persistent === 1 ? "stays" : "stay"} after you close the browser.` : "They are removed when you close the browser."}`;

  for (const cookie of list.slice(0, MAX_COOKIE_ROWS)) {
    addListItem(cookiesList, describeCookie(cookie));
  }
  if (list.length > MAX_COOKIE_ROWS) {
    cookieMore.hidden = false;
    cookieMore.textContent = `View ${list.length - MAX_COOKIE_ROWS} more in Dashboard`;
  }

  setCookiesOpen(cookiesOpen);
}

function describeCookie(cookie) {
  const owner = cookie.party === "first-party"
    ? "set by this site"
    : "set by another company";
  const lifetime = cookie.expiry === "Session"
    ? "removed when you close the browser"
    : `kept until ${String(cookie.expiry).slice(0, 10)}`;
  const flags = [
    cookie.secure ? "only sent over secure connections" : "can be sent over plain connections",
    cookie.httpOnly ? "hidden from page scripts" : "readable by page scripts"
  ];
  return `${cookie.name} (${cookie.domain}) — ${owner}; ${lifetime}; ${flags.join("; ")}.`;
}

function renderPermissions(details) {
  permissionsSection.hidden = false;
  permissionsList.textContent = "";

  if (!details.permissionStatesAvailable) {
    addListItem(permissionsList, "Permission details are unavailable on this page.");
    return;
  }

  const granted = Object.entries(details.permissions ?? {}).filter(([, state]) => state === "granted");
  if (granted.length === 0) {
    addListItem(permissionsList, "No permission granted.");
    return;
  }

  for (const [name] of granted) {
    const label = PERMISSION_LABELS[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
    addListItem(permissionsList, `${label} — this site can use it right now.`);
  }
}

function openDashboard(hash = "") {
  return chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard/dashboard.html${hash}`) });
}

async function loadCurrentSite() {
  const token = ++loadToken;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const details = await chrome.runtime.sendMessage({ type: "webguard.currentSitePrivacy", tabId: tab?.id });
    const summary = (await chrome.runtime.sendMessage({ type: "webguard.blockingSummary", tabId: tab?.id })) ?? {};
    if (token !== loadToken) return;
    current = details;
    render(details, summary);
  } catch (error) {
    if (token !== loadToken) return;
    current = null;
    tabCount.textContent = "–";
    heroFigure.hidden = true;
    heroCard.hidden = true;
    blockSub.hidden = true;
    blockSub.textContent = "";
    status.textContent = "Current-site privacy details are unavailable.";
    blockingToggle.hidden = true;
    allowlistToggle.hidden = true;
    cookiesList.textContent = "";
    cookieSummary.textContent = "";
    cookieTotal.hidden = true;
    cookieUnit.hidden = true;
    seeCookies.hidden = true;
    cookieMore.hidden = true;
    setCookiesOpen(false);
    cookieEmpty.hidden = false;
    cookieEmpty.textContent = "Cookie details are unavailable on this page.";
    permissionsList.textContent = "";
    permissionsSection.hidden = false;
    breachCard.hidden = true;
    addListItem(permissionsList, "Permission details are unavailable on this page.");
    console.error("WebGuard popup could not load site details.", error);
  }
}

function setBlockedOpen(open) {
  blockedPanel.hidden = !open;
  seeBlocked.textContent = open ? "Hide blocked requests" : "See blocked requests";
  seeBlocked.setAttribute("aria-expanded", String(open));
}

seeBlocked.addEventListener("click", () => {
  setBlockedOpen(blockedPanel.hidden);
});

seeCookies.addEventListener("click", () => {
  setCookiesOpen(cookiesPanel.hidden);
});

breachChip.addEventListener("click", () => {
  void openDashboard("#breach");
});

cookieMore.addEventListener("click", () => {
  void openDashboard("#cookies");
});

blockingToggle.addEventListener("click", async () => {
  if (!current) return;
  await chrome.runtime.sendMessage({ type: "webguard.setBlockingEnabled", enabled: !current.blockingEnabled });
  await loadCurrentSite();
});

allowlistToggle.addEventListener("click", async () => {
  if (!current) return;
  await chrome.runtime.sendMessage({ type: "webguard.toggleAllowlist", hostname: current.hostname, allowlisted: !current.allowlisted });
  await loadCurrentSite();
});

document.getElementById("open-dashboard").addEventListener("click", () => {
  void openDashboard();
});

// Counts, the allowlist and blocking state change while the popup is open (a
// page keeps loading in the background), so re-read them instead of going stale.
let reloadTimer = null;
chrome.storage.onChanged.addListener(() => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    void loadCurrentSite();
  }, 250);
});

void loadCurrentSite();

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    window.close();
  }
});

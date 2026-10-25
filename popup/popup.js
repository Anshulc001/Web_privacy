const status = document.getElementById("status");
const cookieTotal = document.getElementById("cookie-total");
const cookieUnit = document.getElementById("cookie-unit");
const cookieEmpty = document.getElementById("cookie-empty");
const cookieSummary = document.getElementById("cookie-summary");
const cookiesPanel = document.getElementById("cookies-panel");
const seeCookies = document.getElementById("see-cookies");
const cookiesList = document.getElementById("cookies");
const permissionsSection = document.getElementById("permissions-heading").parentElement;
const permissionsList = document.getElementById("permissions");
const blockingToggle = document.getElementById("blocking-toggle");
const allowlistToggle = document.getElementById("allowlist-toggle");
const tabCount = document.getElementById("tab-count");
const heroFigure = document.querySelector(".hero-figure");
const heroCard = document.getElementById("hero");
const breachSection = document.getElementById("breach-heading").parentElement;
const breachSummary = document.getElementById("breach-summary");
const breachList = document.getElementById("breach-list");
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

// The popup for the tab it is showing. Clicking a control reloads the details, so
// keep the last report and let the controls act from it.
let current = null;
// Only the newest load may paint, otherwise two loads started close together both
// append rows and the lists end up duplicated.
let loadToken = 0;
// The cookie list is collapsed behind its count, like the blocked-ad list.
let cookiesOpen = false;

function addListItem(list, value) {
  const item = document.createElement("li");
  item.textContent = value;
  list.append(item);
}

function render(details, summary, breach) {
  status.textContent = `Current site: ${details.hostname}`;
  heroFigure.hidden = details.blocking === undefined;
  heroCard.hidden = details.blocking === undefined;

  const blocking = details.blocking ?? { tab: 0, today: 0 };
  tabCount.textContent = String(blocking.tab ?? 0);

  blockingToggle.hidden = false;
  blockingToggle.textContent = details.blockingEnabled ? "WebGuard on" : "WebGuard off";
  blockingToggle.setAttribute("aria-pressed", String(Boolean(details.blockingEnabled)));
  blockingToggle.classList.toggle("on", Boolean(details.blockingEnabled));
  blockingToggle.classList.toggle("off", !details.blockingEnabled);

  allowlistToggle.hidden = false;
  allowlistToggle.textContent = details.allowlisted ? "Remove from allowlist" : "Allowlist this site";

  renderBlocked(summary);
  renderCookies(details.cookies);
  renderPermissions(details);

  if (details.breach && details.breach.status === "match") {
    breachSection.hidden = false;
    breachSummary.textContent = `This site appeared in ${details.breach.matches.length} known breach(es) (matched ${details.breach.matchedDomain}).`;
    breachList.textContent = "";
    for (const match of details.breach.matches) {
      const flags = match.flagLabels && match.flagLabels.length ? ` [${match.flagLabels.join(", ")}]` : "";
      addListItem(breachList, `${match.title} — ${match.breachDate ?? "date unknown"}, ${match.pwnCount ?? "?"} records${flags}. ${match.description}`);
    }
  } else if (details.breach && details.breach.status === "not-found") {
    breachSection.hidden = false;
    breachSummary.textContent = "This site was not found in the breach list. That is not proof it was never breached.";
    breachList.textContent = "";
  } else if (details.breach && details.breach.status === "unavailable") {
    breachSection.hidden = false;
    breachSummary.textContent = `Breach data is unavailable${details.breach.reason ? `: ${details.breach.reason}` : "."}`;
    breachList.textContent = "";
  } else {
    breachSection.hidden = true;
  }
}

function renderBlocked(summary) {
  const hosts = Array.isArray(summary?.topHosts) ? summary.topHosts : [];
  blockedList.textContent = "";
  if (hosts.length === 0) {
    addListItem(blockedList, "No ads or trackers have been blocked yet.");
    blockedSource.textContent = "When WebGuard blocks an ad or tracker request, the host will show up here.";
    return;
  }

  for (const entry of hosts) {
    const host = Array.isArray(entry) ? entry[0] : entry?.host;
    const count = Array.isArray(entry) ? entry[1] : entry?.count;
    if (typeof host !== "string" || !host) continue;
    const item = document.createElement("li");
    item.className = "blocked-row";

    const name = document.createElement("span");
    name.className = "blocked-host";
    name.textContent = host;
    const badge = document.createElement("span");
    badge.className = "blocked-count";
    badge.textContent = String(Number.isFinite(count) ? count : 0);
    badge.title = `${badge.textContent} blocked request(s)`;

    item.append(name, badge);
    blockedList.append(item);
  }

  blockedSource.textContent = "Host-level block counts recorded in this browser, most frequent first. Not a full request log, and page URLs are never stored.";
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

  for (const cookie of list) {
    addListItem(cookiesList, describeCookie(cookie));
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

async function loadCurrentSite() {
  const token = ++loadToken;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const details = await chrome.runtime.sendMessage({ type: "webguard.currentSitePrivacy", tabId: tab?.id });
    const breach = (await chrome.runtime.sendMessage({ type: "webguard.breachInfo", tabId: tab?.id })) ?? null;
    const summary = (await chrome.runtime.sendMessage({ type: "webguard.blockingSummary", tabId: tab?.id })) ?? {};
    if (token !== loadToken) return;
    current = details;
    render(details, summary, breach);
  } catch (error) {
    if (token !== loadToken) return;
    current = null;
    tabCount.textContent = "–";
    heroFigure.hidden = true;
    heroCard.hidden = true;
    status.textContent = "Current-site privacy details are unavailable.";
    blockingToggle.hidden = true;
    allowlistToggle.hidden = true;
    cookiesList.textContent = "";
    cookieSummary.textContent = "";
    cookieTotal.hidden = true;
    cookieUnit.hidden = true;
    seeCookies.hidden = true;
    setCookiesOpen(false);
    cookieEmpty.hidden = false;
    cookieEmpty.textContent = "Cookie details are unavailable on this page.";
    permissionsList.textContent = "";
    permissionsSection.hidden = false;
    breachList.textContent = "";
    breachSection.hidden = true;
    addListItem(permissionsList, "Permission details are unavailable on this page.");
    console.error("WebGuard popup could not load site details.", error);
  }
}

function setBlockedOpen(open) {
  blockedPanel.hidden = !open;
  seeBlocked.textContent = open ? "Hide blocked ads" : "See blocked ads";
  seeBlocked.setAttribute("aria-expanded", String(open));
}

seeBlocked.addEventListener("click", () => {
  setBlockedOpen(blockedPanel.hidden);
});

seeCookies.addEventListener("click", () => {
  setCookiesOpen(cookiesPanel.hidden);
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

document.getElementById("open-dashboard").addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
});

void loadCurrentSite();

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    window.close();
  }
});

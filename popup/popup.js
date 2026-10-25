const status = document.getElementById("status");
const cookiesList = document.getElementById("cookies");
const permissionsSection = document.getElementById("permissions-heading").parentElement;
const permissionsList = document.getElementById("permissions");
const alerts = document.getElementById("permission-alerts");
const expectedButton = document.getElementById("expected-site");
const blockingStatus = document.getElementById("blocking-status");
const blockingData = document.getElementById("blocking-data");
const blockingTopHosts = document.getElementById("blocking-top-hosts");
const blockingToggle = document.getElementById("blocking-toggle");
const allowlistToggle = document.getElementById("allowlist-toggle");
const tabCount = document.getElementById("tab-count");
const heroFigure = document.querySelector(".hero-figure");
const heroCard = document.getElementById("hero");const breachSection = document.getElementById("breach-heading").parentElement;
const breachSummary = document.getElementById("breach-summary");
const breachList = document.getElementById("breach-list");
const blockedSection = document.getElementById("blocked-heading").parentElement;
const blockedSummary = document.getElementById("blocked-summary");
const blockedList = document.getElementById("blocked-list");
const blockedSource = document.getElementById("blocked-source");

// The popup for the tab it is showing. Clicking a control reloads the details, so
// keep the last report and let the controls act from it.
let current = null;
// Only the newest load may paint, otherwise two loads started close together both
// append rows and the lists end up duplicated.
let loadToken = 0;

function addListItem(list, value) {
  const item = document.createElement("li");
  item.textContent = value;
  list.append(item);
}

function render(details, summary, breach, blockedForSite) {
  status.textContent = `Current site: ${details.hostname}`;
  heroFigure.hidden = details.blocking === undefined;
  heroCard.hidden = details.blocking === undefined;

  const blocking = details.blocking ?? { tab: 0, today: 0 };
  tabCount.textContent = String(blocking.tab ?? 0);
  blockingStatus.textContent = `Blocking ${details.blockingEnabled ? "on" : "off"}; this tab: ${blocking.tab}; today: ${blocking.today}.`;
  blockingToggle.hidden = false;
  blockingToggle.textContent = details.blockingEnabled ? "Turn blocking off" : "Turn blocking on";
  allowlistToggle.hidden = false;
  allowlistToggle.textContent = details.allowlisted ? "Remove this site from allowlist" : "Allowlist this site";

  const lastSync = summary.blockingDataLastSync;
  if (lastSync && typeof lastSync === "string") {
    const ageDays = Math.floor((Date.now() - new Date(lastSync).getTime()) / 86400000);
    blockingData.textContent = `Blocklist data: ${ageDays === 0 ? "today" : ageDays + " day" + (ageDays === 1 ? "" : "s") + " old."}`;
  } else if (summary.status === "outdated") {
    blockingData.textContent = "Blocklist data: outdated. Still blocking with last known list.";
  } else {
    blockingData.textContent = "Blocklist data: unavailable.";
  }

  const topHosts = Array.isArray(summary.topHosts) ? summary.topHosts : [];
  blockingTopHosts.textContent = topHosts.length
    ? `Top blocked: ${topHosts.slice(0, 3).map((h) => h[0]).join(", ")}${topHosts.length > 3 ? ", +" + (topHosts.length - 3) + " more" : ""}.`
    : "Top blocked: none yet.";

  if (details.cookies.length === 0) {
    cookiesList.textContent = "No cookies detected for this site.";
  } else {
    cookiesList.textContent = "";
    for (const cookie of details.cookies) {
      addListItem(cookiesList, `${cookie.name} — ${cookie.domain}; ${cookie.party}; ${cookie.expiry}; Secure: ${cookie.secure}; HttpOnly: ${cookie.httpOnly}; SameSite: ${cookie.sameSite}`);
    }
  }

  if (details.permissionStatesAvailable && details.permissions && Object.keys(details.permissions).length > 0) {
    permissionsSection.hidden = false;
    permissionsList.textContent = "";
    for (const [name, state] of Object.entries(details.permissions)) addListItem(permissionsList, `${name}: ${state}`);
    alerts.textContent = details.permissionAlerts.length
      ? details.permissionAlerts.map((alert) => alert.message).join(" ")
      : "No unusual permission pattern detected. This is not a safety verdict.";
    expectedButton.hidden = false;
    expectedButton.textContent = details.expected ? "Mark site as not expected" : "Mark site as expected";
  } else {
    permissionsSection.hidden = true;
  }

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
    breachList.textContent = "";  } else {
    breachSection.hidden = true;
  }
}

async function loadCurrentSite() {
  const token = ++loadToken;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const details = await chrome.runtime.sendMessage({ type: "webguard.currentSitePrivacy", tabId: tab?.id });
    const breach = (await chrome.runtime.sendMessage({ type: "webguard.breachInfo", tabId: tab?.id })) ?? null;
    const summary = (await chrome.runtime.sendMessage({ type: "webguard.blockingSummary", tabId: tab?.id })) ?? {};
    const blockedForSite = (await chrome.runtime.sendMessage({ type: "webguard.blockedForSite", hostname: details.hostname })) ?? null;
    if (token !== loadToken) return;
    current = details;
    render(details, summary, breach, blockedForSite);
    renderBlocked(blockedForSite);
  } catch (error) {
    if (token !== loadToken) return;
    current = null;
    tabCount.textContent = "–";
    heroFigure.hidden = true;
    heroCard.hidden = true;
    status.textContent = "Current-site privacy details are unavailable.";
    cookiesList.textContent = "";
    permissionsList.textContent = "";
    blockedList.textContent = "";
    blockedSection.hidden = true;
    blockedSource.textContent = "";
    addListItem(cookiesList, "Cookie details are unavailable on this page.");
    addListItem(permissionsList, "Permission details are unavailable on this page.");
    alerts.textContent = "";
    console.error("WebGuard popup could not load site details.", error);
  }
}

function renderBlocked(blockedForSite) {
  if (blockedForSite && blockedForSite.status === "ok" && blockedForSite.items.length > 0) {
    blockedSection.hidden = false;
    blockedSummary.textContent = `WebGuard blocked ${blockedForSite.items.length} tracker/ad host observation(s) while this site was open. Host-level observations, not a full request log.`;
    blockedList.textContent = "";
    for (const item of blockedForSite.items) {
      addListItem(blockedList, item.host ? `${item.host} — ${item.count ?? 0} block(s)` : String(item));
    }
    blockedSource.textContent = "Blocked items come from the host-level blocklist the extension ships and from third-party hosts it observed on this site. No page request paths are stored.";
  } else if (blockedForSite && blockedForSite.status === "empty") {
    blockedSection.hidden = false;
    blockedSummary.textContent = "No tracker or ad hosts have been blocked while this site was open yet.";
    blockedList.textContent = "";
    blockedSource.textContent = "When this site loads ad or tracker hosts, they will show up here.";
  } else {
    blockedSection.hidden = true;
  }
}

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

expectedButton.addEventListener("click", async () => {
  if (!current) return;
  await chrome.runtime.sendMessage({ type: "webguard.setExpectedSite", hostname: current.hostname, expected: !current.expected });
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

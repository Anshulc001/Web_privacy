const status = document.getElementById("status");
const cookiesList = document.getElementById("cookies");
const permissionsList = document.getElementById("permissions");
const alerts = document.getElementById("permission-alerts");
const expectedButton = document.getElementById("expected-site");
const blockingStatus = document.getElementById("blocking-status");
const blockingData = document.getElementById("blocking-data");
const blockingTopHosts = document.getElementById("blocking-top-hosts");
const blockingToggle = document.getElementById("blocking-toggle");
const allowlistToggle = document.getElementById("allowlist-toggle");

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

function render(details, summary) {
  status.textContent = `Current site: ${details.hostname}`;

  const blocking = details.blocking ?? { tab: 0, today: 0 };
  blockingStatus.textContent = `Blocking ${details.blockingEnabled ? "on" : "off"}; this tab: ${blocking.tab}; today: ${blocking.today}.`;
  blockingToggle.hidden = false;
  blockingToggle.textContent = details.blockingEnabled ? "Turn blocking off" : "Turn blocking on";

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

  allowlistToggle.hidden = false;
  allowlistToggle.textContent = details.allowlisted ? "Remove this site from allowlist" : "Allowlist this site";

  cookiesList.textContent = "";
  if (details.cookies.length === 0) addListItem(cookiesList, "0 cookies");
  for (const cookie of details.cookies) {
    addListItem(cookiesList, `${cookie.name} — ${cookie.domain}; ${cookie.party}; ${cookie.expiry}; Secure: ${cookie.secure}; HttpOnly: ${cookie.httpOnly}; SameSite: ${cookie.sameSite}`);
  }

  permissionsList.textContent = "";
  for (const [name, state] of Object.entries(details.permissions)) addListItem(permissionsList, `${name}: ${state}`);
  alerts.textContent = details.permissionAlerts.length
    ? details.permissionAlerts.map((alert) => alert.message).join(" ")
    : "No heuristic permission alert. This is not a safety verdict.";

  expectedButton.hidden = false;
  expectedButton.textContent = details.expected ? "Mark site as not expected" : "Mark site as expected";
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
    status.textContent = "Current-site privacy details are unavailable.";
    // Say so inside each section too, otherwise two headings sit over empty space
    // and it looks like a rendering bug rather than a browser-restricted page.
    cookiesList.textContent = "";
    permissionsList.textContent = "";
    addListItem(cookiesList, "Cookie details are unavailable on this page.");
    addListItem(permissionsList, "Permission details are unavailable on this page.");
    alerts.textContent = "";
    console.error("WebGuard popup could not load site details.", error);
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

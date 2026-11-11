/**
 * Permission state is read for exactly the names the worker asks about. The
 * worker knows them because content/permission-observer.js reports what the
 * site actually requested, so a permission WebGuard has never heard of still
 * gets a row and an honest state.
 */
async function permissionStates(names) {
  const states = {};
  for (const name of Array.isArray(names) ? names : []) {
    if (typeof name !== "string" || !name) continue;
    try {
      const result = await navigator.permissions.query({ name });
      states[name] = ["granted", "denied", "prompt"].includes(result.state) ? result.state : "unavailable";
    } catch {
      states[name] = "unavailable";
    }
  }
  return states;
}

function thirdPartyHosts() {
  const ownHost = location.hostname.toLowerCase();
  const hosts = new Set();
  for (const entry of performance.getEntriesByType("resource").slice(0, 500)) {
    try {
      const host = new URL(entry.name).hostname.toLowerCase();
      if (host && host !== ownHost) hosts.add(host);
    } catch { /* Ignore malformed resource URLs. */ }
    if (hosts.size >= 100) break;
  }
  return [...hosts];
}

// The popup and dashboard ask for a fresh read when they open, because a
// permission granted after document_idle must not look stuck on "prompt".
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "webguard.probePermissions") return false;
  permissionStates(message.names)
    .then((states) => sendResponse({ permissionStates: states }))
    .catch(() => sendResponse({ permissionStates: null }));
  return true;
});

void (async () => {
  try {
    await chrome.runtime.sendMessage({
      type: "webguard.siteObservation",
      thirdPartyHosts: thirdPartyHosts()
    });
  } catch (error) {
    console.warn("WebGuard could not send the page observation.", error);
  }
})();

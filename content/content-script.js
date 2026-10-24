const PERMISSIONS = ["camera", "microphone", "geolocation", "notifications"];

async function permissionStates() {
  const states = {};
  for (const name of PERMISSIONS) {
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

void (async () => {
  try {
    await chrome.runtime.sendMessage({
      type: "webguard.siteObservation",
      permissionStates: await permissionStates(),
      thirdPartyHosts: thirdPartyHosts()
    });
  } catch (error) {
    console.warn("WebGuard could not send the page observation.", error);
  }
})();

/**
 * Isolated-world half of the permission request observer. It runs at
 * document_start so no request made by an early page script is missed, then
 * forwards each newly seen permission name to the worker, which records it
 * against the site. Names are only labels: the state shown in the dashboard is
 * always read back from Chrome, so a page that fabricates a name can add a row
 * but cannot fake a grant.
 */
const seen = new Set();

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.__webguard !== "permissionRequest" || !Array.isArray(data.names)) return;
  const fresh = data.names.filter((name) => typeof name === "string" && name.length > 0 && !seen.has(name));
  if (fresh.length === 0) return;
  for (const name of fresh) seen.add(name);
  try {
    chrome.runtime.sendMessage({ type: "webguard.permissionRequested", names: fresh })
      .catch(() => {});
  } catch {
    // The worker may be gone; the next navigation reports again.
  }
});

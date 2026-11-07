// Cosmetic filtering: hides standard ad containers and the frames a blocked ad
// network would have filled, so a page does not keep their empty space.
//
// This runs at document_start rather than on the usual idle pass, because an ad
// slot that is hidden after the page paints is still an ad slot the user saw
// flash. The rules themselves live in lib/cosmetic-rules.mjs so the background,
// this script and the tests share one definition.

// Wake the service worker before the parser dispatches the page's first
// subresource. Chrome starts an MV3 worker lazily, and a worker that starts on
// the first blocked request is already too late for the ones in flight: they
// never reach its webRequest listener, so the page's count begins at zero.
try {
  void chrome.runtime.sendMessage({ type: "webguard.ping" })?.catch(() => {});
} catch {
  // An extension that was just reloaded has no worker to reach; the filter below
  // still has to run, so a failed wake-up is never fatal here.
}

const STYLE_ID = "webguard-cosmetic-filter";
const SETTINGS_KEY = "settings";

let rules = null;

async function loadRules() {
  if (rules) return rules;
  try {
    // Content scripts cannot be ES modules, so the shared rules are imported
    // from the extension itself (see web_accessible_resources in the manifest).
    rules = await import(chrome.runtime.getURL("lib/cosmetic-rules.mjs"));
  } catch (error) {
    console.warn("WebGuard could not load its cosmetic filter rules.", error);
    rules = null;
  }
  return rules;
}

function apply(stylesheet, enabled) {
  const existing = document.getElementById(STYLE_ID);
  if (!enabled) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const target = document.head ?? document.documentElement;
  if (!target) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = stylesheet;
  target.appendChild(style);
}

// At document_start the head element does not exist yet, so the first insert
// lands directly under <html>. Move it into head once the parser has made one,
// leaving the document valid without ever removing the rule in between.
document.addEventListener(
  "DOMContentLoaded",
  () => {
    const style = document.getElementById(STYLE_ID);
    if (style && document.head && style.parentNode !== document.head) document.head.appendChild(style);
  },
  { once: true }
);

void (async () => {
  const module = await loadRules();
  if (!module) return;
  const stylesheet = module.buildCosmeticCss();
  const evaluate = (settings) => module.shouldApplyCosmeticFilter(location.hostname, settings);

  let settings = null;
  try {
    settings = (await chrome.storage.local.get(SETTINGS_KEY))?.[SETTINGS_KEY] ?? null;
  } catch {
    // Unreadable settings keep the defaults, which is blocking on.
  }
  apply(stylesheet, evaluate(settings));

  // Turning WebGuard off or allowlisting this site must take effect on the page
  // that is already open, not on the next reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[SETTINGS_KEY]) return;
    apply(stylesheet, evaluate(changes[SETTINGS_KEY].newValue ?? null));
  });
})();

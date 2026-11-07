// Cosmetic filtering: hides the slots network blocking leaves behind, so a page
// does not keep an empty box where an ad would have been.
//
// Three layers, each arriving sooner or later than the last:
//   1. the standard containers in lib/cosmetic-rules.mjs, available immediately;
//   2. the generic half of the compiled filter lists, one stylesheet shared by
//      every page, fetched from the extension itself;
//   3. the rules the lists publish for this host alone, asked of the worker.
// Then a label pass catches what no selector can name: the publisher's own
// wrapper around an "Advertisement" caption, whose class differs per site.
//
// This runs at document_start rather than on the usual idle pass, because an ad
// slot that is hidden after the page paints is still an ad slot the user saw
// flash.

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
const GENERIC_CSS_PATH = "data/cosmetic-generic.css";
const HIDDEN_ATTRIBUTE = "data-webguard-placeholder";
const SWEEP_WINDOW_MS = 20_000;
const SWEEP_DEBOUNCE_MS = 300;

let rules = null;
let enabled = false;
const layers = { generic: "", host: "" };
let hidden = [];
let sweepTimer = null;
let sweepDeadline = 0;
let watching = false;

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

/** One stylesheet, rebuilt from whichever layers have arrived so far. */
function render() {
  const existing = document.getElementById(STYLE_ID);
  if (!enabled) {
    existing?.remove();
    return;
  }
  const base = rules?.buildCosmeticCss?.() ?? "";
  const stylesheet = [base, layers.generic, layers.host].filter(Boolean).join("\n");
  // An empty list would produce a rule with no selector, which the page would
  // parse as a broken stylesheet. Nothing to hide means no CSS.
  if (!stylesheet) return;

  const target = document.head ?? document.documentElement;
  if (!target) return;
  const style = existing ?? document.createElement("style");
  if (!existing) style.id = STYLE_ID;
  if (style.textContent !== stylesheet) style.textContent = stylesheet;
  if (style.parentNode !== target) target.appendChild(style);
}

function hideElement(element) {
  if (!element || element.nodeType !== 1 || !element.isConnected) return;
  if (element.hasAttribute(HIDDEN_ATTRIBUTE)) return;
  element.setAttribute(HIDDEN_ATTRIBUTE, "");
  element.style.setProperty("display", "none", "important");
  hidden.push(element);
}

function restoreHidden() {
  for (const element of hidden) {
    if (!element?.isConnected) continue;
    element.removeAttribute(HIDDEN_ATTRIBUTE);
    element.style.removeProperty("display");
  }
  hidden = [];
}

const UNSAFE_ANCESTORS = new Set(["BODY", "HTML", "MAIN", "ARTICLE", "HEADER", "FOOTER", "NAV", "FORM", "UL", "OL", "TABLE"]);
const SLOT_CONTENT = "a, button, input, select, textarea, img, picture, video, audio, iframe, canvas, svg, form, table";

/**
 * The wrapper that belongs to a caption is the one holding nothing but that
 * caption. Walking up stops at the first ancestor carrying any other text, a
 * control or an image, because from there on it is page layout and hiding it
 * would delete content.
 */
function slotWrapper(labelText, element) {
  const caption = labelText.trim().replace(/\s+/g, " ");
  let node = element;
  for (let depth = 0; depth < 3; depth += 1) {
    const parent = node.parentElement;
    if (!parent || UNSAFE_ANCESTORS.has(parent.tagName)) break;
    if (parent.textContent.trim().replace(/\s+/g, " ") !== caption) break;
    if (parent.querySelector(SLOT_CONTENT)) break;
    const rect = parent.getBoundingClientRect();
    // A slot is a box in the column; a full-width section or a one-line strip is
    // something else and is left alone.
    if (rect.height > 400 || rect.width < 80) break;
    node = parent;
  }
  return node;
}

/** Hides every leftover caption in the document, and the empty box around it. */
function sweepPlaceholders() {
  if (!enabled || !rules || !document.body) return;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue;
      if (!text || text.trim().length > 40) return NodeFilter.FILTER_REJECT;
      return rules.isPlaceholderLabel(text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  });
  const captions = [];
  while (walker.nextNode()) captions.push(walker.currentNode.parentElement);

  for (const element of captions) {
    if (!element || !element.isConnected) continue;
    // A caption inside a link or a button is a control, so only the caption goes.
    const control = element.closest("a, button");
    hideElement(control ?? slotWrapper(element.textContent, element));
  }
}

function scheduleSweep() {
  if (!enabled) return;
  const now = Date.now();
  if (now > sweepDeadline) return;
  clearTimeout(sweepTimer);
  sweepTimer = setTimeout(sweepPlaceholders, SWEEP_DEBOUNCE_MS);
}

/**
 * Ad tags inject their slot well after the document settles, so the label pass
 * watches mutations, but only for a bounded window: a permanent observer on
 * every page is a cost that no finished page needs to keep paying.
 */
function watchPlaceholders() {
  if (watching) return;
  watching = true;
  sweepPlaceholders();
  sweepDeadline = Date.now() + SWEEP_WINDOW_MS;
  if (typeof MutationObserver !== "function" || !document.body) return;
  const observer = new MutationObserver(() => scheduleSweep());
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => {
    observer.disconnect();
    watching = false;
  }, SWEEP_WINDOW_MS);
}

/**
 * The first sweep cannot run on DOMContentLoaded alone: the settings that decide
 * whether to hide anything are read asynchronously and can arrive after the
 * event, which would leave the pass believing filtering is off.
 */
function startPlaceholderPass() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => watchPlaceholders(), { once: true });
  } else {
    watchPlaceholders();
  }
}

async function loadGenericLayer() {
  try {
    const response = await fetch(chrome.runtime.getURL(GENERIC_CSS_PATH));
    if (!response.ok) return;
    layers.generic = (await response.text()).trim();
    render();
  } catch {
    // The built-in selectors still cover the standard ad containers.
  }
}

async function loadHostLayer() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "webguard.cosmeticRules" });
    const selectors = Array.isArray(response?.selectors) ? response.selectors : [];
    if (selectors.length === 0) return;
    layers.host = rules.buildCosmeticCss(selectors);
    render();
  } catch {
    // A worker that is asleep or reloading costs this page only the extra rules.
  }
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

  const evaluate = (settings) => module.shouldApplyCosmeticFilter(location.hostname, settings);

  let settings = null;
  try {
    settings = (await chrome.storage.local.get(SETTINGS_KEY))?.[SETTINGS_KEY] ?? null;
  } catch {
    // Unreadable settings keep the defaults, which is blocking on.
  }
  enabled = evaluate(settings);
  render();

  // Turning WebGuard off or allowlisting this site must take effect on the page
  // that is already open, not on the next reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[SETTINGS_KEY]) return;
    enabled = evaluate(changes[SETTINGS_KEY].newValue ?? null);
    if (!enabled) {
      restoreHidden();
      clearTimeout(sweepTimer);
    } else {
      startPlaceholderPass();
    }
    render();
  });

  if (!enabled) return;
  startPlaceholderPass();
  void loadGenericLayer();
  void loadHostLayer();
})();

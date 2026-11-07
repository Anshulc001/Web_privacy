import { candidateHosts, hostCoveredBy } from "./host-match.mjs";

/**
 * Cosmetic filtering hides the leftovers network blocking cannot remove: the
 * empty slots, placeholder boxes and blocked iframes an ad tag leaves behind.
 *
 * Every selector here is deliberately narrow, because a false positive deletes
 * real page content. Standard ad containers and the frames a blocked tracker
 * would have filled are covered; nothing generic such as `.banner` is.
 */
export const COSMETIC_SELECTORS = Object.freeze([
  // Google Ad Manager / AdSense slots.
  '[id^="div-gpt-ad"]',
  "[data-google-query-id]",
  "ins.adsbygoogle",
  // AMP ad components.
  "amp-ad",
  "amp-embed",
  "amp-sticky-ad",
  // Taboola / Outbrain recommendation widgets.
  '[id^="taboola-"]',
  ".trc_rbox_container",
  ".OUTBRAIN",
  "[data-ob-template]",
  // Common ad-unit wrappers.
  "[data-ad-slot]",
  "[data-ad-unit]",
  "[data-ad-client]",
  ".ad-slot",
  ".ad-container",
  ".dfp-ad",
  // AdPushup / Geniee slots, and the publisher wrapper that draws the
  // "Advertisement" label above them. Blocking the script leaves both behind.
  "[data-aaad]",
  "[data-aa-adunit]",
  '[id^="adpushup-"]',
  ".ads-wrp",
  // Frames whose source is a blocked ad network: network blocking stops the
  // request, this removes the frame's reserved space.
  'iframe[src*="doubleclick.net"]',
  'iframe[src*="googlesyndication.com"]',
  'iframe[src*="amazon-adsystem.com"]',
  'iframe[src*="adnxs.com"]',
  'iframe[src*="rubiconproject.com"]',
  'iframe[src*="criteo.com"]'
]);

/**
 * The wording a publisher prints inside a slot it could not fill. Filter lists
 * cannot name these wrappers, because the class that draws the label differs on
 * every site; the label itself does not.
 */
export const PLACEHOLDER_LABELS = Object.freeze([
  "advertisement",
  "advertisements",
  "advertising",
  "advert",
  "ads by google",
  "sponsored",
  "sponsored content",
  "anzeige",
  "werbung",
  "publicité",
  "pubblicità",
  "publicidad",
  "anúncio",
  "reklama",
  "реклама",
  "広告",
  "广告",
  "إعلان"
]);

// A label, not a sentence: the exact wording above, or that wording followed by
// a word or two ("Advertisement - scroll to continue"). Anything longer is page
// copy that happens to mention ads.
const LABEL_PREFIX = /^(?:advertisements?|advertising|advert|sponsored(?: content)?|anzeige|werbung|publicité|pubblicità|publicidad|anúncio|reklama|реклама|広告|广告|إعلان)(?:\s*[-–—:|]\s*[\p{L}\d ]{1,20})?$/u;

export function isPlaceholderLabel(text) {
  if (typeof text !== "string") return false;
  const value = text.trim().replace(/\s+/g, " ");
  if (!value || value.length > 40) return false;
  return LABEL_PREFIX.test(value.toLowerCase());
}

/**
 * One stylesheet rule that erases a matched slot completely: `display: none`
 * alone still leaves some ad scripts re-showing the node, so visibility, size
 * and interaction are all neutralised as well.
 */
export function buildCosmeticCss(selectors = COSMETIC_SELECTORS) {
  const list = Array.isArray(selectors) ? selectors.filter((selector) => typeof selector === "string" && selector) : [];
  // An empty selector list would produce a rule with no selector, which the
  // page would parse as a broken stylesheet. Nothing to hide means no CSS.
  if (list.length === 0) return "";
  return `${list.join(",\n")} { display: none !important; visibility: hidden !important; height: 0 !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important; pointer-events: none !important; }`;
}

/**
 * The selectors the compiled filter lists publish for one host: every rule its
 * own name and each parent name carries, minus the rules the lists withdraw with
 * an element-hiding exception on this host.
 *
 * Kept separate from the generic list because the two travel different paths:
 * the generic half is one stylesheet shared by every page, while these are a
 * handful of selectors fetched for the page being loaded.
 */
export function hostSelectorsFor(dataset, hostname) {
  if (!dataset || typeof dataset !== "object") return [];
  const domains = dataset.domains && typeof dataset.domains === "object" ? dataset.domains : {};
  const exceptions = dataset.exceptions && typeof dataset.exceptions === "object" ? dataset.exceptions : {};

  const excluded = new Set();
  const selectors = [];
  const seen = new Set();
  for (const candidate of candidateHosts(hostname)) {
    const withdrawn = exceptions[candidate];
    if (Array.isArray(withdrawn)) for (const selector of withdrawn) excluded.add(selector);

    const listed = domains[candidate];
    if (!Array.isArray(listed)) continue;
    for (const selector of listed) {
      if (typeof selector !== "string" || !selector || seen.has(selector)) continue;
      seen.add(selector);
      selectors.push(selector);
    }
  }
  // The exception list is consulted after collection: a rule withdrawn on the
  // parent domain must also drop for the subdomain that inherited it.
  return selectors.filter((selector) => !excluded.has(selector));
}

/**
 * Cosmetic filtering follows the same two switches as network blocking: it is
 * off when WebGuard itself is off, and off on an allowlisted site (exact host or
 * the same registrable domain, matching how the allowlist rules are applied).
 */
export function shouldApplyCosmeticFilter(hostname, settings) {
  if (settings?.blockingEnabled === false) return false;
  const host = String(hostname ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;

  const allowlist = Array.isArray(settings?.siteAllowlist) ? settings.siteAllowlist : [];
  if (hostCoveredBy(host, allowlist)) return false;

  // hostCoveredBy works in registrable domains, so a single-label host such as
  // "localhost" falls through it; compare those entries exactly instead.
  return !allowlist.some(
    (entry) => String(entry ?? "").trim().toLowerCase().replace(/^\.+|\.$/g, "") === host
  );
}

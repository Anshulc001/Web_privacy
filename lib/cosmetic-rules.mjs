import { hostCoveredBy } from "./host-match.mjs";

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

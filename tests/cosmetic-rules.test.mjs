import { describe, it } from "node:test";
import assert from "node:assert";
import {
  COSMETIC_SELECTORS,
  buildCosmeticCss,
  hostSelectorsFor,
  isPlaceholderLabel,
  shouldApplyCosmeticFilter
} from "../lib/cosmetic-rules.mjs";

// The exact set the filter promises to hide. Pinning it here keeps a selector
// from being dropped by accident, since a missing one is silent on the page.
const REQUIRED_SELECTORS = [
  '[id^="div-gpt-ad"]',
  "[data-google-query-id]",
  "ins.adsbygoogle",
  "amp-ad",
  "amp-embed",
  "amp-sticky-ad",
  '[id^="taboola-"]',
  ".trc_rbox_container",
  ".OUTBRAIN",
  "[data-ob-template]",
  "[data-ad-slot]",
  "[data-ad-unit]",
  "[data-ad-client]",
  ".ad-slot",
  ".ad-container",
  ".dfp-ad",
  "[data-aaad]",
  "[data-aa-adunit]",
  '[id^="adpushup-"]',
  ".ads-wrp",
  'iframe[src*="doubleclick.net"]',
  'iframe[src*="googlesyndication.com"]',
  'iframe[src*="amazon-adsystem.com"]',
  'iframe[src*="adnxs.com"]',
  'iframe[src*="rubiconproject.com"]',
  'iframe[src*="criteo.com"]'
];

const FULL_HIDE = [
  "display: none !important",
  "visibility: hidden !important",
  "height: 0 !important",
  "min-height: 0 !important",
  "margin: 0 !important",
  "padding: 0 !important",
  "pointer-events: none !important"
];

describe("cosmetic filter selectors", () => {
  it("contains every ad container and blocked frame pattern", () => {
    for (const selector of REQUIRED_SELECTORS) {
      assert.ok(COSMETIC_SELECTORS.includes(selector), `missing selector ${selector}`);
    }
    assert.strictEqual(COSMETIC_SELECTORS.length, REQUIRED_SELECTORS.length, "no unexpected extras");
    assert.strictEqual(new Set(COSMETIC_SELECTORS).size, COSMETIC_SELECTORS.length, "no duplicates");
  });

  it("is frozen so a page or a module cannot extend it at runtime", () => {
    assert.ok(Object.isFrozen(COSMETIC_SELECTORS));
    assert.throws(() => COSMETIC_SELECTORS.push(".ad"), TypeError);
  });
});

describe("buildCosmeticCss", () => {
  it("emits one rule that fully hides every selector", () => {
    const css = buildCosmeticCss();
    assert.ok(css.startsWith(`${REQUIRED_SELECTORS[0]},\n`), "selectors are comma/newline separated");
    assert.ok(css.endsWith(" }"), "the rule is closed");
    assert.strictEqual(css.split("{").length, 2, "exactly one rule, so no selector can be read as a declaration");
    for (const selector of REQUIRED_SELECTORS) assert.ok(css.includes(selector), `${selector} must be in the stylesheet`);
    for (const declaration of FULL_HIDE) assert.ok(css.includes(declaration), `missing ${declaration}`);
  });

  it("builds the same rule from a custom selector list", () => {
    assert.strictEqual(
      buildCosmeticCss([".one", ".two"]),
      `.one,\n.two { display: none !important; visibility: hidden !important; height: 0 !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important; pointer-events: none !important; }`
    );
  });

  it("returns no stylesheet when there is nothing to hide", () => {
    // An empty selector list would otherwise render `" { ... }"`, which drops the
    // whole rule and could hide nothing at all if it were ever appended.
    assert.strictEqual(buildCosmeticCss([]), "");
    assert.strictEqual(buildCosmeticCss(null), "");
    assert.strictEqual(buildCosmeticCss(["", null]), "");
  });
});

describe("hostSelectorsFor", () => {
  const dataset = {
    domains: {
      "news.test": [".ad", ".banner"],
      "www.news.test": ["#top-ad"],
      "other.test": [".promo"]
    },
    exceptions: { "www.news.test": [".ad"] }
  };

  it("collects the rules for the host and each parent domain", () => {
    assert.deepEqual(hostSelectorsFor(dataset, "www.news.test"), ["#top-ad", ".banner"]);
  });

  it("applies a domain's rules to the sites below it", () => {
    assert.deepEqual(hostSelectorsFor(dataset, "edition.news.test"), [".ad", ".banner"]);
  });

  it("leaves out the rules an exception withdraws on this host", () => {
    assert.ok(!hostSelectorsFor(dataset, "www.news.test").includes(".ad"));
    assert.ok(hostSelectorsFor(dataset, "mail.news.test").includes(".ad"));
  });

  it("returns nothing for a host the lists do not mention", () => {
    assert.deepEqual(hostSelectorsFor(dataset, "unlisted.test"), []);
    assert.deepEqual(hostSelectorsFor(dataset, "127.0.0.1"), []);
    assert.deepEqual(hostSelectorsFor(null, "news.test"), []);
    assert.deepEqual(hostSelectorsFor({ domains: [] }, "news.test"), []);
  });

  it("never repeats a selector", () => {
    const repeated = { domains: { "news.test": [".ad", ".ad"], "www.news.test": [".ad"] } };
    assert.deepEqual(hostSelectorsFor(repeated, "www.news.test"), [".ad"]);
  });
});

describe("isPlaceholderLabel", () => {
  it("recognises the caption a publisher prints in an unfilled slot", () => {
    for (const label of ["Advertisement", " advertisement ", "Advertisement - scroll to continue", "Sponsored", "Sponsored content", "Anzeige", "Reklama"]) {
      assert.strictEqual(isPlaceholderLabel(label), true, `${label} must count as a placeholder caption`);
    }
  });

  it("does not match page copy that merely mentions advertising", () => {
    for (const text of ["", "   ", null, "Our advertisement policy explains how we work with partners", "Advertisement-free reading for subscribers starts here today"]) {
      assert.strictEqual(isPlaceholderLabel(text), false, `${text} must not be treated as a caption`);
    }
  });
});

describe("shouldApplyCosmeticFilter", () => {
  it("applies when blocking is on and nothing is allowlisted", () => {
    assert.strictEqual(shouldApplyCosmeticFilter("news.test", { blockingEnabled: true, siteAllowlist: [] }), true);
  });

  it("applies with default settings (blocking on)", () => {
    assert.strictEqual(shouldApplyCosmeticFilter("news.test", {}), true);
    assert.strictEqual(shouldApplyCosmeticFilter("news.test", null), true);
  });

  it("does not apply when WebGuard is off", () => {
    assert.strictEqual(shouldApplyCosmeticFilter("news.test", { blockingEnabled: false, siteAllowlist: [] }), false);
  });

  it("does not apply on an exactly allowlisted host", () => {
    assert.strictEqual(shouldApplyCosmeticFilter("news.test", { blockingEnabled: true, siteAllowlist: ["news.test"] }), false);
  });

  it("does not apply on a subdomain of an allowlisted domain", () => {
    assert.strictEqual(shouldApplyCosmeticFilter("edition.cnn.com", { blockingEnabled: true, siteAllowlist: ["cnn.com"] }), false);
    assert.strictEqual(shouldApplyCosmeticFilter("www.cnn.com", { blockingEnabled: true, siteAllowlist: ["edition.cnn.com"] }), false);
  });

  it("keeps applying on sites outside the allowlist", () => {
    assert.strictEqual(shouldApplyCosmeticFilter("news.test", { blockingEnabled: true, siteAllowlist: ["other.test"] }), true);
    assert.strictEqual(shouldApplyCosmeticFilter("news.test", { blockingEnabled: true, siteAllowlist: ["other.test", "cnn.com"] }), true);
  });

  it("handles local hosts that are not registrable domains", () => {
    assert.strictEqual(shouldApplyCosmeticFilter("127.0.0.1", { blockingEnabled: true, siteAllowlist: [] }), true);
    assert.strictEqual(shouldApplyCosmeticFilter("127.0.0.1", { blockingEnabled: true, siteAllowlist: ["127.0.0.1"] }), false);
    assert.strictEqual(shouldApplyCosmeticFilter("localhost", { blockingEnabled: true, siteAllowlist: [] }), true);
    assert.strictEqual(shouldApplyCosmeticFilter("localhost", { blockingEnabled: true, siteAllowlist: ["localhost"] }), false);
    assert.strictEqual(shouldApplyCosmeticFilter("localhost", { blockingEnabled: true, siteAllowlist: ["LOCALHOST."] }), false);
  });

  it("ignores missing or malformed hostnames and allowlists", () => {
    assert.strictEqual(shouldApplyCosmeticFilter("", { blockingEnabled: true }), false);
    assert.strictEqual(shouldApplyCosmeticFilter(null, { blockingEnabled: true }), false);
    assert.strictEqual(shouldApplyCosmeticFilter("news.test", { blockingEnabled: true, siteAllowlist: "news.test" }), true);
  });
});

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256 } from "../lib/data-integrity.mjs";
import { buildCosmeticCss } from "../lib/cosmetic-rules.mjs";
import { normalizeHost } from "../lib/host-match.mjs";

/**
 * Compiles the element-hiding half of EasyList and EasyPrivacy into the data the
 * extension ships.
 *
 * Network blocking stops a request; the slot that request would have filled is
 * still in the DOM, and only a selector for that slot removes it. Those selectors
 * are written per site by the list authors, which is why the compiled output is
 * keyed by domain instead of being one fixed list: a publisher's own wrapper
 * class is meaningless on any other site.
 */

const SOURCE_URL = "https://easylist-downloads.adblockplus.org/easyprivacy+easylist.txt";
const MAX_SOURCE_BYTES = 20_000_000;
const MAX_GENERIC_SELECTORS = 6_000;
const MAX_DOMAINS = 20_000;
const MAX_SELECTORS_PER_DOMAIN = 60;
const MAX_SELECTOR_LENGTH = 300;
const outputDirectory = resolve(import.meta.dirname, "../data");

// Separators, most specific first. Everything after the separator is a selector;
// anything before it is a comma-separated domain list.
const SEPARATORS = ["#@?#", "#?#", "#@$#", "#$#", "#@%#", "#%#", "#@#", "##"];

// Procedural operators need a script inside the extension to evaluate them, and
// style/scriptlet operators are not selectors at all. Native `:has()` is kept:
// Chrome evaluates it, so it needs no extra machinery.
const UNSUPPORTED_SELECTOR = /:-abp-|:has-text\(|:contains\(|:matches-css|:style\(|:remove\(|:upward\(|:xpath\(|:min-text-length|:watch-attr|:others\(|:if\(|:if-not\(|:remove-attr|:remove-class/i;

// A selector that hides the document or the body does not hide an ad, it hides
// the page, so a list mistake of that shape is never published.
const PAGE_WIDE_SELECTOR = /^(?::root|html|body|html\s*>\s*body)$/i;

function normalizeDomainList(value) {
  if (!value) return { include: [], exclude: [] };
  const include = [];
  const exclude = [];
  for (const part of value.split(",")) {
    const entry = part.trim().toLowerCase();
    if (!entry) continue;
    const negated = entry.startsWith("~");
    const host = normalizeHost(negated ? entry.slice(1) : entry);
    if (!host) continue;
    // A negated domain means "every listed domain except this one", so it becomes
    // an exception for the selector rather than a reason to drop the whole rule.
    (negated ? exclude : include).push(host);
  }
  return { include, exclude };
}

function usableSelector(selector) {
  if (!selector) return false;
  if (selector.length > MAX_SELECTOR_LENGTH) return false;
  if (/[\r\n]/.test(selector)) return false;
  if (UNSUPPORTED_SELECTOR.test(selector)) return false;
  if (PAGE_WIDE_SELECTOR.test(selector.trim())) return false;
  return true;
}

const response = await fetch(SOURCE_URL);
if (!response.ok) throw new Error(`Filter list download failed with status ${response.status}.`);
const text = await response.text();
if (text.length > MAX_SOURCE_BYTES) throw new Error("Source list exceeds the 20 MB safety limit.");

const lines = text.split(/\r?\n/);
if (lines.length < 1_000) throw new Error("Source list is unexpectedly small; refusing to build.");

const generic = new Set();
const domains = new Map();
const exceptions = new Map();
let cosmeticLines = 0;
let skippedLines = 0;

function push(map, host, selector) {
  const current = map.get(host);
  if (current) {
    if (current.length < MAX_SELECTORS_PER_DOMAIN) current.push(selector);
    return;
  }
  map.set(host, [selector]);
}

for (const rawLine of lines) {
  const line = rawLine.trim();
  if (!line || line.startsWith("!") || line.startsWith("[")) continue;

  let separator = null;
  let index = -1;
  for (const candidate of SEPARATORS) {
    const at = line.indexOf(candidate);
    if (at !== -1 && (index === -1 || at < index)) {
      separator = candidate;
      index = at;
    }
  }
  if (!separator) continue;

  // Network rules can contain "#" only after the separator, which never happens
  // for the formats above, so a single separator means this is a cosmetic rule.
  cosmeticLines += 1;
  const selector = line.slice(index + separator.length).trim();
  if (!usableSelector(selector)) {
    skippedLines += 1;
    continue;
  }
  // Scriptlet and style-injection formats are not selectors; only the two
  // element-hiding separators are published.
  if (separator !== "##" && separator !== "#@#") {
    skippedLines += 1;
    continue;
  }

  const { include, exclude } = normalizeDomainList(line.slice(0, index));
  if (separator === "#@#") {
    for (const host of include) push(exceptions, host, selector);
    continue;
  }
  if (include.length === 0) {
    generic.add(selector);
    continue;
  }
  for (const host of include) push(domains, host, selector);
  for (const host of exclude) push(exceptions, host, selector);
}

if (generic.size === 0 || domains.size === 0) throw new Error("No cosmetic rules were extracted.");

// Generic rules apply to every page, so the whole set is shipped as one rule and
// its size is a per-page cost. Keep the most specific ones when the list is long.
const genericSelectors = [...generic]
  .sort((a, b) => a.length - b.length || a.localeCompare(b))
  .slice(0, MAX_GENERIC_SELECTORS)
  .sort();

const rankedDomains = [...domains.entries()]
  .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  .slice(0, MAX_DOMAINS)
  .sort((a, b) => a[0].localeCompare(b[0]));

const domainRecord = Object.fromEntries(rankedDomains);
const exceptionRecord = Object.fromEntries([...exceptions.entries()].sort((a, b) => a[0].localeCompare(b[0])));

const publishedSelectors =
  genericSelectors.length + rankedDomains.reduce((total, [, selectors]) => total + selectors.length, 0);

const metadata = {
  version: "1.0.0",
  buildDate: new Date().toISOString(),
  checksum: await sha256(JSON.stringify({ genericSelectors, domainRecord, exceptionRecord })),
  source: "EasyList+EasyPrivacy",
  attribution:
    "Element-hiding rules derived from EasyList and EasyPrivacy, © The EasyList Authors (https://easylist.to/), licensed under CC BY-SA 3.0 / GPL v3.",
  stats: {
    cosmeticLines,
    skippedLines,
    genericSelectors: genericSelectors.length,
    domains: rankedDomains.length,
    exceptionDomains: Object.keys(exceptionRecord).length,
    publishedSelectors
  },
  generic: genericSelectors,
  domains: domainRecord,
  exceptions: exceptionRecord
};

const json = `${JSON.stringify(metadata)}\n`;
if (json.length > 12_000_000) throw new Error("Compiled cosmetic data exceeds the 12 MB budget.");

// The generic half is the same stylesheet on every page, so it ships as CSS the
// content script can inject without waiting for a message from the worker.
const genericCss = buildCosmeticCss(genericSelectors);

await mkdir(outputDirectory, { recursive: true });
await writeFile(resolve(outputDirectory, "cosmetic-rules.json"), json);
await writeFile(resolve(outputDirectory, "cosmetic-generic.css"), genericCss);
console.log(
  `Compiled ${cosmeticLines} element-hiding lines into ${genericSelectors.length} generic selectors, ` +
    `${rankedDomains.length} domains and ${Object.keys(exceptionRecord).length} exception domains ` +
    `(${(json.length / 1024 / 1024).toFixed(1)} MB).`
);

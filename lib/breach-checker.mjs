import { sha256 } from "./data-integrity.mjs";
import { htmlToPlainText, extractHttpsLinks } from "./sanitize.mjs";
import { isPublicSuffix, matchHostInRecord, normalizeHost } from "./host-match.mjs";

export const BREACH_DATA_KEY = "breachData";
export const BREACH_DATA_FILE = "breach-data.json";
export const MAX_BREACH_ENTRIES = 5_000;
export const MAX_BREACHES_PER_DOMAIN = 20;
export const MAX_STALE_DAYS = 7;

const MAX_DESCRIPTION = 600;
const MAX_DATA_CLASSES = 24;

export const BREACH_ATTRIBUTION = Object.freeze({
  label: "Source: Have I Been Pwned",
  url: "https://haveibeenpwned.com"
});

export const SELF_CHECK_LINKS = Object.freeze([
  { label: "Have I Been Pwned", url: "https://haveibeenpwned.com" },
  { label: "Mozilla Monitor", url: "https://monitor.mozilla.org" },
  { label: "Malwarebytes Digital Footprint", url: "https://www.malwarebytes.com/digital-footprint" },
  { label: "XposedOrNot", url: "https://xposedornot.com" },
  { label: "Google Password Checkup", url: "https://passwords.google.com/checkup" }
]);

function canonicalizeFlags(flags) {
  const source = flags && typeof flags === "object" ? flags : {};
  return {
    unverified: source.unverified === true,
    fabricated: source.fabricated === true,
    sensitive: source.sensitive === true,
    retired: source.retired === true,
    spamList: source.spamList === true,
    stealerLog: source.stealerLog === true
  };
}

function canonicalizeBreach(entry) {
  const titles = typeof entry?.title === "string" ? entry.title.slice(0, 200) : "";
  const breachDate = typeof entry?.breachDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.breachDate) ? entry.breachDate : null;
  const pwnCount = Number.isInteger(entry?.pwnCount) && entry.pwnCount >= 0 ? entry.pwnCount : null;
  const dataClasses = Array.isArray(entry?.dataClasses)
    ? entry.dataClasses.slice(0, MAX_DATA_CLASSES).filter((item) => typeof item === "string").map((item) => item.slice(0, 80))
    : [];
  const description = htmlToPlainText(typeof entry?.description === "string" ? entry.description : "", MAX_DESCRIPTION);
  const disclosureLink = extractHttpsLinks(typeof entry?.disclosureUrl === "string" ? entry.disclosureUrl : "", 1)[0] ?? null;
  return { title: titles, breachDate, pwnCount, dataClasses, description, disclosureUrl: disclosureLink, flags: canonicalizeFlags(entry?.flags) };
}

/** Sorts keys so the checksum is stable regardless of download order. */
export function canonicalizeBreaches(breaches) {
  const source = breaches && typeof breaches === "object" && !Array.isArray(breaches) ? breaches : {};
  const result = {};
  for (const domain of Object.keys(source).sort()) {
    const normalized = normalizeHost(domain);
    // A bare public suffix ("com", "co.uk") is a registry, never a site, so it
    // must not become a lookup key.
    if (!normalized || isPublicSuffix(normalized)) continue;
    const entries = Array.isArray(source[domain]) ? source[domain].slice(0, MAX_BREACHES_PER_DOMAIN).map(canonicalizeBreach) : [];
    if (entries.length > 0) result[normalized] = entries;
  }
  return result;
}

/**
 * Validates a downloaded breach data file. Throws on anything unexpected so the
 * caller can keep the last good copy instead of trusting corrupt input.
 */
export async function validateBreachData(candidate, now = Date.now()) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("Breach data is not an object.");
  }
  if (!candidate.data || typeof candidate.data !== "object" || Array.isArray(candidate.data)) {
    throw new TypeError("Breach data has an invalid schema.");
  }
  if (typeof candidate.version !== "string" || typeof candidate.buildDate !== "string" || typeof candidate.checksum !== "string") {
    throw new TypeError("Breach data metadata is missing.");
  }
  const buildTime = Date.parse(candidate.buildDate);
  if (!Number.isFinite(buildTime) || buildTime > now + 300_000) {
    throw new TypeError("Breach data build date is invalid.");
  }
  const breaches = canonicalizeBreaches(candidate.data.breaches);
  const domainCount = Object.keys(breaches).length;
  if (domainCount === 0 || domainCount > MAX_BREACH_ENTRIES) {
    throw new TypeError("Breach data has an invalid number of domains.");
  }
  if (await sha256(JSON.stringify(breaches)) !== candidate.checksum) {
    throw new TypeError("Breach data checksum does not match.");
  }
  return {
    version: candidate.version.slice(0, 32),
    buildDate: candidate.buildDate,
    checksum: candidate.checksum,
    source: String(candidate.source ?? "Have I Been Pwned").slice(0, 100),
    data: { breaches }
  };
}

/** Plain words for each HIBP flag, so nothing is presented as a bare boolean. */
export function describeFlags(flags) {
  const source = flags && typeof flags === "object" ? flags : {};
  const labels = [];
  if (source.unverified === true) labels.push("unverified");
  if (source.fabricated === true) labels.push("fabricated");
  if (source.sensitive === true) labels.push("sensitive");
  if (source.retired === true) labels.push("retired from the list");
  if (source.spamList === true) labels.push("spam list");
  if (source.stealerLog === true) labels.push("stealer log");
  return labels;
}

export function breachDataAgeDays(buildDate, now = Date.now()) {
  const buildTime = Date.parse(buildDate);
  if (!Number.isFinite(buildTime)) return null;
  return Math.max(0, Math.floor((now - buildTime) / 86_400_000));
}

/**
 * Checks a hostname against breach data.
 *
 * status:
 *  - "match"       the site appeared in a known breach
 *  - "not-found"   not found in the list (never "safe")
 *  - "unavailable" no usable data, so no claim can be made
 */
export function checkHostForBreaches(host, breachData, now = Date.now()) {
  if (!breachData || typeof breachData !== "object" || !breachData.data || typeof breachData.data.breaches !== "object") {
    return { status: "unavailable", reason: "Breach data is missing.", matches: [] };
  }
  const ageDays = breachDataAgeDays(breachData.buildDate, now);
  if (ageDays === null) {
    return { status: "unavailable", reason: "Breach data has no usable build date.", matches: [] };
  }
  const normalized = normalizeHost(host);
  if (!normalized) {
    return { status: "unavailable", reason: "No valid hostname to check.", matches: [] };
  }
  const found = matchHostInRecord(normalized, breachData.data.breaches);
  const stale = ageDays > MAX_STALE_DAYS;
  if (!found) {
    return { status: "not-found", matches: [], ageDays, stale, attribution: BREACH_ATTRIBUTION };
  }
  return {
    status: "match",
    matchedDomain: found.match,
    matches: (found.value ?? []).map((entry) => ({ ...entry, flagLabels: describeFlags(entry.flags) })),
    ageDays,
    stale,
    attribution: BREACH_ATTRIBUTION,
    selfCheckLinks: SELF_CHECK_LINKS
  };
}

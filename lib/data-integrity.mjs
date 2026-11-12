import { normalizeHostname } from "../background/history-store.mjs";
import { DNR_RESOURCE_TYPES } from "./filter-options.mjs";

export async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

const PARTY_VALUES = new Set(["firstParty", "thirdParty"]);
const DOMAIN_PATTERN = /^[a-z0-9.*-]+$/;

function canonicalDomainList(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const domains = value.map((domain) => (typeof domain === "string" ? domain.trim().toLowerCase() : ""));
  if (!domains.every((domain) => domain && DOMAIN_PATTERN.test(domain))) return null;
  const unique = [...new Set(domains)].sort();
  return unique.length === domains.length ? unique : null;
}

/**
 * Normalises one option-qualified condition into the single shape the checksum is
 * computed over: fixed key order, sorted domain lists, resource types in DNR
 * order. The build script and the runtime validator both call this, so a
 * regenerated file and a downloaded file can never disagree about the bytes.
 */
export function canonicalHostCondition(condition) {
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) return null;
  const allowed = new Set(["resourceTypes", "domainType", "initiatorDomains", "excludedInitiatorDomains"]);
  if (Object.keys(condition).some((key) => !allowed.has(key))) return null;
  if (!Array.isArray(condition.resourceTypes) || condition.resourceTypes.length === 0) return null;
  if (!condition.resourceTypes.every((type) => DNR_RESOURCE_TYPES.includes(type))) return null;
  const resourceTypes = DNR_RESOURCE_TYPES.filter((type) => condition.resourceTypes.includes(type));
  if (resourceTypes.length !== condition.resourceTypes.length) return null;

  const canonical = { resourceTypes };
  if (condition.domainType !== undefined) {
    if (!PARTY_VALUES.has(condition.domainType)) return null;
    canonical.domainType = condition.domainType;
  }
  if (condition.initiatorDomains !== undefined) {
    const domains = canonicalDomainList(condition.initiatorDomains);
    if (!domains) return null;
    canonical.initiatorDomains = domains;
  }
  if (condition.excludedInitiatorDomains !== undefined) {
    const domains = canonicalDomainList(condition.excludedInitiatorDomains);
    if (!domains) return null;
    canonical.excludedInitiatorDomains = domains;
  }
  // A condition with only resourceTypes is still a narrower rule than the plain
  // host block (`||host^$document` blocks navigations, not every request), so it is
  // a valid entry. Only the build script's folding keeps an entry that names every
  // type out of this list, because that one really is `data.hosts`.
  return canonical;
}

/**
 * Canonical list of option-qualified host rules, or `null` when the input is not
 * a valid list (the caller turns that into a schema error). `null` and `[]` are
 * both accepted as "this file predates qualified rules".
 */
export function canonicalHostRules(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  const entries = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const host = normalizeHostname(entry.host);
    const condition = canonicalHostCondition(entry.condition);
    if (!host || !condition) return null;
    const key = `${host}|${JSON.stringify(condition)}`;
    if (seen.has(key)) return null;
    seen.add(key);
    entries.push({ host, condition });
  }
  return entries.sort(
    (a, b) => a.host.localeCompare(b.host) || JSON.stringify(a.condition).localeCompare(JSON.stringify(b.condition))
  );
}

/**
 * The exact bytes the blocking-data checksum covers. Files without qualified
 * rules keep the original `sha256(JSON.stringify(hosts))` so an existing stored
 * copy still validates; adding or removing the list changes the payload, so
 * stripping the field out of a new file fails the check instead of silently
 * downgrading the blocklist.
 */
export function canonicalBlockingPayload({ hosts, hostRules }) {
  return hostRules && hostRules.length > 0 ? JSON.stringify({ hosts, hostRules }) : JSON.stringify(hosts);
}

export async function validateBlockingData(candidate, now = Date.now()) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || !candidate.data || typeof candidate.data !== "object") {
    throw new TypeError("Blocking data has an invalid schema.");
  }
  if (typeof candidate.version !== "string" || typeof candidate.buildDate !== "string" || typeof candidate.checksum !== "string") {
    throw new TypeError("Blocking data metadata is missing.");
  }
  const buildTime = Date.parse(candidate.buildDate);
  if (!Number.isFinite(buildTime) || buildTime > now + 300_000 || !Array.isArray(candidate.data.hosts) || candidate.data.hosts.length > 30_000) {
    throw new TypeError("Blocking data metadata or hosts are invalid.");
  }
  const hosts = [...new Set(candidate.data.hosts.map(normalizeHostname).filter(Boolean))].sort();
  if (hosts.length !== candidate.data.hosts.length) throw new TypeError("Blocking data hosts are invalid or duplicated.");
  const hostRules = canonicalHostRules(candidate.data.hostRules);
  if (hostRules === null) throw new TypeError("Blocking data host rules are invalid or duplicated.");
  if (hostRules.length > 5_000) throw new TypeError("Blocking data host rules exceed the safety limit.");
  const hostSet = new Set(hosts);
  if (hostRules.some((entry) => hostSet.has(entry.host))) {
    throw new TypeError("Blocking data lists a host both widely and by condition.");
  }
  if (await sha256(canonicalBlockingPayload({ hosts, hostRules })) !== candidate.checksum) {
    throw new TypeError("Blocking data checksum does not match.");
  }
  return {
    version: candidate.version,
    buildDate: candidate.buildDate,
    checksum: candidate.checksum,
    source: String(candidate.source ?? "Unknown"),
    data: { hosts, hostRules }
  };
}

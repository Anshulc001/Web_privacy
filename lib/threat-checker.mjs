import { sha256 } from "./data-integrity.mjs";
import { candidateHosts, normalizeHost } from "./host-match.mjs";

export const THREAT_DATA_KEY = "threatData";
export const THREAT_DATA_FILE = "threat-list.json";
export const MAX_THREAT_HOSTS = 60_000;
export const MAX_STALE_DAYS = 7;

export const THREAT_SOURCE = Object.freeze({
  name: "Phishing.Database",
  url: "https://github.com/mitchellkrogza/Phishing.Database",
  attribution:
    "Phishing domain data from Phishing.Database (https://github.com/mitchellkrogza/Phishing.Database), © 2018-2025 Mitchell Krog, Nissar Chababy, and contributors, licensed under MIT."
});

// A Set is built once per stored array so lookups stay cheap without rebuilding it.
const hostSetCache = new WeakMap();

function hostSetFor(hosts) {
  if (!Array.isArray(hosts)) return null;
  let cached = hostSetCache.get(hosts);
  if (!cached) {
    cached = new Set(hosts);
    hostSetCache.set(hosts, cached);
  }
  return cached;
}

export function canonicalizeThreatHosts(hosts) {
  if (!Array.isArray(hosts)) return [];
  const normalized = new Set();
  for (const value of hosts) {
    const host = normalizeHost(value);
    if (host) normalized.add(host);
  }
  return [...normalized].sort();
}

export async function validateThreatData(candidate, now = Date.now()) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("Threat data is not an object.");
  }
  if (!candidate.data || typeof candidate.data !== "object" || !Array.isArray(candidate.data.hosts)) {
    throw new TypeError("Threat data has an invalid schema.");
  }
  if (typeof candidate.version !== "string" || typeof candidate.buildDate !== "string" || typeof candidate.checksum !== "string") {
    throw new TypeError("Threat data metadata is missing.");
  }
  const buildTime = Date.parse(candidate.buildDate);
  if (!Number.isFinite(buildTime) || buildTime > now + 300_000) {
    throw new TypeError("Threat data build date is invalid.");
  }
  const hosts = canonicalizeThreatHosts(candidate.data.hosts);
  if (hosts.length === 0 || hosts.length > MAX_THREAT_HOSTS) {
    throw new TypeError("Threat data has an invalid number of hosts.");
  }
  if (await sha256(JSON.stringify(hosts)) !== candidate.checksum) {
    throw new TypeError("Threat data checksum does not match.");
  }
  return {
    version: candidate.version.slice(0, 32),
    buildDate: candidate.buildDate,
    checksum: candidate.checksum,
    source: String(candidate.source ?? THREAT_SOURCE.name).slice(0, 100),
    data: { hosts }
  };
}

export function threatDataAgeDays(buildDate, now = Date.now()) {
  const buildTime = Date.parse(buildDate);
  if (!Number.isFinite(buildTime)) return null;
  return Math.max(0, Math.floor((now - buildTime) / 86_400_000));
}

/**
 * Local lookup against the offline list.
 *
 * status "not-found" means only that the hostname is absent from the list.
 * It never means the site is safe.
 */
export function checkHostForThreats(host, threatData, now = Date.now()) {
  if (!threatData || typeof threatData !== "object" || !threatData.data || !Array.isArray(threatData.data.hosts)) {
    return { status: "unavailable", reason: "Threat list is missing.", matchedDomain: null, ageDays: null, stale: null };
  }
  const ageDays = threatDataAgeDays(threatData.buildDate, now);
  if (ageDays === null) {
    return { status: "unavailable", reason: "Threat list has no usable build date.", matchedDomain: null, ageDays: null, stale: null };
  }
  const normalized = normalizeHost(host);
  if (!normalized) {
    return { status: "unavailable", reason: "No valid hostname to check.", matchedDomain: null, ageDays, stale: ageDays > MAX_STALE_DAYS };
  }
  const set = hostSetFor(threatData.data.hosts);
  for (const candidate of candidateHosts(normalized)) {
    if (set.has(candidate)) {
      return {
        status: "match",
        matchedDomain: candidate,
        ageDays,
        stale: ageDays > MAX_STALE_DAYS,
        source: threatData.source ?? THREAT_SOURCE.name,
        attribution: THREAT_SOURCE.attribution
      };
    }
  }
  return {
    status: "not-found",
    matchedDomain: null,
    ageDays,
    stale: ageDays > MAX_STALE_DAYS,
    source: threatData.source ?? THREAT_SOURCE.name,
    attribution: THREAT_SOURCE.attribution
  };
}

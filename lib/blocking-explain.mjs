import { candidateHosts } from "./host-match.mjs";

/**
 * Explains *why* a host was blocked, using only the data this extension ships.
 *
 * What is knowable locally: the downloaded list separates hosts blocked outright
 * from hosts blocked under the condition their list asked for ("$third-party",
 * "$script", "$domain=…"). Chrome does not tell an extension which of the 29,000
 * bundled rules matched (that needs the `declarativeNetRequestFeedback` permission,
 * which only works on an unpacked build), so a host in neither list is reported as
 * matching the bundled ruleset — the honest answer, not a guess about which rule.
 */

/** Words for the shapes a rule can take, used verbatim in the popup. */
export const BLOCK_REASONS = Object.freeze({
  thirdParty: "third-party only",
  party: "first-party only",
  types: "one request type",
  initiator: "specific sites only",
  host: "whole host",
  bundled: "bundled ruleset",
  unknown: "no rule data"
});

/**
 * Builds the lookup once per data checksum. 28,000 strings is small enough to keep
 * for the life of the worker, and rebuilding it per popup open would cost more
 * than the answer is worth.
 */
export function createBlockingIndex(blockingData) {
  const data = blockingData && typeof blockingData === "object" ? blockingData.data : null;
  if (!data || typeof data !== "object") return null;
  const hosts = new Set(Array.isArray(data.hosts) ? data.hosts.filter((host) => typeof host === "string") : []);
  const qualified = new Map();
  for (const entry of Array.isArray(data.hostRules) ? data.hostRules : []) {
    if (!entry || typeof entry.host !== "string" || !entry.condition || typeof entry.condition !== "object") continue;
    const conditions = qualified.get(entry.host) ?? [];
    conditions.push(entry.condition);
    qualified.set(entry.host, conditions);
  }
  return { hosts, qualified, version: blockingData.version ?? null, buildDate: blockingData.buildDate ?? null };
}

function reasonForCondition(condition) {
  if (condition.domainType === "thirdParty") return BLOCK_REASONS.thirdParty;
  if (condition.domainType === "firstParty") return BLOCK_REASONS.party;
  if (condition.initiatorDomains || condition.excludedInitiatorDomains) return BLOCK_REASONS.initiator;
  return BLOCK_REASONS.types;
}

/**
 * `host` is the blocked request's hostname; rules match the registrable domain and
 * its subdomains, so every suffix is checked (`||quantserve.com^` is what blocks
 * `pixel.quantserve.com`).
 */
export function explainBlockedHost(host, index) {
  if (!index) return { reason: BLOCK_REASONS.unknown, label: "Rule data is not downloaded yet", version: null };
  const candidates = candidateHosts(host);
  if (candidates.length === 0) return { reason: BLOCK_REASONS.unknown, label: "Not a public hostname", version: index.version };

  for (const candidate of candidates) {
    const conditions = index.qualified.get(candidate);
    if (conditions && conditions.length > 0) {
      const reasons = [...new Set(conditions.map(reasonForCondition))];
      return {
        reason: reasons[0],
        label: `Blocked by a rule for ${reasons.join(" / ")} requests`,
        matched: candidate,
        version: index.version
      };
    }
  }
  for (const candidate of candidates) {
    if (index.hosts.has(candidate)) {
      return { reason: BLOCK_REASONS.host, label: "Blocked on every request to this host", matched: candidate, version: index.version };
    }
  }
  return {
    reason: BLOCK_REASONS.bundled,
    label: "Blocked by a bundled rule (path-level or host rule)",
    matched: null,
    version: index.version
  };
}

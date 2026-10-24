export const RISK_DISCLAIMER =
  "Checked against community lists and local URL checks, not a full security scan.";

export const NEW_DOMAIN_DAYS = 30;

const THREAT_LIST_WEIGHT = 60;
const NEW_DOMAIN_WEIGHT = 25;
const UNKNOWN_REGISTRAR_WEIGHT = 0;

function clamp(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function riskLevel(score) {
  if (score >= 75) return "severe";
  if (score >= 50) return "high";
  if (score >= 25) return "moderate";
  return "low";
}

/**
 * Builds a single explainable score.
 *
 * Every contribution appears in `reasons`, so the UI never has to invent an
 * explanation and the user can see exactly why a number is what it is.
 */
export function scoreRisk({ urlFindings = [], threat = null, domainInfo = null } = {}) {
  const reasons = [];
  let score = 0;

  for (const finding of urlFindings) {
    if (!finding || typeof finding !== "object") continue;
    const weight = Number.isFinite(finding.weight) ? finding.weight : 0;
    if (weight <= 0) continue;
    score += weight;
    reasons.push({ id: finding.id, weight, label: finding.label, source: "url" });
  }

  if (threat && threat.status === "match") {
    score += THREAT_LIST_WEIGHT;
    reasons.push({
      id: "threat-list-match",
      weight: THREAT_LIST_WEIGHT,
      label: `The hostname appears in an offline phishing blocklist (${threat.matchedDomain ?? "matched entry"}).`,
      source: "threat-list"
    });
  }

  if (domainInfo && domainInfo.status === "ok" && Number.isInteger(domainInfo.ageDays)) {
    if (domainInfo.ageDays < NEW_DOMAIN_DAYS) {
      score += NEW_DOMAIN_WEIGHT;
      const ageText = domainInfo.ageDays === 0 ? "today" : "" + domainInfo.ageDays + " day(s) ago";
      reasons.push({
        id: "new-domain",
        weight: NEW_DOMAIN_WEIGHT,
        label: "The domain was registered " + ageText + ", which is under " + NEW_DOMAIN_DAYS + " days.",
        source: "rdap"
      });
    }
    if (!domainInfo.registrar) {
      reasons.push({
        id: "registrar-unknown",
        weight: UNKNOWN_REGISTRAR_WEIGHT,
        label: "The registry returned no registrar for this domain.",
        source: "rdap"
      });
    }
  }

  const finalScore = clamp(score);

  if (reasons.length === 0) {
    reasons.push({
      id: "no-findings",
      weight: 0,
      label: "No local warning signals were found. The site was not found in our lists, which is not the same as safe.",
      source: "none"
    });
  }

  return {
    score: finalScore,
    level: riskLevel(finalScore),
    reasons,
    disclaimer: RISK_DISCLAIMER,
    threatListAgeDays: threat?.ageDays ?? null,
    threatListStale: threat?.stale ?? null,
    threatListStatus: threat?.status ?? "unavailable",
    domainInfoStatus: domainInfo?.status ?? "unavailable"
  };
}

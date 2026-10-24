import { describe, it } from "node:test";
import assert from "node:assert";
import { scoreRisk, riskLevel, RISK_DISCLAIMER, NEW_DOMAIN_DAYS } from "../lib/risk-score.mjs";

describe("riskLevel", () => {
  it("maps scores to named levels", () => {
    assert.strictEqual(riskLevel(0), "low");
    assert.strictEqual(riskLevel(24), "low");
    assert.strictEqual(riskLevel(25), "moderate");
    assert.strictEqual(riskLevel(50), "high");
    assert.strictEqual(riskLevel(75), "severe");
  });
});

describe("scoreRisk", () => {
  it("returns zero with an explicit not-a-verdict note when nothing was found", () => {
    const result = scoreRisk({});
    assert.strictEqual(result.score, 0);
    assert.strictEqual(result.level, "low");
    assert.strictEqual(result.reasons[0].id, "no-findings");
    assert.ok(result.reasons[0].label.includes("not the same as safe"));
    assert.strictEqual(result.disclaimer, RISK_DISCLAIMER);
  });

  it("adds the weight of every URL finding and explains each one", () => {
    const result = scoreRisk({
      urlFindings: [
        { id: "not-https", weight: 25, label: "plain HTTP" },
        { id: "credentials-in-url", weight: 30, label: "credentials" }
      ]
    });
    assert.strictEqual(result.score, 55);
    assert.strictEqual(result.level, "high");
    assert.strictEqual(result.reasons.length, 2);
    assert.deepStrictEqual(result.reasons.map((reason) => reason.id), ["not-https", "credentials-in-url"]);
  });

  it("adds a large weight when the host is in the offline threat list", () => {
    const result = scoreRisk({ threat: { status: "match", matchedDomain: "bad.example", ageDays: 1, stale: false } });
    assert.strictEqual(result.score, 60);
    assert.ok(result.reasons.some((reason) => reason.id === "threat-list-match"));
    assert.strictEqual(result.threatListStatus, "match");
  });

  it("does not add weight for a threat miss but still records the status", () => {
    const result = scoreRisk({ threat: { status: "not-found", ageDays: 2, stale: false } });
    assert.strictEqual(result.score, 0);
    assert.strictEqual(result.threatListStatus, "not-found");
    assert.strictEqual(result.threatListAgeDays, 2);
  });

  it("flags a newly registered domain", () => {
    const result = scoreRisk({ domainInfo: { status: "ok", ageDays: 3, registrar: "Example Registrar" } });
    assert.strictEqual(result.score, 25);
    assert.ok(result.reasons.some((reason) => reason.id === "new-domain"));
  });

  it("does not flag a domain older than the threshold", () => {
    const result = scoreRisk({ domainInfo: { status: "ok", ageDays: NEW_DOMAIN_DAYS + 1, registrar: "Example Registrar" } });
    assert.ok(!result.reasons.some((reason) => reason.id === "new-domain"));
  });

  it("notes a missing registrar without inflating the score", () => {
    const result = scoreRisk({ domainInfo: { status: "ok", ageDays: 400, registrar: null } });
    assert.strictEqual(result.score, 0);
    assert.ok(result.reasons.some((reason) => reason.id === "registrar-unknown"));
  });

  it("caps the score at 100", () => {
    const result = scoreRisk({
      urlFindings: [
        { id: "a", weight: 60, label: "a" },
        { id: "b", weight: 60, label: "b" }
      ],
      threat: { status: "match", matchedDomain: "bad.example", ageDays: 0, stale: false }
    });
    assert.strictEqual(result.score, 100);
    assert.strictEqual(result.level, "severe");
  });

  it("ignores malformed findings instead of crashing", () => {
    const result = scoreRisk({ urlFindings: [null, { id: "x" }, { id: "y", weight: "lots", label: "y" }] });
    assert.strictEqual(result.score, 0);
  });
});

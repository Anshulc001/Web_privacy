import { describe, it } from "node:test";
import assert from "node:assert";
import { sha256 } from "../lib/data-integrity.mjs";
import {
  canonicalizeThreatHosts,
  validateThreatData,
  checkHostForThreats,
  threatDataAgeDays,
  THREAT_SOURCE
} from "../lib/threat-checker.mjs";

const NOW = Date.parse("2026-10-25T00:00:00Z");

async function makeData({ hosts = ["bad.example", "phish.test"], buildDate = "2026-10-24T00:00:00Z", checksum } = {}) {
  const canonical = canonicalizeThreatHosts(hosts);
  return {
    version: "1.0.0",
    buildDate,
    checksum: checksum ?? (await sha256(JSON.stringify(canonical))),
    source: THREAT_SOURCE.name,
    data: { hosts: canonical }
  };
}

describe("canonicalizeThreatHosts", () => {
  it("normalizes, deduplicates and sorts hosts", () => {
    assert.deepStrictEqual(canonicalizeThreatHosts(["B.example", "a.example", "b.EXAMPLE"]), ["a.example", "b.example"]);
  });

  it("drops invalid entries and returns an empty array for non-arrays", () => {
    assert.deepStrictEqual(canonicalizeThreatHosts(["ok.example", "not a host", "", null]), ["ok.example"]);
    assert.deepStrictEqual(canonicalizeThreatHosts(null), []);
  });
});

describe("validateThreatData", () => {
  it("accepts a well-formed file", async () => {
    const data = await validateThreatData(await makeData(), NOW);
    assert.deepStrictEqual(data.data.hosts, ["bad.example", "phish.test"]);
  });

  it("rejects a wrong checksum", async () => {
    const corrupt = await makeData({ checksum: "sha256:nope" });
    await assert.rejects(() => validateThreatData(corrupt, NOW), /checksum/);
  });

  it("rejects a bad schema and future build dates", async () => {
    await assert.rejects(() => validateThreatData(null, NOW), /object/);
    await assert.rejects(() => validateThreatData({ data: { hosts: [] }, version: "1", buildDate: "x", checksum: "y" }, NOW), /build date/);
    const future = await makeData({ buildDate: "2031-01-01T00:00:00Z" });
    await assert.rejects(() => validateThreatData(future, NOW), /build date/);
  });

  it("rejects an empty list", async () => {
    const empty = await makeData({ hosts: [] });
    await assert.rejects(() => validateThreatData(empty, NOW), /number of hosts/);
  });
});

describe("checkHostForThreats", () => {
  it("matches the exact host and a parent domain", async () => {
    const data = await validateThreatData(await makeData(), NOW);
    assert.strictEqual(checkHostForThreats("bad.example", data, NOW).status, "match");
    assert.strictEqual(checkHostForThreats("login.bad.example", data, NOW).matchedDomain, "bad.example");
  });

  it("reports not-found without implying safety", async () => {
    const data = await validateThreatData(await makeData(), NOW);
    const result = checkHostForThreats("good.example", data, NOW);
    assert.strictEqual(result.status, "not-found");
    assert.strictEqual(result.matchedDomain, null);
    assert.strictEqual(result.safe, undefined);
  });

  it("marks a stale list but still matches", async () => {
    const data = await validateThreatData(await makeData({ buildDate: "2026-08-01T00:00:00Z" }), NOW);
    const result = checkHostForThreats("bad.example", data, NOW);
    assert.strictEqual(result.status, "match");
    assert.strictEqual(result.stale, true);
  });

  it("returns unavailable when the list is missing or unusable", () => {
    assert.strictEqual(checkHostForThreats("bad.example", null, NOW).status, "unavailable");
    assert.strictEqual(checkHostForThreats("bad.example", { buildDate: "x", data: { hosts: [] } }, NOW).status, "unavailable");
    assert.strictEqual(checkHostForThreats("not a host", { buildDate: "2026-10-24T00:00:00Z", data: { hosts: ["a.example"] } }, NOW).status, "unavailable");
  });

  it("includes the required attribution on any result", async () => {
    const data = await validateThreatData(await makeData(), NOW);
    const result = checkHostForThreats("bad.example", data, NOW);
    assert.ok(result.attribution.includes("Phishing.Database"));
    assert.ok(result.attribution.includes("MIT"));
  });
});

describe("threatDataAgeDays", () => {
  it("computes whole days and rejects invalid dates", () => {
    assert.strictEqual(threatDataAgeDays("2026-10-24T00:00:00Z", NOW), 1);
    assert.strictEqual(threatDataAgeDays("nope", NOW), null);
  });
});

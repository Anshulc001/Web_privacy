import { describe, it } from "node:test";
import assert from "node:assert";
import { sha256 } from "../lib/data-integrity.mjs";
import {
  canonicalizeBreaches,
  validateBreachData,
  checkHostForBreaches,
  describeFlags,
  breachDataAgeDays,
  BREACH_ATTRIBUTION,
  SELF_CHECK_LINKS
} from "../lib/breach-checker.mjs";

const NOW = Date.parse("2026-10-25T00:00:00Z");

function sampleBreaches() {
  return {
    "adobe.com": [
      {
        title: "Adobe",
        breachDate: "2013-10-04",
        pwnCount: 152445165,
        dataClasses: ["Email addresses", "Passwords"],
        description: "<p>In October 2013, <b>153 million</b> accounts &amp; more.</p>",
        disclosureUrl: "See the Adobe press release",
        flags: { unverified: false, fabricated: false, sensitive: false, retired: false, spamList: false, stealerLog: false }
      }
    ]
  };
}

async function makeData(overrides = {}) {
  const breaches = canonicalizeBreaches(overrides.breaches ?? sampleBreaches());
  return {
    version: "1.0.0",
    buildDate: overrides.buildDate ?? "2026-10-24T00:00:00Z",
    checksum: overrides.checksum ?? (await sha256(JSON.stringify(breaches))),
    source: "Have I Been Pwned",
    data: { breaches }
  };
}

describe("canonicalizeBreaches", () => {
  it("strips HTML from descriptions and keeps only https disclosure links", () => {
    const result = canonicalizeBreaches(sampleBreaches());
    const entry = result["adobe.com"][0];
    assert.strictEqual(entry.description, "In October 2013, 153 million accounts & more.");
    assert.ok(!entry.description.includes("<"));
    assert.strictEqual(entry.disclosureUrl, null, "non-URL disclosure text must be dropped");
  });

  it("drops entries that have an invalid domain", () => {
    const result = canonicalizeBreaches({ "not a domain": sampleBreaches()["adobe.com"], "ok.test": sampleBreaches()["adobe.com"] });
    assert.deepStrictEqual(Object.keys(result), ["ok.test"]);
  });
});

describe("validateBreachData", () => {
  it("accepts a well-formed file", async () => {
    const data = await validateBreachData(await makeData(), NOW);
    assert.strictEqual(Object.keys(data.data.breaches).length, 1);
  });

  it("rejects a wrong checksum", async () => {
    const file = await makeData({ checksum: "sha256:deadbeef" });
    await assert.rejects(() => validateBreachData(file, NOW), /checksum/);
  });

  it("rejects a missing schema or metadata", async () => {
    await assert.rejects(() => validateBreachData(null, NOW), /object/);
    await assert.rejects(() => validateBreachData({ data: {} }, NOW), /metadata/);
  });

  it("rejects a build date in the future", async () => {
    const file = await makeData({ buildDate: "2030-01-01T00:00:00Z" });
    await assert.rejects(() => validateBreachData(file, NOW), /build date/);
  });

  it("rejects empty breach data", async () => {
    const file = { version: "1", buildDate: "2026-10-24T00:00:00Z", checksum: await sha256(JSON.stringify({})), data: { breaches: {} } };
    await assert.rejects(() => validateBreachData(file, NOW), /number of domains/);
  });
});

describe("checkHostForBreaches", () => {
  it("matches the exact host and parent domains", async () => {
    const data = await makeData();
    assert.strictEqual(checkHostForBreaches("adobe.com", data, NOW).status, "match");
    assert.strictEqual(checkHostForBreaches("www.adobe.com", data, NOW).matchedDomain, "adobe.com");
    assert.strictEqual(checkHostForBreaches("a.b.adobe.com", data, NOW).matchedDomain, "adobe.com");
  });

  it("reports not-found rather than safe", async () => {
    const data = await makeData();
    const result = checkHostForBreaches("unknown.example", data, NOW);
    assert.strictEqual(result.status, "not-found");
    assert.deepStrictEqual(result.matches, []);
  });

  it("never matches a bare public suffix", async () => {
    const data = await makeData();
    assert.strictEqual(checkHostForBreaches("adobe.com", data, NOW).matchedDomain, "adobe.com");
    const suffixOnly = canonicalizeBreaches({ com: sampleBreaches()["adobe.com"], "co.uk": sampleBreaches()["adobe.com"] });
    assert.deepStrictEqual(Object.keys(suffixOnly), [], "bare suffix keys must be dropped");
  });

  it("keeps an https disclosure link when one is present", async () => {
    const breaches = canonicalizeBreaches({
      "adobe.com": [{ ...sampleBreaches()["adobe.com"][0], disclosureUrl: "https://example.test/disclosure" }]
    });
    assert.strictEqual(breaches["adobe.com"][0].disclosureUrl, "https://example.test/disclosure");
  });

  it("marks stale data and still returns matches", async () => {
    const data = await makeData({ buildDate: "2026-09-01T00:00:00Z" });
    const result = checkHostForBreaches("adobe.com", data, NOW);
    assert.strictEqual(result.status, "match");
    assert.strictEqual(result.stale, true);
  });

  it("returns unavailable when data is missing or unusable", () => {
    assert.strictEqual(checkHostForBreaches("adobe.com", null, NOW).status, "unavailable");
    assert.strictEqual(checkHostForBreaches("adobe.com", { data: {} }, NOW).status, "unavailable");
    assert.strictEqual(checkHostForBreaches("adobe.com", { buildDate: "nope", data: { breaches: {} } }, NOW).status, "unavailable");
    assert.strictEqual(checkHostForBreaches("not a host", { buildDate: "2026-10-24T00:00:00Z", data: { breaches: {} } }, NOW).status, "unavailable");
  });

  it("includes attribution and self-check links on a match", async () => {
    const data = await makeData();
    const result = checkHostForBreaches("adobe.com", data, NOW);
    assert.strictEqual(result.attribution.label, BREACH_ATTRIBUTION.label);
    assert.strictEqual(result.attribution.url, "https://haveibeenpwned.com");
    assert.ok(result.selfCheckLinks.length >= 3);
    assert.ok(SELF_CHECK_LINKS.every((link) => link.url.startsWith("https://")));
  });
});

describe("describeFlags", () => {
  it("turns flags into plain words, omitting false flags", () => {
    assert.deepStrictEqual(describeFlags({ unverified: true, fabricated: false, stealerLog: true }), ["unverified", "stealer log"]);
    assert.deepStrictEqual(describeFlags({}), []);
    assert.deepStrictEqual(describeFlags(null), []);
  });
});

describe("breachDataAgeDays", () => {
  it("computes whole days and rejects an invalid date", () => {
    assert.strictEqual(breachDataAgeDays("2026-10-24T00:00:00Z", NOW), 1);
    assert.strictEqual(breachDataAgeDays("not-a-date", NOW), null);
  });
});

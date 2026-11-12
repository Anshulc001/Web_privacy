import assert from "node:assert/strict";
import test from "node:test";
import { canonicalBlockingPayload, canonicalHostRules, sha256, validateBlockingData } from "../lib/data-integrity.mjs";

async function fixture(hosts = ["ads.example", "tracker.test"]) {
  return { version: "1.0.0", buildDate: "2026-10-24T00:00:00.000Z", checksum: await sha256(JSON.stringify(hosts)), source: "test", data: { hosts } };
}

test("validates bounded blocking data with an exact checksum", async () => {
  const data = await fixture();
  assert.deepEqual((await validateBlockingData(data, Date.parse("2026-10-25T00:00:00.000Z"))).data.hosts, ["ads.example", "tracker.test"]);
});

test("rejects corrupt checksums, duplicates, and future data", async () => {
  const data = await fixture();
  await assert.rejects(validateBlockingData({ ...data, checksum: "sha256:bad" }), /checksum/);
  await assert.rejects(validateBlockingData(await fixture(["same.test", "same.test"])), /duplicated/);
  await assert.rejects(validateBlockingData({ ...data, buildDate: "2099-01-01T00:00:00.000Z" }), /metadata/);
});

// The build script canonicalises before hashing, so the fixture does too: that is
// the contract that lets a differently ordered download still validate.
async function qualifiedFixture({ hosts = ["ads.example"], hostRules = [{ host: "pixel.test", condition: { resourceTypes: ["script", "image"], domainType: "thirdParty" } }] } = {}) {
  const canonical = canonicalHostRules(hostRules);
  return {
    version: "1.1.0",
    buildDate: "2026-10-24T00:00:00.000Z",
    checksum: await sha256(canonicalBlockingPayload({ hosts, hostRules: canonical ?? [] })),
    source: "test",
    data: { hosts, hostRules }
  };
}

test("accepts option-qualified host rules and canonicalises their conditions", async () => {
  const data = await qualifiedFixture({
    hostRules: [{ host: "Pixel.test", condition: { resourceTypes: ["image", "script"], domainType: "thirdParty" } }]
  });
  // The checksum was computed over the canonical form, so a differently ordered
  // but equivalent condition must still validate.
  const result = await validateBlockingData(data, Date.parse("2026-10-25T00:00:00.000Z"));
  assert.deepEqual(result.data.hostRules, [
    { host: "pixel.test", condition: { resourceTypes: ["script", "image"], domainType: "thirdParty" } }
  ]);
});

test("a file with no qualified rules keeps the original checksum shape", async () => {
  const data = await fixture();
  const result = await validateBlockingData(data, Date.parse("2026-10-25T00:00:00.000Z"));
  assert.deepEqual(result.data.hostRules, [], "old files must still load, just without qualified rules");
});

test("rejects host rules that are invalid, duplicated or wider than their own host", async () => {
  const duplicates = await qualifiedFixture({
    hostRules: [
      { host: "pixel.test", condition: { resourceTypes: ["script"], domainType: "thirdParty" } },
      { host: "pixel.test", condition: { resourceTypes: ["script"], domainType: "thirdParty" } }
    ]
  });
  await assert.rejects(validateBlockingData(duplicates), /host rules/);

  // A type-only condition is a narrower rule than the plain host block
  // (`||host^$document` blocks navigations only), so it must be accepted: 240 of
  // them were being thrown away when this was rejected.
  const typeOnly = await qualifiedFixture({ hostRules: [{ host: "pixel.test", condition: { resourceTypes: ["main_frame"] } }] });
  const accepted = await validateBlockingData(typeOnly, Date.parse("2026-10-25T00:00:00.000Z"));
  assert.deepEqual(accepted.data.hostRules, [{ host: "pixel.test", condition: { resourceTypes: ["main_frame"] } }]);

  const both = await qualifiedFixture({
    hosts: ["pixel.test"],
    hostRules: [{ host: "pixel.test", condition: { resourceTypes: ["script"], domainType: "thirdParty" } }]
  });
  await assert.rejects(validateBlockingData(both), /both widely and by condition/);

  const badType = await qualifiedFixture({ hostRules: [{ host: "pixel.test", condition: { resourceTypes: ["nonsense"] } }] });
  await assert.rejects(validateBlockingData(badType), /host rules/);
});

test("the checksum covers the qualified rules, so stripping them out fails", async () => {
  const data = await qualifiedFixture();
  const stripped = { ...data, data: { hosts: data.data.hosts } };
  await assert.rejects(validateBlockingData(stripped), /checksum/);
});

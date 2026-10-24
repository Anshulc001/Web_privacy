import assert from "node:assert/strict";
import test from "node:test";
import { sha256, validateBlockingData } from "../lib/data-integrity.mjs";

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

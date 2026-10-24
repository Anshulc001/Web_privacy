import assert from "node:assert/strict";
import test from "node:test";
import { createObservationStore, validateSiteObservation } from "../background/messages.mjs";

const sender = { id: "extension-id", tab: { id: 9 }, url: "https://Example.com/path?secret=1" };

test("accepts a bounded content-script observation and removes invalid hosts", () => {
  const result = validateSiteObservation({
    type: "webguard.siteObservation",
    permissionStates: { camera: "granted" },
    thirdPartyHosts: ["tracker.test", "tracker.test", "bad host!"]
  }, sender, "extension-id");
  assert.deepEqual(result, {
    hostname: "example.com", tabId: 9, thirdPartyHosts: ["tracker.test"],
    permissionStates: { camera: "granted", microphone: "unavailable", geolocation: "unavailable", notifications: "unavailable" }
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("rejects messages with the wrong sender, type, or oversized payload", () => {
  assert.equal(validateSiteObservation({ type: "webguard.siteObservation", thirdPartyHosts: [] }, { ...sender, id: "other" }, "extension-id"), null);
  assert.equal(validateSiteObservation({ type: "wrong", thirdPartyHosts: [] }, sender, "extension-id"), null);
  assert.equal(validateSiteObservation({ type: "webguard.siteObservation", thirdPartyHosts: [], padding: "a".repeat(12_001) }, sender, "extension-id"), null);
});

test("drops corrupt stored observations before they reach privileged APIs", async () => {
  const store = createObservationStore({
    async get() { return { siteObservations: { "example.com": { thirdPartyHosts: "not-an-array" } } }; },
    async set() {}
  });
  assert.equal(await store.get("example.com"), null);
});

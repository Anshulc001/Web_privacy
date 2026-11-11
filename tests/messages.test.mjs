import assert from "node:assert/strict";
import test from "node:test";
import {
  createObservationStore,
  validatePermissionRequest,
  validateSiteObservation
} from "../background/messages.mjs";

const sender = { id: "extension-id", tab: { id: 9 }, url: "https://Example.com/path?secret=1" };

test("accepts a bounded content-script observation and removes invalid hosts", () => {
  const result = validateSiteObservation({
    type: "webguard.siteObservation",
    thirdPartyHosts: ["tracker.test", "tracker.test", "bad host!", "example.com"]
  }, sender, "extension-id");
  assert.deepEqual(result, { hostname: "example.com", tabId: 9, thirdPartyHosts: ["tracker.test"] });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("rejects messages with the wrong sender, type, or oversized payload", () => {
  assert.equal(validateSiteObservation({ type: "webguard.siteObservation", thirdPartyHosts: [] }, { ...sender, id: "other" }, "extension-id"), null);
  assert.equal(validateSiteObservation({ type: "wrong", thirdPartyHosts: [] }, sender, "extension-id"), null);
  assert.equal(validateSiteObservation({ type: "webguard.siteObservation", thirdPartyHosts: [], padding: "a".repeat(12_001) }, sender, "extension-id"), null);
  assert.equal(validateSiteObservation({ type: "webguard.siteObservation" }, sender, "extension-id"), null);
});

test("accepts any reported permission name, from a content script only", () => {
  assert.deepEqual(
    validatePermissionRequest({ type: "webguard.permissionRequested", names: ["camera", "clipboard-read", "camera"] }, sender, "extension-id"),
    { hostname: "example.com", names: ["camera", "clipboard-read"] }
  );
  assert.equal(validatePermissionRequest({ type: "webguard.permissionRequested", names: ["camera"] }, { ...sender, id: "other" }, "extension-id"), null);
  assert.equal(validatePermissionRequest({ type: "webguard.permissionRequested", names: ["bad name"] }, sender, "extension-id"), null);
  assert.equal(validatePermissionRequest({ type: "webguard.permissionRequested", names: [] }, sender, "extension-id"), null);
});

test("drops corrupt stored observations before they reach privileged APIs", async () => {
  const store = createObservationStore({
    async get() { return { siteObservations: { "example.com": { thirdPartyHosts: "not-an-array" } } }; },
    async set() {}
  });
  assert.deepEqual(await store.get("example.com"), { thirdPartyHosts: [], requestedPermissions: [], updatedAt: 0 });
});

test("records requested names per site and keeps them across later observations", async () => {
  let stored = {};
  const store = createObservationStore({
    async get() { return stored; },
    async set(value) { stored = value; }
  });

  assert.deepEqual(await store.recordPermissions("example.com", ["camera"]), ["camera"]);
  assert.deepEqual(await store.recordPermissions("example.com", ["camera", "clipboard-read"]), ["camera", "clipboard-read"]);
  assert.deepEqual(await store.recordPermissions("other.test", ["midi"]), ["midi"]);

  // The document_idle observation must not forget what the page already asked for.
  await store.save({ hostname: "example.com", thirdPartyHosts: ["tracker.test"] });
  const entry = await store.get("example.com");
  assert.deepEqual(entry.thirdPartyHosts, ["tracker.test"]);
  assert.deepEqual(entry.requestedPermissions, ["camera", "clipboard-read"]);
  assert.deepEqual((await store.get("other.test")).requestedPermissions, ["midi"]);
});

test("keeps every name when a page reports several permissions at once", async () => {
  let stored = {};
  const store = createObservationStore({
    async get() { return stored; },
    async set(value) { stored = value; }
  });
  // A page that asks for four permissions in one tick delivers four messages at
  // the same time; storage is read-modify-write, so they must be serialized.
  await Promise.all(["camera", "microphone", "geolocation", "notifications"]
    .map((name) => store.recordPermissions("example.com", [name])));
  assert.deepEqual(
    (await store.get("example.com")).requestedPermissions,
    ["camera", "microphone", "geolocation", "notifications"]
  );
});

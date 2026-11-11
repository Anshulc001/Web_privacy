import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  readSitePermissionSettings,
  setSitePermission,
  SITE_PERMISSION_SETTINGS
} from "../background/permission-settings.mjs";

function fakeApi() {
  const calls = [];
  const make = (type) => ({
    async get({ primaryUrl }) {
      return { setting: primaryUrl.includes("blocked.example") ? "block" : "ask" };
    },
    async set(details) {
      calls.push({ type, ...details });
    }
  });
  return { calls, camera: make("camera"), microphone: make("microphone"), location: make("location"), notifications: make("notifications") };
}

describe("readSitePermissionSettings", () => {
  it("reads all four settings and maps geolocation to location", async () => {
    const api = fakeApi();
    const result = await readSitePermissionSettings(api, "Example.COM");
    assert.equal(result.status, "ok");
    assert.equal(result.hostname, "example.com");
    assert.deepEqual(result.settings, {
      camera: "ask",
      microphone: "ask",
      geolocation: "ask",
      notifications: "ask"
    });
  });

  it("reports a stored block value instead of flattening it to ask", async () => {
    const api = fakeApi();
    const result = await readSitePermissionSettings(api, "blocked.example");
    assert.equal(result.settings.camera, "block");
  });

  it("refuses to guess without a hostname or an API", async () => {
    assert.equal((await readSitePermissionSettings(fakeApi(), "not a host")).status, "unavailable");
    assert.equal((await readSitePermissionSettings(null, "example.com")).status, "unavailable");
  });

  it("marks a permission unavailable when Chrome rejects the read", async () => {
    const api = fakeApi();
    api.camera.get = async () => { throw new Error("no access"); };
    const result = await readSitePermissionSettings(api, "example.com");
    assert.equal(result.settings.camera, "unavailable");
    assert.equal(result.settings.microphone, "ask");
  });
});

describe("setSitePermission", () => {
  it("writes a wildcard-scheme rule for the right permission", async () => {
    const api = fakeApi();
    const result = await setSitePermission(api, "example.com", "geolocation", "block");
    assert.equal(result.status, "ok");
    assert.deepEqual(api.calls, [{ type: "location", primaryPattern: "*://example.com/*", setting: "block" }]);
  });

  it("rejects unknown permissions and invalid settings", async () => {
    const api = fakeApi();
    assert.equal((await setSitePermission(api, "example.com", "cookies", "block")).status, "unavailable");
    assert.equal((await setSitePermission(api, "example.com", "camera", "maybe")).status, "unavailable");
    assert.equal((await setSitePermission(api, "example.com", "camera", "block")).status, "ok");
    assert.deepEqual(SITE_PERMISSION_SETTINGS, ["allow", "ask", "block"]);
  });

  it("explains a Chrome failure instead of throwing", async () => {
    const api = fakeApi();
    api.notifications.set = async () => { throw new Error("policy"); };
    const result = await setSitePermission(api, "example.com", "notifications", "allow");
    assert.equal(result.status, "unavailable");
    assert.match(result.reason, /policy/);
  });
});

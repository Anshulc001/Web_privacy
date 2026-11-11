import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findTabForHost, probePagePermissions, probeTabPermissionStates } from "../background/site-probe.mjs";

const granted = { camera: "granted", microphone: "prompt", geolocation: "denied", notifications: "granted" };

describe("probeTabPermissionStates", () => {
  it("returns the content script's fresh states", async () => {
    const tabsApi = { async sendMessage(tabId, message) {
      assert.equal(tabId, 7);
      assert.equal(message.type, "webguard.probePermissions");
      return { permissionStates: granted };
    } };
    assert.deepEqual(await probeTabPermissionStates(tabsApi, 7, {}), granted);
  });

  it("falls back when the page has no content script", async () => {
    const tabsApi = { async sendMessage() { throw new Error("Receiving end does not exist"); } };
    assert.deepEqual(await probeTabPermissionStates(tabsApi, 7, { camera: "prompt" }), { camera: "prompt" });
    assert.equal(await probeTabPermissionStates(tabsApi, -1, null), null);
  });
});

describe("probePagePermissions", () => {
  it("finds the open tab for the host and probes that tab", async () => {
    const tabsApi = {
      async query() {
        return [
          { id: 1, url: "https://example.com/news" },
          { id: 2, url: "https://www.example.com/" }
        ];
      },
      async sendMessage(tabId) {
        assert.equal(tabId, 2);
        return { permissionStates: granted };
      }
    };
    const result = await probePagePermissions(tabsApi, "www.example.com", null);
    assert.equal(result.tab.id, 2);
    assert.deepEqual(result.permissionStates, granted);
  });

  it("returns the stored fallback when the site is not open", async () => {
    const tabsApi = { async query() { return [{ id: 1, url: "https://other.example/" }]; } };
    const result = await probePagePermissions(tabsApi, "example.com", { camera: "prompt" });
    assert.equal(result.tab, null);
    assert.deepEqual(result.permissionStates, { camera: "prompt" });
    assert.equal(await findTabForHost(tabsApi, "example.com"), null);
  });
});

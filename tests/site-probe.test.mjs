import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findTabForHost, probePagePermissions, probeTabPermissionStates } from "../background/site-probe.mjs";

const states = { camera: "granted", microphone: "prompt", "screen-wake-lock": "denied" };

describe("probeTabPermissionStates", () => {
  it("asks the content script only about the names it was given", async () => {
    const tabsApi = { async sendMessage(tabId, message) {
      assert.equal(tabId, 7);
      assert.equal(message.type, "webguard.probePermissions");
      assert.deepEqual(message.names, ["camera", "microphone", "screen-wake-lock"]);
      return { permissionStates: states };
    } };
    assert.deepEqual(await probeTabPermissionStates(tabsApi, 7, ["camera", "microphone", "screen-wake-lock"]), states);
  });

  it("reports nothing when no names are asked about or the page has no content script", async () => {
    const tabsApi = { async sendMessage() { throw new Error("Receiving end does not exist"); } };
    assert.equal(await probeTabPermissionStates(tabsApi, 7, ["camera"]), null);
    assert.equal(await probeTabPermissionStates(tabsApi, 7, []), null);
    assert.equal(await probeTabPermissionStates(tabsApi, -1, ["camera"]), null);
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
        return { permissionStates: states };
      }
    };
    const result = await probePagePermissions(tabsApi, "www.example.com", ["camera"]);
    assert.equal(result.tab.id, 2);
    assert.deepEqual(result.permissionStates, states);
  });

  it("returns no states when the site is not open", async () => {
    const tabsApi = { async query() { return [{ id: 1, url: "https://other.example/" }]; } };
    const result = await probePagePermissions(tabsApi, "example.com", ["camera"]);
    assert.equal(result.tab, null);
    assert.equal(result.permissionStates, null);
    assert.equal(await findTabForHost(tabsApi, "example.com"), null);
  });
});

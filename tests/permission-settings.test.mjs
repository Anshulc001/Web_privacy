import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  contentSettingTypes,
  ensurePermissionRulesVersion,
  loadPermissionOverrides,
  PERMISSION_OVERRIDES_KEY,
  PERMISSION_RULES_VERSION,
  PERMISSION_RULES_VERSION_KEY,
  readSitePermissionSettings,
  resolveContentSettingType,
  setSitePermission,
  SITE_PERMISSION_SETTINGS
} from "../background/permission-settings.mjs";

function hostFromPattern(pattern) {
  return pattern.replace(/^\*:\/\//, "").replace(/\/\*$/, "");
}

// A stand-in for chrome.contentSettings: one object per type, exactly the shape
// the real API exposes. The type list is a parameter so the tests prove the code
// reads whatever Chrome offers instead of a shipped set of names.
function fakeApi(types = ["camera", "microphone", "location", "notifications", "clipboard", "fullscreen", "mouselock", "images", "javascript"]) {
  const calls = [];
  const rules = Object.fromEntries(types.map((type) => [type, new Map()]));
  const api = {
    calls,
    rules,
    // Not a content-setting type: it must be ignored, not crashed on.
    notAContentSetting: { get: "nope", set: null }
  };
  for (const type of types) {
    api[type] = {
      async get({ primaryUrl }) {
        const host = new URL(primaryUrl).hostname;
        if (rules[type].has(host)) return { setting: rules[type].get(host) };
        return { setting: host === "blocked.example" ? "block" : "ask" };
      },
      async set(details) {
        calls.push({ type, ...details });
        rules[type].set(hostFromPattern(details.primaryPattern), details.setting);
      },
      async clear(details) {
        calls.push({ type, clear: details });
        rules[type].clear();
      }
    };
  }
  return api;
}

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) {
      return { [key]: data[key] };
    },
    async set(patch) {
      Object.assign(data, patch);
    }
  };
}

describe("contentSettingTypes", () => {
  it("lists whatever types Chrome exposes, without a shipped name list", () => {
    const api = fakeApi(["camera", "automaticDownloads", "sensors"]);
    assert.deepEqual(contentSettingTypes(api), ["camera", "automaticDownloads", "sensors"]);
    assert.deepEqual(contentSettingTypes(null), []);
  });
});

describe("resolveContentSettingType", () => {
  it("maps a page permission name to Chrome's type", () => {
    const api = fakeApi();
    assert.equal(resolveContentSettingType(api, "camera"), "camera");
    assert.equal(resolveContentSettingType(api, "geolocation"), "location");
    // Chrome stores one clipboard setting for both directions.
    assert.equal(resolveContentSettingType(api, "clipboard-read"), "clipboard");
    assert.equal(resolveContentSettingType(api, "clipboard-write"), "clipboard");
  });

  it("refuses the deprecated types that crash Chrome when read", () => {
    // chrome.contentSettings still lists these, but reading them kills the
    // renderer in Chrome 121, so the row stays state-only.
    const api = fakeApi();
    assert.equal(resolveContentSettingType(api, "pointer-lock"), null);
    assert.equal(resolveContentSettingType(api, "mouselock"), null);
    assert.equal(resolveContentSettingType(api, "fullscreen"), null);
  });

  it("accepts a type this build has never seen, and refuses one Chrome lacks", () => {
    const api = fakeApi(["camera", "sensors"]);
    assert.equal(resolveContentSettingType(api, "sensors"), "sensors");
    assert.equal(resolveContentSettingType(api, "persistent-storage"), null);
    assert.equal(resolveContentSettingType(null, "camera"), null);
  });
});

describe("readSitePermissionSettings", () => {
  it("reads exactly the names it was given, mapping geolocation to location", async () => {
    const api = fakeApi();
    const result = await readSitePermissionSettings(api, "Example.COM", { names: ["geolocation", "camera"] });
    assert.equal(result.status, "ok");
    assert.equal(result.hostname, "example.com");
    assert.deepEqual(result.settings, { geolocation: "ask", camera: "ask" });
  });

  it("has no setting to report for a permission Chrome cannot store", async () => {
    const api = fakeApi();
    const result = await readSitePermissionSettings(api, "example.com", { names: ["camera", "persistent-storage"] });
    assert.deepEqual(Object.keys(result.settings), ["camera"]);
  });

  it("reports a stored block value instead of flattening it to ask", async () => {
    const api = fakeApi();
    const result = await readSitePermissionSettings(api, "blocked.example", { names: ["camera"] });
    assert.equal(result.settings.camera, "block");
  });

  it("refuses to guess without a hostname or an API", async () => {
    assert.equal((await readSitePermissionSettings(fakeApi(), "not a host", { names: ["camera"] })).status, "unavailable");
    assert.equal((await readSitePermissionSettings(null, "example.com", { names: ["camera"] })).status, "unavailable");
  });

  it("marks a permission unavailable when Chrome rejects the read", async () => {
    const api = fakeApi();
    api.camera.get = async () => { throw new Error("no access"); };
    const result = await readSitePermissionSettings(api, "example.com", { names: ["camera", "microphone"] });
    assert.equal(result.settings.camera, "unavailable");
    assert.equal(result.settings.microphone, "ask");
  });
});

describe("setSitePermission", () => {
  it("writes a wildcard-scheme rule and tracks it under Chrome's type", async () => {
    const api = fakeApi();
    const storage = fakeStorage();
    const result = await setSitePermission(api, "example.com", "geolocation", "block", { storageArea: storage });
    assert.equal(result.status, "ok");
    assert.deepEqual(api.calls, [{ type: "location", primaryPattern: "*://example.com/*", setting: "block" }]);
    assert.deepEqual(storage.data[PERMISSION_OVERRIDES_KEY].location, { "example.com": "block" });
  });

  it("controls a permission outside the old four", async () => {
    const api = fakeApi();
    const storage = fakeStorage();
    const result = await setSitePermission(api, "example.com", "clipboard-read", "allow", { storageArea: storage });
    assert.equal(result.status, "ok");
    assert.deepEqual(api.rules.clipboard, new Map([["example.com", "allow"]]));
    assert.deepEqual(storage.data[PERMISSION_OVERRIDES_KEY].clipboard, { "example.com": "allow" });
  });

  it("withdraws only that site's rule when the setting is ask", async () => {
    const api = fakeApi();
    const storage = fakeStorage();
    await setSitePermission(api, "keep.example", "notifications", "allow", { storageArea: storage });
    await setSitePermission(api, "drop.example", "notifications", "block", { storageArea: storage });
    api.calls.length = 0;

    const result = await setSitePermission(api, "drop.example", "notifications", "ask", { storageArea: storage });
    assert.equal(result.status, "ok");
    // Chrome clears every rule of the type, so the other site is written back.
    assert.deepEqual(api.calls, [
      { type: "notifications", clear: { scope: "regular" } },
      { type: "notifications", primaryPattern: "*://keep.example/*", setting: "allow" }
    ]);
    assert.deepEqual(api.rules.notifications, new Map([["keep.example", "allow"]]));
    assert.deepEqual(storage.data[PERMISSION_OVERRIDES_KEY].notifications, { "keep.example": "allow" });
  });

  it("leaves the rules of other permissions alone", async () => {
    const api = fakeApi();
    const storage = fakeStorage();
    await setSitePermission(api, "example.com", "camera", "allow", { storageArea: storage });
    api.calls.length = 0;
    await setSitePermission(api, "example.com", "clipboard-write", "ask", { storageArea: storage });
    assert.deepEqual(api.calls, [{ type: "clipboard", clear: { scope: "regular" } }]);
    assert.deepEqual(api.rules.camera, new Map([["example.com", "allow"]]));
    assert.deepEqual(storage.data[PERMISSION_OVERRIDES_KEY].camera, { "example.com": "allow" });
  });

  it("does not re-impose a tracked rule Chrome no longer holds", async () => {
    const api = fakeApi();
    const storage = fakeStorage();
    await setSitePermission(api, "keep.example", "notifications", "allow", { storageArea: storage });
    // The reader changed it in Chrome's own site settings since WebGuard wrote it.
    api.rules.notifications.set("keep.example", "block");
    api.calls.length = 0;

    const result = await setSitePermission(api, "other.example", "notifications", "ask", { storageArea: storage });
    assert.equal(result.status, "ok");
    assert.deepEqual(api.calls, [{ type: "notifications", clear: { scope: "regular" } }]);
    assert.equal(storage.data[PERMISSION_OVERRIDES_KEY].notifications, undefined);
  });

  it("never writes an ask rule, so Chrome's own value applies again", async () => {
    const api = fakeApi();
    const storage = fakeStorage();
    await setSitePermission(api, "example.com", "camera", "allow", { storageArea: storage });
    await setSitePermission(api, "example.com", "camera", "ask", { storageArea: storage });
    assert.equal(api.rules.camera.has("example.com"), false);
    const read = await readSitePermissionSettings(api, "example.com", { names: ["camera"] });
    assert.equal(read.settings.camera, "ask");
  });

  it("refuses ask without a place to remember the other rules", async () => {
    const result = await setSitePermission(fakeApi(), "example.com", "notifications", "ask");
    assert.equal(result.status, "unavailable");
    assert.match(result.reason, /overrides/i);
  });

  it("rejects a name Chrome has no setting for, and invalid settings", async () => {
    const api = fakeApi();
    const refused = await setSitePermission(api, "example.com", "persistent-storage", "block");
    assert.equal(refused.status, "unavailable");
    assert.match(refused.reason, /no per-site setting/i);
    assert.equal((await setSitePermission(api, "example.com", "camera", "maybe")).status, "unavailable");
    assert.equal((await setSitePermission(api, "example.com", "camera", "block", { storageArea: fakeStorage() })).status, "ok");
    assert.deepEqual(SITE_PERMISSION_SETTINGS, ["allow", "ask", "block"]);
  });

  it("explains a Chrome failure instead of throwing", async () => {
    const api = fakeApi();
    api.notifications.set = async () => { throw new Error("policy"); };
    const result = await setSitePermission(api, "example.com", "notifications", "allow", { storageArea: fakeStorage() });
    assert.equal(result.status, "unavailable");
    assert.match(result.reason, /policy/);
  });
});

describe("loadPermissionOverrides", () => {
  it("keeps only valid hostnames and allow/block values, by Chrome type", async () => {
    const storage = fakeStorage({
      [PERMISSION_OVERRIDES_KEY]: {
        camera: { "Good.Example": "allow", "bad host": "allow", "block.example": "maybe" },
        automaticDownloads: { "example.com": "block" },
        "not a type": { "example.com": "block" },
        "": { "example.com": "block" }
      }
    });
    const overrides = await loadPermissionOverrides(storage);
    assert.deepEqual(overrides, {
      camera: { "good.example": "allow" },
      automaticDownloads: { "example.com": "block" }
    });
  });
});

describe("ensurePermissionRulesVersion", () => {
  it("clears the rules the previous format could have written, once", async () => {
    const api = fakeApi();
    const storage = fakeStorage();
    assert.equal(await ensurePermissionRulesVersion(api, storage), true);
    // Only the four types the old format wrote: clearing every type Chrome lists
    // crashed the extension's own pages, and untouched types have nothing to clean.
    assert.deepEqual(api.calls.map((call) => call.type).sort(), ["camera", "location", "microphone", "notifications"]);
    assert.equal(storage.data[PERMISSION_RULES_VERSION_KEY], PERMISSION_RULES_VERSION);

    api.calls.length = 0;
    assert.equal(await ensurePermissionRulesVersion(api, storage), false);
    assert.deepEqual(api.calls, []);
  });

  it("also clears a type the tracked map remembers, and forgets the map", async () => {
    const api = fakeApi();
    const storage = fakeStorage({ [PERMISSION_OVERRIDES_KEY]: { clipboard: { "example.com": "allow" } } });
    assert.equal(await ensurePermissionRulesVersion(api, storage), true);
    assert.deepEqual(
      api.calls.map((call) => call.type).sort(),
      ["camera", "clipboard", "location", "microphone", "notifications"]
    );
    assert.deepEqual(storage.data[PERMISSION_OVERRIDES_KEY], {});
  });
});

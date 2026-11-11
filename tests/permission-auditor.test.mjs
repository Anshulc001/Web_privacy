import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_REQUESTED_PERMISSIONS,
  normalizePermissionName,
  normalizePermissionStates,
  normalizeRequestedPermissions
} from "../background/permission-auditor.mjs";

test("keeps the state of every name it was asked about, known or not", () => {
  assert.deepEqual(normalizePermissionStates({ camera: "granted", "screen-wake-lock": "denied", midi: "other" }, ["camera", "midi", "screen-wake-lock"]), {
    camera: "granted",
    midi: "unavailable",
    "screen-wake-lock": "denied"
  });
});

test("never invents a name the page did not ask for", () => {
  assert.deepEqual(normalizePermissionStates({ camera: "granted", microphone: "granted" }, ["camera"]), { camera: "granted" });
  for (const value of [undefined, null, [], "granted"]) {
    assert.deepEqual(normalizePermissionStates(value, ["notifications"]), { notifications: "unavailable" });
    assert.deepEqual(normalizePermissionStates(value), {});
  }
});

test("accepts any well-formed permission name and drops everything else", () => {
  assert.deepEqual(
    normalizeRequestedPermissions(["camera", "Camera", "camera", "clipboard-read", "bad name", "", null, 7, "-x", "a"]),
    ["camera", "clipboard-read"]
  );
  assert.deepEqual(normalizeRequestedPermissions("camera"), []);
  assert.deepEqual(normalizeRequestedPermissions(["x".repeat(41)]), []);
});

test("caps how many names a page can make the extension remember", () => {
  const many = Array.from({ length: MAX_REQUESTED_PERMISSIONS + 5 }, (_, index) => `permission-${index}`);
  assert.equal(normalizeRequestedPermissions(many).length, MAX_REQUESTED_PERMISSIONS);
});

test("validates one permission name by shape, not by a known list", () => {
  assert.equal(normalizePermissionName("  Camera "), "camera");
  assert.equal(normalizePermissionName("clipboard-read"), "clipboard-read");
  assert.equal(normalizePermissionName("screen-wake-lock"), "screen-wake-lock");
  for (const value of ["", "a", "-cam", "1cam", "bad name", "x".repeat(41), null, 42, {}]) {
    assert.equal(normalizePermissionName(value), null, `expected null for ${JSON.stringify(value)}`);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { normalizePermissionStates, SENSITIVE_PERMISSION_NAMES } from "../background/permission-auditor.mjs";

test("keeps the four states the browser reports and drops anything else", () => {
  assert.deepEqual(normalizePermissionStates({ camera: "granted", microphone: "other", geolocation: "denied", notifications: "prompt" }), {
    camera: "granted",
    microphone: "unavailable",
    geolocation: "denied",
    notifications: "prompt"
  });
});

test("reports every permission as unavailable when a page said nothing", () => {
  for (const value of [undefined, null, [], "granted"]) {
    const states = normalizePermissionStates(value);
    assert.deepEqual(Object.keys(states), SENSITIVE_PERMISSION_NAMES);
    assert.ok(Object.values(states).every((state) => state === "unavailable"));
  }
});

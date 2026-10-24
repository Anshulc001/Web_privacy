import assert from "node:assert/strict";
import test from "node:test";
import { auditPermissions, normalizePermissionStates, setExpectedSite } from "../background/permission-auditor.mjs";

test("uses unavailable for unsupported permission states and flags unexplained grants", () => {
  assert.deepEqual(normalizePermissionStates({ camera: "other", microphone: "denied" }), {
    camera: "unavailable", microphone: "denied", geolocation: "unavailable", notifications: "unavailable"
  });
  const audit = auditPermissions("ordinary-shop.test", { camera: "granted", microphone: "prompt", geolocation: "denied", notifications: "unavailable" });
  assert.equal(audit.alerts.length, 1);
  assert.match(audit.alerts[0].message, /heuristic, not a verdict/);
});

test("does not alert expected sites and persists the expected-site choice", async () => {
  let saved;
  const settingsStore = {
    async load() { return { expectedSites: ["already.test"] }; },
    async save(value) { saved = value; return value; }
  };
  await setExpectedSite(settingsStore, "Meet.Test", true);
  assert.deepEqual(saved.expectedSites, ["already.test", "meet.test"]);
  assert.equal(auditPermissions("meet.test", { camera: "granted" }, ["meet.test"]).alerts.length, 0);
});

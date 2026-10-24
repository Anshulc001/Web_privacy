import { normalizeHostname } from "./history-store.mjs";

export const SENSITIVE_PERMISSION_NAMES = ["camera", "microphone", "geolocation", "notifications"];
const EXPECTED_HOST_KEYWORDS = {
  camera: ["meet", "zoom", "teams", "webex", "discord", "messenger"],
  microphone: ["meet", "zoom", "teams", "webex", "discord", "messenger"],
  geolocation: ["map", "weather", "uber", "lyft", "delivery"],
  notifications: ["mail", "news", "slack", "discord", "calendar"]
};

export function normalizePermissionStates(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return Object.fromEntries(SENSITIVE_PERMISSION_NAMES.map((name) => [name, "unavailable"]));
  }
  return Object.fromEntries(SENSITIVE_PERMISSION_NAMES.map((name) => {
    const state = candidate[name];
    return [name, state === "granted" || state === "denied" || state === "prompt" || state === "unavailable" ? state : "unavailable"];
  }));
}

function plausiblyExpected(hostname, permission) {
  return EXPECTED_HOST_KEYWORDS[permission].some((keyword) => hostname.includes(keyword));
}

export function auditPermissions(hostname, states, expectedSites = []) {
  const host = normalizeHostname(hostname);
  const normalizedStates = normalizePermissionStates(states);
  if (!host) {
    return { states: normalizedStates, alerts: [], expected: false };
  }
  const expected = expectedSites.map(normalizeHostname).includes(host);
  const alerts = expected ? [] : SENSITIVE_PERMISSION_NAMES
    .filter((permission) => normalizedStates[permission] === "granted" && !plausiblyExpected(host, permission))
    .map((permission) => ({
      permission,
      message: `${permission} is granted; this is a heuristic, not a verdict.`
    }));
  return { states: normalizedStates, alerts, expected };
}

export async function setExpectedSite(settingsStore, hostname, expected) {
  const host = normalizeHostname(hostname);
  if (!host || typeof expected !== "boolean") {
    throw new TypeError("A valid hostname and expected boolean are required.");
  }
  const settings = await settingsStore.load();
  const sites = new Set(settings.expectedSites.map(normalizeHostname).filter(Boolean));
  if (expected) sites.add(host); else sites.delete(host);
  return settingsStore.save({ expectedSites: [...sites].sort() });
}

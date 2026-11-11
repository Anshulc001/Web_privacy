export const SENSITIVE_PERMISSION_NAMES = ["camera", "microphone", "geolocation", "notifications"];

/**
 * Keeps only the four permission states the browser reports as a string, so the
 * popup and the dashboard never render an empty cell for a permission the page
 * did not ask about.
 */
export function normalizePermissionStates(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return Object.fromEntries(SENSITIVE_PERMISSION_NAMES.map((name) => [name, "unavailable"]));
  }
  return Object.fromEntries(SENSITIVE_PERMISSION_NAMES.map((name) => {
    const state = candidate[name];
    return [name, state === "granted" || state === "denied" || state === "prompt" || state === "unavailable" ? state : "unavailable"];
  }));
}

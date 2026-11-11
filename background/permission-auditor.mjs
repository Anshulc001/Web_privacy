/**
 * Permission names are discovered at runtime, not from a list the extension
 * ships: a site tells WebGuard what it asked for, and that set is what gets
 * probed and displayed. The only thing validated here is shape, so a hostile
 * page cannot store arbitrary text and the store cannot grow without bound.
 */
const PERMISSION_NAME_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
export const MAX_REQUESTED_PERMISSIONS = 40;

export function normalizePermissionName(candidate) {
  if (typeof candidate !== "string") return null;
  const name = candidate.trim().toLowerCase();
  return PERMISSION_NAME_PATTERN.test(name) ? name : null;
}

/** Deduplicates, validates and caps a list of permission names. */
export function normalizeRequestedPermissions(candidate) {
  if (!Array.isArray(candidate)) return [];
  const names = [];
  for (const entry of candidate) {
    const name = normalizePermissionName(entry);
    if (name && !names.includes(name)) names.push(name);
    if (names.length >= MAX_REQUESTED_PERMISSIONS) break;
  }
  return names;
}

/**
 * Reads the state of exactly the names it was given, so a permission WebGuard
 * has never heard of still shows up once a site asks for it. An unknown or
 * unsupported name is reported as "unavailable" rather than dropped, because
 * "the browser will not say" and "the site never asked" are different facts.
 */
export function normalizePermissionStates(candidate, names = []) {
  const wanted = normalizeRequestedPermissions(names);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return Object.fromEntries(wanted.map((name) => [name, "unavailable"]));
  }
  return Object.fromEntries(wanted.map((name) => {
    const state = candidate[name];
    return [name, state === "granted" || state === "denied" || state === "prompt" ? state : "unavailable"];
  }));
}

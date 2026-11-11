import { hostnameFromUrl, normalizeHostname } from "./history-store.mjs";

/**
 * Chrome's per-site content settings are the only place a stored allow / ask /
 * block for one site lives, and Chrome decides which types exist. That list is
 * read from chrome.contentSettings at runtime (see contentSettingTypes), so the
 * Permissions panel is not limited to a set of names this extension ships: a
 * permission Chrome stores a setting for gets a control even if WebGuard has
 * never heard of it.
 *
 * Only two mappings are needed, and both are about names, not about which
 * permissions are supported:
 * - the page calls it "geolocation", Chrome's content setting is "location", and
 *   "pointer-lock" is Chrome's "mouselock";
 * - clipboard-read / clipboard-write / midi-sysex share one Chrome setting, so
 *   the name before the first dash is the type when an exact match does not
 *   exist. Two rows can therefore show one underlying setting, which is honest:
 *   Chrome cannot allow reading a clipboard and block writing it per site.
 */
const PERMISSION_TYPE_ALIASES = Object.freeze({
  geolocation: "location",
  "pointer-lock": "mouselock"
});

export const SITE_PERMISSION_SETTINGS = Object.freeze(["allow", "ask", "block"]);

/**
 * Types chrome.contentSettings still lists but that are gone in Chrome 121, and
 * reading them kills the calling renderer ("Target crashed", reproduced from both
 * an extension page and the worker for fullscreen and mouselock; the same crash
 * made clearing every type unsafe). They report no stored value at all, so the
 * row keeps the page's live state and says Chrome has no per-site setting. This
 * is a list of broken Chrome types, not of permissions WebGuard understands, and
 * it can shrink as Chrome removes them for good.
 */
const UNSAFE_CONTENT_SETTING_TYPES = new Set(["fullscreen", "mouselock"]);

/** Every content-setting type this Chrome exposes, in the API's own order. */
export function contentSettingTypes(contentSettings) {
  if (!contentSettings || typeof contentSettings !== "object") return [];
  const types = [];
  for (const key of Object.keys(contentSettings)) {
    let api;
    try {
      api = contentSettings[key];
    } catch {
      continue;
    }
    if (api && typeof api.get === "function" && typeof api.set === "function" && typeof api.clear === "function") {
      types.push(key);
    }
  }
  return types;
}

/** The content-setting type a page permission name maps to, or null. */
export function resolveContentSettingType(contentSettings, permission) {
  if (typeof permission !== "string" || !permission) return null;
  const types = contentSettingTypes(contentSettings);
  if (types.length === 0) return null;
  const alias = PERMISSION_TYPE_ALIASES[permission];
  const type = alias && types.includes(alias)
    ? alias
    : types.includes(permission)
      ? permission
      : types.includes(permission.replace(/-.*$/, ""))
        ? permission.replace(/-.*$/, "")
        : null;
  if (!type || UNSAFE_CONTENT_SETTING_TYPES.has(type)) return null;
  return type;
}

/**
 * WebGuard's own Allow/Block rules, keyed by Chrome's content-setting type and
 * then by host. Chrome can only clear every rule an extension set for a type, so
 * this map is what lets "Ask" withdraw one site's rule without dropping the
 * other sites'.
 */
export const PERMISSION_OVERRIDES_KEY = "permissionOverrides";

/**
 * Chrome has no per-site clear, and an extension-written "ask" rule keeps the
 * site at Chrome's prompt and wins over the reader's decision in the prompt.
 * This version marker makes the worker clear the previous rules once, so a site
 * that was pinned at "ask" is released. Version 3 moved the map from permission
 * names to Chrome types.
 */
export const PERMISSION_RULES_VERSION_KEY = "permissionRulesVersion";
export const PERMISSION_RULES_VERSION = 3;

const TYPE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const MAX_OVERRIDE_TYPES = 60;
const MAX_OVERRIDE_HOSTS = 500;

function normalizeSetting(value) {
  return value === "allow" || value === "block" ? value : "ask";
}

function emptyOverrides() {
  return {};
}

/**
 * Keeps only allow/block entries with a valid hostname, grouped by a key shaped
 * like a content-setting type. Shape only: which types exist is a runtime fact,
 * and unknown keys are simply never applied.
 */
export function normalizePermissionOverrides(value) {
  const result = emptyOverrides();
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [rawType, entry] of Object.entries(value)) {
    if (Object.keys(result).length >= MAX_OVERRIDE_TYPES) break;
    if (!TYPE_KEY_PATTERN.test(rawType)) continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const hosts = {};
    for (const [host, setting] of Object.entries(entry)) {
      if (Object.keys(hosts).length >= MAX_OVERRIDE_HOSTS) break;
      const normalized = normalizeHostname(host);
      if (normalized && (setting === "allow" || setting === "block")) hosts[normalized] = setting;
    }
    if (Object.keys(hosts).length > 0) result[rawType] = hosts;
  }
  return result;
}

export async function loadPermissionOverrides(storageArea) {
  if (!storageArea) return emptyOverrides();
  try {
    const stored = await storageArea.get(PERMISSION_OVERRIDES_KEY);
    return normalizePermissionOverrides(stored?.[PERMISSION_OVERRIDES_KEY]);
  } catch {
    return emptyOverrides();
  }
}

async function savePermissionOverrides(storageArea, overrides) {
  await storageArea.set({ [PERMISSION_OVERRIDES_KEY]: overrides });
}

function patternFor(host) {
  return `*://${host}/*`;
}

async function applyOverrides(contentSettings, type, entries) {
  for (const [host, setting] of Object.entries(entries ?? {})) {
    await contentSettings[type].set({ primaryPattern: patternFor(host), setting });
  }
}

/**
 * Keeps only the tracked rules Chrome still holds as WebGuard wrote them. A
 * setting changed in Chrome's own site settings would otherwise be silently
 * overwritten the next time any site of that type is set back to "ask".
 */
async function reconcileOverrides(contentSettings, type, entries) {
  const current = {};
  for (const [host, setting] of Object.entries(entries ?? {})) {
    try {
      const answer = await contentSettings[type].get({ primaryUrl: `https://${host}/` });
      if (answer?.setting === setting) current[host] = setting;
    } catch {
      // An unreadable entry is dropped rather than re-imposed blindly.
    }
  }
  return current;
}

/** True when Chrome lets an extension write a per-site setting for this name. */
export function canEditSitePermission(contentSettings, permission) {
  return Boolean(resolveContentSettingType(contentSettings, permission));
}

/**
 * Reads Chrome's own per-site setting for the given page permission names. These
 * are the persisted "allow / ask / block" values, not the transient
 * granted/denied state the page reported. A name Chrome has no setting for is
 * left out of the map, which is how the panel knows the row is state-only.
 */
export async function readSitePermissionSettings(contentSettings, hostname, { primaryUrl = null, names = [] } = {}) {
  const host = normalizeHostname(hostname);
  const settings = {};
  if (!host) {
    return { status: "unavailable", reason: "A hostname is required.", hostname: null, settings };
  }
  if (!contentSettings) {
    return { status: "unavailable", reason: "Permission settings are unavailable.", hostname: host, settings };
  }
  // The page's own URL keeps the scheme and port Chrome used when it created the
  // exception; a synthetic https URL would miss an http site's rule.
  const url = typeof primaryUrl === "string" && hostnameFromUrl(primaryUrl) === host
    ? primaryUrl
    : `https://${host}/`;
  for (const name of Array.isArray(names) ? names : []) {
    const type = resolveContentSettingType(contentSettings, name);
    if (!type) continue;
    try {
      const answer = await contentSettings[type].get({ primaryUrl: url });
      settings[name] = normalizeSetting(answer?.setting);
    } catch {
      settings[name] = "unavailable";
    }
  }
  return { status: "ok", hostname: host, settings };
}

/**
 * Applies one setting to one site.
 *
 * "ask" is Chrome's default, not an override: an extension-written "ask" rule
 * keeps the site prompting and wins over the decision the reader makes in
 * Chrome's own prompt, so choosing it removes WebGuard's rule instead of adding
 * one. Chrome removes rules per content type rather than per site, so the
 * remaining sites' rules are written back from the tracked map.
 */
export async function setSitePermission(contentSettings, hostname, permission, setting, { storageArea } = {}) {
  const host = normalizeHostname(hostname);
  if (!host) return { status: "unavailable", reason: "A hostname is required." };
  const type = resolveContentSettingType(contentSettings, permission);
  if (!type) return { status: "unavailable", reason: "Chrome has no per-site setting for this permission." };
  if (!SITE_PERMISSION_SETTINGS.includes(setting)) {
    return { status: "unavailable", reason: "Setting must be allow, ask or block." };
  }

  if (setting !== "ask") {
    try {
      await contentSettings[type].set({ primaryPattern: patternFor(host), setting });
    } catch (error) {
      return { status: "unavailable", reason: String(error?.message ?? error) };
    }
    if (storageArea) {
      const overrides = await loadPermissionOverrides(storageArea);
      overrides[type] = { ...(overrides[type] ?? {}), [host]: setting };
      await savePermissionOverrides(storageArea, overrides).catch(() => {});
    }
    return { status: "ok", hostname: host, permission, setting };
  }

  if (!storageArea) {
    return { status: "unavailable", reason: "Permission overrides are unavailable." };
  }
  const overrides = await loadPermissionOverrides(storageArea);
  const remaining = { ...(overrides[type] ?? {}) };
  delete remaining[host];
  // Read before clearing, while Chrome still holds the rules being checked.
  const kept = await reconcileOverrides(contentSettings, type, remaining);
  if (Object.keys(kept).length > 0) overrides[type] = kept;
  else delete overrides[type];
  try {
    await contentSettings[type].clear({ scope: "regular" });
  } catch (error) {
    return { status: "unavailable", reason: String(error?.message ?? error) };
  }
  // Saved before rewriting so a failed rewrite can be retried from the map.
  await savePermissionOverrides(storageArea, overrides).catch(() => {});
  try {
    await applyOverrides(contentSettings, type, kept);
  } catch (error) {
    return { status: "unavailable", reason: String(error?.message ?? error) };
  }
  return { status: "ok", hostname: host, permission, setting };
}

/**
 * The only types the previous rule formats could write. This is a migration
 * detail, not the list of permissions the panel offers.
 */
const LEGACY_WRITTEN_TYPES = Object.freeze(["camera", "microphone", "location", "notifications"]);

/**
 * Clears every content-setting rule this extension has set and forgets the
 * tracked map. Used once when the rule format changes, because the old "ask"
 * rules have to go for the affected sites to prompt normally again.
 *
 * Only the rules WebGuard could have written are touched: the four types the
 * previous format wrote, plus whatever the stored map tracks. Clearing every
 * type chrome.contentSettings lists is not safe — doing that on worker start
 * crashed the extension's own pages in Chrome 121, and types this extension
 * never wrote have nothing to clean up anyway.
 */
export async function resetExtensionPermissionRules(contentSettings, storageArea) {
  if (!contentSettings || !storageArea) return false;
  const known = contentSettingTypes(contentSettings);
  const tracked = Object.keys(await loadPermissionOverrides(storageArea));
  const types = [...new Set([...LEGACY_WRITTEN_TYPES, ...tracked])].filter((type) => known.includes(type));
  for (const type of types) {
    try {
      await contentSettings[type].clear({ scope: "regular" });
    } catch {
      // A type that cannot be cleared must not stop the others.
    }
  }
  await storageArea.set({
    [PERMISSION_OVERRIDES_KEY]: emptyOverrides(),
    [PERMISSION_RULES_VERSION_KEY]: PERMISSION_RULES_VERSION
  });
  return true;
}

/** Runs the one-time cleanup unless this profile already has the new rules. */
export async function ensurePermissionRulesVersion(contentSettings, storageArea) {
  if (!contentSettings || !storageArea) return false;
  try {
    const stored = await storageArea.get(PERMISSION_RULES_VERSION_KEY);
    if (stored?.[PERMISSION_RULES_VERSION_KEY] === PERMISSION_RULES_VERSION) return false;
  } catch {
    return false;
  }
  return resetExtensionPermissionRules(contentSettings, storageArea);
}

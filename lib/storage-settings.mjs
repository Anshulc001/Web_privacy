import { hostCoveredBy } from "./host-match.mjs";

export const SETTINGS_KEY = "settings";
export const DATA_URL_BASE =
  "https://raw.githubusercontent.com/Anshulc001/Web_privacy/main/data/";

export const DEFAULT_SETTINGS = Object.freeze({
  historyRetentionHours: 168,
  historyPaused: false,
  blockingEnabled: true,
  // Registry data is loaded for a selected site without a second click; the
  // switch keeps that automatic request optional.
  autoDomainLookup: true,
  // Frozen so the fallback returned for invalid settings cannot be mutated by a
  // caller; otherwise a push to that array would change the defaults for every
  // later read in the same worker.
  siteAllowlist: Object.freeze([]),
  // Sites the reader asked to block *every* third-party request on. A separate list
  // because it is the opposite of the allowlist: same mechanism (host plus
  // registrable domain), opposite effect, and a site must never be in both.
  strictSites: Object.freeze([])
});

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function normalizeSettings(candidate = {}) {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ...DEFAULT_SETTINGS };
  }

  const retention = candidate.historyRetentionHours;
  return {
    historyRetentionHours:
      Number.isInteger(retention) && retention >= 24 && retention <= 168
        ? retention
        : DEFAULT_SETTINGS.historyRetentionHours,
    historyPaused:
      typeof candidate.historyPaused === "boolean"
        ? candidate.historyPaused
        : DEFAULT_SETTINGS.historyPaused,
    blockingEnabled:
      typeof candidate.blockingEnabled === "boolean"
        ? candidate.blockingEnabled
        : DEFAULT_SETTINGS.blockingEnabled,
    autoDomainLookup:
      typeof candidate.autoDomainLookup === "boolean"
        ? candidate.autoDomainLookup
        : DEFAULT_SETTINGS.autoDomainLookup,
    siteAllowlist: isStringArray(candidate.siteAllowlist)
      ? [...new Set(candidate.siteAllowlist)]
      : [],
    strictSites: isStringArray(candidate.strictSites)
      ? [...new Set(candidate.strictSites.map((host) => host.trim().toLowerCase()).filter(Boolean))]
      : []
  };
}

/**
 * The one place that decides which site mode is in force. Off beats strict: a site
 * the reader allowlisted must stay untouched even if it was also marked strict,
 * which is what the DNR priorities already do (allow 10 > strict 2 > block 1).
 */
export function resolveSiteMode(hostname, settings) {
  // hostCoveredBy is the same test the DNR allow rules use (host plus registrable
  // domain), so the popup cannot disagree with what blocking does.
  if (hostCoveredBy(hostname, settings?.siteAllowlist)) return "off";
  return hostCoveredBy(hostname, settings?.strictSites) ? "strict" : "basic";
}

export function createSettingsStore(storageArea) {
  if (!storageArea || typeof storageArea.get !== "function" || typeof storageArea.set !== "function") {
    throw new TypeError("A Chrome-compatible storage area is required.");
  }

  async function read() {
    try {
      const stored = await storageArea.get(SETTINGS_KEY);
      return normalizeSettings(stored?.[SETTINGS_KEY]);
    } catch (error) {
      throw new Error("Could not read WebGuard settings.", { cause: error });
    }
  }

  async function write(patch) {
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
      throw new TypeError("Settings updates must be an object.");
    }
    const settings = normalizeSettings({ ...(await read()), ...patch });
    try {
      await storageArea.set({ [SETTINGS_KEY]: settings });
      return settings;
    } catch (error) {
      throw new Error("Could not save WebGuard settings.", { cause: error });
    }
  }

  // Each save reads the whole settings object and writes it back, so two updates
  // fired close together used to clobber each other: changing retention while
  // ticking "pause history" could silently switch recording back on. Writes are
  // serialized so every save sees the result of the previous one.
  let pending = Promise.resolve();

  return {
    load: read,
    save(patch) {
      const result = pending.then(() => write(patch), () => write(patch));
      pending = result.then(() => undefined, () => undefined);
      return result;
    }
  };
}

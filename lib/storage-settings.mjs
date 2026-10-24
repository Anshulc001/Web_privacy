export const SETTINGS_KEY = "settings";
export const DATA_URL_BASE =
  "https://raw.githubusercontent.com/Anshulc001/Web_privacy/main/data/";

export const DEFAULT_SETTINGS = Object.freeze({
  historyRetentionHours: 48,
  historyPaused: false,
  blockingEnabled: true,
  expectedSites: [],
  siteAllowlist: []
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
    expectedSites: isStringArray(candidate.expectedSites)
      ? [...new Set(candidate.expectedSites)]
      : [],
    siteAllowlist: isStringArray(candidate.siteAllowlist)
      ? [...new Set(candidate.siteAllowlist)]
      : []
  };
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

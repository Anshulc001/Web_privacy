import { validateBlockingData } from "../lib/data-integrity.mjs";
import { BREACH_DATA_FILE, BREACH_DATA_KEY, validateBreachData } from "../lib/breach-checker.mjs";
import { THREAT_DATA_FILE, THREAT_DATA_KEY, validateThreatData } from "../lib/threat-checker.mjs";
import { DATA_URL_BASE } from "../lib/storage-settings.mjs";

export const BLOCKING_DATA_KEY = "blockingData";
export const BLOCKING_DATA_URL = `${DATA_URL_BASE}ad-tracker-data.json`;
export const BREACH_DATA_URL = `${DATA_URL_BASE}${BREACH_DATA_FILE}`;
export const THREAT_DATA_URL = `${DATA_URL_BASE}${THREAT_DATA_FILE}`;
export const LAST_SYNC_KEY = "dataLastSync";

// The blocklists change daily at most, and the alarm that refreshes them is a
// 24-hour one. A worker starts for every page, so it must not treat each start as
// a reason to download three files and rebuild ~25,000 dynamic rules.
export const DATA_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
// A failed download is retried sooner than a successful one: the profile is left
// with older data, and the next page load is a reasonable retry point.
export const DATA_SYNC_RETRY_MS = 60 * 60 * 1000;

function describeError(error) {
  return String(error?.message ?? error);
}

/** Whether a data kind needs a download now, judged from its last sync record. */
export function isSyncDue(status, kind, now = Date.now()) {
  const entry = status?.[kind];
  if (!entry || typeof entry.at !== "string") return true;
  const at = Date.parse(entry.at);
  if (!Number.isFinite(at)) return true;
  const age = now - at;
  // A record from the future means the clock moved; retrying is the safe answer.
  if (age < 0) return true;
  return age >= (entry.ok ? DATA_SYNC_INTERVAL_MS : DATA_SYNC_RETRY_MS);
}

export function createDataSync(fetchImpl, storageArea, blockingManager, settingsStore) {
  async function storeLastSync(kind, ok) {
    try {
      const stored = await storageArea.get(LAST_SYNC_KEY);
      const current = stored?.[LAST_SYNC_KEY] && typeof stored[LAST_SYNC_KEY] === "object" ? stored[LAST_SYNC_KEY] : {};
      await storageArea.set({ [LAST_SYNC_KEY]: { ...current, [kind]: { at: new Date().toISOString(), ok } } });
    } catch {
      // Recording sync history is best-effort; it must never break the sync itself.
    }
  }

  /** Download, validate, store, and never lose the last good copy on failure. */
  async function syncFile({ kind, key, url, validate, afterStore }) {
    try {
      const response = await fetchImpl(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`Download failed: ${response.status}`);
      const data = await validate(await response.json());
      const stored = await storageArea.get(key);
      const previous = stored?.[key];
      // The list changes by a handful of hosts on a normal day, but applying it
      // costs a full DNR rewrite of every downloaded host rule. An identical
      // checksum means there is nothing new to apply, so the costly side effect
      // is skipped; the copy is not rewritten either, since it is byte-identical.
      if (previous && typeof previous.checksum === "string" && previous.checksum === data.checksum) {
        await storageArea.set({ [`${kind}DataLastSync`]: new Date().toISOString() });
        await storeLastSync(kind, true);
        return { status: "unchanged", data };
      }
      if (afterStore) await afterStore(data);
      await storageArea.set({ [key]: data, [`${kind}DataLastSync`]: new Date().toISOString() });
      await storeLastSync(kind, true);
      return { status: "updated", data };
    } catch (error) {
      await storeLastSync(kind, false);
      const stored = await storageArea.get(key);
      return { status: "outdated", data: stored?.[key] ?? null, error: describeError(error) };
    }
  }

  /** First-run path: use the copy bundled in the package so checks work offline. */
  async function seedFromBundle({ kind, key, file, validate }) {
    const stored = await storageArea.get(key);
    if (stored?.[key]) return { status: "present" };
    try {
      const response = await fetchImpl(new URL(`../data/${file}`, import.meta.url), { cache: "no-store" });
      if (!response.ok) throw new Error(`Bundled file unreadable: ${response.status}`);
      const data = await validate(await response.json());
      await storageArea.set({ [key]: data, [`${kind}DataSource`]: "bundled" });
      return { status: "seeded", data };
    } catch (error) {
      return { status: "unavailable", error: describeError(error) };
    }
  }

  return {
    syncBlockingData() {
      return syncFile({
        kind: "blocking",
        key: BLOCKING_DATA_KEY,
        url: BLOCKING_DATA_URL,
        validate: (candidate) => validateBlockingData(candidate),
        afterStore: async (data) => {
          const settings = await settingsStore.load();
          await blockingManager.applyRemoteHosts(data.data.hosts, settings.blockingEnabled, data.data.hostRules ?? []);
        }
      });
    },

    syncBreachData() {
      return syncFile({ kind: "breach", key: BREACH_DATA_KEY, url: BREACH_DATA_URL, validate: (candidate) => validateBreachData(candidate), afterStore: null });
    },

    syncThreatData() {
      return syncFile({ kind: "threat", key: THREAT_DATA_KEY, url: THREAT_DATA_URL, validate: (candidate) => validateThreatData(candidate), afterStore: null });
    },

    seedBreachDataFromBundle() {
      return seedFromBundle({ kind: "breach", key: BREACH_DATA_KEY, file: BREACH_DATA_FILE, validate: (candidate) => validateBreachData(candidate) });
    },

    seedThreatDataFromBundle() {
      return seedFromBundle({ kind: "threat", key: THREAT_DATA_KEY, file: THREAT_DATA_FILE, validate: (candidate) => validateThreatData(candidate) });
    },

    async readSyncStatus() {
      const stored = await storageArea.get(LAST_SYNC_KEY);
      const value = stored?.[LAST_SYNC_KEY];
      return value && typeof value === "object" ? value : {};
    }
  };
}

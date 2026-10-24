export const HISTORY_KEY = "historyEvents";
export const MIN_RETENTION_HOURS = 24;
export const MAX_RETENTION_HOURS = 168;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeHostname(value) {
  if (typeof value !== "string") {
    return null;
  }
  const hostname = value.trim().toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname.length > 253 || /[^a-z0-9.:-]/.test(hostname)) {
    return null;
  }
  return hostname;
}

export function hostnameFromUrl(value) {
  if (typeof value !== "string" || value.length > 8_192) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? normalizeHostname(url.hostname)
      : null;
  } catch {
    return null;
  }
}

export function retentionMilliseconds(hours) {
  if (!Number.isInteger(hours) || hours < MIN_RETENTION_HOURS || hours > MAX_RETENTION_HOURS) {
    throw new RangeError("History retention must be between 24 and 168 whole hours.");
  }
  return hours * 60 * 60 * 1_000;
}

export function normalizeHistory(records) {
  if (!Array.isArray(records)) {
    return [];
  }
  return records.flatMap((record) => {
    if (!isPlainObject(record)) {
      return [];
    }
    const hostname = normalizeHostname(record.hostname);
    const timestamp = record.timestamp;
    return hostname && Number.isFinite(timestamp) && timestamp >= 0
      ? [{ hostname, timestamp }]
      : [];
  });
}

export function pruneHistory(records, now, retentionHours) {
  if (!Number.isFinite(now)) {
    throw new TypeError("The current time must be a finite timestamp.");
  }
  const cutoff = now - retentionMilliseconds(retentionHours);
  return normalizeHistory(records)
    .filter((record) => record.timestamp >= cutoff && record.timestamp <= now)
    .sort((left, right) => left.timestamp - right.timestamp);
}

export function createHistoryStore(storageArea, now = () => Date.now()) {
  if (!storageArea || typeof storageArea.get !== "function" || typeof storageArea.set !== "function") {
    throw new TypeError("A Chrome-compatible storage area is required.");
  }
  if (typeof now !== "function") {
    throw new TypeError("A clock function is required.");
  }

  async function read() {
    try {
      const stored = await storageArea.get(HISTORY_KEY);
      return normalizeHistory(stored?.[HISTORY_KEY]);
    } catch (error) {
      throw new Error("Could not read WebGuard history.", { cause: error });
    }
  }

  async function write(records) {
    try {
      await storageArea.set({ [HISTORY_KEY]: records });
    } catch (error) {
      throw new Error("Could not save WebGuard history.", { cause: error });
    }
  }

  return {
    read,
    async recordHostname(hostname, retentionHours, paused = false) {
      const validHostname = normalizeHostname(hostname);
      if (!validHostname) {
        throw new TypeError("A valid hostname is required.");
      }
      if (typeof paused !== "boolean") {
        throw new TypeError("The paused setting must be a boolean.");
      }
      const currentTime = now();
      const retained = pruneHistory(await read(), currentTime, retentionHours);
      const records = paused ? retained : [...retained, { hostname: validHostname, timestamp: currentTime }];
      await write(records);
      return { recorded: !paused, records };
    },
    async recordUrl(url, retentionHours, paused = false) {
      const hostname = hostnameFromUrl(url);
      if (!hostname) {
        return { recorded: false, ignored: true, records: pruneHistory(await read(), now(), retentionHours) };
      }
      return this.recordHostname(hostname, retentionHours, paused);
    },
    async prune(retentionHours) {
      const records = pruneHistory(await read(), now(), retentionHours);
      await write(records);
      return records;
    },
    async clear() {
      await write([]);
    }
  };
}

export function createNavigationRecorder(tabs, historyStore, settingsStore) {
  if (!tabs || typeof tabs.get !== "function") {
    throw new TypeError("A Chrome-compatible tabs API is required.");
  }
  if (!historyStore || typeof historyStore.recordUrl !== "function") {
    throw new TypeError("A history store is required.");
  }
  if (!settingsStore || typeof settingsStore.load !== "function") {
    throw new TypeError("A settings store is required.");
  }

  return async function recordTopLevelNavigation(details) {
    if (!isPlainObject(details) || details.frameId !== 0 || !Number.isInteger(details.tabId) || details.tabId < 0) {
      return { recorded: false, ignored: true };
    }
    const tab = await tabs.get(details.tabId);
    if (tab?.incognito) {
      return { recorded: false, ignored: true };
    }
    const settings = await settingsStore.load();
    return historyStore.recordUrl(details.url, settings.historyRetentionHours, settings.historyPaused);
  };
}

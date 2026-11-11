import { hostnameFromUrl, normalizeHostname } from "./history-store.mjs";
import { normalizeRequestedPermissions } from "./permission-auditor.mjs";

export const SITE_OBSERVATIONS_KEY = "siteObservations";
const MAX_MESSAGE_BYTES = 12_000;
const MAX_HOSTS = 100;

function senderHostname(sender, extensionId) {
  if (sender?.id !== extensionId || !Number.isInteger(sender?.tab?.id)) return null;
  return hostnameFromUrl(sender.url);
}

export function validateSiteObservation(message, sender, extensionId) {
  const hostname = senderHostname(sender, extensionId);
  if (!hostname || !message || typeof message !== "object") return null;
  if (message.type !== "webguard.siteObservation") return null;
  try {
    if (JSON.stringify(message).length > MAX_MESSAGE_BYTES) return null;
  } catch { return null; }
  const hosts = Array.isArray(message.thirdPartyHosts)
    ? [...new Set(message.thirdPartyHosts.map(normalizeHostname).filter(Boolean))].slice(0, MAX_HOSTS)
    : null;
  if (!hosts) return null;
  return { hostname, tabId: sender.tab.id, thirdPartyHosts: hosts.filter((host) => host !== hostname) };
}

/**
 * A page reported that it asked Chrome for these permissions. The names are
 * kept verbatim (validated for shape only) so a permission the extension has
 * never seen still reaches the dashboard.
 */
export function validatePermissionRequest(message, sender, extensionId) {
  const hostname = senderHostname(sender, extensionId);
  if (!hostname || !message || typeof message !== "object") return null;
  if (message.type !== "webguard.permissionRequested") return null;
  const names = normalizeRequestedPermissions(message.names);
  return names.length > 0 ? { hostname, names } : null;
}

export function createObservationStore(storageArea) {
  function normalizeStoredObservation(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return {
      thirdPartyHosts: [...new Set((Array.isArray(value.thirdPartyHosts) ? value.thirdPartyHosts : [])
        .map(normalizeHostname).filter(Boolean))].slice(0, MAX_HOSTS),
      requestedPermissions: normalizeRequestedPermissions(value.requestedPermissions),
      updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0
    };
  }
  async function read() {
    const stored = await storageArea.get(SITE_OBSERVATIONS_KEY);
    const source = stored?.[SITE_OBSERVATIONS_KEY];
    if (!source || typeof source !== "object" || Array.isArray(source)) return {};
    return Object.fromEntries(Object.entries(source)
      .map(([hostname, value]) => [normalizeHostname(hostname), normalizeStoredObservation(value)])
      .filter(([hostname, value]) => hostname && value));
  }
  async function write(next) {
    for (const [hostname, value] of Object.entries(next)) {
      if (value) next[hostname] = { ...value, updatedAt: Date.now() };
    }
    await storageArea.set({ [SITE_OBSERVATIONS_KEY]: next });
  }
  // A page can request several permissions in one tick, so the worker receives
  // those messages concurrently. Storage is a read-modify-write, so without this
  // queue the last write would win and the earlier names would vanish.
  let pending = Promise.resolve();
  function serialize(task) {
    const result = pending.then(task, task);
    pending = result.then(() => {}, () => {});
    return result;
  }
  return {
    save(observation) {
      return serialize(async () => {
        const all = await read();
        // The requested names are written by their own message, which can arrive
        // before or after this one; keeping them prevents a later observation from
        // forgetting what the page already asked for.
        const previous = all[observation.hostname];
        all[observation.hostname] = {
          thirdPartyHosts: observation.thirdPartyHosts,
          requestedPermissions: previous?.requestedPermissions ?? [],
          updatedAt: Date.now()
        };
        await write(all);
      });
    },
    /** Adds newly observed permission names without touching the rest. */
    recordPermissions(hostname, names) {
      const host = normalizeHostname(hostname);
      const fresh = normalizeRequestedPermissions(names);
      if (!host || fresh.length === 0) return Promise.resolve([]);
      return serialize(async () => {
        const all = await read();
        const previous = all[host] ?? { thirdPartyHosts: [], requestedPermissions: [], updatedAt: 0 };
        const merged = [...previous.requestedPermissions];
        for (const name of fresh) if (!merged.includes(name)) merged.push(name);
        all[host] = { ...previous, requestedPermissions: normalizeRequestedPermissions(merged), updatedAt: Date.now() };
        await write(all);
        return all[host].requestedPermissions;
      });
    },
    async get(hostname) {
      // Reads wait for queued writes so a report taken right after a request
      // already sees it.
      await pending;
      const all = await read();
      return all[hostname] ?? null;
    }
  };
}

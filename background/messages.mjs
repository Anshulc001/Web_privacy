import { hostnameFromUrl, normalizeHostname } from "./history-store.mjs";
import { normalizePermissionStates } from "./permission-auditor.mjs";

export const SITE_OBSERVATIONS_KEY = "siteObservations";
const MAX_MESSAGE_BYTES = 12_000;
const MAX_HOSTS = 100;

export function validateSiteObservation(message, sender, extensionId) {
  if (sender?.id !== extensionId || !Number.isInteger(sender?.tab?.id) || !message || typeof message !== "object") return null;
  if (message.type !== "webguard.siteObservation") return null;
  try {
    if (JSON.stringify(message).length > MAX_MESSAGE_BYTES) return null;
  } catch { return null; }
  const hostname = hostnameFromUrl(sender.url);
  const hosts = Array.isArray(message.thirdPartyHosts)
    ? [...new Set(message.thirdPartyHosts.map(normalizeHostname).filter(Boolean))].slice(0, MAX_HOSTS)
    : null;
  if (!hostname || !hosts) return null;
  return { hostname, tabId: sender.tab.id, thirdPartyHosts: hosts.filter((host) => host !== hostname), permissionStates: normalizePermissionStates(message.permissionStates) };
}

export function createObservationStore(storageArea) {
  function normalizeStoredObservation(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.thirdPartyHosts)) return null;
    return {
      thirdPartyHosts: [...new Set(value.thirdPartyHosts.map(normalizeHostname).filter(Boolean))].slice(0, MAX_HOSTS),
      permissionStates: normalizePermissionStates(value.permissionStates),
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
  return {
    async save(observation) {
      const all = await read();
      await storageArea.set({ [SITE_OBSERVATIONS_KEY]: { ...all, [observation.hostname]: {
        thirdPartyHosts: observation.thirdPartyHosts,
        permissionStates: observation.permissionStates,
        updatedAt: Date.now()
      } } });
    },
    async get(hostname) {
      const all = await read();
      return all[hostname] ?? null;
    }
  };
}

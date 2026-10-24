import { normalizeHost } from "./host-match.mjs";

export const IANA_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
export const BOOTSTRAP_CACHE_KEY = "rdapBootstrap";
export const BOOTSTRAP_MAX_AGE_MS = 7 * 86_400_000;
export const RDAP_TIMEOUT_MS = 8_000;

const MAX_RESPONSE_BYTES = 512_000;

export const TLS_LIMITATION =
  "TLS certificate details are not available to browser extensions, so they are not shown here.";

function withTimeout(signal) {
  return signal ?? (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(RDAP_TIMEOUT_MS) : undefined);
}

/** Picks the RDAP base URL for a hostname's TLD from the IANA bootstrap. */
export function rdapBaseForHost(hostname, bootstrap) {
  const host = normalizeHost(hostname);
  if (!host) return null;
  const services = bootstrap?.services;
  if (!Array.isArray(services)) return null;

  const labels = host.split(".");
  const tld = labels[labels.length - 1];
  for (const service of services) {
    if (!Array.isArray(service) || service.length < 2) continue;
    const [tlds, urls] = service;
    if (!Array.isArray(tlds) || !Array.isArray(urls)) continue;
    if (!tlds.some((entry) => typeof entry === "string" && entry.toLowerCase() === tld)) continue;
    const httpsUrl = urls.find((url) => typeof url === "string" && url.startsWith("https://"));
    if (httpsUrl) return httpsUrl.endsWith("/") ? httpsUrl : `${httpsUrl}/`;
  }
  return null;
}

function findRegistrar(payload) {
  const entities = Array.isArray(payload?.entities) ? payload.entities : [];
  for (const entity of entities) {
    const roles = Array.isArray(entity?.roles) ? entity.roles : [];
    if (!roles.includes("registrar")) continue;
    const vcard = entity?.vcardArray;
    if (Array.isArray(vcard) && Array.isArray(vcard[1])) {
      for (const field of vcard[1]) {
        if (Array.isArray(field) && field[0] === "fn" && typeof field[3] === "string" && field[3].trim()) {
          return field[3].trim().slice(0, 200);
        }
      }
    }
    if (typeof entity?.handle === "string" && entity.handle.trim()) return entity.handle.trim().slice(0, 200);
  }
  return null;
}

function findRegistrationDate(payload) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  for (const event of events) {
    if (event?.eventAction === "registration" && typeof event.eventDate === "string") {
      const parsed = Date.parse(event.eventDate);
      if (Number.isFinite(parsed)) return { iso: new Date(parsed).toISOString(), time: parsed };
    }
  }
  return null;
}

/**
 * Looks a domain up in RDAP. Only called when the user explicitly asks, because
 * it sends the hostname to the relevant registry.
 */
export async function lookupDomain(hostname, { fetchImpl = fetch, bootstrap = null, now = Date.now(), includeTlsNote = true } = {}) {
  const host = normalizeHost(hostname);
  if (!host) return { status: "unavailable", reason: "No valid hostname to look up.", tlsNote: includeTlsNote ? TLS_LIMITATION : null };

  let effectiveBootstrap = bootstrap;
  if (!effectiveBootstrap) {
    try {
      const response = await fetchImpl(IANA_BOOTSTRAP_URL, { cache: "no-store", signal: withTimeout() });
      if (!response.ok) throw new Error(`Bootstrap request failed: ${response.status}`);
      effectiveBootstrap = await response.json();
    } catch (error) {
      return { status: "unavailable", reason: `RDAP bootstrap could not be loaded (${String(error.message ?? error)}).`, tlsNote: includeTlsNote ? TLS_LIMITATION : null };
    }
  }

  const base = rdapBaseForHost(host, effectiveBootstrap);
  if (!base) {
    return { status: "unsupported", reason: "No RDAP service is published for this top-level domain.", hostname: host, tlsNote: includeTlsNote ? TLS_LIMITATION : null };
  }

  let payload;
  try {
    const response = await fetchImpl(`${base}domain/${encodeURIComponent(host)}`, {
      cache: "no-store",
      headers: { accept: "application/rdap+json, application/json" },
      signal: withTimeout()
    });
    if (response.status === 404) {
      return { status: "not-found", reason: "The registry has no record for this domain.", hostname: host, tlsNote: includeTlsNote ? TLS_LIMITATION : null };
    }
    if (!response.ok) throw new Error(`RDAP request failed: ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error("RDAP response was too large.");
    payload = JSON.parse(text);
  } catch (error) {
    return { status: "unavailable", reason: `RDAP lookup failed (${String(error.message ?? error)}).`, hostname: host, tlsNote: includeTlsNote ? TLS_LIMITATION : null };
  }

  const registrar = findRegistrar(payload);
  const registration = findRegistrationDate(payload);
  const ageDays = registration ? Math.max(0, Math.floor((now - registration.time) / 86_400_000)) : null;

  return {
    status: "ok",
    hostname: host,
    registrar,
    registrationDate: registration?.iso ?? null,
    ageDays,
    isNewDomain: Number.isInteger(ageDays) ? ageDays < 30 : null,
    source: new URL(base).hostname,
    tlsNote: includeTlsNote ? TLS_LIMITATION : null
  };
}

export function createBootstrapStore(storageArea) {
  return {
    async read() {
      try {
        const stored = await storageArea.get(BOOTSTRAP_CACHE_KEY);
        const cached = stored?.[BOOTSTRAP_CACHE_KEY];
        if (!cached || typeof cached !== "object" || !Array.isArray(cached.services)) return null;
        if (!Number.isFinite(cached.savedAt) || Date.now() - cached.savedAt > BOOTSTRAP_MAX_AGE_MS) return null;
        return cached;
      } catch {
        return null;
      }
    },
    async save(bootstrap) {
      if (!bootstrap || !Array.isArray(bootstrap.services)) return null;
      const record = { services: bootstrap.services, savedAt: Date.now() };
      try {
        await storageArea.set({ [BOOTSTRAP_CACHE_KEY]: record });
        return record;
      } catch {
        return null;
      }
    }
  };
}

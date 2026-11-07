import { IPV4_PATTERN, normalizeHost, registrableDomain } from "./host-match.mjs";

export const IANA_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
export const BOOTSTRAP_CACHE_KEY = "rdapBootstrap";
export const DOMAIN_CACHE_KEY = "domainInfoCache";
export const BOOTSTRAP_MAX_AGE_MS = 7 * 86_400_000;
export const RDAP_TIMEOUT_MS = 8_000;
const DOMAIN_CACHE_MAX_AGE_MS = 86_400_000;
const DOMAIN_CACHE_LIMIT = 50;

/**
 * Built-in RDAP endpoints, used when the IANA bootstrap has not been downloaded
 * yet (first run, offline, or a blocked request). Every value is the base a
 * `domain/<name>` path is appended to, and every value was verified against the
 * live service, so a lookup never lands on an invented endpoint.
 *
 * `.io`, `.me` and `.ai` are served by Identity Digital's RDAP even though they
 * publish no IANA bootstrap entry; `.us` and `.gg` run their own.
 */
export const RDAP_BASE_BY_TLD = Object.freeze({
  com: "https://rdap.verisign.com/com/v1/",
  net: "https://rdap.verisign.com/net/v1/",
  org: "https://rdap.publicinterestregistry.org/rdap/",
  info: "https://rdap.identitydigital.services/rdap/",
  biz: "https://rdap.nic.biz/",
  ai: "https://rdap.identitydigital.services/rdap/",
  io: "https://rdap.identitydigital.services/rdap/",
  me: "https://rdap.identitydigital.services/rdap/",
  us: "https://rdap.nic.us/",
  ca: "https://rdap.ca.fury.ca/rdap/",
  au: "https://rdap.cctld.au/rdap/",
  nl: "https://rdap.sidn.nl/",
  fr: "https://rdap.nic.fr/",
  in: "https://rdap.nixiregistry.in/rdap/",
  xyz: "https://rdap.centralnic.com/xyz/",
  tech: "https://rdap.radix.host/rdap/",
  tv: "https://rdap.nic.tv/",
  cc: "https://tld-rdap.verisign.com/cc/v1/",
  br: "https://rdap.registro.br/",
  uk: "https://rdap.nominet.uk/uk/"
});

/**
 * rdap.org resolves the right registry for a name through the IANA bootstrap and
 * then proxies the request, so it covers TLDs that publish no usable RDAP
 * service of their own (`.co`, `.eu`, `.gg`, and any new gTLD) instead of
 * failing with "unsupported".
 */
export const RDAP_AGGREGATOR_BASE = "https://rdap.org/";

export const TLS_LIMITATION =
  "TLS certificate details are not available to browser extensions, so they are not shown here.";

const MAX_RESPONSE_BYTES = 512_000;

function withTimeout(signal) {
  return signal ?? (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(RDAP_TIMEOUT_MS) : undefined);
}

/** Every label suffix of a name, longest first: bbc.co.uk -> ["co.uk", "uk"]. */
function suffixLabels(domain) {
  const labels = domain.split(".");
  const suffixes = [];
  for (let index = 1; index < labels.length; index += 1) suffixes.push(labels.slice(index).join("."));
  return suffixes;
}

function bootstrapBaseFor(bootstrap, suffix) {
  const services = bootstrap?.services;
  if (!Array.isArray(services)) return null;
  for (const service of services) {
    if (!Array.isArray(service) || service.length < 2) continue;
    const [tlds, urls] = service;
    if (!Array.isArray(tlds) || !Array.isArray(urls)) continue;
    if (!tlds.some((entry) => typeof entry === "string" && entry.toLowerCase() === suffix)) continue;
    const httpsUrl = urls.find((url) => typeof url === "string" && url.startsWith("https://"));
    if (httpsUrl) return httpsUrl.endsWith("/") ? httpsUrl : `${httpsUrl}/`;
  }
  return null;
}

/**
 * Picks the RDAP base URL for a hostname: the live IANA bootstrap first (it is
 * the authority on which registry serves a suffix), then the built-in map, then
 * the rdap.org aggregator. Returns null only when there is no registrable
 * domain to ask about — an IP, a bare suffix or a local-only name.
 */
export function rdapBaseForHost(hostname, bootstrap = null) {
  const host = normalizeHost(hostname);
  if (!host || IPV4_PATTERN.test(host)) return null;
  const root = registrableDomain(host);
  if (!root) return null;

  for (const suffix of suffixLabels(root)) {
    const base = bootstrapBaseFor(bootstrap, suffix);
    if (base) return base;
  }

  const builtIn = RDAP_BASE_BY_TLD[root.split(".").pop()];
  if (builtIn) return builtIn;

  return RDAP_AGGREGATOR_BASE;
}

/** The URL a domain's registry record is read from, without making a request. */
export function lookupDomainUrl(hostname, bootstrap = null) {
  const host = normalizeHost(hostname);
  if (!host) return null;
  const root = registrableDomain(host);
  if (!root) return null;
  const base = rdapBaseForHost(host, bootstrap);
  if (!base) return null;
  return new URL(`domain/${encodeURIComponent(root)}`, base);
}

/**
 * Whether a hostname can have a public registry record worth looking up: a
 * registrable root exists, and it is neither an IP nor a local-only name.
 */
export function isPublicDomain(hostname) {
  const host = normalizeHost(hostname);
  if (!host || IPV4_PATTERN.test(host)) return false;
  return registrableDomain(host) !== null;
}

/** Reads one day-old RDAP answer without making a network request. */
export async function cachedDomainInfo(storageArea, hostname, now = Date.now()) {
  let stored;
  try {
    stored = await storageArea.get(DOMAIN_CACHE_KEY);
  } catch {
    return null;
  }
  const cache = stored?.[DOMAIN_CACHE_KEY] && typeof stored[DOMAIN_CACHE_KEY] === "object" ? stored[DOMAIN_CACHE_KEY] : {};
  // Answers are stored against the registrable domain, so every subdomain of a
  // site shares one entry instead of asking the registry again per host.
  const key = registrableDomain(hostname);
  if (!key) return null;
  const entry = cache[key];
  if (!entry || typeof entry !== "object" || !Number.isFinite(entry.at)) return null;
  // RDAP answers change slowly; keep them for a day so repeat views stay local.
  if (now - entry.at > DOMAIN_CACHE_MAX_AGE_MS) return null;
  return entry.value ?? null;
}

/** Stores an RDAP answer under its registrable domain, keeping the newest few. */
export async function saveDomainInfo(storageArea, hostname, value, now = Date.now()) {
  const key = registrableDomain(hostname);
  if (!key) return null;
  try {
    const stored = await storageArea.get(DOMAIN_CACHE_KEY);
    const cache = stored?.[DOMAIN_CACHE_KEY] && typeof stored[DOMAIN_CACHE_KEY] === "object" ? stored[DOMAIN_CACHE_KEY] : {};
    const entries = Object.entries(cache)
      .filter(([entryKey]) => entryKey !== key)
      .slice(-(DOMAIN_CACHE_LIMIT - 1));
    const next = Object.fromEntries(entries);
    next[key] = { at: now, value };
    await storageArea.set({ [DOMAIN_CACHE_KEY]: next });
    return next;
  } catch {
    return null;
  }
}

/** The human-readable names in a vCard, most specific field first. */
function vcardNames(entity) {
  const vcard = entity?.vcardArray;
  if (!Array.isArray(vcard) || !Array.isArray(vcard[1])) return { fn: null, org: null };
  let fn = null;
  let org = null;
  for (const field of vcard[1]) {
    if (!Array.isArray(field) || field.length < 4) continue;
    const type = field[0];
    const value = field[field.length - 1];
    if (type === "fn" && !fn && typeof value === "string" && value.trim()) fn = value.trim();
    if (type === "org" && !org) {
      const first = Array.isArray(value) ? value[0] : value;
      if (typeof first === "string" && first.trim()) org = first.trim();
    }
  }
  return { fn, org };
}

/** The registry's own identifiers for an entity, used when no vCard is present. */
function entityIdentifier(entity) {
  for (const id of Array.isArray(entity?.publicIds) ? entity.publicIds : []) {
    if (typeof id?.ldhName === "string" && id.ldhName.trim()) return id.ldhName.trim();
    if (typeof id?.identifier === "string" && id.identifier.trim()) return id.identifier.trim();
  }
  if (typeof entity?.handle === "string" && entity.handle.trim()) return entity.handle.trim();
  return null;
}

function findRegistrar(payload) {
  const entities = Array.isArray(payload?.entities) ? payload.entities : [];
  for (const entity of entities) {
    const roles = Array.isArray(entity?.roles) ? entity.roles.map((role) => String(role).toLowerCase()) : [];
    if (!roles.includes("registrar")) continue;
    const { fn, org } = vcardNames(entity);
    const name = fn ?? org ?? entityIdentifier(entity);
    if (name) return name.slice(0, 200);
  }
  return null;
}

const EVENT_ACTIONS = {
  registration: ["registration", "registered", "created"],
  lastChanged: ["last changed", "last update of rdap database", "last updated", "changed"],
  expiration: ["expiration", "expiry", "expires"]
};

/** Finds an event by intent, trying each known spelling before the next one. */
function findDomainEvent(payload, intent) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const actions = EVENT_ACTIONS[intent] ?? [];
  for (const wanted of actions) {
    for (const event of events) {
      if (String(event?.eventAction ?? "").toLowerCase() !== wanted) continue;
      const parsed = typeof event?.eventDate === "string" ? Date.parse(event.eventDate) : NaN;
      if (Number.isFinite(parsed)) return { iso: new Date(parsed).toISOString(), time: parsed };
    }
  }
  return null;
}

function findStatuses(payload) {
  const statuses = Array.isArray(payload?.status) ? payload.status : [];
  const byKey = new Map();
  for (const status of statuses) {
    if (typeof status !== "string") continue;
    const trimmed = status.trim();
    // RDAP statuses are protocol values such as clientTransferProhibited; keep
    // the registry's own spelling and only drop exact duplicates.
    if (trimmed && !byKey.has(trimmed.toLowerCase())) byKey.set(trimmed.toLowerCase(), trimmed);
  }
  return byKey.size ? [...byKey.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())) : null;
}

/**
 * Looks a domain up in RDAP. Only called when the user asks (or when the
 * dashboard selects a public domain), because it sends the name to the registry.
 *
 * The query always uses the registrable domain, so `edition.cnn.com` asks about
 * `cnn.com` and `news.bbc.co.uk` asks about `bbc.co.uk`.
 */
export async function lookupDomain(hostname, { fetchImpl = fetch, bootstrap = undefined, now = Date.now(), includeTlsNote = true } = {}) {
  const host = normalizeHost(hostname);
  if (!host) return { status: "unavailable", reason: "No valid hostname to look up.", tlsNote: includeTlsNote ? TLS_LIMITATION : null };
  if (IPV4_PATTERN.test(host)) return { status: "unsupported", reason: "IP addresses have no registry record.", hostname: host, tlsNote: includeTlsNote ? TLS_LIMITATION : null };

  const root = registrableDomain(host);
  if (!root) {
    return { status: "unsupported", reason: "Only a registrable domain has a registry record, and this is a bare suffix or an internal name.", hostname: host, tlsNote: includeTlsNote ? TLS_LIMITATION : null };
  }

  // `undefined` means the caller has no bootstrap yet, so one is downloaded;
  // `null` means the caller already tried and it is unavailable, which must not
  // repeat the request (the built-in map and aggregator still answer).
  let effectiveBootstrap = bootstrap;
  if (effectiveBootstrap === undefined) {
    try {
      const response = await fetchImpl(IANA_BOOTSTRAP_URL, { cache: "no-store", signal: withTimeout() });
      if (!response.ok) throw new Error(`Bootstrap request failed: ${response.status}`);
      effectiveBootstrap = await response.json();
    } catch {
      // The live bootstrap is only the best source, not a requirement: the
      // built-in map and the rdap.org aggregator still answer without it.
      effectiveBootstrap = null;
    }
  }

  const base = rdapBaseForHost(root, effectiveBootstrap);
  if (!base) {
    return { status: "unsupported", reason: "No RDAP service is known for this top-level domain.", hostname: host, tlsNote: includeTlsNote ? TLS_LIMITATION : null };
  }

  let payload;
  try {
    const response = await fetchImpl(`${base}domain/${encodeURIComponent(root)}`, {
      cache: "no-store",
      headers: { accept: "application/rdap+json, application/json" },
      signal: withTimeout()
    });
    if (response.status === 404) {
      return { status: "not-found", reason: "The registry has no record for this domain.", hostname: host, tlsNote: includeTlsNote ? TLS_LIMITATION : null };
    }
    if (!response.ok) throw new Error(`RDAP request failed: ${response.status}`);
    const body = await response.text();
    if (body.length > MAX_RESPONSE_BYTES) throw new Error("RDAP response was too large.");
    payload = JSON.parse(body);
  } catch (error) {
    return { status: "unavailable", reason: `RDAP lookup failed (${String(error.message ?? error)}).`, hostname: host, tlsNote: includeTlsNote ? TLS_LIMITATION : null };
  }

  const registration = findDomainEvent(payload, "registration");
  const lastChanged = findDomainEvent(payload, "lastChanged");
  const expiration = findDomainEvent(payload, "expiration");
  const ageDays = registration ? Math.max(0, Math.floor((now - registration.time) / 86_400_000)) : null;

  return {
    status: "ok",
    hostname: host,
    domain: root,
    registrar: findRegistrar(payload),
    registrationDate: registration?.iso ?? null,
    lastChangedDate: lastChanged?.iso ?? null,
    expirationDate: expiration?.iso ?? null,
    ageDays,
    isNewDomain: Number.isInteger(ageDays) ? ageDays < 30 : null,
    source: new URL(base).hostname,
    statuses: findStatuses(payload),
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

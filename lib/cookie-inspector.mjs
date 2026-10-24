import { normalizeHostname } from "../background/history-store.mjs";

function sameSite(firstPartyHost, cookieDomain) {
  const host = normalizeHostname(firstPartyHost);
  const domain = normalizeHostname(String(cookieDomain).replace(/^\./, ""));
  return Boolean(host && domain && (host === domain || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`)));
}

export function presentCookie(cookie, firstPartyHost) {
  if (!cookie || typeof cookie !== "object" || typeof cookie.name !== "string" || typeof cookie.domain !== "string") {
    return null;
  }
  const domain = normalizeHostname(cookie.domain.replace(/^\./, ""));
  if (!domain || cookie.name.length > 512) {
    return null;
  }
  const expiry = Number.isFinite(cookie.expirationDate)
    ? new Date(cookie.expirationDate * 1_000).toISOString()
    : "Session";
  return {
    name: cookie.name,
    domain,
    expiry,
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    sameSite: typeof cookie.sameSite === "string" ? cookie.sameSite : "unspecified",
    party: sameSite(firstPartyHost, domain) ? "first-party" : "third-party"
  };
}

export async function inspectSiteCookies(cookieApi, firstPartyHost, thirdPartyHosts = []) {
  if (!cookieApi || typeof cookieApi.getAll !== "function") {
    throw new TypeError("A Chrome-compatible cookies API is required.");
  }
  const firstParty = normalizeHostname(firstPartyHost);
  if (!firstParty) {
    throw new TypeError("A valid first-party hostname is required.");
  }
  const hosts = [...new Set([firstParty, ...thirdPartyHosts.map(normalizeHostname).filter(Boolean)])].slice(0, 100);
  const groups = await Promise.all(hosts.map(async (host) => cookieApi.getAll({ domain: host })));
  return groups.flat().map((cookie) => presentCookie(cookie, firstParty)).filter(Boolean);
}

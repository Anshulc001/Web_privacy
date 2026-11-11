import { normalizeHostname } from "../background/history-store.mjs";
import { registrableDomain } from "./host-match.mjs";

// Chrome never returns an expired cookie, but a malformed answer from the API
// must not take the whole list down: an impossible date is not a session cookie,
// it is simply an unknown expiry.
function expiryIso(value) {
  if (!Number.isFinite(value)) return "Session";
  const date = new Date(value * 1_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "Session";
}

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
  const expiry = expiryIso(cookie.expirationDate);
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
  // A site's cookies usually live on the registrable domain (".example.com"), so
  // asking only for "www.example.com" would list one cookie while "Clear site"
  // removes them all. Both scopes are queried, and a cookie seen twice is kept once.
  // A stored observation is validated, but this is a public helper: a non-array
  // list must be ignored rather than throwing away the first-party cookies too.
  const related = Array.isArray(thirdPartyHosts) ? thirdPartyHosts : [];
  const hosts = [...new Set([
    firstParty,
    registrableDomain(firstParty),
    ...related.map(normalizeHostname).filter(Boolean)
  ].filter(Boolean))].slice(0, 100);
  const groups = await Promise.all(hosts.map(async (host) => cookieApi.getAll({ domain: host })));
  const seen = new Set();
  const list = [];
  for (const cookie of groups.flat()) {
    const presented = presentCookie(cookie, firstParty);
    if (!presented) continue;
    const key = `${cookie.storeId ?? ""}|${presented.domain}|${cookie.path ?? "/"}|${presented.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(presented);
  }
  return list;
}

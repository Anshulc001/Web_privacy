import { normalizeHostname } from "../background/history-store.mjs";
import { registrableDomain } from "./host-match.mjs";

/**
 * chrome.cookies.remove needs a URL that the cookie would be sent to, not a
 * domain: the scheme, host and path together identify the cookie's scope. The
 * leading dot of a domain cookie is not part of a URL host.
 */
export function cookieRemovalUrl(cookie) {
  if (!cookie || typeof cookie !== "object") throw new TypeError("A cookie object is required.");
  const host = String(cookie.domain || "").replace(/^\./, "");
  if (!host) throw new TypeError("A cookie domain is required.");
  return `${cookie.secure ? "https:" : "http:"}//${host}${cookie.path || "/"}`;
}

function cookieKey(cookie) {
  return [cookie?.storeId ?? "", cookie?.domain ?? "", cookie?.path ?? "/", cookie?.name ?? ""].join("|");
}

/**
 * Removes every cookie the site can see. The site's own host covers subdomain
 * cookies that belong to it, and its registrable domain adds the sibling
 * subdomains (www. and login. sharing one cookie) plus domain cookies. Both
 * queries overlap, so cookies are de-duplicated before removal.
 */
export async function clearCookiesForHost(cookiesApi, hostname) {
  if (!cookiesApi || typeof cookiesApi.getAll !== "function" || typeof cookiesApi.remove !== "function") {
    throw new TypeError("A Chrome-compatible cookies API is required.");
  }
  const host = normalizeHostname(hostname);
  if (!host) throw new TypeError("A valid hostname is required.");

  const scopes = [...new Set([host, registrableDomain(host)].filter(Boolean))];
  const groups = await Promise.all(scopes.map((scope) => cookiesApi.getAll({ domain: scope })));
  const seen = new Set();
  let removed = 0;
  for (const cookie of groups.flat()) {
    if (!cookie || typeof cookie.name !== "string" || typeof cookie.domain !== "string") continue;
    const key = cookieKey(cookie);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      // Chrome resolves with the removed cookie, or null when nothing matched
      // (it vanished between the query and the removal). Counting the attempt
      // would tell the reader more cookies were cleared than really were.
      const removedCookie = await cookiesApi.remove({ url: cookieRemovalUrl(cookie), name: cookie.name, storeId: cookie.storeId });
      if (removedCookie) removed += 1;
    } catch {
      // A cookie can disappear between the query and the removal; the count must
      // describe what really happened, so a failed removal is not counted.
    }
  }
  return { removed };
}

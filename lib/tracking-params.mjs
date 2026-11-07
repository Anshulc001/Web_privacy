/**
 * Click identifiers and campaign parameters that only exist so an ad network or
 * an analytics vendor can follow a visit from one site to the next. They never
 * change what the page shows, so they are safe to drop before the request leaves
 * the browser.
 */
export const TRACKING_QUERY_PARAMS = Object.freeze([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
  "dclid",
  "msclkid",
  "twclid",
  "ttclid",
  "igshid",
  "yclid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "mkt_tok",
  "vero_id",
  "oly_enc_id",
  "oly_anon_id",
  "rb_clickid",
  "s_kwcid"
]);

const TRACKING_PARAM_SET = new Set(TRACKING_QUERY_PARAMS);

/** The dynamic-rule id reserved for the tracking-parameter redirect. */
export const TRACKING_PARAM_RULE_ID = 950;

/**
 * Returns the URL with every tracking parameter removed, leaving all other
 * query parameters and the fragment in their original order. Anything that is
 * not an absolute http(s) URL is returned untouched: relative addresses, data
 * URLs and malformed input cannot be parsed reliably, and rewriting them is
 * never what the caller wants.
 */
export function stripTrackingParams(urlString) {
  if (typeof urlString !== "string") return urlString;
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return urlString;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return urlString;

  const removed = [...url.searchParams.keys()].filter((key) => TRACKING_PARAM_SET.has(key));
  if (removed.length === 0) return urlString;
  for (const key of new Set(removed)) url.searchParams.delete(key);
  return url.toString();
}

/**
 * The declarativeNetRequest rule that performs the same stripping inside Chrome,
 * before the request is sent. Priority 1 keeps it below the priority-10 allowlist
 * rules, so an allowlisted site keeps the URL exactly as it was typed.
 */
export function buildTrackingParamRule({ id = TRACKING_PARAM_RULE_ID, excludedDomains = [] } = {}) {
  const domains = [...new Set(Array.isArray(excludedDomains) ? excludedDomains : [])].filter((domain) => typeof domain === "string" && domain.length > 0);
  const condition = {
    urlFilter: "*",
    resourceTypes: ["main_frame", "sub_frame"]
  };
  // A top-level navigation has no initiator, so matching only excludedInitiatorDomains
  // would leave allowlisted sites redirecting anyway; both lists are needed.
  if (domains.length > 0) {
    condition.excludedRequestDomains = domains;
    condition.excludedInitiatorDomains = domains;
  }
  return {
    id,
    priority: 1,
    action: {
      type: "redirect",
      redirect: { transform: { queryTransform: { removeParams: [...TRACKING_QUERY_PARAMS] } } }
    },
    condition
  };
}

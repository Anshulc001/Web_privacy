/**
 * Tracker hosts grouped by what the company behind them is doing with the data.
 * The lists are matched against a host's own name and its parent domains, so
 * "www.googletagmanager.com" is Analytics without needing an entry for every
 * subdomain. Anything unknown is still a tracker; it just has no finer label.
 */
const ADS_DOMAINS = Object.freeze([
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adnxs.com",
  "amazon-adsystem.com", "criteo.com", "criteo.net", "rubiconproject.com", "pubmatic.com",
  "openx.net", "casalemedia.com", "taboola.com", "outbrain.com", "adsrvr.org", "adform.net",
  "moatads.com", "ads-twitter.com", "ads.yahoo.com", "advertising.com", "mediavine.com",
  "smartadserver.com", "indexexchange.com", "3lift.com", "bidswitch.net", "teads.tv",
  "brightline.tv"
]);

const ANALYTICS_DOMAINS = Object.freeze([
  "google-analytics.com", "googletagmanager.com", "scorecardresearch.com", "quantserve.com",
  "mixpanel.com", "segment.io", "segment.com", "amplitude.com", "chartbeat.com",
  "chartbeat.net", "newrelic.com", "nr-data.net", "omtrdc.net", "2o7.net", "demdex.net",
  "krxd.net", "parsely.com", "statcounter.com", "optimizely.com", "bing.com"
]);

const REPLAY_DOMAINS = Object.freeze([
  "hotjar.com", "hotjar.io", "fullstory.com", "mouseflow.com", "luckyorange.com",
  "clarity.ms", "crazyegg.com", "logrocket.com", "logrocket.io", "smartlook.com",
  "inspectlet.com", "contentsquare.net"
]);

const SOCIAL_DOMAINS = Object.freeze([
  "facebook.net", "facebook.com", "twitter.com", "t.co", "licdn.com", "linkedin.com",
  "tiktok.com", "pinimg.com", "pinterest.com", "redditstatic.com", "addthis.com",
  "sharethis.com", "disqus.com"
]);

const CATEGORIES = Object.freeze([
  { id: "ads", label: "Ads", domains: ADS_DOMAINS, prefixes: Object.freeze(["ad.", "ads.", "adserver."]) },
  { id: "analytics", label: "Analytics", domains: ANALYTICS_DOMAINS, prefixes: Object.freeze(["analytics.", "metrics.", "telemetry."]) },
  { id: "replay", label: "Session Replay", domains: REPLAY_DOMAINS, prefixes: Object.freeze([]) },
  { id: "social", label: "Social", domains: SOCIAL_DOMAINS, prefixes: Object.freeze([]) }
]);

const FALLBACK = Object.freeze({ id: "tracker", label: "Tracker" });

function normalize(hostname) {
  return String(hostname ?? "").trim().toLowerCase().replace(/\.$/, "");
}

/**
 * The category for a blocked host. The most specific matching list wins in the
 * order above, and an unrecognised host is reported as a plain Tracker rather
 * than being left unlabelled.
 */
export function categorizeTrackerHost(hostname) {
  const host = normalize(hostname);
  if (!host) return { ...FALLBACK };
  for (const category of CATEGORIES) {
    for (const prefix of category.prefixes) {
      if (host.startsWith(prefix)) return { id: category.id, label: category.label };
    }
    for (const domain of category.domains) {
      if (host === domain || host.endsWith(`.${domain}`)) return { id: category.id, label: category.label };
    }
  }
  return { ...FALLBACK };
}

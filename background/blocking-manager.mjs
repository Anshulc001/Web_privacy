import { normalizeHostname } from "./history-store.mjs";
import { candidateHosts } from "../lib/host-match.mjs";
import { buildTrackingParamRule, TRACKING_PARAM_RULE_ID } from "../lib/tracking-params.mjs";

const REMOTE_RULE_MIN_ID = 1_000_000;
// Option-qualified host rules ("||ads.example^$third-party") sit above the plain
// ones and below the allowlist. Keeping them inside the 1,000,000–2,000,000 band
// means the single existing sweep that removes "remote" rules removes them too.
const QUALIFIED_RULE_MIN_ID = 1_500_000;
const ALLOW_RULE_MIN_ID = 2_000_000;
// Strict-mode rules live above the allowlist so the allowlist's open-ended sweep
// (everything at or above ALLOW_RULE_MIN_ID) cannot delete them by accident, and so
// one look at the ids says which feature owns a rule.
const STRICT_RULE_MIN_ID = 3_000_000;
const MAX_DYNAMIC_HOSTS = 30_000;
// The tracking-parameter redirect is added in its own update and shares the same
// dynamic-rule budget, so one slot is always left free for it.
const TRACKING_RULE_RESERVE = 1;
// Chrome rejects an allowAllRequests rule that has no resourceTypes, and permits
// only these two values. Anything else fails the whole allowlist update.
const ALLOW_ALL_RESOURCE_TYPES = ["main_frame", "sub_frame"];
// allowAllRequests only covers requests whose document it matched. In-page XHR,
// images and media keep their own initiator, so they need an explicit allow rule.
const ALLOW_SUBRESOURCE_TYPES = ["sub_frame", "xmlhttprequest", "script", "image", "media", "stylesheet", "font", "ping", "other"];
// Strict mode blocks the third-party request types that track and advertise:
// scripts, frames, XHR/fetch, beacons and anything unclassified. Images, styles,
// fonts and media stay allowed.
//
// That list is deliberately narrower than "everything third-party". Measured on
// real sites, blocking all third parties also blocked each site's own content
// delivery: BBC lost 53 scripts/CSS from static.files.bbci.co.uk and 13
// ichef.bbci.co.uk images, Wikipedia lost upload.wikimedia.org images. Those hosts
// are third parties by registrable domain but they are the page's own assets, and a
// "strict" mode that strips them is not usable on ordinary sites. Known tracking
// pixels are still blocked by the normal list above; strict adds the blanket block on
// the request types that carry tracking.
//
// main_frame is absent for a second reason: a navigation has no initiator of its own,
// so including it would block visiting the site.
const STRICT_BLOCK_TYPES = ["sub_frame", "script", "xmlhttprequest", "ping", "other"];

/**
 * The domains that must be spared the tracking-parameter redirect: each
 * allowlisted host and its registrable domain, the same pair the allow rules use
 * so an allowlisted site keeps its subdomains' URLs intact too.
 */
function trackingExclusions(hosts) {
  const excluded = new Set();
  for (const host of hosts) {
    const roots = candidateHosts(host);
    excluded.add(host);
    if (roots.length > 0) excluded.add(roots[roots.length - 1]);
  }
  return [...excluded].sort();
}

function hostRule(id, host) {
  return { id, priority: 1, action: { type: "block" }, condition: { urlFilter: `||${host}^`, resourceTypes: ["main_frame", "sub_frame", "script", "image", "xmlhttprequest", "media", "font", "stylesheet", "ping", "other"] } };
}

/**
 * The same host rule narrowed by the condition the list asked for. The condition
 * comes from the validated data file, so it can only contain urlFilter-compatible
 * DNR fields; without it the rule would block the host everywhere, including on
 * the page the reader is looking at.
 */
function qualifiedHostRule(id, entry) {
  return { id, priority: 1, action: { type: "block" }, condition: { urlFilter: `||${entry.host}^`, ...entry.condition } };
}

export function createBlockingManager(dnr, settingsStore, readRemoteHosts = null) {
  if (!dnr || typeof dnr.updateEnabledRulesets !== "function" || typeof dnr.getDynamicRules !== "function" || typeof dnr.updateDynamicRules !== "function") throw new TypeError("A Chrome-compatible DNR API is required.");
  // Every mutation here is a read-then-write of the same rule set. The startup
  // install, the blocking toggle and an allowlist edit can land together, and two
  // overlapping updates that both re-add the tracking rule make Chrome reject the
  // second one with "rule id already exists". One queue keeps them in order.
  let queue = Promise.resolve();
  function serialized(task) {
    const result = queue.then(task, task);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    setEnabled(enabled) {
      return serialized(() => applyEnabled(enabled));
    },
    syncTrackingParamRule(enabled, allowlist = []) {
      return serialized(() => applyTrackingParamRule(enabled, allowlist));
    },
    applyRemoteHosts(hosts, enabled, hostRules = []) {
      return serialized(() => applyHosts(hosts, enabled, hostRules));
    },
    setAllowlist(hosts) {
      return serialized(() => applyAllowlist(hosts));
    },
    setStrictSites(hosts) {
      return serialized(async () => {
        const settings = await settingsStore.load();
        return applyStrictSites(hosts, settings.blockingEnabled);
      });
    }
  };

  async function applyEnabled(enabled) {
    if (typeof enabled !== "boolean") throw new TypeError("Blocking enabled must be a boolean.");
    await dnr.updateEnabledRulesets(enabled ? { enableRulesetIds: ["ad_tracker_rules"] } : { disableRulesetIds: ["ad_tracker_rules"] });
    // The downloaded host list lives in dynamic rules, which updateEnabledRulesets
    // does not touch. Without re-applying it here, "blocking off" kept blocking.
    if (typeof readRemoteHosts === "function") {
      // Inside the queue already, so call the queue-free body rather than deadlocking.
      // The reader returns the stored blocking data; an older reader that still
      // returns a bare host array keeps working, it just has no qualified rules.
      const payload = await readRemoteHosts();
      const hosts = Array.isArray(payload) ? payload : payload?.hosts;
      const hostRules = Array.isArray(payload) ? [] : payload?.hostRules;
      await applyHosts(Array.isArray(hosts) ? hosts : [], enabled, Array.isArray(hostRules) ? hostRules : []);
    }
    // The tracking-parameter rule is a redirect, not a block, but it belongs to
    // the same switch: turning WebGuard off must leave URLs exactly as typed.
    const settings = await settingsStore.load();
    await applyTrackingParamRule(enabled, settings.siteAllowlist ?? []);
    // Strict-mode rules are blocks like any other: leaving them installed while
    // WebGuard is off would keep blocking the sites the reader had marked strict.
    await applyStrictSites(settings.strictSites ?? [], enabled);
    return settingsStore.save({ blockingEnabled: enabled });
  }

  async function applyTrackingParamRule(enabled, allowlist = []) {
    const hosts = (Array.isArray(allowlist) ? allowlist : []).map(normalizeHostname).filter(Boolean);
    const addRules = enabled ? [buildTrackingParamRule({ excludedDomains: trackingExclusions(hosts) })] : [];
    // Removing the id unconditionally is what makes re-adding it safe: Chrome
    // ignores unknown ids in removeRuleIds and rejects an id that already exists.
    await dnr.updateDynamicRules({ removeRuleIds: [TRACKING_PARAM_RULE_ID], addRules });
    return enabled;
  }

  /**
   * The 25,000-rule cap in the build script only counts the downloaded list; allow
   * rules (two per allowlisted site) and the tracking-parameter rule are charged to
   * the same budget. Trimming to the real limit is better than an update Chrome
   * rejects, which would install no host rules at all.
   *
   * There is no "available dynamic rules" call: `getAvailableDynamicRuleCount` does
   * not exist (checked against the live API surface — `chrome.declarativeNetRequest`
   * exposes `getAvailableStaticRuleCount` only). The limit is the exported constant
   * `MAX_NUMBER_OF_DYNAMIC_RULES` (30,000 on Chrome 121+), so the free slots have to be
   * derived from the rules that are already installed.
   */
  async function installableCounts(hostCount, qualifiedCount, existingRemoteCount, existingTotal) {
    const limit = Number(dnr.MAX_NUMBER_OF_DYNAMIC_RULES ?? 30_000);
    if (!Number.isFinite(limit) || limit <= 0) return { hosts: hostCount, qualified: qualifiedCount };
    // Existing remote rules are removed in this same update, so their slots come
    // back and may be reused; allow and redirect rules stay and keep theirs.
    const slots = Math.max(0, limit - (existingTotal - existingRemoteCount) - TRACKING_RULE_RESERVE);
    // Plain host rules go first: they cover the hosts that are trackers whatever
    // the context, so they matter more than a narrowed duplicate.
    const hosts = Math.min(hostCount, slots);
    const qualified = Math.min(qualifiedCount, Math.max(0, slots - hosts));
    if (hosts < hostCount || qualified < qualifiedCount) {
      console.warn(
        `WebGuard can install ${hosts} of ${hostCount} downloaded host rules and ${qualified} of ${qualifiedCount} qualified ones; the rest stay unblocked.`
      );
    }
    return { hosts, qualified };
  }

  function validHostRules(hostRules) {
    if (!Array.isArray(hostRules)) return [];
    const seen = new Set();
    const entries = [];
    for (const entry of hostRules) {
      const host = normalizeHostname(entry?.host);
      const condition = entry?.condition;
      if (!host || !condition || typeof condition !== "object" || !Array.isArray(condition.resourceTypes)) continue;
      if (condition.resourceTypes.length === 0) continue;
      const key = `${host}|${JSON.stringify(condition)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ host, condition });
    }
    return entries.sort((a, b) => a.host.localeCompare(b.host) || JSON.stringify(a.condition).localeCompare(JSON.stringify(b.condition)));
  }

  async function applyHosts(hosts, enabled, hostRules = []) {
    const valid = [...new Set(hosts.map(normalizeHostname).filter(Boolean))].sort();
    const qualified = validHostRules(hostRules);
    if (valid.length + qualified.length > MAX_DYNAMIC_HOSTS) throw new RangeError("Too many dynamic blocking hosts.");
    const existing = await dnr.getDynamicRules();
    const remoteRuleIds = existing.filter((rule) => rule.id >= REMOTE_RULE_MIN_ID && rule.id < ALLOW_RULE_MIN_ID).map((rule) => rule.id);
    const installable = enabled
      ? await installableCounts(valid.length, qualified.length, remoteRuleIds.length, existing.length)
      : { hosts: 0, qualified: 0 };
    const installedHosts = valid.slice(0, installable.hosts);
    const installedQualified = qualified.slice(0, installable.qualified);
    await dnr.updateDynamicRules({
      removeRuleIds: remoteRuleIds,
      addRules: [
        ...installedHosts.map((host, index) => hostRule(REMOTE_RULE_MIN_ID + index, host)),
        ...installedQualified.map((entry, index) => qualifiedHostRule(QUALIFIED_RULE_MIN_ID + index, entry))
      ]
    });
    return installedHosts.length + installedQualified.length;
  }

  /**
   * One rule per strict site: block requests to any third party that page starts.
   * The registrable domain is included so `www.example.com` covers requests made by
   * `cdn.example.com` too, exactly like the allow rules.
   */
  async function applyStrictSites(hosts, enabled) {
    const valid = [...new Set((Array.isArray(hosts) ? hosts : []).map(normalizeHostname).filter(Boolean))].sort();
    const existing = await dnr.getDynamicRules();
    const removeRuleIds = existing.filter((rule) => rule.id >= STRICT_RULE_MIN_ID).map((rule) => rule.id);
    const addRules = enabled
      ? valid.map((host, index) => {
          const roots = candidateHosts(host);
          const root = roots.length ? roots[roots.length - 1] : host;
          return {
            id: STRICT_RULE_MIN_ID + index,
            // Above the ordinary block rules (1) so it cannot be outranked by one,
            // below the allowlist (10) so "Off" always wins.
            priority: 2,
            action: { type: "block" },
            condition: {
              initiatorDomains: [...new Set([host, root])],
              domainType: "thirdParty",
              resourceTypes: STRICT_BLOCK_TYPES
            }
          };
        })
      : [];
    await dnr.updateDynamicRules({ removeRuleIds, addRules });
    return valid.length;
  }

  async function applyAllowlist(hosts) {
    const valid = [...new Set(hosts.map(normalizeHostname).filter(Boolean))].sort();
    const settings = await settingsStore.load();
    const existing = await dnr.getDynamicRules();
    // Allowlist ids live at and above ALLOW_RULE_MIN_ID, so the range is open
    // ended. Comparing against REMOTE_RULE_MIN_ID here would never match. The
    // tracking-parameter rule is rewritten in the same update so it always sees
    // the new exclusions.
    const removeRuleIds = existing
      .filter((rule) => (rule.id >= ALLOW_RULE_MIN_ID && rule.id < STRICT_RULE_MIN_ID) || rule.id === TRACKING_PARAM_RULE_ID)
      .map((rule) => rule.id);
    // The first rule has to match the document request itself: allowAllRequests
    // only applies to a request it matches, and an address-bar navigation has no
    // initiator domain, so initiatorDomains never matched and nothing was allowed.
    // The second rule allows the page's subresources, and its registrable domain
    // extends that to sibling subdomains (www.cnn.com for edition.cnn.com).
    const addRules = valid.flatMap((host, index) => {
      const roots = candidateHosts(host);
      const root = roots.length ? roots[roots.length - 1] : host;
      const initiatorDomains = [...new Set([host, root])];
      return [
        {
          id: ALLOW_RULE_MIN_ID + index * 2,
          priority: 10,
          action: { type: "allowAllRequests" },
          condition: { urlFilter: `||${host}^`, resourceTypes: ALLOW_ALL_RESOURCE_TYPES }
        },
        {
          id: ALLOW_RULE_MIN_ID + index * 2 + 1,
          priority: 10,
          action: { type: "allow" },
          condition: { initiatorDomains, resourceTypes: ALLOW_SUBRESOURCE_TYPES }
        }
      ];
    });
    if (settings.blockingEnabled) {
      addRules.push(buildTrackingParamRule({ excludedDomains: trackingExclusions(valid) }));
    }
    await dnr.updateDynamicRules({ removeRuleIds, addRules });
    return settingsStore.save({ siteAllowlist: valid });
  }
}

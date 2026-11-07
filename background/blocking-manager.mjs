import { normalizeHostname } from "./history-store.mjs";
import { candidateHosts } from "../lib/host-match.mjs";
import { buildTrackingParamRule, TRACKING_PARAM_RULE_ID } from "../lib/tracking-params.mjs";

const REMOTE_RULE_MIN_ID = 1_000_000;
const ALLOW_RULE_MIN_ID = 2_000_000;
const MAX_DYNAMIC_HOSTS = 30_000;
// Chrome rejects an allowAllRequests rule that has no resourceTypes, and permits
// only these two values. Anything else fails the whole allowlist update.
const ALLOW_ALL_RESOURCE_TYPES = ["main_frame", "sub_frame"];
// allowAllRequests only covers requests whose document it matched. In-page XHR,
// images and media keep their own initiator, so they need an explicit allow rule.
const ALLOW_SUBRESOURCE_TYPES = ["sub_frame", "xmlhttprequest", "script", "image", "media", "stylesheet", "font", "ping", "other"];

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
    applyRemoteHosts(hosts, enabled) {
      return serialized(() => applyHosts(hosts, enabled));
    },
    setAllowlist(hosts) {
      return serialized(() => applyAllowlist(hosts));
    }
  };

  async function applyEnabled(enabled) {
    if (typeof enabled !== "boolean") throw new TypeError("Blocking enabled must be a boolean.");
    await dnr.updateEnabledRulesets(enabled ? { enableRulesetIds: ["ad_tracker_rules"] } : { disableRulesetIds: ["ad_tracker_rules"] });
    // The downloaded host list lives in dynamic rules, which updateEnabledRulesets
    // does not touch. Without re-applying it here, "blocking off" kept blocking.
    if (typeof readRemoteHosts === "function") {
      // Inside the queue already, so call the queue-free body rather than deadlocking.
      await applyHosts(await readRemoteHosts(), enabled);
    }
    // The tracking-parameter rule is a redirect, not a block, but it belongs to
    // the same switch: turning WebGuard off must leave URLs exactly as typed.
    const settings = await settingsStore.load();
    await applyTrackingParamRule(enabled, settings.siteAllowlist ?? []);
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

  async function applyHosts(hosts, enabled) {
    const valid = [...new Set(hosts.map(normalizeHostname).filter(Boolean))].sort();
    if (valid.length > MAX_DYNAMIC_HOSTS) throw new RangeError("Too many dynamic blocking hosts.");
    const existing = await dnr.getDynamicRules();
    const removeRuleIds = existing.filter((rule) => rule.id >= REMOTE_RULE_MIN_ID && rule.id < ALLOW_RULE_MIN_ID).map((rule) => rule.id);
    await dnr.updateDynamicRules({ removeRuleIds, addRules: enabled ? valid.map((host, index) => hostRule(REMOTE_RULE_MIN_ID + index, host)) : [] });
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
      .filter((rule) => rule.id >= ALLOW_RULE_MIN_ID || rule.id === TRACKING_PARAM_RULE_ID)
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

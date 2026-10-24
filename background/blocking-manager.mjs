import { normalizeHostname } from "./history-store.mjs";

const REMOTE_RULE_MIN_ID = 1_000_000;
const ALLOW_RULE_MIN_ID = 2_000_000;
const MAX_DYNAMIC_HOSTS = 30_000;
// Chrome rejects an allowAllRequests rule that has no resourceTypes, and permits
// only these two values. Anything else fails the whole allowlist update.
const ALLOW_ALL_RESOURCE_TYPES = ["main_frame", "sub_frame"];

function hostRule(id, host) {
  return { id, priority: 1, action: { type: "block" }, condition: { urlFilter: `||${host}^`, resourceTypes: ["main_frame", "sub_frame", "script", "image", "xmlhttprequest", "media", "font", "stylesheet", "ping", "other"] } };
}

export function createBlockingManager(dnr, settingsStore, readRemoteHosts = null) {
  if (!dnr || typeof dnr.updateEnabledRulesets !== "function" || typeof dnr.getDynamicRules !== "function" || typeof dnr.updateDynamicRules !== "function") throw new TypeError("A Chrome-compatible DNR API is required.");
  return {
    async setEnabled(enabled) {
      if (typeof enabled !== "boolean") throw new TypeError("Blocking enabled must be a boolean.");
      await dnr.updateEnabledRulesets(enabled ? { enableRulesetIds: ["ad_tracker_rules"] } : { disableRulesetIds: ["ad_tracker_rules"] });
      // The downloaded host list lives in dynamic rules, which updateEnabledRulesets
      // does not touch. Without re-applying it here, "blocking off" kept blocking.
      if (typeof readRemoteHosts === "function") {
        await this.applyRemoteHosts(await readRemoteHosts(), enabled);
      }
      return settingsStore.save({ blockingEnabled: enabled });
    },
    async applyRemoteHosts(hosts, enabled) {
      const valid = [...new Set(hosts.map(normalizeHostname).filter(Boolean))].sort();
      if (valid.length > MAX_DYNAMIC_HOSTS) throw new RangeError("Too many dynamic blocking hosts.");
      const existing = await dnr.getDynamicRules();
      const removeRuleIds = existing.filter((rule) => rule.id >= REMOTE_RULE_MIN_ID && rule.id < ALLOW_RULE_MIN_ID).map((rule) => rule.id);
      await dnr.updateDynamicRules({ removeRuleIds, addRules: enabled ? valid.map((host, index) => hostRule(REMOTE_RULE_MIN_ID + index, host)) : [] });
      return valid.length;
    },
    async setAllowlist(hosts) {
      const valid = [...new Set(hosts.map(normalizeHostname).filter(Boolean))].sort();
      const existing = await dnr.getDynamicRules();
      // Allowlist ids live at and above ALLOW_RULE_MIN_ID, so the range is open
      // ended. Comparing against REMOTE_RULE_MIN_ID here would never match.
      const removeRuleIds = existing.filter((rule) => rule.id >= ALLOW_RULE_MIN_ID).map((rule) => rule.id);
      // The rule has to match the document request itself: allowAllRequests only
      // applies to a request it matches, and an address-bar navigation has no
      // initiator domain, so initiatorDomains never matched and nothing was allowed.
      const addRules = valid.map((host, index) => ({
        id: ALLOW_RULE_MIN_ID + index,
        priority: 10,
        action: { type: "allowAllRequests" },
        condition: { urlFilter: `||${host}^`, resourceTypes: ALLOW_ALL_RESOURCE_TYPES }
      }));
      await dnr.updateDynamicRules({ removeRuleIds, addRules });
      return settingsStore.save({ siteAllowlist: valid });
    }
  };
}

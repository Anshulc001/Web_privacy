import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalBlockingPayload, canonicalHostCondition, canonicalHostRules, sha256 } from "../lib/data-integrity.mjs";
import { buildRuleCondition, isWideCondition } from "../lib/filter-options.mjs";
import { candidateHosts, normalizeHost } from "../lib/host-match.mjs";
import { ADS_DOMAINS, ANALYTICS_DOMAINS, REPLAY_DOMAINS, SOCIAL_DOMAINS } from "../lib/tracker-categories.mjs";

const SOURCE_URL = "https://easylist-downloads.adblockplus.org/easyprivacy+easylist.txt";
const MAX_SOURCE_BYTES = 20_000_000;
// Chrome guarantees 30,000 static rules per extension. The host rules are the
// bulk of that; path rules get the remainder, so the total can never outgrow the
// budget and leave the ruleset rejected.
const MAX_HOST_RULES = 25_000;
// Host rules that carry an option ("$third-party", "$domain=", "$script") cannot
// be widened to a plain ||host^ block, so they are published as their own rules
// with the matching DNR condition. They get a smaller slice of the budget because
// the wide rules cover the hosts that are trackers everywhere.
const MAX_QUALIFIED_HOST_RULES = 3_000;
const MAX_PATH_RULES = 4_500;
const MAX_STATIC_RULES = 30_000;
const RESOURCE_TYPES = ["main_frame", "sub_frame", "script", "image", "xmlhttprequest", "media", "font", "stylesheet", "ping", "other"];
const outputDirectory = resolve(import.meta.dirname, "../data");

// A rule is only safe to widen to host-level blocking when its pattern is a bare
// domain anchor: "||host^" or ".host". Path rules such as ".facebook.com/tr"
// target one path on a site that must otherwise keep working, so they are skipped.
const HOST_RULE_PATTERNS = [
  /^\|\|([a-z0-9.-]+)\^$/i,
  /^\.([a-z0-9.-]+)\/?$/i
];

// A path rule blocks one path on a site that must otherwise keep working
// (`||example.com/ads/`), which a host rule cannot express: it would take the
// whole site down. Path rules are still only published when they carry no
// options: the path budget is small, and every option-qualified path rule would
// need its own condition and its own ranking, so they are counted and dropped
// rather than widened.
const PATH_RULE_PATTERNS = [
  /^\|\|([a-z0-9.-]+)(\/[^|$]*)$/i,
  /^\.([a-z0-9.-]+)(\/[^|$]*)$/i
];

// Paths that name what they block, used to spend the small path-rule budget on
// the rules most likely to matter.
const AD_PATH_TOKENS = /(?:^|[/._-])(?:ad|ads|adv|advert|advertisement|banners?|sponsors?|sponsored|promo|pixel|beacon|impressions?|track|tracking|analytics|pagead|doubleclick|collect|gtag|pageview|conversion)(?:[/._-]|$)/i;

function normalizedKey(pattern) {
  const host = HOST_RULE_PATTERNS[0].exec(pattern)?.[1] ?? HOST_RULE_PATTERNS[1].exec(pattern)?.[1];
  if (host) return normalizeHost(host);
  for (const matcher of PATH_RULE_PATTERNS) {
    const match = matcher.exec(pattern);
    if (!match) continue;
    const pathHost = normalizeHost(match[1]);
    const path = match[2].replace(/\^+$/, "");
    return pathHost && path.length > 1 ? `${pathHost}${path}` : null;
  }
  return null;
}

// Blocking loopback would break every local dev server and localhost tool, so
// these are always excluded no matter what the upstream lists contain.
const LOOPBACK_HOSTS = new Set(["localhost", "localhost.localdomain", "0.0.0.0", "127.0.0.1", "::1"]);

function isLoopback(host) {
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (/^127\./.test(host)) return true;
  return /^\[?::1\]?$/.test(host);
}

function registrableDomain(host) {
  const candidates = candidateHosts(host);
  return candidates.length ? candidates[candidates.length - 1] : null;
}

// Known tracker/ad/social/analytics domains that must always be blocked when
// the lists publish a host rule for them, even if they don't rank in the top
// EasyList mentions. The categorization library already knows about these hosts;
// the blocklist should agree with it.
//
// Only hosts EasyList itself declares are eligible. These rules cover every
// resource type including main_frame, so inventing one for a site the list only
// targets by path would block visiting that site at all: "facebook.com",
// "linkedin.com", "bing.com" and "disqus.com" are sites, not tracker endpoints.
const MUST_BLOCK_DOMAINS = new Set([
  ...ADS_DOMAINS,
  ...ANALYTICS_DOMAINS,
  ...REPLAY_DOMAINS,
  ...SOCIAL_DOMAINS
]);

const response = await fetch(SOURCE_URL);
if (!response.ok) throw new Error(`Rule list download failed with status ${response.status}.`);
const text = await response.text();
if (text.length > MAX_SOURCE_BYTES) throw new Error("Source list exceeds the 20 MB safety limit.");

const lines = text.split(/\r?\n/);
if (lines.length < 1_000) throw new Error("Source list is unexpectedly small; refusing to build.");

const hosts = new Set();
// host|condition -> entry. A host can legitimately appear with two different
// conditions (blocked third-party for one type, fully for another), so the key is
// the pair, not the host.
const qualifiedRules = new Map();
const pathRules = new Set();
const exceptionKeys = new Set();
const domainMentions = new Map();
// Option names that DNR cannot express on a block rule. Counted, never widened.
const droppedOptions = new Map();

for (const rawLine of lines) {
  const line = rawLine.trim();
  if (!line || line.startsWith("!") || line.startsWith("[") || line.startsWith("#")) continue;

  // Options come after "$"; only the pattern part decides whether this is a host rule.
  const hasOptions = line.includes("$");
  const optionText = hasOptions ? line.slice(line.indexOf("$") + 1) : "";
  const patternPart = line.split("$")[0];

  // An exception withdraws one pattern; a block rule that repeats it must not be
  // published, or the lists' own unblock is silently overridden.
  if (patternPart.startsWith("@@")) {
    const key = normalizedKey(patternPart.slice(2));
    if (key) exceptionKeys.add(key);
    continue;
  }

  let matchedHostRule = false;
  for (const pattern of HOST_RULE_PATTERNS) {
    const match = pattern.exec(patternPart);
    if (!match) continue;
    matchedHostRule = true;
    const host = normalizeHost(match[1]);
    // Loopback rules and rules whose options have no DNR equivalent are dropped
    // as a whole: publishing the host without its condition would block the site
    // the rule was careful to spare.
    if (!host || isLoopback(host)) break;
    const built = buildRuleCondition(optionText, RESOURCE_TYPES);
    if (built.unsupported) {
      droppedOptions.set(built.unsupported, (droppedOptions.get(built.unsupported) ?? 0) + 1);
      break;
    }
    // `$~image` over a type list that only contains images, or an option set that
    // covers every type, compiles to exactly the wide rule. Folding it back keeps
    // one rule per host instead of two equivalent ones.
    if (built.isWide || isWideCondition(built.condition, RESOURCE_TYPES)) {
      hosts.add(host);
      break;
    }
    const conditionKey = `${host}|${JSON.stringify(built.condition)}`;
    if (!qualifiedRules.has(conditionKey)) qualifiedRules.set(conditionKey, { host, condition: built.condition, conditionKey });
    break;
  }

  if (!matchedHostRule && !hasOptions) {
    for (const pattern of PATH_RULE_PATTERNS) {
      const match = pattern.exec(patternPart);
      if (!match) continue;
      const host = normalizeHost(match[1]);
      if (host && !isLoopback(host)) pathRules.add(`${host}${match[2].replace(/\^+$/, "")}`);
      break;
    }
  }

  // Score how often each registrable domain is referenced anywhere in the list.
  // Widely targeted domains are the ones worth spending a rule on.
  for (const token of line.split(/[^a-z0-9.-]+/i)) {
    const domain = registrableDomain(token);
    if (domain) domainMentions.set(domain, (domainMentions.get(domain) ?? 0) + 1);
  }
}

if (hosts.size === 0) throw new Error("No host-level rules were found.");

for (const key of exceptionKeys) {
  hosts.delete(key);
  pathRules.delete(key);
}
// An exception withdraws the host, whatever condition the block rule carried.
if (exceptionKeys.size > 0) {
  for (const [key, entry] of qualifiedRules) {
    if (exceptionKeys.has(entry.host)) qualifiedRules.delete(key);
  }
}

function scoreHost(host) {
  const domain = registrableDomain(host);
  const mentions = domain ? domainMentions.get(domain) ?? 0 : 0;
  const labels = host.split(".").length;
  return { mentions, labels, length: host.length, host };
}

// Rank all candidate hosts by EasyList mention frequency, then by specificity.
const ranked = [...hosts]
  .map(scoreHost)
  .sort((a, b) => b.mentions - a.mentions || a.labels - b.labels || a.length - b.length || a.host.localeCompare(b.host))
  .map((entry) => entry.host);

// Always include the known tracker hosts the lists actually declare, even if
// they did not rank in the top EasyList mentions. They displace the lowest-ranked
// hosts so the total never exceeds MAX_HOST_RULES. Taking the forced entries out
// of the ranking before filling the rest means a forced host can never be sliced
// away by the budget.
const forced = [...MUST_BLOCK_DOMAINS].filter((host) => hosts.has(host)).sort();
if (forced.length > MAX_HOST_RULES) throw new Error("Forced host rules exceed the static ruleset budget.");
const forcedSet = new Set(forced);
const remaining = ranked.filter((host) => !forcedSet.has(host));

const selected = [
  ...forced,
  ...remaining.slice(0, MAX_HOST_RULES - forced.length)
].sort();

if (selected.length === 0) throw new Error("No rules survived selection.");

// Option-qualified rules are ranked the same way as hosts, by how often the list
// mentions their registrable domain, so the small qualified budget goes to the
// trackers the lists care about most. A host already blocked widely needs no
// second rule: the wide one is strictly broader.
const selectedHosts = new Set(selected);
const qualifiedBudget = Math.min(
  MAX_QUALIFIED_HOST_RULES,
  MAX_STATIC_RULES - selected.length - Math.min(MAX_PATH_RULES, 1_000)
);
// Two filter spellings can compile to the same condition (`$image,script` and
// `$script,image`), so entries are de-duplicated again on the canonical form
// rather than on their source text.
const canonicalByHostCondition = new Map();
for (const entry of qualifiedRules.values()) {
  if (selectedHosts.has(entry.host)) continue;
  const condition = canonicalHostCondition(entry.condition);
  if (!condition) {
    droppedOptions.set("unrepresentable-condition", (droppedOptions.get("unrepresentable-condition") ?? 0) + 1);
    continue;
  }
  const key = `${entry.host}|${JSON.stringify(condition)}`;
  if (!canonicalByHostCondition.has(key)) canonicalByHostCondition.set(key, { host: entry.host, condition });
}
const selectedQualified = [...canonicalByHostCondition.values()]
  .map((entry) => ({ entry, mentions: domainMentions.get(registrableDomain(entry.host)) ?? 0 }))
  .sort((a, b) => b.mentions - a.mentions || a.entry.host.localeCompare(b.entry.host) || JSON.stringify(a.entry.condition).localeCompare(JSON.stringify(b.entry.condition)))
  .slice(0, Math.max(0, qualifiedBudget))
  .map(({ entry }) => entry);
const canonicalQualified = canonicalHostRules(selectedQualified);
if (canonicalQualified === null) throw new Error("Compiled host-rule conditions are not valid DNR conditions.");

const pathBudget = Math.min(MAX_PATH_RULES, MAX_STATIC_RULES - selected.length - canonicalQualified.length);
const selectedPaths = [...pathRules]
  .map((key) => {
    const slash = key.indexOf("/");
    const host = key.slice(0, slash);
    const path = key.slice(slash);
    const mentions = domainMentions.get(registrableDomain(host)) ?? 0;
    return { key, mentions, adPath: AD_PATH_TOKENS.test(path) ? 1 : 0, pathLength: path.length, host, path };
  })
  // A path that does not name an ad or a tracker is not worth the risk of
  // blocking a real page: `/report/` and `/log/` are as likely to be the site's
  // own content as a beacon.
  .filter((entry) => entry.adPath === 1)
  .sort((a, b) => b.mentions - a.mentions || a.pathLength - b.pathLength || a.key.localeCompare(b.key))
  .slice(0, pathBudget)
  .sort((a, b) => a.key.localeCompare(b.key));

const rules = [
  ...selected.map((host) => ({ urlFilter: `||${host}^`, condition: { resourceTypes: RESOURCE_TYPES } })),
  ...canonicalQualified.map((entry) => ({ urlFilter: `||${entry.host}^`, condition: entry.condition })),
  ...selectedPaths.map((entry) => ({ urlFilter: `||${entry.key}`, condition: { resourceTypes: RESOURCE_TYPES } }))
].map(({ urlFilter, condition }, index) => ({
  id: index + 1,
  priority: 1,
  action: { type: "block" },
  condition: { urlFilter, ...condition }
}));

if (rules.length > MAX_STATIC_RULES) throw new Error("Rule count exceeds the static ruleset budget.");

const metadata = {
  version: "1.1.0",
  buildDate: new Date().toISOString(),
  checksum: await sha256(canonicalBlockingPayload({ hosts: selected, hostRules: canonicalQualified })),
  source: "EasyList+EasyPrivacy",
  attribution: "Ad and tracker blocking rules derived from EasyList and EasyPrivacy, © The EasyList Authors (https://easylist.to/), licensed under CC BY-SA 3.0 / GPL v3.",
  stats: {
    extractedHosts: hosts.size,
    extractedPathRules: pathRules.size,
    withdrawnByException: exceptionKeys.size,
    publishedHostRules: selected.length,
    publishedQualifiedHostRules: canonicalQualified.length,
    publishedPathRules: selectedPaths.length,
    publishedRules: rules.length,
    droppedByOption: Object.fromEntries([...droppedOptions].sort((a, b) => b[1] - a[1]))
  },
  data: { hosts: selected, hostRules: canonicalQualified }
};

await mkdir(outputDirectory, { recursive: true });
await writeFile(resolve(outputDirectory, "ad-tracker-rules.json"), `${JSON.stringify(rules)}\n`);
await writeFile(resolve(outputDirectory, "ad-tracker-data.json"), `${JSON.stringify(metadata)}\n`);
console.log(
  `Extracted ${hosts.size} hosts, ${qualifiedRules.size} option-qualified host rules and ${pathRules.size} path rules; ` +
    `published ${selected.length} host, ${canonicalQualified.length} qualified and ${selectedPaths.length} path rules.`
);

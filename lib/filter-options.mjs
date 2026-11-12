/**
 * Filter option parsing: turns the `$...` tail of an ad-blocking filter line into
 * a Declarative Net Request condition, or reports that the option cannot be
 * expressed there.
 *
 * Why this module exists: the previous build script dropped every line containing
 * `$`, so `||ads.example^$third-party` — the most common shape in EasyList, and
 * the one that keeps a site's own first-party use of a host working — was thrown
 * away instead of compiled. Only options that map onto a DNR condition are
 * accepted here. Anything else is reported as unsupported and the caller must
 * drop that rule rather than widen it: publishing `||host^` for a rule that only
 * asked to block third-party requests would block the host everywhere, including
 * the page the reader is on.
 *
 * The mapping is the same one uBlock Origin performs in its MV3 build (it is the
 * only mapping DNR offers), reimplemented here from the public DNR schema.
 */

// Every resource type a DNR rule may name. Kept in one place so the build script
// and the runtime stay byte-identical when a condition is canonicalised.
export const DNR_RESOURCE_TYPES = Object.freeze([
  "main_frame",
  "sub_frame",
  "script",
  "image",
  "xmlhttprequest",
  "media",
  "font",
  "stylesheet",
  "ping",
  "other",
  "object",
  "websocket"
]);

// EasyList spells the same type several ways; DNR has exactly one name for it.
const TYPE_ALIASES = new Map([
  ["script", "script"],
  ["image", "image"],
  ["stylesheet", "stylesheet"],
  ["css", "stylesheet"],
  ["object", "object"],
  ["object-subrequest", "object"],
  ["xmlhttprequest", "xmlhttprequest"],
  ["xhr", "xmlhttprequest"],
  ["subdocument", "sub_frame"],
  ["frame", "sub_frame"],
  ["ping", "ping"],
  ["beacon", "ping"],
  ["media", "media"],
  ["font", "font"],
  ["websocket", "websocket"],
  ["document", "main_frame"],
  ["doc", "main_frame"],
  ["other", "other"]
]);

const PARTY_ALIASES = new Map([
  ["third-party", "thirdParty"],
  ["3p", "thirdParty"],
  ["first-party", "firstParty"],
  ["1p", "firstParty"]
]);

/**
 * Options with no DNR equivalent on a static rule. `redirect`, `removeparam`,
 * `csp`, `header` and friends are separate DNR actions, not conditions, so a
 * block rule carrying them cannot be published as a block rule; `elemhide`,
 * `generichide` and `specifichide` are exception-only options; `badfilter`
 * disables the rule it names. Listing them explicitly keeps a future option from
 * being silently widened.
 */
const UNSUPPORTED_OPTIONS = new Set([
  "badfilter",
  "csp",
  "denyallow",
  "elemhide",
  "empty",
  "generichide",
  "genericblock",
  "header",
  "inline-font",
  "inline-script",
  "match-case",
  "method",
  "mp4",
  "popup",
  "redirect",
  "redirect-rule",
  "removeparam",
  "replace",
  "sitekey",
  "specifichide",
  "strict1p",
  "strict3p",
  "to",
  "webrtc"
]);

function splitDomains(value) {
  const include = [];
  const exclude = [];
  for (const raw of String(value).split("|")) {
    const domain = raw.trim().toLowerCase().replace(/^~/, "");
    if (!domain || !/^[a-z0-9.*-]+$/.test(domain)) continue;
    if (raw.trim().startsWith("~")) exclude.push(domain);
    else include.push(domain);
  }
  return { include, exclude };
}

/**
 * Parses one option tail (`"third-party,domain=a.com|~b.com,script"`).
 *
 * Returns `{ unsupported }` for an option DNR cannot express, otherwise the
 * pieces `buildRuleCondition` needs. A `null` or empty tail is the common
 * "no options" case and yields no constraints at all.
 */
export function parseRuleOptions(optionText) {
  const result = {
    party: null,
    types: [],
    excludedTypes: [],
    initiatorDomains: [],
    excludedInitiatorDomains: [],
    important: false,
    unsupported: null
  };
  const text = String(optionText ?? "").trim();
  if (!text) return result;

  for (const rawToken of text.split(",")) {
    const token = rawToken.trim().toLowerCase();
    if (!token) continue;
    const negated = token.startsWith("~");
    const body = negated ? token.slice(1) : token;
    const equals = body.indexOf("=");
    const name = equals === -1 ? body : body.slice(0, equals);

    if (equals !== -1) {
      const value = body.slice(equals + 1);
      if (name === "domain" || name === "from") {
        const { include, exclude } = splitDomains(value);
        // `domain=` with nothing usable left says something we cannot honour. Left
        // as a no-op it would make the rule look unconditional and block the host
        // everywhere, which is the opposite of what the list asked for.
        if (include.length === 0 && exclude.length === 0) {
          return { ...result, unsupported: `${name}=` };
        }
        result.initiatorDomains.push(...include);
        result.excludedInitiatorDomains.push(...exclude);
        continue;
      }
      return { ...result, unsupported: name };
    }

    if (PARTY_ALIASES.has(name)) {
      const party = PARTY_ALIASES.get(name);
      // `~third-party` means first-party, and `~first-party` means third-party:
      // the negation flips the constraint rather than removing it.
      result.party = negated ? (party === "thirdParty" ? "firstParty" : "thirdParty") : party;
      continue;
    }

    if (name === "important") {
      // An explicit `~important` is not a thing; treat it as unexpressible
      // rather than guessing which way the list meant it.
      if (negated) return { ...result, unsupported: "~important" };
      result.important = true;
      continue;
    }

    if (TYPE_ALIASES.has(name)) {
      const type = TYPE_ALIASES.get(name);
      if (negated) result.excludedTypes.push(type);
      else result.types.push(type);
      continue;
    }

    return { ...result, unsupported: name };
  }

  return {
    ...result,
    types: [...new Set(result.types)],
    excludedTypes: [...new Set(result.excludedTypes)],
    initiatorDomains: [...new Set(result.initiatorDomains)].sort(),
    excludedInitiatorDomains: [...new Set(result.excludedInitiatorDomains)].sort()
  };
}

/**
 * Builds the DNR condition for a rule whose own filter text is `urlFilter`.
 *
 * `defaultTypes` is the full type list the caller wants when the filter names no
 * type; passing it in keeps the build script and the runtime on one definition.
 * Returns `condition: null` when the tail cannot be expressed, so the caller
 * drops the rule instead of publishing a widened one.
 */
export function buildRuleCondition(optionText, defaultTypes = DNR_RESOURCE_TYPES) {
  const parsed = parseRuleOptions(optionText);
  if (parsed.unsupported) return { condition: null, unsupported: parsed.unsupported, important: false };

  let types;
  if (parsed.types.length > 0) {
    types = parsed.types.filter((type) => !parsed.excludedTypes.includes(type));
  } else {
    types = [...defaultTypes].filter((type) => !parsed.excludedTypes.includes(type));
  }
  // `$~image` applied to a default list that is all images would leave nothing to
  // match; DNR rejects an empty resourceTypes array, so fall back to the default.
  if (types.length === 0) types = [...defaultTypes];

  const condition = { resourceTypes: types };
  if (parsed.party) condition.domainType = parsed.party;
  if (parsed.initiatorDomains.length > 0) condition.initiatorDomains = parsed.initiatorDomains;
  if (parsed.excludedInitiatorDomains.length > 0) condition.excludedInitiatorDomains = parsed.excludedInitiatorDomains;

  // A condition that talks about where the request comes *from* says nothing about
  // a top-level navigation, which has no initiator of its own. Chrome still reports
  // a navigation as third-party when the previous page was a different site, so
  // keeping main_frame here turns "block third-party pixels" into "block visiting
  // the site" — measured, not assumed: a live Chrome run blocked a qualified
  // tracker host's own home page through exactly this rule before the type list was
  // narrowed.
  if (condition.domainType || condition.initiatorDomains || condition.excludedInitiatorDomains) {
    const narrowed = condition.resourceTypes.filter((type) => type !== "main_frame");
    if (narrowed.length === 0) {
      // `$document,third-party` has no DNR form without main_frame; dropping the
      // rule is the honest outcome, widening it is not.
      return { condition: null, unsupported: "document-with-initiator", important: false };
    }
    condition.resourceTypes = narrowed;
  }

  return {
    condition,
    unsupported: null,
    important: parsed.important,
    // "No constraint at all" is the wide host rule the build script already
    // publishes; recognising it here prevents the same host appearing twice with
    // two equivalent rules.
    isWide: !parsed.party && parsed.types.length === 0 && parsed.excludedTypes.length === 0 &&
      parsed.initiatorDomains.length === 0 && parsed.excludedInitiatorDomains.length === 0
  };
}

/**
 * True when a parsed condition is equivalent to the plain wide host rule, so the
 * build script can fold it back into the `hosts` list instead of shipping a
 * second, redundant entry.
 */
export function isWideCondition(condition, defaultTypes = DNR_RESOURCE_TYPES) {
  if (!condition || typeof condition !== "object") return false;
  const keys = Object.keys(condition).filter((key) => key !== "resourceTypes");
  if (keys.length > 0) return false;
  const types = condition.resourceTypes;
  if (!Array.isArray(types) || types.length !== defaultTypes.length) return false;
  return defaultTypes.every((type) => types.includes(type));
}

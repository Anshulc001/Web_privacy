// Common multi-label public suffixes. A single-label suffix (a bare TLD such as
// "com") is always rejected without needing this list; this covers the cases
// where the registrable domain is one label shorter than the TLD.
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  "co.in", "net.in", "org.in", "firm.in", "gen.in", "ind.in",
  "com.br", "net.br", "org.br", "gov.br", "edu.br",
  "co.za", "net.za", "org.za", "gov.za",
  "com.tr", "net.tr", "org.tr", "gov.tr",
  "com.mx", "net.mx", "org.mx", "gob.mx",
  "com.ar", "net.ar", "org.ar", "gob.ar",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "com.hk", "net.hk", "org.hk", "gov.hk", "edu.hk",
  "com.sg", "net.sg", "org.sg", "gov.sg", "edu.sg",
  "com.my", "net.my", "org.my", "gov.my", "edu.my",
  "com.tw", "net.tw", "org.tw", "gov.tw", "edu.tw",
  "co.kr", "ne.kr", "or.kr", "go.kr", "ac.kr",
  "co.id", "net.id", "or.id", "go.id", "ac.id",
  "com.pl", "net.pl", "org.pl", "gov.pl", "edu.pl",
  "co.il", "net.il", "org.il", "gov.il", "ac.il",
  "com.ua", "net.ua", "org.ua", "gov.ua", "edu.ua",
  "com.ru", "net.ru", "org.ru", "msk.ru", "spb.ru",
  "com.es", "net.es", "org.es", "gob.es", "edu.es",
  "co.at", "or.at", "gv.at", "ac.at",
  "com.pt", "net.pt", "org.pt", "gov.pt", "edu.pt",
  "com.gr", "net.gr", "org.gr", "gov.gr", "edu.gr",
  "com.eg", "net.eg", "org.eg", "gov.eg", "edu.eg",
  "com.sa", "net.sa", "org.sa", "gov.sa", "edu.sa",
  "com.pk", "net.pk", "org.pk", "gov.pk", "edu.pk",
  "com.bd", "net.bd", "org.bd", "gov.bd", "edu.bd",
  "com.ng", "net.ng", "org.ng", "gov.ng", "edu.ng",
  "com.gh", "net.gh", "org.gh", "gov.gh", "edu.gh",
  "com.co", "net.co", "org.co", "gov.co", "edu.co",
  "com.pe", "net.pe", "org.pe", "gob.pe", "edu.pe",
  "com.ve", "net.ve", "org.ve", "gob.ve", "edu.ve",
  "com.uy", "net.uy", "org.uy", "gub.uy", "edu.uy",
  "com.py", "net.py", "org.py", "gov.py", "edu.py",
  "com.ec", "net.ec", "org.ec", "gob.ec", "edu.ec",
  "com.bo", "net.bo", "org.bo", "gob.bo", "edu.bo",
  "com.cl", "net.cl", "org.cl", "gob.cl", "edu.cl",
  "com.do", "net.do", "org.do", "gob.do", "edu.do",
  "com.gt", "net.gt", "org.gt", "gob.gt", "edu.gt",
  "com.sv", "net.sv", "org.sv", "gob.sv", "edu.sv",
  "com.hn", "net.hn", "org.hn", "gob.hn", "edu.hn",
  "com.ni", "net.ni", "org.ni", "gob.ni", "edu.ni",
  "com.pa", "net.pa", "org.pa", "gob.pa", "edu.pa",
  "com.cr", "net.cr", "org.cr", "gob.cr", "edu.cr",
  "co.ke", "net.ke", "org.ke", "go.ke", "ac.ke",
  "co.tz", "net.tz", "org.tz", "go.tz", "ac.tz",
  "co.ug", "net.ug", "org.ug", "go.ug", "ac.ug",
  "co.zw", "net.zw", "org.zw", "gov.zw", "ac.zw",
  "com.vn", "net.vn", "org.vn", "gov.vn", "edu.vn",
  "co.th", "net.th", "or.th", "go.th", "ac.th",
  "com.ph", "net.ph", "org.ph", "gov.ph", "edu.ph",
  "com.np", "net.np", "org.np", "gov.np", "edu.np",
  "com.lk", "net.lk", "org.lk", "gov.lk", "edu.lk"
]);

const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const HOST_LABEL_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Normalizes a hostname to lowercase without a trailing dot.
 * Returns null for anything that is not a syntactically valid hostname.
 */
export function normalizeHost(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed || trimmed.length > 253) return null;
  if (IPV4_PATTERN.test(trimmed)) {
    return trimmed.split(".").every((part) => Number(part) <= 255) ? trimmed : null;
  }
  if (trimmed.includes(":")) return null;
  const labels = trimmed.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((label) => HOST_LABEL_PATTERN.test(label))) return null;
  return trimmed;
}

/**
 * True when the host is a bare public suffix: a single-label TLD, or a known
 * multi-label suffix such as "co.uk". These are registries, not registrable
 * domains, so they must never be used for a lookup match.
 */
export function isPublicSuffix(host) {
  const normalized = String(host ?? "").toLowerCase().replace(/\.$/, "");
  if (!normalized) return true;
  const labels = normalized.split(".");
  if (labels.length === 1) return true;
  return MULTI_LABEL_SUFFIXES.has(normalized);
}

/**
 * Candidate hosts from the most specific to the least: the exact host, then each
 * parent domain, stopping before a public suffix.
 *
 * mail.example.com -> ["mail.example.com", "example.com"]
 * example.co.uk    -> ["example.co.uk"]     (never "co.uk")
 */
export function candidateHosts(value) {
  const host = normalizeHost(value);
  if (!host) return [];
  if (IPV4_PATTERN.test(host)) return [host];

  const labels = host.split(".");
  const candidates = [];
  for (let index = 0; index < labels.length; index += 1) {
    const candidate = labels.slice(index).join(".");
    if (isPublicSuffix(candidate)) break;
    candidates.push(candidate);
  }
  return candidates;
}

/**
 * Returns the first matching key from a domain-keyed record, most specific first.
 */
export function matchHostInRecord(host, record) {
  if (!record || typeof record !== "object") return null;
  for (const candidate of candidateHosts(host)) {
    if (Object.prototype.hasOwnProperty.call(record, candidate)) {
      return { match: candidate, value: record[candidate] };
    }
  }
  return null;
}

const MAX_HTML_LENGTH = 200_000;
const MAX_PLAIN_LENGTH = 2_000;
const MAX_LINKS = 5;

const NAMED_ENTITIES = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: "...",
  rsquo: "'",
  lsquo: "'",
  rdquo: "\"",
  ldquo: "\""
});

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (match, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? "");
}

/**
 * Converts untrusted HTML to plain text. Never returns markup, never executes
 * anything, and bounds both input and output size.
 */
export function htmlToPlainText(html, maxLength = MAX_PLAIN_LENGTH) {
  if (typeof html !== "string") return "";
  const limit = Number.isInteger(maxLength) && maxLength > 0 ? Math.min(maxLength, MAX_PLAIN_LENGTH) : MAX_PLAIN_LENGTH;
  const bounded = html.slice(0, MAX_HTML_LENGTH);
  const withoutBlocks = bounded
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ");
  const withoutTags = withoutBlocks.replace(/<\/?[a-z][^>]*>/gi, " ");
  return decodeEntities(withoutTags)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit)
    .trim();
}

function toHttps(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 2_048);
  if (!/^https:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return null;
    if (!url.hostname.includes(".")) return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Extracts only absolute https links from untrusted HTML or an explicit value.
 * Non-https links are dropped, never downgraded.
 */
export function extractHttpsLinks(input, maxLinks = MAX_LINKS) {
  const limit = Number.isInteger(maxLinks) && maxLinks > 0 ? maxLinks : MAX_LINKS;
  const links = [];
  const add = (value) => {
    const safe = toHttps(value);
    if (safe && !links.includes(safe) && links.length < limit) links.push(safe);
  };

  if (typeof input === "string") {
    const bounded = input.slice(0, MAX_HTML_LENGTH);
    for (const match of bounded.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) add(match[1]);
    for (const match of bounded.matchAll(/https:\/\/[^\s"'<>]+/gi)) add(match[0]);
  }

  return links;
}

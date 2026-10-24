import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256 } from "../lib/data-integrity.mjs";
import { candidateHosts, normalizeHost } from "../lib/host-match.mjs";

const SOURCE_URL = "https://easylist-downloads.adblockplus.org/easyprivacy+easylist.txt";
const MAX_SOURCE_BYTES = 20_000_000;
const MAX_RULES = 25_000;
const RESOURCE_TYPES = ["main_frame", "sub_frame", "script", "image", "xmlhttprequest", "media", "font", "stylesheet", "ping", "other"];
const outputDirectory = resolve(import.meta.dirname, "../data");

// A rule is only safe to widen to host-level blocking when its pattern is a bare
// domain anchor: "||host^" or ".host". Path rules such as ".facebook.com/tr"
// target one path on a site that must otherwise keep working, so they are skipped.
const HOST_RULE_PATTERNS = [
  /^\|\|([a-z0-9.-]+)\^$/i,
  /^\.([a-z0-9.-]+)\/?$/i
];

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

const response = await fetch(SOURCE_URL);
if (!response.ok) throw new Error(`Rule list download failed with status ${response.status}.`);
const text = await response.text();
if (text.length > MAX_SOURCE_BYTES) throw new Error("Source list exceeds the 20 MB safety limit.");

const lines = text.split(/\r?\n/);
if (lines.length < 1_000) throw new Error("Source list is unexpectedly small; refusing to build.");

const hosts = new Set();
const domainMentions = new Map();

for (const rawLine of lines) {
  const line = rawLine.trim();
  if (!line || line.startsWith("!") || line.startsWith("[") || line.startsWith("#")) continue;

  // Options come after "$"; only the pattern part decides whether this is a host rule.
  const patternPart = line.split("$")[0];
  for (const pattern of HOST_RULE_PATTERNS) {
    const match = pattern.exec(patternPart);
    if (!match) continue;
    const host = normalizeHost(match[1]);
    if (host && !isLoopback(host)) hosts.add(host);
    break;
  }

  // Score how often each registrable domain is referenced anywhere in the list.
  // Widely targeted domains are the ones worth spending a rule on.
  for (const token of line.split(/[^a-z0-9.-]+/i)) {
    const domain = registrableDomain(token);
    if (domain) domainMentions.set(domain, (domainMentions.get(domain) ?? 0) + 1);
  }
}

if (hosts.size === 0) throw new Error("No host-level rules were found.");

function scoreHost(host) {
  const domain = registrableDomain(host);
  const mentions = domain ? domainMentions.get(domain) ?? 0 : 0;
  const labels = host.split(".").length;
  return { mentions, labels, length: host.length, host };
}

const selected = [...hosts]
  .map(scoreHost)
  .sort((a, b) => b.mentions - a.mentions || a.labels - b.labels || a.length - b.length || a.host.localeCompare(b.host))
  .slice(0, MAX_RULES)
  .map((entry) => entry.host)
  .sort();

if (selected.length === 0) throw new Error("No rules survived selection.");

const rules = selected.map((host, index) => ({
  id: index + 1,
  priority: 1,
  action: { type: "block" },
  condition: { urlFilter: `||${host}^`, resourceTypes: RESOURCE_TYPES }
}));

const metadata = {
  version: "1.0.0",
  buildDate: new Date().toISOString(),
  checksum: await sha256(JSON.stringify(selected)),
  source: "EasyList+EasyPrivacy",
  attribution: "Ad and tracker blocking rules derived from EasyList and EasyPrivacy, © The EasyList Authors (https://easylist.to/), licensed under CC BY-SA 3.0 / GPL v3.",
  stats: { extractedHosts: hosts.size, publishedRules: selected.length },
  data: { hosts: selected }
};

await mkdir(outputDirectory, { recursive: true });
await writeFile(resolve(outputDirectory, "ad-tracker-rules.json"), `${JSON.stringify(rules)}\n`);
await writeFile(resolve(outputDirectory, "ad-tracker-data.json"), `${JSON.stringify(metadata)}\n`);
console.log(`Extracted ${hosts.size} host-level hosts; published ${selected.length} highest-impact rules.`);

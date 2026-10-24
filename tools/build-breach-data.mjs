import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256 } from "../lib/data-integrity.mjs";
import { canonicalizeBreaches, BREACH_DATA_FILE } from "../lib/breach-checker.mjs";
import { htmlToPlainText, extractHttpsLinks } from "../lib/sanitize.mjs";
import { normalizeHost } from "../lib/host-match.mjs";

const SOURCE_URL = "https://haveibeenpwned.com/api/v3/breaches";
const USER_AGENT = "WebGuard-Extension";
const MAX_RESPONSE_BYTES = 20_000_000;
const outputDirectory = resolve(import.meta.dirname, "../data");

const response = await fetch(SOURCE_URL, {
  headers: { "User-Agent": USER_AGENT, accept: "application/json" },
});
if (!response.ok) throw new Error(`HIBP request failed with status ${response.status}.`);

const text = await response.text();
if (text.length > MAX_RESPONSE_BYTES) throw new Error("HIBP response exceeds the 20 MB safety limit.");

let payload;
try {
  payload = JSON.parse(text);
} catch {
  throw new Error("HIBP response is not valid JSON.");
}
if (!Array.isArray(payload)) throw new Error("HIBP response is not an array.");
if (payload.length === 0) throw new Error("HIBP response is empty.");

const grouped = {};
let skippedEmptyDomain = 0;
let skippedInvalidDomain = 0;

for (const entry of payload) {
  const domain = typeof entry?.Domain === "string" ? entry.Domain.trim().toLowerCase() : "";
  if (!domain) {
    skippedEmptyDomain += 1;
    continue;
  }
  const normalized = normalizeHost(domain);
  if (!normalized) {
    skippedInvalidDomain += 1;
    continue;
  }
  const title = htmlToPlainText(typeof entry.Title === "string" ? entry.Title : entry.Name ?? "", 200);
  const record = {
    title,
    breachDate: typeof entry.BreachDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.BreachDate) ? entry.BreachDate : null,
    pwnCount: Number.isInteger(entry.PwnCount) && entry.PwnCount >= 0 ? entry.PwnCount : null,
    dataClasses: Array.isArray(entry.DataClasses) ? entry.DataClasses.filter((item) => typeof item === "string").slice(0, 24).map((item) => item.slice(0, 80)) : [],
    description: htmlToPlainText(typeof entry.Description === "string" ? entry.Description : "", 600),
    disclosureUrl: extractHttpsLinks(typeof entry.DisclosureUrl === "string" ? entry.DisclosureUrl : "", 1)[0] ?? null,
    flags: {
      unverified: entry.IsVerified === false,
      fabricated: entry.IsFabricated === true,
      sensitive: entry.IsSensitive === true,
      retired: entry.IsRetired === true,
      spamList: entry.IsSpamList === true,
      stealerLog: entry.IsStealerLog === true
    }
  };
  if (!grouped[normalized]) grouped[normalized] = [];
  if (grouped[normalized].length < 20) grouped[normalized].push(record);
}

const breaches = canonicalizeBreaches(grouped);
const domainCount = Object.keys(breaches).length;
if (domainCount === 0) throw new Error("No breach domains were produced.");

const metadata = {
  version: "1.0.0",
  buildDate: new Date().toISOString(),
  checksum: await sha256(JSON.stringify(breaches)),
  source: "Have I Been Pwned",
  attribution: "Breach data source: Have I Been Pwned by Troy Hunt (https://haveibeenpwned.com), licensed under CC BY 4.0.",
  skippedEmptyDomain,
  data: { breaches }
};

await mkdir(outputDirectory, { recursive: true });
await writeFile(resolve(outputDirectory, BREACH_DATA_FILE), `${JSON.stringify(metadata)}\n`);
console.log(`Built breach data for ${domainCount} domains (skipped ${skippedEmptyDomain} entries with an empty domain, ${skippedInvalidDomain} with an invalid domain).`);

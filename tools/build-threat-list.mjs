import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256 } from "../lib/data-integrity.mjs";
import { canonicalizeThreatHosts, MAX_THREAT_HOSTS, THREAT_DATA_FILE, THREAT_SOURCE } from "../lib/threat-checker.mjs";

const SOURCE_URL = "https://raw.githubusercontent.com/mitchellkrogza/Phishing.Database/master/phishing-domains-ACTIVE.txt";
const MAX_SOURCE_BYTES = 40_000_000;
const outputDirectory = resolve(import.meta.dirname, "../data");

const response = await fetch(SOURCE_URL, { headers: { accept: "text/plain" } });
if (!response.ok) throw new Error(`Threat list download failed with status ${response.status}.`);

const text = await response.text();
if (text.length > MAX_SOURCE_BYTES) throw new Error("Threat list exceeds the 40 MB safety limit.");

const lines = text.split(/\r?\n/);
if (lines.length < 100) throw new Error("Threat list is unexpectedly small; refusing to build.");

const hosts = canonicalizeThreatHosts(lines.map((line) => line.trim()));
if (hosts.length === 0) throw new Error("No usable phishing hosts were found.");

const selected = hosts.slice(0, MAX_THREAT_HOSTS).sort();

const metadata = {
  version: "1.0.0",
  buildDate: new Date().toISOString(),
  checksum: await sha256(JSON.stringify(selected)),
  source: THREAT_SOURCE.name,
  attribution: THREAT_SOURCE.attribution,
  stats: { parsedHosts: hosts.length, publishedHosts: selected.length },
  data: { hosts: selected }
};

await mkdir(outputDirectory, { recursive: true });
await writeFile(resolve(outputDirectory, THREAT_DATA_FILE), `${JSON.stringify(metadata)}\n`);
console.log(`Built threat list with ${selected.length} hosts from ${lines.length} source lines.`);

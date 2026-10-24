import { normalizeHostname } from "../background/history-store.mjs";

export async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function validateBlockingData(candidate, now = Date.now()) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || !candidate.data || typeof candidate.data !== "object") {
    throw new TypeError("Blocking data has an invalid schema.");
  }
  if (typeof candidate.version !== "string" || typeof candidate.buildDate !== "string" || typeof candidate.checksum !== "string") {
    throw new TypeError("Blocking data metadata is missing.");
  }
  const buildTime = Date.parse(candidate.buildDate);
  if (!Number.isFinite(buildTime) || buildTime > now + 300_000 || !Array.isArray(candidate.data.hosts) || candidate.data.hosts.length > 30_000) {
    throw new TypeError("Blocking data metadata or hosts are invalid.");
  }
  const hosts = [...new Set(candidate.data.hosts.map(normalizeHostname).filter(Boolean))].sort();
  if (hosts.length !== candidate.data.hosts.length) throw new TypeError("Blocking data hosts are invalid or duplicated.");
  if (await sha256(JSON.stringify(hosts)) !== candidate.checksum) throw new TypeError("Blocking data checksum does not match.");
  return { version: candidate.version, buildDate: candidate.buildDate, checksum: candidate.checksum, source: String(candidate.source ?? "Unknown"), data: { hosts } };
}

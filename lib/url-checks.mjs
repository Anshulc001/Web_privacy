import { normalizeHost } from "./host-match.mjs";

const DEFAULT_PORTS = Object.freeze({ "http:": 80, "https:": 443 });

const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const PUNYCODE_PATTERN = /(^|\.)xn--/i;

/**
 * Inspects a URL using only local information. Never contacts the network.
 * Returns one entry per finding so the UI can explain every point of the score.
 */
export function inspectUrl(rawUrl) {
  const text = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!text) return { ok: false, reason: "No URL was provided.", hostname: null, findings: [] };

  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "The URL could not be parsed.", hostname: null, findings: [] };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "Only http and https pages can be checked.", hostname: null, findings: [] };
  }

  const hostname = normalizeHost(url.hostname);
  if (!hostname) {
    return { ok: false, reason: "The URL has no usable hostname.", hostname: null, findings: [] };
  }

  const findings = [];

  if (url.protocol === "http:") {
    findings.push({
      id: "not-https",
      weight: 25,
      label: "The page is loaded over plain HTTP, so it is not encrypted."
    });
  }

  if (PUNYCODE_PATTERN.test(hostname)) {
    findings.push({
      id: "punycode",
      weight: 30,
      label: "The hostname uses punycode (xn--), which can disguise look-alike characters."
    });
  }

  if (IPV4_PATTERN.test(hostname) || hostname.includes(":") || /^\[.*\]$/.test(url.hostname)) {
    findings.push({
      id: "ip-host",
      weight: 20,
      label: "The site is addressed by a raw IP address instead of a domain name."
    });
  }

  const port = url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol];
  if (url.port && Number.isFinite(port) && port !== DEFAULT_PORTS[url.protocol]) {
    findings.push({
      id: "non-default-port",
      weight: 10,
      label: `The site uses the non-standard port ${port}.`
    });
  }

  if (url.username || url.password) {
    findings.push({
      id: "credentials-in-url",
      weight: 30,
      label: "The link contains a username or password in the address itself."
    });
  }

  if (hostname.split(".").length >= 5) {
    findings.push({
      id: "deep-subdomain",
      weight: 10,
      label: "The hostname has an unusually deep subdomain chain, often used to imitate a brand."
    });
  }

  if (hostname.startsWith("www.") === false && /[a-z0-9]\.[a-z0-9-]+\.[a-z0-9-]{2,}$/.test(hostname) && hostname.split(".").length >= 4) {
    findings.push({
      id: "subdomain-brand",
      weight: 5,
      label: "A brand name appears only inside the subdomain, not in the registered domain."
    });
  }

  return {
    ok: true,
    hostname,
    protocol: url.protocol.replace(":", ""),
    isHttps: url.protocol === "https:",
    findings
  };
}

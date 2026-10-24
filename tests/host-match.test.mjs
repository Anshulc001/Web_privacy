import { describe, it } from "node:test";
import assert from "node:assert";
import { normalizeHost, isPublicSuffix, candidateHosts, matchHostInRecord } from "../lib/host-match.mjs";

describe("normalizeHost", () => {
  it("lowercases and strips a trailing dot", () => {
    assert.strictEqual(normalizeHost("Example.COM."), "example.com");
  });

  it("rejects invalid hostnames", () => {
    for (const value of ["", "com", "bad host.com", "-a.com", "a..com", null, 42, "http://x.com"]) {
      assert.strictEqual(normalizeHost(value), null, `expected null for ${JSON.stringify(value)}`);
    }
  });

  it("accepts IPv4 addresses", () => {
    assert.strictEqual(normalizeHost("192.168.0.1"), "192.168.0.1");
    assert.strictEqual(normalizeHost("999.1.1.1"), null);
  });
});

describe("isPublicSuffix", () => {
  it("treats a bare TLD as a public suffix", () => {
    assert.strictEqual(isPublicSuffix("com"), true);
    assert.strictEqual(isPublicSuffix("uk"), true);
  });

  it("treats known multi-label suffixes as public suffixes", () => {
    assert.strictEqual(isPublicSuffix("co.uk"), true);
    assert.strictEqual(isPublicSuffix("com.au"), true);
  });

  it("does not treat a registrable domain as a public suffix", () => {
    assert.strictEqual(isPublicSuffix("example.com"), false);
    assert.strictEqual(isPublicSuffix("example.co.uk"), false);
  });
});

describe("candidateHosts", () => {
  it("returns the exact host then parent domains", () => {
    assert.deepStrictEqual(candidateHosts("mail.example.com"), ["mail.example.com", "example.com"]);
  });

  it("never returns a bare public suffix", () => {
    assert.deepStrictEqual(candidateHosts("example.co.uk"), ["example.co.uk"]);
    assert.deepStrictEqual(candidateHosts("a.b.example.co.uk"), ["a.b.example.co.uk", "b.example.co.uk", "example.co.uk"]);
  });

  it("returns only the address for an IP host", () => {
    assert.deepStrictEqual(candidateHosts("10.0.0.5"), ["10.0.0.5"]);
  });

  it("returns an empty array for an invalid host", () => {
    assert.deepStrictEqual(candidateHosts("not a host"), []);
  });
});

describe("matchHostInRecord", () => {
  const record = { "example.com": "parent", "mail.example.com": "exact", "com": "should-never-win" };

  it("prefers the most specific match", () => {
    assert.deepStrictEqual(matchHostInRecord("mail.example.com", record), { match: "mail.example.com", value: "exact" });
  });

  it("falls back to the parent domain", () => {
    assert.deepStrictEqual(matchHostInRecord("other.example.com", record), { match: "example.com", value: "parent" });
  });

  it("never matches a bare public suffix", () => {
    assert.strictEqual(matchHostInRecord("unrelated.net", record), null);
  });

  it("returns null for a missing record or invalid host", () => {
    assert.strictEqual(matchHostInRecord("example.com", null), null);
    assert.strictEqual(matchHostInRecord("invalid host", record), null);
  });
});

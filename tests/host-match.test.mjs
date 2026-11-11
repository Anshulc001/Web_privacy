import { describe, it } from "node:test";
import assert from "node:assert";
import { normalizeHost, isPublicSuffix, candidateHosts, matchHostInRecord, toggleAllowlistEntry, registrableDomain, hostCoveredBy } from "../lib/host-match.mjs";

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

describe("toggleAllowlistEntry", () => {
  it("adds a host once and keeps the list sorted", () => {
    assert.deepStrictEqual(toggleAllowlistEntry(["z.example"], "a.example", true), ["a.example", "z.example"]);
    assert.deepStrictEqual(toggleAllowlistEntry(["example.com"], "example.com", true), ["example.com"]);
  });

  it("removes the entry that covers the host through its registrable domain", () => {
    assert.deepStrictEqual(toggleAllowlistEntry(["example.com", "unrelated.net"], "www.example.com", false), ["unrelated.net"]);
    assert.deepStrictEqual(toggleAllowlistEntry(["www.example.com"], "www.example.com", false), []);
  });

  it("keeps unrelated entries and tolerates an invalid host", () => {
    assert.deepStrictEqual(toggleAllowlistEntry(["other.test"], "not a host", false), ["other.test"]);
    assert.deepStrictEqual(toggleAllowlistEntry(["other.test"], "not a host", true), ["other.test"]);
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

describe("registrableDomain", () => {
  it("returns the shortest non-suffix candidate", () => {
    assert.strictEqual(registrableDomain("edition.cnn.com"), "cnn.com");
    assert.strictEqual(registrableDomain("news.bbc.co.uk"), "bbc.co.uk");
    assert.strictEqual(registrableDomain("a.b.example.com"), "example.com");
  });

  it("has no answer for addresses and names with no registry", () => {
    for (const value of ["192.168.0.1", "com", "co.uk", "printer.local", "example.test", "not a host", null]) {
      assert.strictEqual(registrableDomain(value), null, `expected null for ${JSON.stringify(value)}`);
    }
  });
});

describe("hostCoveredBy", () => {
  it("matches the exact host and its registrable domain", () => {
    assert.strictEqual(hostCoveredBy("www.example.com", ["example.com"]), true);
    assert.strictEqual(hostCoveredBy("example.com", ["www.example.com"]), true);
    assert.strictEqual(hostCoveredBy("mail.example.com", ["example.com"]), true);
  });

  it("does not cover a sibling domain or a lookalike suffix", () => {
    assert.strictEqual(hostCoveredBy("example.net", ["example.com"]), false);
    assert.strictEqual(hostCoveredBy("notexample.com", ["example.com"]), false);
  });

  it("ignores invalid input and invalid entries", () => {
    assert.strictEqual(hostCoveredBy("example.com", ["bad host", 42, null]), false);
    assert.strictEqual(hostCoveredBy("bad host", ["example.com"]), false);
    assert.strictEqual(hostCoveredBy("example.com", null), false);
  });
});

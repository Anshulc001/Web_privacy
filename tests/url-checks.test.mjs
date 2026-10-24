import { describe, it } from "node:test";
import assert from "node:assert";
import { inspectUrl } from "../lib/url-checks.mjs";

function ids(result) {
  return result.findings.map((finding) => finding.id);
}

describe("inspectUrl", () => {
  it("passes a plain https URL with no findings", () => {
    const result = inspectUrl("https://example.com/page?a=1");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.hostname, "example.com");
    assert.strictEqual(result.isHttps, true);
    assert.deepStrictEqual(ids(result), []);
  });

  it("flags plain HTTP", () => {
    assert.deepStrictEqual(ids(inspectUrl("http://example.com/")), ["not-https"]);
  });

  it("flags punycode hostnames", () => {
    assert.ok(ids(inspectUrl("https://xn--80ak6aa92e.com/")).includes("punycode"));
  });

  it("flags a raw IP host", () => {
    assert.ok(ids(inspectUrl("https://192.168.4.4/login")).includes("ip-host"));
  });

  it("flags a non-default port", () => {
    assert.ok(ids(inspectUrl("https://example.com:8443/")).includes("non-default-port"));
    assert.ok(!ids(inspectUrl("https://example.com:443/")).includes("non-default-port"));
  });

  it("flags credentials embedded in the URL", () => {
    assert.ok(ids(inspectUrl("https://user:secret@example.com/")).includes("credentials-in-url"));
  });

  it("flags an unusually deep subdomain chain", () => {
    assert.ok(ids(inspectUrl("https://a.b.c.d.example.com/")).includes("deep-subdomain"));
  });

  it("rejects unusable input instead of guessing", () => {
    assert.strictEqual(inspectUrl("").ok, false);
    assert.strictEqual(inspectUrl("not a url").ok, false);
    assert.strictEqual(inspectUrl("ftp://example.com/").ok, false);
    assert.strictEqual(inspectUrl(null).ok, false);
  });

  it("never reports a safe verdict, only findings", () => {
    const result = inspectUrl("https://example.com/");
    assert.strictEqual(result.safe, undefined);
    assert.strictEqual(result.verdict, undefined);
  });
});

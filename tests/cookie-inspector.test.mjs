import assert from "node:assert/strict";
import test from "node:test";
import { inspectSiteCookies, presentCookie } from "../lib/cookie-inspector.mjs";

test("presents cookie metadata without ever returning the value", () => {
  const presented = presentCookie({
    name: "session", value: "do-not-leak", domain: ".example.com", expirationDate: 1_700_000_000,
    secure: true, httpOnly: true, sameSite: "lax"
  }, "app.example.com");
  assert.deepEqual(presented, {
    name: "session", domain: "example.com", expiry: "2023-11-14T22:13:20.000Z",
    secure: true, httpOnly: true, sameSite: "lax", party: "first-party"
  });
  assert.equal(JSON.stringify(presented).includes("do-not-leak"), false);
});

test("queries the site and reported third-party hosts, then labels third-party cookies", async () => {
  const domains = [];
  const cookies = await inspectSiteCookies({
    async getAll({ domain }) {
      domains.push(domain);
      return [{ name: domain, value: "hidden", domain, secure: false, httpOnly: false, sameSite: "unspecified" }];
    }
  }, "example.com", ["tracker.test", "tracker.test"]);
  assert.deepEqual(domains, ["example.com", "tracker.test"]);
  assert.equal(cookies[1].party, "third-party");
});

test("lists the registrable domain's cookies once, matching what Clear removes", async () => {
  const domains = [];
  const domainCookie = { name: "shared", value: "hidden", domain: ".example.com", path: "/", secure: true };
  const hostCookie = { name: "host_only", value: "hidden", domain: "www.example.com", path: "/" };
  const cookies = await inspectSiteCookies({
    async getAll({ domain }) {
      domains.push(domain);
      // Chrome returns the domain cookie for both scopes, and a host-only one only
      // for its own host.
      return domain === "www.example.com" ? [domainCookie, hostCookie] : [domainCookie];
    }
  }, "www.example.com", []);
  assert.deepEqual(domains, ["www.example.com", "example.com"]);
  assert.deepEqual(cookies.map((cookie) => cookie.name).sort(), ["host_only", "shared"]);
});

test("keeps a session cookie and survives an impossible expiry date", () => {
  assert.strictEqual(presentCookie({ name: "session", domain: "example.com" }, "example.com").expiry, "Session");
  // An out-of-range number used to throw RangeError from toISOString(), which
  // took the whole cookie panel down instead of listing the other cookies.
  const impossible = presentCookie({ name: "odd", domain: "example.com", expirationDate: 1e20 }, "example.com");
  assert.strictEqual(impossible.expiry, "Session");
  assert.strictEqual(presentCookie({ name: "nan", domain: "example.com", expirationDate: Number.NaN }, "example.com").expiry, "Session");
});

test("tolerates a non-array third-party list instead of failing the whole report", async () => {
  const cookies = await inspectSiteCookies({
    async getAll() {
      return [{ name: "first", domain: ".example.com", path: "/" }];
    }
  }, "example.com", "tracker.test");
  assert.deepEqual(cookies.map((cookie) => cookie.name), ["first"]);
});

test("keeps one row per store and path, even when the name and domain repeat", async () => {
  const cookies = await inspectSiteCookies({
    async getAll({ domain }) {
      if (domain !== "example.com") return [];
      return [
        { name: "id", domain: "example.com", path: "/", storeId: "0", secure: true },
        { name: "id", domain: "example.com", path: "/", storeId: "0", secure: true },
        { name: "id", domain: "example.com", path: "/", storeId: "1", secure: true },
        { name: "id", domain: "example.com", path: "/app", storeId: "0", secure: true }
      ];
    }
  }, "example.com");
  assert.strictEqual(cookies.length, 3);
});

test("queries an IP host once and a multi-label suffix site without the suffix", async () => {
  const ipDomains = [];
  await inspectSiteCookies({
    async getAll({ domain }) {
      ipDomains.push(domain);
      return [];
    }
  }, "127.0.0.1");
  assert.deepEqual(ipDomains, ["127.0.0.1"]);

  const suffixDomains = [];
  await inspectSiteCookies({
    async getAll({ domain }) {
      suffixDomains.push(domain);
      return [];
    }
  }, "news.bbc.co.uk");
  assert.deepEqual(suffixDomains, ["news.bbc.co.uk", "bbc.co.uk"]);
});

test("labels a sibling subdomain's cookie as first-party and drops oversized names", () => {
  assert.strictEqual(presentCookie({ name: "shared", domain: ".example.com" }, "www.example.com").party, "first-party");
  assert.equal(presentCookie({ name: "x".repeat(513), domain: "example.com" }, "example.com"), null);
});

test("rejects unavailable cookie APIs and malformed cookies", async () => {
  await assert.rejects(inspectSiteCookies({}, "example.com"), /cookies API/);
  assert.equal(presentCookie({ name: "x", domain: "bad host!" }, "example.com"), null);
});

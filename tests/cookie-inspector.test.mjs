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

test("rejects unavailable cookie APIs and malformed cookies", async () => {
  await assert.rejects(inspectSiteCookies({}, "example.com"), /cookies API/);
  assert.equal(presentCookie({ name: "x", domain: "bad host!" }, "example.com"), null);
});

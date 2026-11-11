import assert from "node:assert/strict";
import test from "node:test";
import { clearCookiesForHost, cookieRemovalUrl } from "../lib/cookie-insights.mjs";

function fakeCookies(cookiesByDomain) {
  const removed = [];
  return {
    removed,
    async getAll({ domain }) {
      return cookiesByDomain[domain] ?? [];
    },
    async remove(details) {
      removed.push(details);
      return { name: details.name, url: details.url };
    }
  };
}

test("builds over http for an insecure cookie and keeps its path", () => {
  assert.equal(
    cookieRemovalUrl({ domain: ".example.com", path: "/app", secure: false }),
    "http://example.com/app"
  );
});

test("builds over https for a secure cookie", () => {
  assert.equal(
    cookieRemovalUrl({ domain: "example.com", path: "/", secure: true }),
    "https://example.com/"
  );
});

test("defaults to the root path and strips only the leading dot", () => {
  assert.equal(cookieRemovalUrl({ domain: ".news.example.co.uk", secure: true }), "https://news.example.co.uk/");
});

test("rejects a cookie without a domain", () => {
  assert.throws(() => cookieRemovalUrl({ path: "/" }), /domain is required/);
  assert.throws(() => cookieRemovalUrl(null), TypeError);
});

test("removes the cookies of the host and of its registrable domain", async () => {
  const api = fakeCookies({
    "www.example.com": [{ name: "first", domain: ".example.com", path: "/", secure: true, storeId: "0" }],
    "example.com": [
      { name: "first", domain: ".example.com", path: "/", secure: true, storeId: "0" },
      { name: "second", domain: "www.example.com", path: "/", secure: false, storeId: "0" }
    ]
  });

  const result = await clearCookiesForHost(api, "www.example.com");

  // The same cookie is returned by both queries; it must be removed only once.
  assert.equal(result.removed, 2);
  assert.deepEqual(api.removed.map((entry) => entry.name).sort(), ["first", "second"]);
  assert.deepEqual(api.removed[0], { url: "https://example.com/", name: "first", storeId: "0" });
});

test("removes a cookie once per store when the same name exists in two stores", async () => {
  const api = fakeCookies({
    "example.com": [
      { name: "id", domain: "example.com", path: "/", secure: true, storeId: "0" },
      { name: "id", domain: "example.com", path: "/", secure: true, storeId: "1" }
    ]
  });
  const result = await clearCookiesForHost(api, "example.com");
  assert.equal(result.removed, 2);
  assert.deepEqual(api.removed.map((entry) => entry.storeId), ["0", "1"]);
});

test("does not count a cookie that vanished before removal", async () => {
  const api = {
    removed: 0,
    async getAll() {
      return [
        { name: "gone", domain: ".example.com", path: "/", secure: false, storeId: "0" },
        { name: "kept", domain: ".example.com", path: "/", secure: false, storeId: "0" }
      ];
    },
    async remove(details) {
      if (details.name === "gone") throw new Error("No matching cookie");
      return { name: details.name };
    }
  };
  const result = await clearCookiesForHost(api, "example.com");
  assert.equal(result.removed, 1);
});

test("skips malformed cookie records and IP hosts without a registrable domain", async () => {
  const api = fakeCookies({
    "127.0.0.1": [
      { name: "ok", domain: "127.0.0.1", path: "/", secure: false, storeId: "0" },
      { name: 5, domain: "127.0.0.1" },
      { name: "no-domain" }
    ]
  });
  const result = await clearCookiesForHost(api, "127.0.0.1");
  assert.equal(result.removed, 1);
  assert.equal(api.removed.length, 1);
});

test("does not count a removal Chrome reports as null", async () => {
  const api = {
    async getAll() {
      return [{ name: "gone", domain: ".example.com", path: "/", secure: false, storeId: "0" }];
    },
    async remove() {
      return null;
    }
  };
  const result = await clearCookiesForHost(api, "example.com");
  assert.equal(result.removed, 0);
});

test("rejects a missing cookies API or an invalid host", async () => {
  await assert.rejects(() => clearCookiesForHost(null, "example.com"), TypeError);
  await assert.rejects(() => clearCookiesForHost({ getAll() {} }, "example.com"), TypeError);
  await assert.rejects(() => clearCookiesForHost(fakeCookies({}), "not a host"), /valid hostname/);
});

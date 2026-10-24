import { describe, it } from "node:test";
import assert from "node:assert";
import { rdapBaseForHost, lookupDomain, TLS_LIMITATION, createBootstrapStore } from "../lib/domain-info.mjs";

const NOW = Date.parse("2026-10-25T00:00:00Z");
const BOOTSTRAP = {
  services: [
    [["com", "net"], ["https://rdap.verisign.com/com/v1/"]],
    [["uk"], ["https://rdap.nominet.uk/uk/"]],
    [["org"], ["http://insecure.example/", "https://rdap.publicinterestregistry.org/rdap/"]]
  ]
};

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
    async text() { return JSON.stringify(payload); }
  };
}

describe("rdapBaseForHost", () => {
  it("picks the https base for the hostname's TLD", () => {
    assert.strictEqual(rdapBaseForHost("example.com", BOOTSTRAP), "https://rdap.verisign.com/com/v1/");
    assert.strictEqual(rdapBaseForHost("example.org", BOOTSTRAP), "https://rdap.publicinterestregistry.org/rdap/");
  });

  it("adds a trailing slash when missing", () => {
    const bootstrap = { services: [[["com"], ["https://rdap.example"]]] };
    assert.strictEqual(rdapBaseForHost("example.com", bootstrap), "https://rdap.example/");
  });

  it("returns null when the TLD has no https service", () => {
    assert.strictEqual(rdapBaseForHost("example.zz", BOOTSTRAP), null);
    assert.strictEqual(rdapBaseForHost("not a host", BOOTSTRAP), null);
    assert.strictEqual(rdapBaseForHost("example.com", null), null);
  });
});

describe("lookupDomain", () => {
  it("returns registrar and registration date with a computed age", async () => {
    const payload = {
      entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["fn", {}, "text", "Example Registrar Inc."]]] }],
      events: [{ eventAction: "registration", eventDate: "2026-10-20T00:00:00Z" }]
    };
    const result = await lookupDomain("example.com", {
      bootstrap: BOOTSTRAP,
      now: NOW,
      fetchImpl: async () => jsonResponse(payload)
    });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.registrar, "Example Registrar Inc.");
    assert.strictEqual(result.registrationDate, "2026-10-20T00:00:00.000Z");
    assert.strictEqual(result.ageDays, 5);
    assert.strictEqual(result.isNewDomain, true);
    assert.strictEqual(result.tlsNote, TLS_LIMITATION);
  });

  it("reports not-found on a 404 instead of a clean result", async () => {
    const result = await lookupDomain("example.com", {
      bootstrap: BOOTSTRAP,
      fetchImpl: async () => jsonResponse({}, 404)
    });
    assert.strictEqual(result.status, "not-found");
  });

  it("reports unavailable on a network failure", async () => {
    const result = await lookupDomain("example.com", {
      bootstrap: BOOTSTRAP,
      fetchImpl: async () => { throw new Error("network down"); }
    });
    assert.strictEqual(result.status, "unavailable");
    assert.ok(result.reason.includes("network down"));
  });

  it("reports unavailable when the bootstrap cannot load", async () => {
    const result = await lookupDomain("example.com", {
      fetchImpl: async () => { throw new Error("offline"); }
    });
    assert.strictEqual(result.status, "unavailable");
    assert.ok(result.reason.includes("bootstrap"));
  });

  it("reports unsupported when the TLD publishes no RDAP service", async () => {
    const result = await lookupDomain("example.zz", { bootstrap: BOOTSTRAP, fetchImpl: async () => jsonResponse({}) });
    assert.strictEqual(result.status, "unsupported");
  });

  it("rejects oversized responses", async () => {
    const result = await lookupDomain("example.com", {
      bootstrap: BOOTSTRAP,
      fetchImpl: async () => ({ ok: true, status: 200, async text() { return "x".repeat(600_000); } })
    });
    assert.strictEqual(result.status, "unavailable");
  });

  it("reports unavailable for an invalid hostname", async () => {
    const result = await lookupDomain("not a host", { bootstrap: BOOTSTRAP, fetchImpl: async () => jsonResponse({}) });
    assert.strictEqual(result.status, "unavailable");
  });

  it("never returns a safety verdict", async () => {
    const payload = { entities: [], events: [] };
    const result = await lookupDomain("example.com", { bootstrap: BOOTSTRAP, fetchImpl: async () => jsonResponse(payload) });
    assert.strictEqual(result.safe, undefined);
    assert.strictEqual(result.registrar, null);
  });
});

describe("createBootstrapStore", () => {
  it("returns null when nothing is cached", async () => {
    const store = createBootstrapStore({ async get() { return {}; }, async set() {} });
    assert.strictEqual(await store.read(), null);
  });

  it("round-trips a cached bootstrap", async () => {
    let saved;
    const store = createBootstrapStore({
      async get() { return { rdapBootstrap: saved }; },
      async set(patch) { saved = patch.rdapBootstrap; }
    });
    await store.save(BOOTSTRAP);
    const read = await store.read();
    assert.deepStrictEqual(read.services, BOOTSTRAP.services);
  });

  it("ignores a corrupt or expired cache", async () => {
    const corrupt = createBootstrapStore({ async get() { return { rdapBootstrap: { services: "nope" } }; }, async set() {} });
    assert.strictEqual(await corrupt.read(), null);

    const expired = createBootstrapStore({
      async get() { return { rdapBootstrap: { services: [], savedAt: 0 } }; },
      async set() {}
    });
    assert.strictEqual(await expired.read(), null);
  });
});

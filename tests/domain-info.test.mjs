import { describe, it } from "node:test";
import assert from "node:assert";
import {
  RDAP_AGGREGATOR_BASE,
  RDAP_BASE_BY_TLD,
  cachedDomainInfo,
  isPublicDomain,
  lookupDomain,
  lookupDomainUrl,
  rdapBaseForHost,
  saveDomainInfo,
  TLS_LIMITATION,
  createBootstrapStore
} from "../lib/domain-info.mjs";

const NOW = Date.parse("2026-10-25T00:00:00Z");

const BOOTSTRAP = {
  services: [
    [["com", "net"], ["https://rdap.verisign.com/com/v1/"]],
    [["uk"], ["https://rdap.nominet.uk/uk/"]],
    [["org"], ["http://insecure.example/", "https://rdap.publicinterestregistry.org/rdap/"]],
    [["io"], ["https://rdap.registry.io/v1/"]],
    [["zz"], ["http://insecure.example/"]],
    [["uk", "co.uk"], ["https://rdap.registry.uk/v1/"]]
  ]
};

const GOOGLE_COM_PAYLOAD = {
  entities: [
    {
      roles: ["registrar"],
      handle: "GOOGLE",
      vcardArray: ["vcard", [["fn", {}, "text", "MarkMonitor Inc."]]],
      publicIds: [{ type: "IANA Registrar ID", identifier: "292" }]
    },
    {
      roles: ["registrar"],
      vcardArray: ["vcard", [["org", {}, "text", ["Cloudflare, Inc.", "US"]]]]
    },
    {
      roles: ["registrar"],
      publicIds: [{ ldhName: "ENOM" }]
    },
    {
      roles: ["registrar"],
      handle: "9999"
    }
  ],
  events: [
    { eventAction: "registration", eventDate: "2020-03-15T00:00:00Z" },
    { eventAction: "last changed", eventDate: "2026-10-10T00:00:00Z" },
    { eventAction: "last update of RDAP database", eventDate: "2026-10-20T00:00:00Z" },
    { eventAction: "expiration", eventDate: "2027-03-15T00:00:00Z" }
  ],
  status: ["clientTransferProhibited", "active", "clientTransferProhibited"]
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
  it("picks the https base for the hostname's TLD from the live bootstrap", () => {
    assert.strictEqual(rdapBaseForHost("example.com", BOOTSTRAP), "https://rdap.verisign.com/com/v1/");
    // An http-only service is skipped in favour of one that can be used safely.
    assert.strictEqual(rdapBaseForHost("example.org", BOOTSTRAP), "https://rdap.publicinterestregistry.org/rdap/");
  });

  it("adds a trailing slash when the bootstrap omits it", () => {
    const bootstrap = { services: [[["com"], ["https://rdap.example"]]] };
    assert.strictEqual(rdapBaseForHost("example.com", bootstrap), "https://rdap.example/");
  });

  it("falls back to the built-in map when no bootstrap is cached yet", () => {
    assert.strictEqual(rdapBaseForHost("example.com", null), "https://rdap.verisign.com/com/v1/");
    assert.strictEqual(rdapBaseForHost("example.fr", null), RDAP_BASE_BY_TLD.fr);
    assert.strictEqual(rdapBaseForHost("example.ai", null), RDAP_BASE_BY_TLD.ai);
  });

  it("prefers the live bootstrap over the built-in map", () => {
    const bootstrap = { services: [[["com"], ["https://rdap.mirror.example/v1/"]]] };
    assert.strictEqual(rdapBaseForHost("example.com", bootstrap), "https://rdap.mirror.example/v1/");
  });

  it("uses the longest matching suffix for multi-part public suffixes", () => {
    assert.strictEqual(rdapBaseForHost("news.bbc.co.uk", BOOTSTRAP), "https://rdap.registry.uk/v1/");
    assert.strictEqual(rdapBaseForHost("www.bbc.co.uk", BOOTSTRAP), "https://rdap.registry.uk/v1/");
    // Without a bootstrap, the country registry that serves .co.uk is used.
    assert.strictEqual(rdapBaseForHost("news.bbc.co.uk", null), "https://rdap.nominet.uk/uk/");
  });

  it("covers the common extra TLDs without the bootstrap", () => {
    assert.strictEqual(rdapBaseForHost("example.io", null), RDAP_BASE_BY_TLD.io);
    assert.strictEqual(rdapBaseForHost("example.me", null), RDAP_BASE_BY_TLD.me);
    assert.strictEqual(rdapBaseForHost("example.us", null), RDAP_BASE_BY_TLD.us);
    assert.strictEqual(rdapBaseForHost("example.tv", null), RDAP_BASE_BY_TLD.tv);
    assert.strictEqual(rdapBaseForHost("example.cc", null), RDAP_BASE_BY_TLD.cc);
    assert.strictEqual(rdapBaseForHost("example.xyz", null), RDAP_BASE_BY_TLD.xyz);
    assert.strictEqual(rdapBaseForHost("example.tech", null), RDAP_BASE_BY_TLD.tech);
  });

  it("falls back to the rdap.org aggregator when the TLD has no usable service", () => {
    // Not in the built-in map, no https entry in the bootstrap.
    assert.strictEqual(rdapBaseForHost("example.zz", BOOTSTRAP), RDAP_AGGREGATOR_BASE);
    // TLDs with no registry RDAP endpoint of their own.
    assert.strictEqual(rdapBaseForHost("example.co", null), RDAP_AGGREGATOR_BASE);
    assert.strictEqual(rdapBaseForHost("example.eu", null), RDAP_AGGREGATOR_BASE);
  });

  it("returns null for a bare public suffix, a local name, an IP or invalid input", () => {
    assert.strictEqual(rdapBaseForHost("com", BOOTSTRAP), null);
    assert.strictEqual(rdapBaseForHost("co.uk", BOOTSTRAP), null);
    assert.strictEqual(rdapBaseForHost("127.0.0.1", BOOTSTRAP), null);
    assert.strictEqual(rdapBaseForHost("localhost", BOOTSTRAP), null);
    assert.strictEqual(rdapBaseForHost("example.local", BOOTSTRAP), null);
    assert.strictEqual(rdapBaseForHost("not a host", BOOTSTRAP), null);
  });
});

describe("lookupDomainUrl", () => {
  it("queries the registrable domain, not the subdomain", () => {
    const url = lookupDomainUrl("edition.cnn.com", BOOTSTRAP);
    assert.ok(url);
    assert.strictEqual(url.href, "https://rdap.verisign.com/com/v1/domain/cnn.com");

    const linkedin = lookupDomainUrl("www.linkedin.com", null);
    assert.strictEqual(linkedin.href, "https://rdap.verisign.com/com/v1/domain/linkedin.com");
  });

  it("keeps the multi-part suffix on multi-part public suffixes", () => {
    const bbc = lookupDomainUrl("news.bbc.co.uk", BOOTSTRAP);
    assert.strictEqual(bbc.href, "https://rdap.registry.uk/v1/domain/bbc.co.uk");
  });

  it("builds the aggregator URL without doubling the /domain/ path", () => {
    const url = lookupDomainUrl("example.eu", null);
    assert.strictEqual(url.href, "https://rdap.org/domain/example.eu");
  });

  it("returns null for an IP, a local name or a bare suffix", () => {
    assert.strictEqual(lookupDomainUrl("127.0.0.1", BOOTSTRAP), null);
    assert.strictEqual(lookupDomainUrl("example.local", BOOTSTRAP), null);
    assert.strictEqual(lookupDomainUrl("co.uk", BOOTSTRAP), null);
    assert.strictEqual(lookupDomainUrl("com", BOOTSTRAP), null);
  });
});

describe("lookupDomain", () => {
  it("uses the registrable domain and returns registrar + dates", async () => {
    const requested = [];
    const result = await lookupDomain("edition.cnn.com", {
      bootstrap: BOOTSTRAP,
      now: NOW,
      fetchImpl: async (url) => {
        requested.push(url);
        return jsonResponse(GOOGLE_COM_PAYLOAD);
      }
    });

    assert.deepStrictEqual(requested, ["https://rdap.verisign.com/com/v1/domain/cnn.com"]);
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.hostname, "edition.cnn.com");
    assert.strictEqual(result.domain, "cnn.com");
    assert.strictEqual(result.registrar, "MarkMonitor Inc.");
    assert.strictEqual(result.registrationDate, "2020-03-15T00:00:00.000Z");
    // "last changed" wins over "last update of RDAP database".
    assert.strictEqual(result.lastChangedDate, "2026-10-10T00:00:00.000Z");
    assert.strictEqual(result.expirationDate, "2027-03-15T00:00:00.000Z");
    assert.strictEqual(result.ageDays, 2415);
    assert.strictEqual(result.isNewDomain, false);
    assert.strictEqual(result.tlsNote, TLS_LIMITATION);
    assert.deepStrictEqual(result.statuses, ["active", "clientTransferProhibited"]);
  });

  it("resolves multi-part suffixes to the registrable domain", async () => {
    const requested = [];
    const result = await lookupDomain("news.bbc.co.uk", {
      bootstrap: BOOTSTRAP,
      now: NOW,
      fetchImpl: async (url) => {
        requested.push(url);
        return jsonResponse({
          entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["fn", {}, "text", "BBC Registry Limited"]]] }],
          events: [
            { eventAction: "registration", eventDate: "2000-01-01T00:00:00Z" },
            { eventAction: "last changed", eventDate: "2026-09-01T00:00:00Z" },
            { eventAction: "expiration", eventDate: "2027-01-01T00:00:00Z" }
          ]
        });
      }
    });

    assert.deepStrictEqual(requested, ["https://rdap.registry.uk/v1/domain/bbc.co.uk"]);
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.domain, "bbc.co.uk");
    assert.strictEqual(result.registrar, "BBC Registry Limited");
    assert.strictEqual(result.registrationDate, "2000-01-01T00:00:00.000Z");
    assert.strictEqual(result.expirationDate, "2027-01-01T00:00:00.000Z");
  });

  it("works when the live bootstrap cannot be downloaded", async () => {
    const requested = [];
    const result = await lookupDomain("www.cnn.com", {
      now: NOW,
      fetchImpl: async (url) => {
        requested.push(url);
        if (url.includes("data.iana.org")) throw new Error("offline");
        return jsonResponse(GOOGLE_COM_PAYLOAD);
      }
    });

    assert.deepStrictEqual(requested, [
      "https://data.iana.org/rdap/dns.json",
      "https://rdap.verisign.com/com/v1/domain/cnn.com"
    ]);
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.registrar, "MarkMonitor Inc.");
    assert.strictEqual(result.source, "rdap.verisign.com");
  });

  it("does not download the bootstrap again when the caller says it is unavailable", async () => {
    const requested = [];
    const result = await lookupDomain("www.cnn.com", {
      bootstrap: null,
      now: NOW,
      fetchImpl: async (url) => {
        requested.push(url);
        return jsonResponse(GOOGLE_COM_PAYLOAD);
      }
    });
    assert.deepStrictEqual(requested, ["https://rdap.verisign.com/com/v1/domain/cnn.com"]);
    assert.strictEqual(result.status, "ok");
  });

  it("uses the rdap.org fallback for a TLD with no registry service", async () => {
    const requested = [];
    const result = await lookupDomain("example.eu", {
      now: NOW,
      fetchImpl: async (url) => {
        requested.push(url);
        if (url.includes("data.iana.org")) throw new Error("offline");
        return jsonResponse(GOOGLE_COM_PAYLOAD);
      }
    });

    assert.deepStrictEqual(requested, [
      "https://data.iana.org/rdap/dns.json",
      "https://rdap.org/domain/example.eu"
    ]);
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.source, "rdap.org");
  });

  it("parses every registrar fallback shape", async () => {
    const registrarFor = async (entities) => {
      const result = await lookupDomain("example.com", {
        bootstrap: BOOTSTRAP,
        fetchImpl: async () => jsonResponse({ entities, events: [] })
      });
      return result.registrar;
    };

    assert.strictEqual(
      await registrarFor([{ roles: ["registrar"], vcardArray: ["vcard", [["fn", {}, "text", "Name Only"]]] }]),
      "Name Only"
    );
    assert.strictEqual(
      await registrarFor([{ roles: ["registrar"], vcardArray: ["vcard", [["org", {}, "text", ["Org Only Ltd", "GB"]]]] }]),
      "Org Only Ltd"
    );
    assert.strictEqual(
      await registrarFor([{ roles: ["registrar"], publicIds: [{ ldhName: "PUBLIC-ID" }] }]),
      "PUBLIC-ID"
    );
    assert.strictEqual(
      await registrarFor([{ roles: ["registrar"], handle: "HANDLE-1" }]),
      "HANDLE-1"
    );
    // Only an entity with the registrar role counts.
    assert.strictEqual(
      await registrarFor([{ roles: ["registrant"], vcardArray: ["vcard", [["fn", {}, "text", "Not A Registrar"]]] }]),
      null
    );
  });

  it("accepts alternative event names", async () => {
    const result = await lookupDomain("example.com", {
      bootstrap: BOOTSTRAP,
      now: NOW,
      fetchImpl: async () => jsonResponse({
        events: [
          { eventAction: "created", eventDate: "2026-10-20T00:00:00Z" },
          { eventAction: "changed", eventDate: "2026-10-22T00:00:00Z" },
          { eventAction: "expires", eventDate: "2027-10-20T00:00:00Z" }
        ]
      })
    });
    assert.strictEqual(result.registrationDate, "2026-10-20T00:00:00.000Z");
    assert.strictEqual(result.lastChangedDate, "2026-10-22T00:00:00.000Z");
    assert.strictEqual(result.expirationDate, "2027-10-20T00:00:00.000Z");
    assert.strictEqual(result.ageDays, 5);
    assert.strictEqual(result.isNewDomain, true);
    assert.strictEqual(result.statuses, null);
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

  it("reports unsupported for an IP and for a bare suffix", async () => {
    for (const hostname of ["127.0.0.1", "co.uk"]) {
      const result = await lookupDomain(hostname, { bootstrap: BOOTSTRAP, fetchImpl: async () => jsonResponse({}) });
      assert.strictEqual(result.status, "unsupported", hostname);
    }
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
    const result = await lookupDomain("example.com", {
      bootstrap: BOOTSTRAP,
      fetchImpl: async () => jsonResponse({ entities: [], events: [] })
    });
    assert.strictEqual(result.safe, undefined);
    assert.strictEqual(result.registrar, null);
    assert.strictEqual(result.registrationDate, null);
    assert.strictEqual(result.ageDays, null);
    assert.strictEqual(result.isNewDomain, null);
  });
});

describe("isPublicDomain", () => {
  it("accepts real public domains, including deep subdomains", () => {
    assert.strictEqual(isPublicDomain("example.com"), true);
    assert.strictEqual(isPublicDomain("edition.cnn.com"), true);
    assert.strictEqual(isPublicDomain("www.linkedin.com"), true);
    assert.strictEqual(isPublicDomain("news.bbc.co.uk"), true);
    assert.strictEqual(isPublicDomain("example.io"), true);
    assert.strictEqual(isPublicDomain("example.gg"), true);
  });

  it("rejects local addresses, IPs, bare suffixes and invalid input", () => {
    assert.strictEqual(isPublicDomain("127.0.0.1"), false);
    assert.strictEqual(isPublicDomain("10.0.0.5"), false);
    assert.strictEqual(isPublicDomain("localhost"), false);
    assert.strictEqual(isPublicDomain("com"), false);
    assert.strictEqual(isPublicDomain("co.uk"), false);
    assert.strictEqual(isPublicDomain("example.local"), false);
    assert.strictEqual(isPublicDomain("router.home.arpa"), false);
    assert.strictEqual(isPublicDomain("not a host"), false);
  });
});

describe("domain info cache", () => {
  function memoryStorage() {
    let stored;
    return {
      async get() { return { domainInfoCache: stored }; },
      async set(patch) { stored = patch.domainInfoCache; }
    };
  }

  it("reads one registrable-domain answer for every subdomain", async () => {
    const storage = memoryStorage();
    await storage.set({ domainInfoCache: { "cnn.com": { at: NOW, value: { registrar: "CNN Registrar" } } } });

    for (const hostname of ["edition.cnn.com", "www.cnn.com", "cnn.com"]) {
      assert.deepStrictEqual(await cachedDomainInfo(storage, hostname, NOW), { registrar: "CNN Registrar" });
    }
  });

  it("does not return a cached answer for a different registrable domain", async () => {
    const storage = memoryStorage();
    await storage.set({ domainInfoCache: { "cnn.com": { at: NOW, value: { registrar: "CNN Registrar" } } } });
    assert.strictEqual(await cachedDomainInfo(storage, "edition.bbc.co.uk", NOW), null);
  });

  it("ignores an expired answer and a local name", async () => {
    const storage = memoryStorage();
    await storage.set({ domainInfoCache: { "cnn.com": { at: NOW - 2 * 86_400_000, value: { registrar: "x" } } } });
    assert.strictEqual(await cachedDomainInfo(storage, "cnn.com", NOW), null);
    assert.strictEqual(await cachedDomainInfo(storage, "example.local", NOW), null);
  });

  it("writes under the registrable domain so subdomains share one entry", async () => {
    const storage = memoryStorage();
    await saveDomainInfo(storage, "edition.cnn.com", { registrar: "CNN Registrar" }, NOW);
    const stored = await storage.get();
    assert.deepStrictEqual(Object.keys(stored.domainInfoCache), ["cnn.com"]);

    // Re-storing through another subdomain refreshes the same entry.
    await saveDomainInfo(storage, "www.cnn.com", { registrar: "CNN Registrar 2" }, NOW + 10);
    const refreshed = await storage.get();
    assert.deepStrictEqual(Object.keys(refreshed.domainInfoCache), ["cnn.com"]);
    assert.deepStrictEqual(await cachedDomainInfo(storage, "cnn.com", NOW + 10), { registrar: "CNN Registrar 2" });
  });

  it("refuses to write an entry for a name with no registry record", async () => {
    const storage = memoryStorage();
    assert.strictEqual(await saveDomainInfo(storage, "example.local", { registrar: "x" }, NOW), null);
    assert.strictEqual(await saveDomainInfo(storage, "127.0.0.1", { registrar: "x" }, NOW), null);
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

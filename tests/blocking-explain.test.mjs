import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_REASONS, createBlockingIndex, explainBlockedHost } from "../lib/blocking-explain.mjs";

const data = {
  version: "1.1.0",
  data: {
    hosts: ["doubleclick.net"],
    hostRules: [
      { host: "quantserve.com", condition: { resourceTypes: ["script"], domainType: "thirdParty" } },
      { host: "tracked.example", condition: { resourceTypes: ["main_frame"] } }
    ]
  }
};

test("a subdomain is explained by the rule on its registrable domain", () => {
  const index = createBlockingIndex(data);
  const explain = explainBlockedHost("pixel.quantserve.com", index);
  assert.equal(explain.reason, BLOCK_REASONS.thirdParty);
  assert.equal(explain.matched, "quantserve.com");
  assert.match(explain.label, /third-party/);
  assert.equal(explain.version, "1.1.0");
});

test("a plain host rule says the host is blocked on every request", () => {
  const explain = explainBlockedHost("ads.doubleclick.net", createBlockingIndex(data));
  assert.equal(explain.reason, BLOCK_REASONS.host);
  assert.equal(explain.matched, "doubleclick.net");
});

test("a type-only rule is reported as one request type, not as third-party", () => {
  const explain = explainBlockedHost("tracked.example", createBlockingIndex(data));
  assert.equal(explain.reason, BLOCK_REASONS.types);
});

test("initiator rules are named as such", () => {
  const index = createBlockingIndex({
    version: "1.1.0",
    data: { hosts: [], hostRules: [{ host: "only.example", condition: { resourceTypes: ["script"], initiatorDomains: ["a.example"] } }] }
  });
  assert.equal(explainBlockedHost("only.example", index).reason, BLOCK_REASONS.initiator);
});

test("a host in no downloaded list is attributed to the bundled ruleset, not guessed", () => {
  const explain = explainBlockedHost("mystery.example", createBlockingIndex(data));
  assert.equal(explain.reason, BLOCK_REASONS.bundled);
  assert.equal(explain.matched, null);
});

test("without downloaded data the answer says so instead of claiming a rule", () => {
  const explain = explainBlockedHost("pixel.quantserve.com", null);
  assert.equal(explain.reason, BLOCK_REASONS.unknown);
  assert.equal(explain.version, null);
});

test("an index tolerates malformed entries and never throws", () => {
  const index = createBlockingIndex({ data: { hosts: [null, 42, "ok.example"], hostRules: [null, { host: 7 }, { host: "bad.example", condition: null }] } });
  assert.deepEqual([...index.hosts], ["ok.example"]);
  assert.equal(index.qualified.size, 0);
  assert.equal(explainBlockedHost("bad.example", index).reason, BLOCK_REASONS.bundled);
  assert.equal(createBlockingIndex(undefined), null);
  assert.equal(createBlockingIndex({ data: null }), null);
});

test("a non-public hostname is not attributed to any list", () => {
  const explain = explainBlockedHost("localhost", createBlockingIndex(data));
  assert.equal(explain.reason, BLOCK_REASONS.unknown);
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildRuleCondition, isWideCondition, parseRuleOptions } from "../lib/filter-options.mjs";

test("an option-less filter keeps today's wide block", () => {
  const built = buildRuleCondition("", ["script", "image"]);
  assert.deepEqual(built.condition, { resourceTypes: ["script", "image"] });
  assert.equal(built.unsupported, null);
  assert.equal(built.isWide, true);
  assert.equal(isWideCondition(built.condition, ["script", "image"]), true);
});

test("$third-party becomes a DNR domainType instead of a dropped rule", () => {
  const built = buildRuleCondition("third-party", ["script", "main_frame"]);
  assert.equal(built.unsupported, null);
  assert.equal(built.isWide, false);
  // main_frame is deliberately absent: a navigation is not a third-party request.
  assert.deepEqual(built.condition, { resourceTypes: ["script"], domainType: "thirdParty" });
});

test("the party options and their negations map both ways", () => {
  assert.equal(buildRuleCondition("3p").condition.domainType, "thirdParty");
  assert.equal(buildRuleCondition("1p").condition.domainType, "firstParty");
  assert.equal(buildRuleCondition("~third-party").condition.domainType, "firstParty");
  assert.equal(buildRuleCondition("~first-party").condition.domainType, "thirdParty");
});

test("$domain= becomes initiatorDomains and excludedInitiatorDomains", () => {
  const built = buildRuleCondition("domain=b.example|~c.example|A.example", ["script"]);
  assert.deepEqual(built.condition.initiatorDomains, ["a.example", "b.example"]);
  assert.deepEqual(built.condition.excludedInitiatorDomains, ["c.example"]);
  // Sorted and de-duplicated, so the checksum over the condition is stable.
  const again = buildRuleCondition("domain=A.example|b.example|~c.example", ["script"]);
  assert.deepEqual(again.condition, built.condition);
});

test("a $domain= with no usable value is dropped instead of widening the rule", () => {
  // Read as "no constraint", the rule would become a plain host block: the exact
  // over-blocking the option existed to prevent.
  for (const option of ["domain=", "from=", "domain=~", "domain=!!bad!!"]) {
    const built = buildRuleCondition(option, ["script"]);
    assert.equal(built.condition, null, `${option} must not compile`);
    assert.ok(built.unsupported, `${option} must name itself`);
  }
});

test("$from= is an alias for $domain=", () => {
  assert.deepEqual(buildRuleCondition("from=d.example", ["script"]).condition.initiatorDomains, ["d.example"]);
});

test("resource-type options narrow the type list, aliases included", () => {
  assert.deepEqual(buildRuleCondition("script,image", ["script", "image", "font"]).condition.resourceTypes, ["script", "image"]);
  assert.deepEqual(buildRuleCondition("xhr,css", ["script", "xmlhttprequest", "stylesheet"]).condition.resourceTypes, ["xmlhttprequest", "stylesheet"]);
  assert.deepEqual(buildRuleCondition("~image", ["script", "image"]).condition.resourceTypes, ["script"]);
});

test("an emptied type list falls back to the defaults rather than an empty DNR array", () => {
  // Chrome rejects a rule whose resourceTypes is empty, which would fail the
  // whole ruleset update, so this can never be published as-is.
  const built = buildRuleCondition("~image", ["image"]);
  assert.deepEqual(built.condition.resourceTypes, ["image"]);
});

test("options DNR cannot express are reported, never widened", () => {
  for (const option of ["redirect", "removeparam=x", "csp=script-src", "popup", "match-case", "badfilter", "header=x"]) {
    const built = buildRuleCondition(option, ["script"]);
    assert.equal(built.condition, null, `${option} must not compile`);
    assert.ok(built.unsupported, `${option} must name itself`);
  }
});

test("an unknown option is unsupported too, so a new list option cannot slip through", () => {
  assert.equal(parseRuleOptions("some-future-option").unsupported, "some-future-option");
});

test("a third-party rule never matches the navigation itself", () => {
  // Chrome reports a top-level navigation as third-party when the previous page was
  // another site, so leaving main_frame in would block visiting the site. A live run
  // blocked https://www.quantserve.com/ this way before the fix.
  const built = buildRuleCondition("third-party", ["main_frame", "script", "image"]);
  assert.deepEqual(built.condition.resourceTypes, ["script", "image"]);
  for (const option of ["domain=a.example", "~domain=a.example", "first-party"]) {
    const narrow = buildRuleCondition(option, ["main_frame", "script"]);
    assert.ok(!narrow.condition.resourceTypes.includes("main_frame"), `${option} must not match main_frame`);
  }
});

test("$document,$third-party has no DNR form and is reported instead of widened", () => {
  const built = buildRuleCondition("document,third-party", ["main_frame"]);
  assert.equal(built.condition, null);
  assert.equal(built.unsupported, "document-with-initiator");
});

test("$important is parsed but does not change the condition", () => {
  const built = buildRuleCondition("important,third-party", ["script"]);
  assert.equal(built.important, true);
  assert.deepEqual(built.condition, { resourceTypes: ["script"], domainType: "thirdParty" });
});

test("empty and whitespace-only option tails are treated as no options", () => {
  assert.equal(buildRuleCondition("   ").isWide, true);
  assert.equal(buildRuleCondition(undefined).isWide, true);
});

test("isWideCondition rejects conditions that carry a constraint", () => {
  assert.equal(isWideCondition({ resourceTypes: ["script"], domainType: "thirdParty" }, ["script"]), false);
  assert.equal(isWideCondition({ resourceTypes: ["script", "image"] }, ["script"]), false);
  assert.equal(isWideCondition(null, ["script"]), false);
});

import { describe, it } from "node:test";
import assert from "node:assert";
import { htmlToPlainText, extractHttpsLinks } from "../lib/sanitize.mjs";

describe("htmlToPlainText", () => {
  it("strips tags and decodes entities", () => {
    assert.strictEqual(
      htmlToPlainText("<p>Hello &amp; welcome to <strong>Acme</strong></p>"),
      "Hello & welcome to Acme"
    );
  });

  it("removes script and style blocks entirely", () => {
    const text = htmlToPlainText("<style>body{color:red}</style><script>alert('x')</script>Visible text");
    assert.strictEqual(text, "Visible text");
  });

  it("collapses whitespace and trims", () => {
    assert.strictEqual(htmlToPlainText("  a \n\n  b\t\tc  "), "a b c");
  });

  it("bounds the output length", () => {
    const text = htmlToPlainText(`<p>${"a".repeat(5000)}</p>`, 100);
    assert.ok(text.length <= 100, `expected <= 100 chars, got ${text.length}`);
  });

  it("returns an empty string for non-string input", () => {
    assert.strictEqual(htmlToPlainText(null), "");
    assert.strictEqual(htmlToPlainText(42), "");
    assert.strictEqual(htmlToPlainText(undefined), "");
  });

  it("never leaves angle brackets that could be markup", () => {
    assert.ok(!htmlToPlainText("<img src=x onerror=alert(1)>hello").includes("<"));
  });
});

describe("extractHttpsLinks", () => {
  it("keeps absolute https links and drops http", () => {
    const links = extractHttpsLinks('<a href="https://example.com/a">a</a><a href="http://insecure.test/b">b</a>');
    assert.deepStrictEqual(links, ["https://example.com/a"]);
  });

  it("drops javascript and data URLs", () => {
    const links = extractHttpsLinks('href="javascript:alert(1)" href="data:text/html,x" href="https://ok.test/"');
    assert.deepStrictEqual(links, ["https://ok.test/"]);
  });

  it("deduplicates and respects the limit", () => {
    const html = 'https://a.test/ https://a.test/ https://b.test/ https://c.test/';
    assert.deepStrictEqual(extractHttpsLinks(html, 2), ["https://a.test/", "https://b.test/"]);
  });

  it("strips credentials and fragments from returned links", () => {
    const [link] = extractHttpsLinks("https://user:pass@example.com/path#frag");
    assert.strictEqual(link, "https://example.com/path");
  });

  it("returns an empty array for non-string input", () => {
    assert.deepStrictEqual(extractHttpsLinks(null), []);
  });
});

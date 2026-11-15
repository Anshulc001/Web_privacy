import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildStateBlock, stateBlockMatches } from "../tools/agents-state.mjs";

test("AGENTS.md current-state block matches the repository", async () => {
  const markdown = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
  const block = await buildStateBlock();
  // The block is generated, not written by hand: a mismatch means a version, data
  // build, permission or default changed and the briefing a new session reads is
  // now wrong. The fix is `npm run agents:state`, not editing the numbers.
  assert.ok(
    stateBlockMatches(markdown, block),
    "AGENTS.md is stale. Run `npm run agents:state` and commit the result."
  );
});

test("state-block check passes when only line endings differ (CRLF checkout)", async () => {
  // A Windows checkout (core.autocrlf=true) writes CRLF, the generator joins lines
  // with "\n". Same values, so this must not be reported as drift.
  const block = await buildStateBlock();
  const crlfMarkdown = `# AGENTS.md\r\n\r\n${block.replace(/\n/g, "\r\n")}\r\n\r\n## Next section\r\n`;
  assert.equal(
    stateBlockMatches(crlfMarkdown, block),
    true,
    "a CRLF checkout must not be reported as stale"
  );
});

test("state-block check still fails when a value genuinely differs", async () => {
  const block = await buildStateBlock();
  const drifted = block.replace(/- Test files: \d+/, "- Test files: 999");
  assert.notEqual(drifted, block, "the fixture must actually change a value");
  assert.equal(
    stateBlockMatches(`x\r\n${drifted.replace(/\n/g, "\r\n")}\r\n`, block),
    false,
    "real content drift must still fail, even with line endings normalised"
  );
});

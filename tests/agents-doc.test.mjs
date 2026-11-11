import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildStateBlock } from "../tools/agents-state.mjs";

test("AGENTS.md current-state block matches the repository", async () => {
  const markdown = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
  const block = await buildStateBlock();
  // The block is generated, not written by hand: a mismatch means a version, data
  // build, permission or default changed and the briefing a new session reads is
  // now wrong. The fix is `npm run agents:state`, not editing the numbers.
  assert.ok(
    markdown.includes(block),
    "AGENTS.md is stale. Run `npm run agents:state` and commit the result."
  );
});

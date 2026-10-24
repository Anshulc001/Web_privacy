import { fileURLToPath } from "node:url";
import { probe } from "./mcp-probe.mjs";

// Dev-only MCP servers used while building WebGuard. None of them ship inside the
// extension; this exists so their health can be re-checked at any time.

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/\\/g, "/");

const SERVERS = [
  {
    name: "Context7",
    command: process.execPath,
    args: ["node_modules/@upstash/context7-mcp/dist/index.js"],
    call: "resolve-library-id",
    callArgs: { libraryName: "chrome extensions", query: "declarativeNetRequest" },
    timeout: 60_000
  },
  {
    name: "Playwright",
    command: process.execPath,
    args: ["node_modules/@playwright/mcp/cli.js"],
    call: "browser_navigate",
    callArgs: { url: "https://example.com" },
    timeout: 120_000
  },
  {
    // Installed with `pip install code-review-graph`, not from npm. It is on PATH
    // after a pip install, so it is resolved by name.
    name: "Code review graph",
    command: "code-review-graph",
    args: ["serve", "--repo", REPO_ROOT],
    // The server writes UTF-8 to stdio; Windows needs to be told.
    env: { PYTHONUTF8: "1" },
    call: "list_graph_stats_tool",
    callArgs: {},
    // A repository that has never been built has no graph to report on.
    blockedPattern: /no graph|not been built|code-review-graph build/i,
    optional: true,
    timeout: 90_000
  }
];

const results = [];

for (const server of SERVERS) {
  process.stdout.write(`${server.name}: `);
  const result = await probe(server);

  const callText = result.call ? String(result.call.text ?? "") : "";
  const blocked = Boolean(server.blockedPattern && server.blockedPattern.test(callText));

  let status;
  if (!result.ok) {
    // A missing optional binary is not a broken setup, so say so plainly instead
    // of failing the whole check.
    status = result.stage === "spawn" && server.optional ? "SKIPPED" : "FAIL";
  } else if (result.call && result.call.isError) {
    status = blocked ? "BLOCKED" : "FAIL";
  } else if (blocked) {
    // The tool answered without error but did no real work (for example it had no
    // staged diff). Calling that a pass would overstate what was verified.
    status = "BLOCKED";
  } else {
    status = "PASS";
  }

  results.push({ server, result, status });

  if (status === "SKIPPED") {
    console.log(`SKIPPED - ${result.error?.message ?? "not installed"}`);
  } else if (status === "FAIL") {
    const detail = result.ok ? result.call?.text ?? "unknown failure" : `${result.stage}: ${JSON.stringify(result.error)}`;
    console.log(`FAIL - ${detail}`);
  } else if (status === "BLOCKED") {
    console.log(`BLOCKED - ${result.toolCount} tools listed; ${String(result.call.text).slice(0, 120)}`);
  } else {
    // Show what the tool actually returned, so a tool that short-circuits (for
    // example because no staged changes exist) cannot look like a full success.
    const snippet = result.call ? String(result.call.text ?? "").replace(/\s+/g, " ").slice(0, 90) : "";
    const callText = result.call ? `; ${server.call} -> ${snippet}` : "";
    console.log(`PASS - ${result.toolCount} tools${callText}`);
  }
}

console.log("\nSummary");
for (const { server, status, result } of results) {
  const tools = result.ok ? ` [${result.toolNames.slice(0, 4).join(", ")}${result.toolNames.length > 4 ? ", …" : ""}]` : "";
  console.log(`- ${server.name}: ${status}${tools}`);
}

const failed = results.filter((entry) => entry.status === "FAIL" || entry.status === "BLOCKED");
process.exit(failed.length ? 1 : 0);

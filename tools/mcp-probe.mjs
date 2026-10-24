import { spawn } from "node:child_process";

const PROTOCOL_VERSION = "2024-11-05";

function parseArgs(argv) {
  const options = { command: null, args: [], call: null, callArgs: {}, timeout: 45_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--command") options.command = argv[++index];
    else if (token === "--arg") options.args.push(argv[++index]);
    else if (token === "--call") options.call = argv[++index];
    else if (token === "--json") options.callArgs = JSON.parse(argv[++index]);
    else if (token === "--timeout") options.timeout = Number(argv[++index]);
  }
  return options;
}

/** Speaks MCP over stdio: newline-delimited JSON-RPC 2.0. */
function createClient(child, timeoutMs) {
  const pending = new Map();
  let buffer = "";
  let nextId = 1;
  const stderr = [];

  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // Servers may print log lines to stdout; ignore non-JSON.
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve } = pending.get(message.id);
        pending.delete(message.id);
        resolve(message);
      }
    }
  });

  function request(method, params) {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, {
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        }
      });
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  /** Fails every pending request, for cases like a binary that does not exist. */
  function fail(error) {
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.reject(error);
    }
  }

  return { request, notify, fail, stderr };
}

export async function probe({ command, args = [], call, callArgs = {}, env, timeout = 45_000 }) {
  // Only .cmd/.bat shims need a shell. Using a shell for an absolute path such as
  // process.execPath would split it on the spaces in "Program Files".
  const useShell = /\.(cmd|bat)$/i.test(String(command));
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    shell: useShell,
    env: env ? { ...process.env, ...env } : process.env
  });
  const client = createClient(child, timeout);
  // A missing binary emits 'error' and then never answers, so fail the handshake
  // immediately instead of waiting out the timeout.
  child.on("error", (error) => client.fail(error));

  const exited = new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
  });

  try {
    const init = await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "webguard-probe", version: "1.0.0" }
    });

    if (init.error) {
      return { ok: false, stage: "initialize", error: init.error };
    }

    client.notify("notifications/initialized", {});

    const listed = await client.request("tools/list", {});
    const tools = listed.result?.tools ?? [];
    if (listed.error) {
      return { ok: false, stage: "tools/list", error: listed.error, serverInfo: init.result?.serverInfo };
    }

    const result = {
      ok: true,
      serverInfo: init.result?.serverInfo ?? null,
      protocolVersion: init.result?.protocolVersion ?? null,
      toolCount: tools.length,
      toolNames: tools.map((tool) => tool.name)
    };

    if (call) {
      const called = await client.request("tools/call", { name: call, arguments: callArgs });
      if (called.error) {
        result.call = { ok: false, error: called.error };
      } else {
        const content = called.result?.content ?? [];
        const textParts = content.filter((part) => part.type === "text").map((part) => part.text);
        result.call = {
          ok: called.result?.isError !== true,
          isError: called.result?.isError === true,
          text: textParts.join("\n").slice(0, 1200)
        };
      }
    }

    return result;
  } catch (error) {
    return {
      ok: false,
      stage: error.code === "ENOENT" ? "spawn" : "runtime",
      error: { message: String(error.message ?? error), code: error.code ?? null },
      stderr: client.stderr.join("").slice(-1500)
    };
  } finally {
    child.stdin.end();
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
}

const isDirectRun = process.argv[1] ? /mcp-probe\.mjs$/.test(process.argv[1].replace(/\\/g, "/")) : false;

if (isDirectRun) {
  const options = parseArgs(process.argv.slice(2));
  if (!options.command) {
    console.error("Usage: node tools/mcp-probe.mjs --command <server> [--arg ...] [--call <tool>] [--json '{...}']");
    process.exit(2);
  }

  const result = await probe(options);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

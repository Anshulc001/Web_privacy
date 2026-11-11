import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DISPLAYED_LINK_HOSTS,
  LOCAL_FETCH_PATTERN,
  NETWORK_FILES,
  NETWORK_PRIMITIVES,
  OUTBOUND_ENDPOINTS,
  PRIVACY_PERMISSIONS
} from "../lib/privacy-contract.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHIPPED_DIRS = ["background", "content", "dashboard", "lib", "popup"];
const SOURCE_EXTENSIONS = new Set([".js", ".mjs"]);

async function sourceFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path);
  }
  return files;
}

const files = (await Promise.all(SHIPPED_DIRS.map((dir) => sourceFiles(join(ROOT, dir))))).flat();
const sources = await Promise.all(files.map(async (file) => ({
  path: relative(ROOT, file).split("\\").join("/"),
  lines: (await readFile(file, "utf8")).split("\n")
})));

const declaredHosts = new Set([
  ...OUTBOUND_ENDPOINTS.flatMap((endpoint) => endpoint.hosts),
  ...DISPLAYED_LINK_HOSTS
]);

test("declares every endpoint once, with servers and a trigger", () => {
  const ids = OUTBOUND_ENDPOINTS.map((endpoint) => endpoint.id);
  assert.deepEqual(ids, [...new Set(ids)], "endpoint ids must be unique");
  for (const endpoint of OUTBOUND_ENDPOINTS) {
    assert.ok(endpoint.label && endpoint.when && endpoint.detail, `${endpoint.id} needs reader-facing text`);
    assert.ok(endpoint.hosts.length > 0, `${endpoint.id} must name at least one server`);
  }
  const endpointIds = new Set(ids);
  for (const [file, used] of Object.entries(NETWORK_FILES)) {
    for (const id of used) assert.ok(endpointIds.has(id), `${file} references an undeclared endpoint: ${id}`);
  }
});

test("every network primitive is a local file read or lives in a declared file", () => {
  const offenders = [];
  for (const source of sources) {
    for (const [index, line] of source.lines.entries()) {
      if (!NETWORK_PRIMITIVES.some((primitive) => line.includes(primitive))) continue;
      if (LOCAL_FETCH_PATTERN.test(line)) continue;
      // The contract file itself only lists the primitives as strings.
      if (source.path === "lib/privacy-contract.mjs") continue;
      if (!NETWORK_FILES[source.path]) offenders.push(`${source.path}:${index + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `new outbound code needs an entry in NETWORK_FILES and OUTBOUND_ENDPOINTS:\n${offenders.join("\n")}`);
});

test("every hardcoded server is declared as a destination or a displayed link", () => {
  const offenders = [];
  for (const source of sources) {
    for (const [index, line] of source.lines.entries()) {
      for (const match of line.matchAll(/https:\/\/([a-z0-9.-]+)/gi)) {
        const host = match[1].toLowerCase();
        if (!declaredHosts.has(host)) offenders.push(`${source.path}:${index + 1}: ${host}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `undeclared host(s) — add to OUTBOUND_ENDPOINTS or DISPLAYED_LINK_HOSTS:\n${offenders.join("\n")}`);
});

test("the permission panel matches the manifest exactly", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(PRIVACY_PERMISSIONS.map((permission) => permission.name), manifest.permissions);
  for (const permission of PRIVACY_PERMISSIONS) {
    assert.ok(permission.why && permission.why.length > 20, `${permission.name} needs a plain-language reason`);
  }
});

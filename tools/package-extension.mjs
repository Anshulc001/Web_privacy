import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve, join, relative, sep } from "node:path";
import { deflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT_DIR = resolve(ROOT, "dist");

// A build replaces the previous pack instead of piling up versions: anything
// this script (or an earlier manual pack) produced is removed before writing.
const PREVIOUS_PACKAGE = /^(webguard-.*\.(zip|crx|pem)|WebGuard-latest.*)$/i;

async function clearPreviousPackages() {
  let entries = [];
  try {
    entries = await readdir(OUTPUT_DIR);
  } catch {
    return;
  }
  const stale = entries.filter((entry) => PREVIOUS_PACKAGE.test(entry));
  for (const entry of stale) await rm(join(OUTPUT_DIR, entry), { recursive: true, force: true });
  if (stale.length > 0) console.log(`Removed ${stale.length} previous package(s): ${stale.join(", ")}`);
}

// Everything the browser needs at runtime. Tests, tools, docs and the signing
// key stay out of the package.
const INCLUDE = ["manifest.json", "background", "content", "lib", "popup", "dashboard", "data"];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function collect(path, files) {
  const info = await stat(path);
  if (info.isDirectory()) {
    const entries = await readdir(path);
    for (const entry of entries.sort()) {
      await collect(join(path, entry), files);
    }
    return;
  }
  files.push(path);
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

const files = [];
for (const entry of INCLUDE) {
  try {
    await collect(resolve(ROOT, entry), files);
  } catch (error) {
    throw new Error(`Packaging input is missing: ${entry} (${error.message})`);
  }
}
if (files.length === 0) throw new Error("Nothing to package.");

const manifest = JSON.parse(readFileSync(resolve(ROOT, "manifest.json"), "utf8"));
const version = typeof manifest.version === "string" ? manifest.version : "0.0.0";

const chunks = [];
const central = [];
let offset = 0;
const { time, day } = dosDateTime(new Date());

for (const file of files) {
  const name = relative(ROOT, file).split(sep).join("/");
  const raw = await readFile(file);
  const compressed = deflateRawSync(raw, { level: 9 });
  const useDeflate = compressed.length < raw.length;
  const payload = useDeflate ? compressed : raw;
  const nameBytes = Buffer.from(name, "utf8");
  const crc = crc32(raw);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0x0800, 6);
  localHeader.writeUInt16LE(useDeflate ? 8 : 0, 8);
  localHeader.writeUInt16LE(time, 10);
  localHeader.writeUInt16LE(day, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(payload.length, 18);
  localHeader.writeUInt32LE(raw.length, 22);
  localHeader.writeUInt16LE(nameBytes.length, 26);
  localHeader.writeUInt16LE(0, 28);

  chunks.push(localHeader, nameBytes, payload);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0x0800, 8);
  centralHeader.writeUInt16LE(useDeflate ? 8 : 0, 10);
  centralHeader.writeUInt16LE(time, 12);
  centralHeader.writeUInt16LE(day, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(payload.length, 20);
  centralHeader.writeUInt32LE(raw.length, 24);
  centralHeader.writeUInt16LE(nameBytes.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(offset, 42);
  central.push(Buffer.concat([centralHeader, nameBytes]));

  offset += localHeader.length + nameBytes.length + payload.length;
}

const centralBuffer = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuffer.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

await mkdir(OUTPUT_DIR, { recursive: true });
await clearPreviousPackages();
const outputPath = resolve(OUTPUT_DIR, `webguard-${version}.zip`);
await writeFile(outputPath, Buffer.concat([...chunks, centralBuffer, end]));

const totalBytes = (await stat(outputPath)).size;
console.log(`Packaged ${files.length} files into ${outputPath} (${(totalBytes / 1024).toFixed(1)} KB).`);

import playwright from "playwright";
const { chromium } = playwright;
import { describe, it } from "node:test";
import assert from "node:assert";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(__dirname, "..").replace(/\\/g, "/");

// Derived from the manifest "key": sha256 of the public DER, hex mapped 0-f -> a-p.
const EXTENSION_ID = "mkemflphgmnjjdebbcgioplolpgeclii";

// Hosts that the published ruleset blocks, and URLs that return real content when
// they are not blocked, so a block is unambiguous rather than a network error.
const BLOCKED = [
  { host: "googletagmanager.com", url: "https://www.googletagmanager.com/gtag/js" },
  { host: "google-analytics.com", url: "https://www.google-analytics.com/analytics.js" },
  { host: "doubleclick.net", url: "https://ad.doubleclick.net/ddm/activity.js" }
];

describe("live blocking in Chrome with the unpacked extension", () => {
  it("blocks tracker hosts, keeps the page working, and loads the bundled ruleset", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/control.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end("window.__controlLoaded = true;");
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><html><body>
        <script src="/control.js"></script>
        ${BLOCKED.map((entry) => `<script src="${entry.url}"></script>`).join("\n")}
      </body></html>`);
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/`;
    const userDataDir = await mkdtemp(join(tmpdir(), "webguard-live-"));

    // Extensions require a persistent profile and a headful browser; Playwright's
    // bundled Chromium is used because branded Google Chrome ignores --load-extension.
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-default-apps",
        "--disable-translate"
      ],
      ignoreDefaultArgs: ["--disable-extensions", "--disable-component-extensions-with-background-pages"]
    });

    try {
      let workers = context.serviceWorkers();
      if (workers.length === 0) {
        workers = [await context.waitForEvent("serviceworker", { timeout: 20_000 })];
      }
      const workerUrl = workers[0]?.url() ?? "";
      assert.ok(
        workerUrl.startsWith(`chrome-extension://${EXTENSION_ID}/`),
        `expected the extension to load as ${EXTENSION_ID}, got ${workerUrl || "no service worker"}`
      );

      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");

      const requestUrls = new Map();
      const failures = [];
      cdp.on("Network.requestWillBeSent", (event) => requestUrls.set(event.requestId, event.request.url));
      cdp.on("Network.loadingFailed", (event) => {
        failures.push({ url: requestUrls.get(event.requestId) ?? "", error: event.errorText });
      });

      await page.goto(baseUrl, { waitUntil: "load", timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(4_000);

      // The local page itself must never be blocked (loopback is excluded on purpose).
      const pageFailure = failures.find((failure) => failure.url === baseUrl);
      assert.strictEqual(pageFailure, undefined, "the local test page must not be blocked");

      const controlLoaded = await page.evaluate(() => window.__controlLoaded === true);
      assert.strictEqual(controlLoaded, true, "the first-party control script must run");

      for (const entry of BLOCKED) {
        const failure = failures.find((item) => item.url.includes(entry.host));
        assert.ok(failure, `expected ${entry.host} to fail`);
        assert.ok(
          failure.error.includes("ERR_BLOCKED_BY_CLIENT"),
          `expected ${entry.host} to fail with ERR_BLOCKED_BY_CLIENT, got ${failure.error}`
        );
      }
    } finally {
      await context.close();
      await new Promise((resolve) => server.close(resolve));
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});

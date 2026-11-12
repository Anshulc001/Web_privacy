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
  { host: "doubleclick.net", url: "https://ad.doubleclick.net/ddm/activity.js" },
  // The last two are published as "$third-party" rules: their condition is
  // domainType thirdParty, not a plain host block. They prove the compiled
  // condition actually reaches Chrome and fires, which the wide hosts above
  // cannot show.
  { host: "quantserve.com", url: "https://secure.quantserve.com/quant.js", qualified: true },
  { host: "taboola.com", url: "https://www.taboola.com/libtrc/unip/1/tfa.js", qualified: true }
];

// A host that only has an option-qualified rule must still be reachable when it is
// the page itself: blocking a first-party visit is exactly what the list did not ask
// for, and what an unconditioned host rule would have done.
const FIRST_PARTY_SITE = "https://www.quantserve.com/";

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
        // A fresh profile downloads the *published* data file within a second of the
        // worker starting, which silently replaced the bundled list this test is
        // meant to measure: a run against the published v1.0.0 file reported every
        // host as a wide rule. Pointing the data host at loopback makes the worker
        // fall back to the bundled copy, so the assertions describe the ruleset in
        // this repository. Remove this only if the test should track the published
        // copy instead.
        "--host-resolver-rules=MAP raw.githubusercontent.com 127.0.0.1",
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

      // Chrome validates the bundled ruleset at install time and silently disables
      // every rule it cannot parse, so a broken condition would leave the extension
      // blocking nothing while every other check still passed. With the data host
      // pointed at loopback there is no downloaded list to hide behind either.
      const ruleHealth = await workers[0].evaluate(async () => {
        const dnr = chrome.declarativeNetRequest;
        if (typeof dnr.getDisabledRuleIds !== "function") return null;
        return {
          enabled: await dnr.getEnabledRulesets(),
          disabled: (await dnr.getDisabledRuleIds({ rulesetId: "ad_tracker_rules" })).length
        };
      });
      if (ruleHealth) {
        assert.deepEqual(ruleHealth.enabled, ["ad_tracker_rules"], "the bundled ruleset must be enabled");
        assert.equal(ruleHealth.disabled, 0, "Chrome disabled compiled rules as invalid");
      }

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
          `expected ${entry.host}${entry.qualified ? " (third-party-only rule)" : ""} to fail with ERR_BLOCKED_BY_CLIENT, got ${failure.error}`
        );
      }

      // Visiting the site itself is a first-party request, so the third-party-only
      // rule must stay out of the way. A network error is acceptable here (the run
      // may be offline); being blocked by WebGuard is not.
      const direct = await context.newPage();
      const directCdp = await context.newCDPSession(direct);
      await directCdp.send("Network.enable");
      const directUrls = new Map();
      const directFailures = [];
      directCdp.on("Network.requestWillBeSent", (event) => directUrls.set(event.requestId, event.request.url));
      directCdp.on("Network.loadingFailed", (event) => {
        directFailures.push({ url: directUrls.get(event.requestId) ?? "", error: event.errorText });
      });
      await direct.goto(FIRST_PARTY_SITE, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      const blockedVisit = directFailures.find(
        (failure) => failure.url.startsWith(FIRST_PARTY_SITE) && failure.error.includes("ERR_BLOCKED_BY_CLIENT")
      );
      assert.strictEqual(
        blockedVisit,
        undefined,
        `${FIRST_PARTY_SITE} is a first-party visit and must not be blocked by a third-party-only rule`
      );
      await direct.close();
    } finally {
      await context.close();
      await new Promise((resolve) => server.close(resolve));
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});

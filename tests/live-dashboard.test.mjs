import playwright from "playwright";
const { chromium } = playwright;
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(__dirname, "..").replace(/\\/g, "/");
const EXTENSION_ID = "mkemflphgmnjjdebbcgioplolpgeclii";
const DASHBOARD_URL = `chrome-extension://${EXTENSION_ID}/dashboard/dashboard.html`;

async function openExtensionPage(url) {
  const userDataDir = await mkdtemp(join(tmpdir(), "webguard-ui-"));
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
  return { context, userDataDir, url };
}

const POPUP_URL = `chrome-extension://${EXTENSION_ID}/popup/popup.html`;

describe("live dashboard in Chrome", () => {
  it("renders every section with no console errors", async () => {
    const { context, userDataDir } = await openExtensionPage(DASHBOARD_URL);
    try {
      if (context.serviceWorkers().length === 0) {
        await context.waitForEvent("serviceworker", { timeout: 20_000 });
      }

      const page = await context.newPage();
      const consoleErrors = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => consoleErrors.push(String(error.message)));

      await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForSelector("main", { timeout: 10_000 });

      assert.strictEqual(await page.title(), "WebGuard Dashboard");

      for (const id of ["overview", "cookies", "permissions", "domain", "ads", "suspicious", "breach", "history", "settings"]) {
        assert.ok(await page.locator(`#${id}`).isVisible(), `section #${id} should be visible`);
      }

      await page.waitForFunction(() => document.getElementById("status")?.textContent === "Loaded.", null, { timeout: 20_000 });
      assert.strictEqual(await page.locator("#status").innerText(), "Loaded.");

      // Charts must be real SVG built without a chart library.
      const svgCount = await page.locator(".chart svg").count();
      assert.ok(svgCount >= 1, `expected at least one rendered SVG chart, found ${svgCount}`);

      // Data freshness list must be populated.
      const dataItems = await page.locator("#data-status li").count();
      assert.ok(dataItems >= 1, "data freshness list should have entries");

      assert.deepStrictEqual(consoleErrors, [], "dashboard must not log console errors");
    } finally {
      await context.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  it("loads the popup page and degrades to an explicit unavailable state without a web tab", async () => {
    const { context, userDataDir } = await openExtensionPage(POPUP_URL);
    try {
      if (context.serviceWorkers().length === 0) {
        await context.waitForEvent("serviceworker", { timeout: 20_000 });
      }
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(String(error.message)));

      await page.goto(POPUP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForSelector("main", { timeout: 10_000 });

      assert.strictEqual(await page.locator("h1").innerText(), "WebGuard");
      // Text placeholders are empty until data arrives, so presence is the right check;
      // interactive controls must actually be visible.
      for (const id of ["status", "blocking-status", "blocking-data", "blocking-top-hosts"]) {
        assert.strictEqual(await page.locator(`#${id}`).count(), 1, `popup element #${id} should exist`);
      }
      for (const id of ["open-dashboard"]) {
        assert.ok(await page.locator(`#${id}`).isVisible(), `popup element #${id} should be visible`);
      }

      // The popup tab is itself the active tab, so there is no web page to report on.
      // The popup must say so instead of showing a clean result or throwing.
      await page.waitForFunction(
        () => document.getElementById("status")?.textContent !== "Loading current-site privacy details…",
        null,
        { timeout: 10_000 }
      );
      assert.strictEqual(await page.locator("#status").innerText(), "Current-site privacy details are unavailable.");
      assert.deepStrictEqual(pageErrors, [], "popup must not throw an unhandled error");
    } finally {
      await context.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});

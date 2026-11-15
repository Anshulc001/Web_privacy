import playwright from "playwright";
const { chromium } = playwright;
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(__dirname, "..").replace(/\\/g, "/");
const EXTENSION_ID = "mkemflphgmnjjdebbcgioplolpgeclii";
const DASHBOARD_URL = `chrome-extension://${EXTENSION_ID}/dashboard/dashboard.html`;

async function openExtensionPage(url, extraArgs = []) {
  const userDataDir = await mkdtemp(join(tmpdir(), "webguard-ui-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      ...extraArgs,
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
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function workerOf(context) {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
}

async function waitForLoaded(page) {
  await page.waitForFunction(
    () => document.getElementById("status")?.textContent === "Loaded.",
    null,
    { timeout: 25_000 }
  );
}

/** A local page served as example.com through Chrome's host resolver map. */
function fixture() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><head><title>fixture</title></head><body><h1>fixture</h1></body></html>");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/**
 * Opens the real toolbar popup over the site tab. Chrome's popup bubble is not a
 * Playwright page, so this attaches to the target it opens, as the e2e suite does.
 */
async function openToolbarPopup(context, siteFragment) {
  const worker = await workerOf(context);
  const activate = () => worker.evaluate(async (fragment) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((entry) => (entry.url ?? "").includes(fragment));
    if (!tab) return null;
    await chrome.tabs.update(tab.id, { active: true });
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
    return tab.id;
  }, siteFragment);
  await activate();

  const browserSession = await context.browser().newBrowserCDPSession();
  const before = new Set((await browserSession.send("Target.getTargets")).targetInfos.map((info) => info.targetId));
  let opened = false;
  for (let attempt = 0; attempt < 15 && !opened; attempt += 1) {
    try {
      await worker.evaluate(() => chrome.action.openPopup());
      opened = true;
    } catch {
      await wait(400);
      await activate();
    }
  }
  assert.ok(opened, "chrome.action.openPopup() must succeed");

  let popupTarget = null;
  for (let attempt = 0; attempt < 60 && !popupTarget; attempt += 1) {
    const { targetInfos } = await browserSession.send("Target.getTargets");
    popupTarget = targetInfos.find((info) => info.type === "page" && info.url === POPUP_URL && !before.has(info.targetId)) ?? null;
    if (!popupTarget) await wait(200);
  }
  assert.ok(popupTarget, "the toolbar popup must open");
  const { sessionId } = await browserSession.send("Target.attachToTarget", { targetId: popupTarget.targetId, flatten: false });
  let nextId = 1;
  const pending = new Map();
  browserSession.on("Target.receivedMessageFromTarget", (event) => {
    const data = JSON.parse(event.message);
    const waiter = pending.get(data.id);
    if (!waiter) return;
    pending.delete(data.id);
    if (data.error) waiter.reject(new Error(JSON.stringify(data.error)));
    else waiter.resolve(data.result);
  });
  const send = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      browserSession.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) }).catch(reject);
    });
  };
  const evaluate = async (expression) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  await send("Page.enable");
  await send("Runtime.enable");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await evaluate("Boolean(document.getElementById('open-dashboard'))")) break;
    await wait(200);
  }
  return { evaluate, targetId: popupTarget.targetId };
}

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

      // Wait for the first render: the two-mode layout is applied then, so
      // reading section visibility before it would see the raw HTML.
      await page.waitForFunction(() => document.getElementById("status")?.textContent === "Loaded.", null, { timeout: 20_000 });
      assert.strictEqual(await page.locator("#status").innerText(), "Loaded.");

      // The dashboard opens in "All sites" mode, where only the whole-browser
      // sections are shown; per-site panels appear once a site is picked.
      for (const id of ["overview", "ads", "settings"]) {
        assert.ok(await page.locator(`#${id}`).isVisible(), `section #${id} should be visible`);
      }
      for (const id of ["inspect-site", "history"]) {
        assert.strictEqual(await page.locator(`#${id}`).count(), 0, `section #${id} must be gone`);
      }
      for (const id of ["cookies", "permissions", "domain", "suspicious", "breach"]) {
        assert.strictEqual(await page.locator(`#${id}`).isVisible(), false, `section #${id} is site-only`);
      }

      // A fresh profile has nothing to plot, so both charts must say so rather than
      // draw an empty axis with a lone "1" tick. The populated charts (real SVG,
      // built without a chart library) are covered by the seeded e2e dashboard.
      const emptyCharts = await page.locator(".chart .empty").allInnerTexts();
      assert.deepStrictEqual(emptyCharts.map((entry) => entry.trim()), ["No data yet.", "No data yet."]);
      assert.strictEqual(await page.locator(".chart svg").count(), 0, "no chart is drawn before any data exists");

      // Data freshness is one row per file in Settings, with the build in use.
      const dataRows = await page.locator("#data-list .data-row").allInnerTexts();
      assert.ok(
        dataRows.some((row) => row.includes("Ad and tracker rules")),
        `rules row missing: ${dataRows.join(" | ")}`
      );
      // A profile that has not synced yet still has the bundled ruleset, so its row
      // must say so instead of vanishing.
      assert.strictEqual(await page.locator("#refresh-data").count(), 1, "the update button must be present");
      assert.strictEqual(await page.locator("#sync-status").count(), 0, "the old one-line status is gone");

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
      for (const id of ["status", "tab-count", "see-blocked", "cookie-total", "see-cookies", "cookies", "permissions"]) {
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

  it("seeds the site picker from the source tab opened through the toolbar popup", async () => {
    const { server, port } = await fixture();
    const { context, userDataDir } = await openExtensionPage(null, ["--host-resolver-rules=MAP example.com 127.0.0.1"]);
    try {
      await workerOf(context);
      const site = await context.newPage();
      await site.goto(`http://example.com:${port}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await site.bringToFront();

      const popup = await openToolbarPopup(context, `example.com:${port}`);
      await popup.evaluate("document.getElementById('open-dashboard').click()");

      let dashboard = null;
      for (let attempt = 0; attempt < 80 && !dashboard; attempt += 1) {
        dashboard = context.pages().find((page) =>
          page.url().startsWith(DASHBOARD_URL) && page.url().includes("sourceHost=example.com")
        ) ?? null;
        if (!dashboard) await wait(200);
      }
      assert.ok(dashboard, "the popup must open the dashboard with the source host in its URL");
      await waitForLoaded(dashboard);

      assert.strictEqual(new URL(dashboard.url()).searchParams.get("sourceHost"), "example.com");
      assert.strictEqual(await dashboard.locator("#target-select").inputValue(), "example.com");
      assert.ok(await dashboard.locator("#cookies").isVisible(), "the site-only cookies panel must be visible");
      assert.match(await dashboard.locator("#target-summary").innerText(), /example\.com/);
      assert.doesNotMatch(
        await dashboard.locator("#cookies-status").innerText(),
        /Select a site above/,
        "the cookies panel must be populated, not left in All sites text"
      );
    } finally {
      await context.close();
      await rm(userDataDir, { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("falls back to All sites when the source hostname is absent, invalid, or not offered", async () => {
    const { context, userDataDir } = await openExtensionPage(null);
    try {
      await workerOf(context);
      // Three different code paths, all required to land on All sites:
      // no query at all; a value normalizeHostname rejects outright; and a valid
      // hostname that fillTargetSelect() cannot find among its options.
      for (const query of ["", "?sourceHost=chrome", "?sourceHost=not-offered.test"]) {
        const page = await context.newPage();
        await page.goto(`${DASHBOARD_URL}${query}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await waitForLoaded(page);
        assert.strictEqual(await page.locator("#target-select").inputValue(), "", `query ${query || "(none)"} must select All sites`);
        assert.strictEqual(await page.locator("#cookies").isVisible(), false, "site-only panels stay hidden in All sites");
        assert.match(await page.locator("#target-summary").innerText(), /Showing all sites/);
        await page.close();
      }
    } finally {
      await context.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  it("keeps a manual picker choice across a live storage refresh", async () => {
    const { context, userDataDir } = await openExtensionPage(null);
    try {
      const worker = await workerOf(context);
      const now = Date.now();
      const events = [
        { hostname: "example.com", timestamp: now },
        { hostname: "other.test", timestamp: now }
      ];
      await worker.evaluate(async (value) => chrome.storage.local.set({ historyEvents: value }), events);

      const page = await context.newPage();
      await page.goto(`${DASHBOARD_URL}?sourceHost=example.com`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await waitForLoaded(page);
      assert.strictEqual(await page.locator("#target-select").inputValue(), "example.com");

      await page.selectOption("#target-select", "other.test");
      await page.waitForFunction(
        () => document.getElementById("target-summary")?.textContent?.includes("other.test"),
        null,
        { timeout: 20_000 }
      );

      // A real storage change fires chrome.storage.onChanged -> refresh(). Adding a
      // third site also proves the picker was rebuilt; B must survive that rebuild.
      await worker.evaluate(async (value) => chrome.storage.local.set({ historyEvents: value }), [
        ...events,
        { hostname: "third.test", timestamp: Date.now() }
      ]);
      await page.waitForFunction(
        () => [...document.querySelectorAll("#target-select option")].some((option) => option.value === "third.test"),
        null,
        { timeout: 20_000 }
      );

      assert.strictEqual(await page.locator("#target-select").inputValue(), "other.test", "the manual choice must survive the live refresh");
      assert.match(await page.locator("#target-summary").innerText(), /other\.test/);
    } finally {
      await context.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  it("renders Settings and the global allowlist the same with or without a seeded site", async () => {
    const { context, userDataDir } = await openExtensionPage(null);
    try {
      const worker = await workerOf(context);
      await worker.evaluate(async () => chrome.storage.local.set({
        settings: { blockingEnabled: true, siteAllowlist: ["allowed.test"] },
        historyEvents: [{ hostname: "example.com", timestamp: Date.now() }]
      }));

      const seeded = await context.newPage();
      await seeded.goto(`${DASHBOARD_URL}?sourceHost=example.com`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const all = await context.newPage();
      await all.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await waitForLoaded(seeded);
      await waitForLoaded(all);

      assert.strictEqual(await seeded.locator("#target-select").inputValue(), "example.com", "the seeded page must really be in site mode");
      assert.ok(await seeded.locator("#settings").isVisible(), "Settings stays visible in site mode");
      assert.ok(await all.locator("#settings").isVisible(), "Settings stays visible in All sites mode");
      assert.strictEqual(
        await seeded.locator("#allowlist-list").innerText(),
        await all.locator("#allowlist-list").innerText(),
        "the global allowlist must not become site-scoped"
      );
      assert.match(await seeded.locator("#allowlist-list").innerText(), /allowed\.test/);
    } finally {
      await context.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});

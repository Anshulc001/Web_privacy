import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "playwright";

const { chromium } = playwright;
const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const EXTENSION_ID = "mkemflphgmnjjdebbcgioplolpgeclii";
const POPUP_URL = `chrome-extension://${EXTENSION_ID}/popup/popup.html`;
const DASHBOARD_URL = `chrome-extension://${EXTENSION_ID}/dashboard/dashboard.html`;
// A two-label host, because lib/host-match.mjs rejects single-label names such as
// "localhost" and the observation store keys on the hostname.
const HOST = "example.com";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A page that asks for exactly the permissions in its query string:
 * ?request=notifications calls Notification.requestPermission(),
 * ?query=camera calls navigator.permissions.query({ name }).
 * With neither, the page asks for nothing, which is the "revisit without asking"
 * case: whatever the panels show then must come from the stored record.
 */
function fixture() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${HOST}/`);
    const asked = (url.searchParams.get("request") ?? "").split(",").filter(Boolean);
    const queried = (url.searchParams.get("query") ?? "").split(",").filter(Boolean);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>permission fixture</title></head><body>
      <h1>permission fixture</h1>
      <script>
        window.__asked = [];
        void (async () => {
          for (const name of ${JSON.stringify(asked)}) {
            try {
              if (name === "notifications" && typeof Notification !== "undefined") {
                // Not awaited: an unanswered prompt leaves the promise pending, and
                // the queries below must still run.
                void Notification.requestPermission().then((answer) => window.__asked.push("notifications:" + answer));
              }
            } catch (error) {
              window.__asked.push(name + ":threw:" + error.message);
            }
          }
          for (const name of ${JSON.stringify(queried)}) {
            try { await navigator.permissions.query({ name }); } catch {}
          }
        })();
      </script></body></html>`);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function launch(userDataDir, origin) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
      // Notification needs a secure context; this treats the local fixture as one
      // instead of shipping a certificate for a test.
      `--unsafely-treat-insecure-origin-as-secure=${origin}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-default-apps",
      "--disable-translate"
    ],
    ignoreDefaultArgs: ["--disable-extensions", "--disable-component-extensions-with-background-pages"]
  });
  if (context.serviceWorkers().length === 0) {
    await context.waitForEvent("serviceworker", { timeout: 30_000 });
  }
  return context;
}

async function workerOf(context) {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
}

/** Brings the fixture tab for this host to the front, so the popup describes it. */
async function activateSiteTab(context) {
  const worker = await workerOf(context);
  return worker.evaluate(async (host) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((entry) => (entry.url ?? "").includes(host));
    if (!tab) return null;
    await chrome.tabs.update(tab.id, { active: true });
    // A just-restarted browser can have no "active window" yet, and
    // chrome.action.openPopup() refuses until one is focused.
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
    return tab.id;
  }, HOST);
}

/**
 * Reads the real toolbar popup. Chrome's popup bubble is not a Playwright page, so
 * this attaches to the target it opens, exactly as tests/e2e.test.mjs does.
 */
async function popupText(context) {
  await activateSiteTab(context);
  const worker = await workerOf(context);
  const browserSession = await context.browser().newBrowserCDPSession();
  const before = new Set((await browserSession.send("Target.getTargets")).targetInfos.map((info) => info.targetId));
  let opened = false;
  for (let attempt = 0; attempt < 15 && !opened; attempt += 1) {
    try {
      await worker.evaluate(() => chrome.action.openPopup());
      opened = true;
    } catch {
      // A cold worker or an unfocused window refuses at first; retry.
      await wait(400);
      await activateSiteTab(context);
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

  let text = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    text = await evaluate("document.getElementById('permissions')?.innerText ?? ''");
    if (text.trim().length > 0) break;
    await wait(200);
  }
  await browserSession.send("Target.closeTarget", { targetId: popupTarget.targetId }).catch(() => {});
  return text;
}

/** Selects the site in the dashboard and returns the Permissions panel rows. */
async function dashboardRows(context) {
  const page = await context.newPage();
  try {
    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => document.getElementById("status")?.textContent === "Loaded.", null, { timeout: 20_000 });
    await wait(1_000);
    const offered = await page.evaluate((host) =>
      [...document.getElementById("target-select").options].some((option) => option.value === host), HOST);
    assert.ok(offered, `the dashboard must offer ${HOST} after the revisit`);
    await page.evaluate((host) => {
      const select = document.getElementById("target-select");
      select.value = host;
      select.dispatchEvent(new Event("change"));
    }, HOST);
    let rows = [];
    for (let attempt = 0; attempt < 25; attempt += 1) {
      rows = await page.evaluate(() =>
        [...(document.getElementById("permissions-list")?.children ?? [])].map((node) => node.innerText.trim()));
      if (rows.length > 0) break;
      await wait(200);
    }
    return rows;
  } finally {
    await page.close();
  }
}

async function readStorage(context) {
  const worker = await workerOf(context);
  return worker.evaluate(async () => (await chrome.storage.local.get("siteObservations")).siteObservations ?? {});
}

/**
 * Polls storage until every named permission is recorded. A fixed wait is not
 * enough when the suite runs this file beside the other browser suites.
 */
async function waitForStoredNames(context, names, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let latest = [];
  while (Date.now() < deadline) {
    latest = (await readStorage(context))[HOST]?.requestedPermissions ?? [];
    if (names.every((name) => latest.includes(name))) return latest;
    await wait(250);
  }
  return latest;
}

test("a permission recorded before a full restart is still named afterwards", { timeout: 240_000 }, async () => {
  const { server, port } = await fixture();
  const origin = `http://${HOST}:${port}`;
  const userDataDir = await mkdtemp(join(tmpdir(), "webguard-restart-perms-"));
  let context = null;
  try {
    context = await launch(userDataDir, origin);
    // Chrome's own grant, so the site really holds the permission before the close.
    await context.grantPermissions(["notifications"], { origin });
    const site = await context.newPage();
    await site.goto(`${origin}/page?request=notifications`, { waitUntil: "load", timeout: 30_000 });
    // A second navigation: a fresh profile's very first commit can beat worker
    // registration, so the visit record (and the site in the picker) needs it.
    await site.reload({ waitUntil: "load", timeout: 30_000 });
    const recordedNames = await waitForStoredNames(context, ["notifications"]);
    assert.ok(
      recordedNames.includes("notifications"),
      `the first visit must record the notification request, got ${JSON.stringify(recordedNames)}`
    );

    const popupBefore = await popupText(context);
    assert.match(popupBefore, /Notifications/i, "before the restart the popup must name the permission");
    assert.match(popupBefore, /can use it right now/i, "before the restart the popup reports the live grant");
    const rowsBefore = await dashboardRows(context);
    assert.ok(rowsBefore.some((row) => /^Notifications:/i.test(row)), "before the restart the dashboard must show the row");
    await context.close();
    context = null;

    // A full quit: new browser process on the same profile, no tab carried over.
    context = await launch(userDataDir, origin);
    const revisit = await context.newPage();
    await revisit.goto(`${origin}/page`, { waitUntil: "load", timeout: 30_000 });
    await revisit.reload({ waitUntil: "load", timeout: 30_000 });
    assert.deepStrictEqual(
      await revisit.evaluate(() => window.__asked),
      [],
      "the revisit must not re-request the permission, or the record is not what is being tested"
    );
    const afterRestart = await waitForStoredNames(context, ["notifications"]);
    assert.ok(
      afterRestart.includes("notifications"),
      `the stored record must survive the full restart, got ${JSON.stringify(afterRestart)}`
    );

    // The regression: the popup used to say only "No permission granted." here,
    // naming nothing, which is what made the record look lost.
    const popupAfter = await popupText(context);
    assert.match(popupAfter, /Notifications/i, `after the restart the popup must still name the permission, got "${popupAfter}"`);
    const rowsAfter = await dashboardRows(context);
    assert.ok(
      rowsAfter.some((row) => /^Notifications:/i.test(row)),
      `after the restart the dashboard must still show the row, got ${JSON.stringify(rowsAfter)}`
    );
  } finally {
    if (context) await context.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("two recorded permissions are both named when only one is re-observed after a restart", { timeout: 240_000 }, async () => {
  const { server, port } = await fixture();
  const origin = `http://${HOST}:${port}`;
  const userDataDir = await mkdtemp(join(tmpdir(), "webguard-restart-two-"));
  let context = null;
  try {
    context = await launch(userDataDir, origin);
    await context.grantPermissions(["notifications"], { origin });
    const site = await context.newPage();
    await site.goto(`${origin}/page?request=notifications&query=camera`, { waitUntil: "load", timeout: 30_000 });
    await site.reload({ waitUntil: "load", timeout: 30_000 });
    const recorded = await waitForStoredNames(context, ["notifications", "camera"]);
    assert.ok(recorded.includes("notifications") && recorded.includes("camera"), `both names must be recorded, got ${JSON.stringify(recorded)}`);
    await context.close();
    context = null;

    context = await launch(userDataDir, origin);
    const revisit = await context.newPage();
    // This page re-observes camera only. Notifications is never mentioned again in
    // this session, so it can only appear from the stored record.
    await revisit.goto(`${origin}/page?query=camera`, { waitUntil: "load", timeout: 30_000 });
    await revisit.reload({ waitUntil: "load", timeout: 30_000 });
    // Wait for the re-observed name, then require the other one to still be there.
    const stored = await waitForStoredNames(context, ["camera", "notifications"]);
    assert.ok(
      stored.includes("notifications") && stored.includes("camera"),
      `the record must keep both names, got ${JSON.stringify(stored)}`
    );

    const popup = await popupText(context);
    assert.match(popup, /Notifications/i, `the popup must name the permission that was not re-observed, got "${popup}"`);
    assert.match(popup, /Camera/i, `the popup must still name the re-observed permission, got "${popup}"`);
    const rows = await dashboardRows(context);
    assert.ok(rows.some((row) => /^Notifications:/i.test(row)), `the dashboard must name notifications, got ${JSON.stringify(rows)}`);
    assert.ok(rows.some((row) => /^Camera:/i.test(row)), `the dashboard must name camera, got ${JSON.stringify(rows)}`);
  } finally {
    if (context) await context.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
});

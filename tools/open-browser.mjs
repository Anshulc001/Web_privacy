// Opens a headed Chromium with the unpacked WebGuard extension loaded so the
// extension can be checked by hand. Close the browser window to quit.
//
//   node tools/open-browser.mjs [url-to-open]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profileDir = path.join(root, "test-results", "manual-profile");
fs.mkdirSync(profileDir, { recursive: true });

const target = process.argv[2] ?? "https://www.cnn.com/";

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    "--no-first-run",
    "--no-default-browser-check"
  ],
  ignoreDefaultArgs: ["--disable-extensions"]
});

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15_000 });
const extensionId = new URL(worker.url()).host;

const dashboardUrl = `chrome-extension://${extensionId}/dashboard/dashboard.html`;
console.log(`Extension ID: ${extensionId}`);
console.log(`Dashboard:    ${dashboardUrl}`);
console.log(`Popup:        chrome-extension://${extensionId}/popup/popup.html`);

const sitePage = context.pages()[0] ?? (await context.newPage());
await sitePage.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});

const dashboard = await context.newPage();
await dashboard.goto(dashboardUrl).catch(() => {});
await sitePage.bringToFront();

// Try to show the real toolbar popup over the site tab; harmless if refused.
try {
  await worker.evaluate(() => chrome.action.openPopup());
  console.log("Popup opened via chrome.action.openPopup().");
} catch {
  console.log("Pin the WebGuard icon in the toolbar and click it to see the popup.");
}

console.log("Browser ready — close the window to quit.");
context.on("close", () => process.exit(0));

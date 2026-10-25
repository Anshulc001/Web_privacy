import playwright from "playwright";
const { chromium } = playwright;
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(__dirname, "..").replace(/\\/g, "/");
const EXTENSION_ID = "mkemflphgmnjjdebbcgioplolpgeclii";
const DASHBOARD_URL = `chrome-extension://${EXTENSION_ID}/dashboard/dashboard.html`;
const POPUP_URL = `chrome-extension://${EXTENSION_ID}/popup/popup.html`;

const TRACKERS = [
  "https://www.googletagmanager.com/gtag/js",
  "https://www.google-analytics.com/analytics.js",
  "https://sb.scorecardresearch.com/beacon.js"
];

let server;
let baseUrl;
let context;
let userDataDir;
let sitePage;

/**
 * Selects a site in the dashboard picker and waits for its section to render.
 *
 * The picker offers open tabs plus recent history, so the local test host is
 * always there while an external site depends on the network. Choosing the
 * first preference that exists keeps these tests honest on a flaky connection
 * instead of failing on an assumption about example.com.
 */
async function pickTarget(page, preferred = ["example.com", "127.0.0.1"]) {
  const chosen = await page.evaluate((names) => {
    const select = document.getElementById("target-select");
    const values = [...select.options].map((option) => option.value).filter(Boolean);
    const match = names.find((name) => values.includes(name)) ?? values[0] ?? "";
    if (select.value !== match) {
      select.value = match;
      select.dispatchEvent(new Event("change"));
    }
    return match;
  }, preferred);
  assert.ok(chosen, "the site picker must offer at least one site");
  await page.waitForFunction(
    (target) => document.getElementById("target-summary")?.textContent?.startsWith(target),
    chosen,
    { timeout: 15_000 }
  );
  return chosen;
}

function assertNoOverflow(width, height) {
  return async (page, label) => {
    await page.setViewportSize({ width, height });
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    }));
    assert.ok(
      scrollWidth <= clientWidth + 1,
      `${label}: page overflows horizontally (${scrollWidth} > ${clientWidth}) at ${width}px`
    );
  };
}

describe("WebGuard end to end", () => {
  before(async () => {
    server = createServer((request, response) => {
      if (request.url === "/control.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end("window.__controlLoaded = true;");
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><html><head><title>Test Site</title></head><body>
        <h1>Test site</h1>
        <script src="/control.js"></script>
        ${TRACKERS.map((url) => `<script src="${url}"></script>`).join("\n")}
      </body></html>`);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;

    userDataDir = await mkdtemp(join(tmpdir(), "webguard-e2e-"));
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      viewport: { width: 1280, height: 900 },
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

    if (context.serviceWorkers().length === 0) {
      await context.waitForEvent("serviceworker", { timeout: 25_000 });
    }

    // One real cookie lets the popup test the collapsed count and its detail list.
    await context.addCookies([{ name: "webguard_test_cookie", value: "test-value", domain: "127.0.0.1", path: "/" }]);

    // Seed real activity: a page full of trackers, plus a second site for history.
    sitePage = await context.newPage();
    await sitePage.goto(baseUrl, { waitUntil: "load", timeout: 30_000 });
    await sitePage.waitForTimeout(3_000);
    await sitePage.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    await sitePage.waitForTimeout(1_500);
    await sitePage.goto(baseUrl, { waitUntil: "load", timeout: 30_000 });
    await sitePage.waitForTimeout(3_000);
  });

  after(async () => {
    if (context) await context.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
  });

  it("installs as the expected extension and starts its service worker", async () => {
    const workers = context.serviceWorkers();
    assert.strictEqual(workers.length, 1, "exactly one extension service worker");
    assert.ok(
      workers[0].url().startsWith(`chrome-extension://${EXTENSION_ID}/`),
      `service worker must belong to ${EXTENSION_ID}, got ${workers[0].url()}`
    );
  });

  it("blocks real tracker requests and still runs first-party script", async () => {
    const failures = [];
    sitePage.on("requestfailed", (request) => failures.push({ url: request.url(), error: request.failure()?.errorText ?? "" }));
    await sitePage.reload({ waitUntil: "load", timeout: 30_000 });
    await sitePage.waitForTimeout(3_000);

    assert.strictEqual(await sitePage.evaluate(() => window.__controlLoaded === true), true, "first-party script must run");

    for (const url of TRACKERS) {
      const failure = failures.find((entry) => entry.url === url);
      assert.ok(failure, `expected ${url} to be blocked`);
      assert.ok(failure.error.includes("ERR_BLOCKED_BY_CLIENT"), `${url} should be ERR_BLOCKED_BY_CLIENT, got ${failure.error}`);
    }
  });

  it("shows the blocked counter through the background API", async () => {
    const page = await context.newPage();
    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });
    const summary = await page.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const webTab = tabs.find((tab) => tab.url && tab.url.startsWith("http://127.0.0.1"));
      return chrome.runtime.sendMessage({ type: "webguard.blockingSummary", tabId: webTab?.id });
    });
    await page.close();
    assert.ok(summary.today > 0, `expected a non-zero daily blocked count, got ${summary.today}`);
    assert.ok(Array.isArray(summary.topHosts) && summary.topHosts.length > 0, "expected top blocked hosts");
  });

  it("renders the dashboard with live data in every section", async () => {
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(String(error.message)));

    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => document.getElementById("status")?.textContent === "Loaded.", null, { timeout: 25_000 });

    // Overview reflects the seeded browsing. The tiles are stacked boxes, so the
    // text may be split across lines; compare on normalized whitespace.
    const overview = (await page.locator("#overview-stats").innerText()).replace(/\s+/g, " ");
    assert.ok(/Sites recorded \d+/.test(overview), `overview should show a sites-recorded count, got "${overview}"`);
    assert.ok(/Blocked today \d+/.test(overview), `overview should show a blocked count, got "${overview}"`);

    // Charts are real SVG with bars.
    const charts = await page.locator(".chart svg").count();
    assert.ok(charts >= 3, `expected 3 chart SVGs, found ${charts}`);
    const bars = await page.locator("#chart-blocked svg rect.bar").count();
    assert.ok(bars >= 7, `blocked chart should have 7 daily bars, found ${bars}`);

    // Data freshness lists all three files.
    const dataText = await page.locator("#data-status").innerText();
    assert.ok(dataText.includes("Ad and tracker rules"), "rules status missing");
    assert.ok(dataText.includes("Breach data"), "breach status missing");
    assert.ok(dataText.includes("Phishing blocklist"), "threat status missing");

    // The picker starts on "All sites": site-only panels explain that a site is
    // needed instead of showing one site's data as if it were everyone's.
    assert.strictEqual(await page.locator("#target-select").inputValue(), "", "the picker must default to all sites");
    assert.match(await page.locator("#target-select option").first().innerText(), /All sites/);
    assert.match(await page.locator("#cookies-status").innerText(), /Select a site/);
    assert.strictEqual(await page.locator("#expected-toggle").isDisabled(), true, "site actions are disabled for all sites");
    assert.match(await page.locator("#block-unit").innerText(), /this browser/);

    // Pick a deterministic site and check every site-scoped section.
    const target = await pickTarget(page, ["127.0.0.1", "example.com"]);
    assert.match(await page.locator("#block-unit").innerText(), /on this site/, "the Ads count must follow the picker");
    assert.strictEqual(await page.locator("#expected-toggle").isDisabled(), false, "site actions work for a picked site");

    // Top blocked hosts use horizontal bars, so long hostnames cannot collide.
    assert.strictEqual(await page.locator("#chart-trackers svg").count(), 1, "a ranked host chart is rendered");
    assert.ok((await page.locator("#chart-trackers svg rect.bar").count()) >= 1, "ranked bars are drawn");
    assert.strictEqual(
      await page.locator("#chart-trackers svg text.label").count(),
      await page.locator("#chart-trackers svg rect.bar").count(),
      "every ranked bar must have its own label"
    );

    // Ads: one list of hosts, no separate collapse arrow, no repeated summary rows.
    await page.click("#expand-blocked");
    await page.waitForFunction(
      () => document.getElementById("expand-blocked")?.getAttribute("aria-expanded") === "true",
      null,
      { timeout: 10_000 }
    );
    assert.strictEqual(await page.locator("#blocked-panel").isVisible(), true, "Show blocked items must open the host list");
    assert.strictEqual(await page.locator("#collapse-blocked").count(), 0, "the extra collapse arrow must be gone");
    assert.strictEqual(await page.locator("#top-hosts").count(), 0, "the duplicate top-hosts list must be gone");
    const blockedText = await page.locator("#blocked-list").innerText();
    assert.ok(blockedText.length > 0, "the blocked list must have content");
    assert.ok(!/Blocked today|Blocked in this tab|Blocking is/.test(blockedText), `the blocked list repeats summary rows: ${blockedText}`);
    await page.click("#expand-blocked");
    assert.strictEqual(await page.locator("#blocked-panel").isVisible(), false, "the same button hides the list");

    const permissions = await page.locator("#permissions-list li").count();
    assert.strictEqual(permissions, 4, "four permission rows expected");
    assert.ok((await page.locator("#permissions-alerts").innerText()).includes("not a safety verdict"));

    const risk = await page.locator("#risk-summary").innerText();
    assert.ok(/Risk score \d+\/100 \((\w+)\)/.test(risk), `unexpected risk summary: ${risk}`);
    assert.ok((await page.locator("#risk-reasons li").count()) >= 1, "risk reasons must be listed");
    assert.ok((await page.locator("#risk-disclaimer").innerText()).includes("not a full security scan"));

    const breach = await page.locator("#breach-summary").innerText();
    assert.ok(/not found in the breach list|appeared in/i.test(breach), `unexpected breach summary: ${breach}`);
    const attribution = await page.locator("#breach-attribution").innerText();
    assert.ok(attribution.includes("Have I Been Pwned"), "breach attribution required");
    assert.ok((await page.locator("#self-check-links a").count()) >= 3, "self-check links required");

    assert.ok((await page.locator("#tls-note").innerText()).includes("TLS certificate details are not available"));

    // Cookie rows must never carry a value, only metadata.
    const cookieRows = await page.locator("#cookies-list li").allInnerTexts();
    for (const row of cookieRows) {
      assert.ok(!/=/.test(row), `cookie row must not contain a name=value pair: ${row}`);
    }
    assert.ok(
      (await page.locator("#cookies .hint").innerText()).includes("never read"),
      "the cookie section must state that values are never read"
    );
    assert.ok((await page.locator("#cookies-status").innerText()).length > 0, "cookie status must be explicit");

    assert.deepStrictEqual(consoleErrors, [], "dashboard must not log console errors");
    assert.ok(target, "a site was selected");
    await page.close();
  });

  it("looks up RDAP on demand and reports a real registry", async () => {
    // A registry answer needs a real domain, so open one first; the picker then
    // offers it from the open tabs even when it never made it into history.
    const siteTab = await context.newPage();
    const reachedExample = await siteTab
      .goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);

    const page = await context.newPage();
    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => document.getElementById("status")?.textContent === "Loaded.", null, { timeout: 25_000 });
    const target = await pickTarget(page, reachedExample ? ["example.com", "127.0.0.1"] : ["127.0.0.1"]);
    await page.waitForTimeout(800);

    await page.click("#rdap-lookup");
    // The summary updates before the detail rows are re-rendered, so wait for the
    // rows themselves rather than reading immediately after the first change.
    await page.waitForFunction(
      () => {
        const summary = document.getElementById("domain-summary")?.textContent ?? "";
        const settled = !summary.startsWith("Looking this domain up");
        const rendered = document.querySelectorAll("#domain-details dt").length > 0;
        return settled && (rendered || /unavailable|could not|no record|no registry/i.test(summary));
      },
      null,
      { timeout: 30_000 }
    );

    const summary = await page.locator("#domain-summary").innerText();
    const rows = await page.locator("#domain-details dt").count();
    // RDAP is an external service: either it answered with registry data, or it
    // must say so explicitly. It must never silently look clean.
    // The summary reads "Registry data ..." right after the lookup and becomes
    // "Cached registry data ..." once the section re-renders from the cache.
    if (/registry data/i.test(summary)) {
      assert.ok(rows >= 1, `a successful lookup must render registry rows, got ${rows} for "${summary}"`);
      const details = await page.locator("#domain-details").innerText();
      assert.ok(details.includes("Registrar"), "registrar row required");
    } else {
      assert.ok(/unavailable|could not|no record|no registry/i.test(summary), `unexpected RDAP message: ${summary}`);
    }
    assert.ok(target, "a site was selected");
    await page.close();
    await siteTab.close();
  });

  it("persists settings, history and the allowlist across a reload", async () => {
    const page = await context.newPage();
    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => document.getElementById("status")?.textContent === "Loaded.", null, { timeout: 25_000 });

    // Retention change.
    await page.selectOption("#retention-select", "72");
    await page.waitForFunction(
      () => document.getElementById("settings-retention-note")?.textContent?.includes("3 days"),
      null,
      { timeout: 15_000 }
    );

    // Pause history, then confirm it stays paused.
    await page.check("#history-paused");
    await page.waitForTimeout(800);

    // Allowlist the current target.
    const target = await pickTarget(page);
    const beforeAllow = await page.locator("#allowlist-toggle").innerText();
    await page.click("#allowlist-toggle");
    await page.waitForFunction(
      (previous) => document.getElementById("allowlist-toggle")?.textContent !== previous,
      beforeAllow,
      { timeout: 15_000 }
    );
    const afterAllow = await page.locator("#allowlist-toggle").innerText();
    assert.notStrictEqual(afterAllow, beforeAllow, "allowlist toggle must change state");
    assert.ok((await page.locator("#allowlist-list").innerText()).includes(target), "allowlist must list the site");

    // Mark as expected.
    await page.click("#expected-toggle");
    await page.waitForFunction(
      () => document.getElementById("expected-toggle")?.textContent?.includes("not expected"),
      null,
      { timeout: 15_000 }
    );

    // Reload: every setting must survive.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.getElementById("status")?.textContent === "Loaded.", null, { timeout: 25_000 });

    assert.strictEqual(await page.locator("#retention-select").inputValue(), "72", "retention must persist");
    assert.strictEqual(await page.isChecked("#history-paused"), true, "pause must persist");
    assert.ok((await page.locator("#allowlist-list").innerText()).includes(target), "allowlist must persist");

    await pickTarget(page, [target]);
    assert.ok(
      (await page.locator("#expected-toggle").innerText()).includes("not expected"),
      "expected-site marking must persist"
    );

    // Undo so later tests are not affected.
    await page.click("#expected-toggle");
    await page.click("#allowlist-toggle");
    await page.uncheck("#history-paused");
    await page.selectOption("#retention-select", "48");
    await page.waitForTimeout(800);
    await page.close();
  });

  it("limits the history date picker to the retention window and lists visits", async () => {
    const page = await context.newPage();
    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => document.getElementById("status")?.textContent === "Loaded.", null, { timeout: 25_000 });

    const retentionHours = Number(await page.locator("#retention-select").inputValue());
    const expectedDays = Math.ceil(retentionHours / 24);
    const options = await page.locator("#history-date option").count();
    assert.strictEqual(options, expectedDays, `retention ${retentionHours}h should offer ${expectedDays} days, got ${options}`);

    const list = await page.locator("#history-list").innerText();
    assert.ok(/127\.0\.0\.1|example\.com/.test(list), `history should list visited hosts, got: ${list}`);
    assert.ok(!/https?:\/\//.test(list), "history must never show full URLs");
    assert.ok((await page.locator("#history-retention").innerText()).includes("hostnames"), "retention rule must be shown");

    // Clear history and confirm the empty state is explicit.
    await page.click("#clear-history");
    await page.waitForTimeout(1_200);
    assert.ok((await page.locator("#settings-feedback").innerText()).includes("cleared"), "clear must report back");
    const cleared = await page.locator("#history-list").innerText();
    assert.ok(/No sites recorded|unavailable/i.test(cleared), `history should be empty, got: ${cleared}`);
    await page.close();
  });

  it("renders the popup with the quick summary and a working dashboard button", async () => {
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error.message)));

    await page.goto(POPUP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector("main", { timeout: 10_000 });

    assert.strictEqual(await page.locator("h1").innerText(), "WebGuard");
    for (const id of ["status", "tab-count", "see-blocked", "allowlist-toggle", "cookies", "permissions", "open-dashboard"]) {
      assert.strictEqual(await page.locator(`#${id}`).count(), 1, `popup #${id} must exist`);
    }
    for (const id of ["blocking-status", "blocking-data", "blocking-top-hosts", "expected-site"]) {
      assert.strictEqual(await page.locator(`#${id}`).count(), 0, `popup #${id} must be gone`);
    }
    assert.ok(await page.locator("#open-dashboard").isVisible());

    // The popup queries the background for the site; assert the contract directly
    // because the popup tab is itself the active tab.
    const report = await page.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const webTab = tabs.find((tab) => tab.url === "https://example.com/");
      if (!webTab) return null;
      return chrome.runtime.sendMessage({ type: "webguard.currentSitePrivacy", tabId: webTab.id });
    });
    if (report) {
      assert.strictEqual(report.hostname, "example.com");
      assert.ok(Array.isArray(report.cookies), "popup contract must include cookies");
      assert.ok(report.permissions && typeof report.permissions === "object", "popup contract must include permissions");
      assert.ok(report.blocking && typeof report.blocking.today === "number", "popup contract must include blocking counts");
      const serialized = JSON.stringify(report.cookies);
      assert.ok(!/"value"/.test(serialized), "cookie values must never cross the message boundary");
    }

    await page.click("#open-dashboard");
    await page.waitForTimeout(1_500);
    const urls = context.pages().map((open) => open.url());
    assert.ok(urls.some((url) => url.startsWith(DASHBOARD_URL)), "Open Dashboard must create the dashboard tab");

    assert.deepStrictEqual(pageErrors, [], "popup must not throw");
  });

  it("keeps the UI usable: labelled controls, no overflow, described charts", async () => {
    const page = await context.newPage();
    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => document.getElementById("status")?.textContent === "Loaded.", null, { timeout: 25_000 });

    const checkOverflow = assertNoOverflow(1280, 900);
    await checkOverflow(page, "dashboard");
    await page.setViewportSize({ width: 820, height: 900 });
    const narrow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    }));
    assert.ok(narrow.scrollWidth <= narrow.clientWidth + 1, `dashboard overflows at 820px (${narrow.scrollWidth} > ${narrow.clientWidth})`);

    // Every interactive control must have an accessible name.
    const unnamed = await page.evaluate(() => {
      const controls = [...document.querySelectorAll("button, select, input")];
      return controls
        .filter((node) => {
          if (node.getAttribute("aria-label")) return false;
          if (node.id && document.querySelector(`label[for="${node.id}"]`)) return false;
          if (node.closest("label")) return false;
          return (node.textContent ?? "").trim().length === 0;
        })
        .map((node) => node.id || node.tagName);
    });
    assert.deepStrictEqual(unnamed, [], "every control needs an accessible name");

    // Nav links must point at real sections.
    const brokenAnchors = await page.evaluate(() =>
      [...document.querySelectorAll("nav a")].map((link) => link.getAttribute("href")).filter((href) => href && !document.querySelector(href))
    );
    assert.deepStrictEqual(brokenAnchors, [], "nav links must resolve to sections");

    // Charts must be described rather than decorative noise.
    const chartLabels = await page.locator(".chart svg[role='img']").count();
    assert.ok(chartLabels >= 1, "charts need an accessible role and label");

    await page.close();
  });

  it("puts the blocked count on the toolbar badge", async () => {
    const worker = context.serviceWorkers()[0];
    const badge = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const site = tabs.find((tab) => (tab.url ?? "").startsWith("http://127.0.0.1"));
      if (!site) return { error: "the test tab is gone" };
      return { tabId: site.id, text: await chrome.action.getBadgeText({ tabId: site.id }) };
    });
    assert.ok(!badge.error, badge.error);
    assert.match(badge.text, /^\d+$/, `badge must show a count, got "${badge.text}"`);
    assert.ok(Number(badge.text) > 0, "badge must be non-zero after blocked requests");
  });

  it("records what the content script observes on a real page", async () => {
    const page = await context.newPage();
    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => document.getElementById("status")?.textContent === "Loaded.", null, { timeout: 25_000 });

    const observations = await page.evaluate(async () =>
      (await chrome.storage.local.get("siteObservations")).siteObservations ?? {});
    await page.close();

    const entry = observations["example.com"] ?? observations["127.0.0.1"];
    assert.ok(entry, `the content script must have stored an observation, got ${Object.keys(observations)}`);
    assert.ok(Array.isArray(entry.thirdPartyHosts), "third-party hosts must be recorded");
    for (const name of ["camera", "microphone", "geolocation", "notifications"]) {
      assert.ok(name in entry.permissionStates, `permission ${name} must be recorded`);
    }
    assert.ok(!entry.thirdPartyHosts.includes("example.com"), "a site is not its own third party");
  });

  it("really stops blocking when turned off, and resumes when turned back on", async () => {
    const page = await context.newPage();
    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => document.getElementById("status")?.textContent === "Loaded.", null, { timeout: 25_000 });
    assert.strictEqual(await page.isChecked("#blocking-toggle"), true, "blocking starts on");

    await page.uncheck("#blocking-toggle");
    await page.waitForFunction(
      () => document.getElementById("ads-status")?.textContent?.includes("Blocking is off"),
      null,
      { timeout: 15_000 }
    );

    const collect = async () => {
      const failures = [];
      const handler = (request) => failures.push(request.failure()?.errorText ?? "");
      sitePage.on("requestfailed", handler);
      await sitePage.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      await sitePage.waitForTimeout(3_000);
      sitePage.off("requestfailed", handler);
      return failures.filter((error) => error.includes("ERR_BLOCKED_BY_CLIENT")).length;
    };

    const whileOff = await collect();
    assert.strictEqual(whileOff, 0, `with blocking off nothing may be blocked, saw ${whileOff}`);

    await page.check("#blocking-toggle");
    await page.waitForFunction(
      () => document.getElementById("ads-status")?.textContent?.includes("Blocking is on"),
      null,
      { timeout: 15_000 }
    );
    const whileOn = await collect();
    assert.ok(whileOn >= 1, `with blocking on the trackers must be blocked again, saw ${whileOn}`);

    await page.close();
  });

  it("really lets trackers through once a site is allowlisted", async () => {
    const page = await context.newPage();
    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => document.getElementById("status")?.textContent === "Loaded.", null, { timeout: 25_000 });

    await page.selectOption("#target-select", "127.0.0.1");
    await page.waitForFunction(
      () => document.getElementById("target-summary")?.textContent?.startsWith("127.0.0.1"),
      null,
      { timeout: 15_000 }
    );
    await page.click("#allowlist-toggle");
    await page.waitForFunction(
      () => document.getElementById("allowlist-toggle")?.textContent?.includes("Remove"),
      null,
      { timeout: 15_000 }
    );
    assert.ok(
      (await page.locator("#allowlist-status").innerText()).includes("allowlisted"),
      "the UI must say the site is allowlisted"
    );

    const blockedCount = async () => {
      const failures = [];
      const handler = (request) => failures.push(request.failure()?.errorText ?? "");
      sitePage.on("requestfailed", handler);
      await sitePage.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      await sitePage.waitForTimeout(3_000);
      sitePage.off("requestfailed", handler);
      return failures.filter((error) => error.includes("ERR_BLOCKED_BY_CLIENT")).length;
    };

    // The allowlist is enforced with a real allowAllRequests rule, so this is a
    // measure of Chrome's behaviour, not of our own bookkeeping.
    assert.strictEqual(await blockedCount(), 0, "an allowlisted site must not have requests blocked");

    await page.click("#allowlist-toggle");
    await page.waitForFunction(
      () => document.getElementById("allowlist-toggle")?.textContent?.includes("Allowlist"),
      null,
      { timeout: 15_000 }
    );
    assert.ok((await blockedCount()) >= 1, "removing the allowlist must restore blocking");

    await page.close();
  });

  it("meets basic accessibility: contrast, heading order, focus ring, 200% zoom", async () => {
    const page = await context.newPage();
    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => document.getElementById("status")?.textContent === "Loaded.", null, { timeout: 25_000 });

    // WCAG AA contrast for the text that carries the meaning of each section.
    const contrast = await page.evaluate(() => {
      // Colours arrive as rgb(), rgba() or the modern color(srgb 0.96 ...) form,
      // so parse both; reading raw digits out of the latter gives a false result.
      const parse = (value) => {
        const text = String(value);
        const srgb = text.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?/i);
        if (srgb) {
          return { rgb: [1, 2, 3].map((index) => Math.round(Number(srgb[index]) * 255)), alpha: srgb[4] === undefined ? 1 : Number(srgb[4]) };
        }
        const legacy = text.match(/rgba?\(([^)]+)\)/i);
        if (!legacy) return null;
        const parts = legacy[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        return parts.length >= 3 ? { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 } : null;
      };
      const toRgb = (value) => parse(value)?.rgb ?? null;
      const channel = (value) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      const background = (node) => {
        let current = node;
        while (current) {
          const parsed = parse(getComputedStyle(current).backgroundColor);
          if (parsed && parsed.alpha > 0) return parsed.rgb;
          current = current.parentElement;
        }
        return [255, 255, 255];
      };
      const ratio = (node) => {
        const fg = toRgb(getComputedStyle(node).color);
        if (!fg) return null;
        const bg = background(node);
        const [light, dark] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
        return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
      };
      const selectors = ["#overview-stats li", "p.hint", "nav a", "#breach a", "#status"];
      return selectors.map((selector) => {
        const node = document.querySelector(selector);
        return node ? { selector, ratio: ratio(node), text: (node.textContent ?? "").slice(0, 30) } : { selector, ratio: null };
      });
    });

    for (const entry of contrast.filter((row) => row.ratio !== null)) {
      assert.ok(entry.ratio >= 4.5, `${entry.selector} contrast is ${entry.ratio}, needs 4.5 for AA`);
    }

    // One h1, and no heading level skipped on the way down the page.
    const headings = await page.evaluate(() => [...document.querySelectorAll("h1, h2, h3, h4")].map((node) => Number(node.tagName[1])));
    assert.strictEqual(headings.filter((level) => level === 1).length, 1, "exactly one h1");
    for (let index = 1; index < headings.length; index += 1) {
      assert.ok(headings[index] - headings[index - 1] <= 1, `heading level jumps from h${headings[index - 1]} to h${headings[index]}`);
    }

    // A keyboard user must be able to see where they are.
    await page.keyboard.press("Tab");
    const focusRing = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active || active === document.body) return null;
      const style = getComputedStyle(active);
      return { tag: active.tagName, outline: `${style.outlineStyle} ${style.outlineWidth}`, shadow: style.boxShadow };
    });
    assert.ok(focusRing, "Tab must move focus to a control");
    assert.ok(
      (focusRing.outline.includes("auto") || focusRing.outline.includes("solid")) || focusRing.shadow !== "none",
      `the focused ${focusRing.tag} has no visible focus indicator (outline: ${focusRing.outline})`
    );

    // 200% zoom: the layout must reflow, not scroll sideways.
    await page.setViewportSize({ width: 640, height: 900 });
    const zoomed = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    }));
    assert.ok(zoomed.scrollWidth <= zoomed.clientWidth + 1, `dashboard overflows at 200% zoom (${zoomed.scrollWidth} > ${zoomed.clientWidth})`);

    // External links must not leak the opener.
    const unsafeLinks = await page.evaluate(() =>
      [...document.querySelectorAll("a[target='_blank']")].filter((link) => !/noreferrer|noopener/.test(link.rel)).map((link) => link.href));
    assert.deepStrictEqual(unsafeLinks, [], "external links need rel=noreferrer");

    await page.close();
  });

  it("renders the popup with real current-site data", async () => {
    // The popup is only meaningful next to a web page, and a popup cannot be opened
    // from a tab, so point its active-tab query at the real site tab while the real
    // popup script, messaging and background service do the work.
    const page = await context.newPage();
    const worker = context.serviceWorkers()[0];
    const siteTabId = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((tab) => (tab.url ?? "").startsWith("http://127.0.0.1"))?.id ?? null;
    });
    assert.ok(siteTabId !== null, "the test tab must still be open");

    await page.addInitScript((tabId) => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (info) =>
        info && info.active ? [{ id: tabId, url: "http://127.0.0.1/" }] : query(info);
    }, siteTabId);

    await page.setViewportSize({ width: 400, height: 700 });
    await page.goto(POPUP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(
      () => /Current site: 127\.0\.0\.1/.test(document.getElementById("status")?.textContent ?? ""),
      null,
      { timeout: 20_000 }
    );

    assert.match(await page.locator("#blocking-toggle").innerText(), /^WebGuard (on|off)$/, "the header toggle states only the blocking mode");
    assert.match(await page.locator("#tab-count").innerText(), /^\d+$/, "the popup shows only the blocked count");
    assert.strictEqual(await page.locator("#status").innerText(), "Current site: 127.0.0.1");

    // "See blocked ads" opens a host list with per-host counts.
    assert.strictEqual(await page.locator("#blocked-panel").isVisible(), false, "the blocked list starts collapsed");
    assert.strictEqual(await page.locator("#see-blocked").innerText(), "See blocked ads");
    await page.click("#see-blocked");
    await page.waitForFunction(() => document.getElementById("see-blocked")?.textContent === "Hide blocked ads", null, { timeout: 10_000 });
    assert.strictEqual(await page.locator("#blocked-panel").isVisible(), true, "clicking must reveal the blocked list");
    const blockedRows = await page.locator("#blocked-list li.blocked-row").count();
    const blockedText = await page.locator("#blocked-list").innerText();
    assert.ok(blockedRows >= 1, `the seeded trackers must appear in the blocked list, got "${blockedText}"`);
    for (const row of await page.locator("#blocked-list li.blocked-row").all()) {
      assert.match(await row.locator(".blocked-count").innerText(), /^\d+$/, "every blocked row needs a count");
    }
    const openShotDir = join(__dirname, "..", "test-results", "screenshots");
    await mkdir(openShotDir, { recursive: true });
    await page.screenshot({ path: join(openShotDir, "popup-live-blocked.png"), fullPage: true });
    await page.click("#see-blocked");
    assert.strictEqual(await page.locator("#blocked-panel").isVisible(), false, "the list collapses again");
    // Cookies stay collapsed behind their count and open on request.
    assert.strictEqual(await page.locator("#cookies-panel").isVisible(), false, "cookies start collapsed");
    assert.strictEqual(await page.locator("#cookie-total").innerText(), "1", "the count must reflect the stored cookie");
    assert.strictEqual(await page.locator("#cookie-unit").innerText(), "cookie");
    await page.click("#see-cookies");
    assert.strictEqual(await page.locator("#cookies-panel").isVisible(), true, "See cookies must open the details");
    assert.strictEqual(await page.locator("#cookies li").count(), 1, "the stored cookie must be listed once");
    assert.ok((await page.locator("#cookie-summary").innerText()).includes("1 cookie"), "the summary must explain the cookie");
    const cookieShotDir = join(__dirname, "..", "test-results", "screenshots");
    await mkdir(cookieShotDir, { recursive: true });
    await page.screenshot({ path: join(cookieShotDir, "popup-cookies.png"), fullPage: true });
    await page.click("#see-cookies");
    assert.strictEqual(await page.locator("#cookies-panel").isVisible(), false, "Hide cookies must collapse it again");
    // Permissions list only what the site actually holds, never prompts.
    assert.strictEqual(await page.locator("#permissions-heading").locator("..").isVisible(), true, "the permissions section is always visible");
    const permissionText = await page.locator("#permissions").innerText();
    assert.ok(
      /no permission granted|this site can use it right now|unavailable/i.test(permissionText),
      `the permissions section must list granted access or say none, got "${permissionText}"`
    );
    assert.ok(!/prompt|denied/i.test(permissionText), `permission prompts must not be listed, got "${permissionText}"`);

    for (const id of ["blocking-toggle", "allowlist-toggle"]) {
      assert.strictEqual(await page.locator(`#${id}`).isVisible(), true, `popup #${id} must become visible`);
    }

    // The popup controls must really drive the background service.
    assert.strictEqual(await page.locator("#allowlist-toggle").innerText(), "Allowlist this site");
    await page.click("#allowlist-toggle");
    await page.waitForFunction(
      () => document.getElementById("allowlist-toggle")?.textContent?.includes("Remove"),
      null,
      { timeout: 15_000 }
    );
    await page.click("#allowlist-toggle");
    await page.waitForFunction(
      () => document.getElementById("allowlist-toggle")?.textContent === "Allowlist this site",
      null,
      { timeout: 15_000 }
    );

    await page.click("#blocking-toggle");
    await page.waitForFunction(
      () => document.getElementById("blocking-toggle")?.textContent === "WebGuard off",
      null,
      { timeout: 15_000 }
    );
    await page.click("#blocking-toggle");
    await page.waitForFunction(
      () => document.getElementById("blocking-toggle")?.textContent === "WebGuard on",
      null,
      { timeout: 15_000 }
    );

    // Two reloads in quick succession used to append the rows twice.
    const permissionsAfterReload = await page.locator("#permissions li").count();
    if (permissionsAfterReload > 0) {
      assert.ok(
        permissionsAfterReload <= 4,
        `permissions must not be duplicated, saw ${permissionsAfterReload} rows`
      );
    }
    const cookieRowCount = await page.locator("#cookies li").count();
    assert.ok(cookieRowCount <= 1 || new Set(await page.locator("#cookies li").allInnerTexts()).size === cookieRowCount, "cookie rows must not be duplicated");

    // Capture the populated popup for visual review while the data is on screen.
    const directory = join(__dirname, "..", "test-results", "screenshots");
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: join(directory, "popup-live.png"), fullPage: true });

    await page.close();
  });

  it("opens the real toolbar popup over a site tab", async () => {
    // This is the installed-extension path a user takes: activate a real site tab,
    // open the action popup, and read the popup window itself. Playwright does not
    // list Chrome's popup bubble as a page, so drive the target over CDP.
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const worker = context.serviceWorkers()[0];
    const siteTabId = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const site = tabs.find((tab) => (tab.url ?? "").startsWith("http://127.0.0.1"));
      if (!site) return null;
      await chrome.tabs.update(site.id, { active: true });
      return site.id;
    });
    assert.ok(siteTabId, "the seeded site tab must still be open");

    const browserSession = await context.browser().newBrowserCDPSession();
    await worker.evaluate(() => chrome.action.openPopup());

    let popupTarget = null;
    for (let attempt = 0; attempt < 50 && !popupTarget; attempt += 1) {
      const { targetInfos } = await browserSession.send("Target.getTargets");
      popupTarget = targetInfos.find((info) => info.type === "page" && info.url === POPUP_URL) ?? null;
      if (!popupTarget) await wait(200);
    }
    assert.ok(popupTarget, "the toolbar button must open the popup window");

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
    const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;

    await send("Page.enable");
    await send("Runtime.enable");

    let popupStatus = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      popupStatus = await evaluate("document.getElementById('status')?.textContent ?? ''");
      if (/Current site: 127\.0\.0\.1/.test(popupStatus)) break;
      await wait(200);
    }
    assert.match(popupStatus, /Current site: 127\.0\.0\.1/, `the toolbar popup must describe the active tab, got "${popupStatus}"`);
    assert.match(await evaluate("document.getElementById('blocking-toggle').innerText"), /^WebGuard (on|off)$/, "the toolbar popup shows the on/off switch");
    assert.match(await evaluate("document.getElementById('tab-count').innerText"), /^\d+$/, "the toolbar popup shows the blocked count");
    assert.match(
      await evaluate("document.getElementById('permissions').innerText"),
      /no permission granted|this site can use it right now/i,
      "the real popup lists granted permissions or says there are none"
    );

    // Chrome sizes the popup window, so it must fit without sideways scrolling.
    const overflow = await evaluate("JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })");
    const { scrollWidth, clientWidth } = JSON.parse(overflow);
    assert.ok(scrollWidth <= clientWidth + 1, `the real popup overflows (${scrollWidth} > ${clientWidth})`);

    // The expandable blocked list must work in the real popup too.
    await evaluate("document.getElementById('see-blocked').click()");
    assert.strictEqual(await evaluate("document.getElementById('blocked-panel').hidden"), false, "the blocked list must open");
    assert.ok((await evaluate("document.getElementById('blocked-list').innerText")).length > 0, "the blocked list must say what happened");

    const directory = join(__dirname, "..", "test-results", "screenshots");
    await mkdir(directory, { recursive: true });
    const shot = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(join(directory, "popup-toolbar.png"), Buffer.from(shot.data, "base64"));

    await browserSession.send("Target.closeTarget", { targetId: popupTarget.targetId });
    await browserSession.detach();
  });

  it("captures screenshots of the dashboard and popup for visual review", async () => {
    const directory = join(__dirname, "..", "test-results", "screenshots");
    await mkdir(directory, { recursive: true });

    const dashboard = await context.newPage();
    await dashboard.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await dashboard.waitForFunction(() => document.getElementById("status")?.textContent === "Loaded.", null, { timeout: 25_000 });
    await dashboard.setViewportSize({ width: 1280, height: 900 });
    await dashboard.screenshot({ path: join(directory, "dashboard-all-sites.png"), fullPage: true });
    // Earlier tests clear history, so the seeded site may no longer be listed;
    // screenshot whatever target the dashboard actually offers.
    const target = await dashboard.evaluate(() => {
      const select = document.getElementById("target-select");
      const values = [...select.options].map((option) => option.value).filter(Boolean);
      select.value = values.includes("example.com") ? "example.com" : values[0] ?? "";
      select.dispatchEvent(new Event("change"));
      return select.value;
    });
    assert.ok(target, "a site must be selectable for the screenshot");
    await dashboard.waitForTimeout(1_500);
    await dashboard.setViewportSize({ width: 1280, height: 900 });
    await dashboard.screenshot({ path: join(directory, "dashboard-light.png"), fullPage: true });
    await dashboard.emulateMedia({ colorScheme: "dark" });
    await dashboard.waitForTimeout(400);
    await dashboard.screenshot({ path: join(directory, "dashboard-dark.png"), fullPage: true });
    await dashboard.emulateMedia({ colorScheme: "light" });
    await dashboard.setViewportSize({ width: 640, height: 900 });
    await dashboard.waitForTimeout(400);
    await dashboard.screenshot({ path: join(directory, "dashboard-narrow.png"), fullPage: true });
    await dashboard.close();

    const written = (await readdir(directory)).filter((name) => name.endsWith(".png"));
    for (const name of ["dashboard-all-sites.png", "dashboard-light.png", "dashboard-dark.png", "dashboard-narrow.png"]) {
      assert.ok(written.includes(name), `${name} must be written, found ${written.join(", ")}`);
    }

    // The popup is a fixed 320px-wide surface, so capture it at that width too.
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 640 });
    await popup.goto(POPUP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await popup.waitForSelector("main");
    await popup.waitForTimeout(800);
    await popup.screenshot({ path: join(directory, "popup.png") });
    // A page the popup cannot read must still explain itself, not show empty sections.
    assert.match(await popup.locator("#cookie-empty").innerText(), /unavailable/, "the popup must explain missing details");
    assert.match(await popup.locator("#permissions").innerText(), /unavailable/, "the popup must explain missing permissions");
    await popup.close();
    assert.ok((await readdir(directory)).includes("popup.png"), "popup.png must be written");
  });

  it("clears everything when asked, and starts again cleanly", async () => {
    const page = await context.newPage();
    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => document.getElementById("status")?.textContent === "Loaded.", null, { timeout: 25_000 });

    await page.click("#clear-all");
    await page.waitForFunction(
      () => document.getElementById("settings-feedback")?.textContent?.includes("cleared"),
      null,
      { timeout: 15_000 }
    );
    await page.waitForTimeout(1_000);

    const overview = (await page.locator("#overview-stats").innerText()).replace(/\s+/g, " ");
    assert.ok(/Sites recorded 0/.test(overview), `history must be empty after clearing, got: ${overview}`);
    assert.ok(/Blocked today 0/.test(overview), `counters must reset after clearing, got: ${overview}`);
    assert.ok((await page.locator("#allowlist-list").innerText()).includes("No allowlisted sites"), "allowlist must be cleared");
    assert.ok(/No sites recorded|unavailable/i.test(await page.locator("#history-list").innerText()), "history view must be empty");

    // A cleared extension must still work: browse again and watch the counter climb.
    await sitePage.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await sitePage.waitForTimeout(3_000);
    const after = await page.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const site = tabs.find((tab) => (tab.url ?? "").startsWith("http://127.0.0.1"));
      return chrome.runtime.sendMessage({ type: "webguard.blockingSummary", tabId: site.id });
    });
    assert.ok(after.tab > 0, `blocking must keep working after a reset, saw ${after.tab}`);

    await page.close();
  });
});

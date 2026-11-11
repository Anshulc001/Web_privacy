import { barChartModel, CHART_HEIGHT, CHART_WIDTH, horizontalBarModel } from "./charts.mjs";
import { formatCount } from "../lib/format.mjs";
import { isPublicDomain } from "../lib/domain-info.mjs";
import { OUTBOUND_ENDPOINTS, PRIVACY_PERMISSIONS, STORED_DATA } from "../lib/privacy-contract.mjs";
import { categorizeTrackerHost } from "../lib/tracker-categories.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";
const state = { target: null, targets: null, overview: null, site: null, frame: "today" };
// True while a click on the blocking switch is still being saved.
let blockingToggleBusy = false;
// These panels describe one site; in "All sites" mode they are hidden rather
// than left on the page as boxes saying "select a site".
const SITE_ONLY_SECTIONS = ["cookies", "permissions", "domain", "suspicious", "breach"];
const PERMISSION_STATE_LABELS = { granted: "allowed", denied: "not permitted", prompt: "not given" };
const PERMISSION_SETTING_LABELS = { allow: "Allow", ask: "Ask", block: "Block" };

const el = (id) => document.getElementById(id);

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function text(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = String(value ?? "");
  if (className) node.className = className;
  return node;
}

function listItem(value) {
  return text("li", value);
}

function permissionLabel(name) {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/** A retention value is stored in hours but only ever shown in whole days. */
function dayLabel(hours) {
  const days = Math.max(1, Math.round(Number(hours) / 24));
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** Dates covered by the selected time frame, oldest first. */
function frameDates() {
  const series = state.overview?.blocking.series ?? [];
  if (state.frame === "today") return series.slice(-1).map((day) => day.date);
  if (state.frame === "yesterday") return series.slice(-2, -1).map((day) => day.date);
  return series.map((day) => day.date);
}

/** Sums a { "YYYY-MM-DD": count } map over the selected time frame. */
function frameTotal(days) {
  return frameDates().reduce((sum, date) => sum + (Number.isFinite(days?.[date]) ? days[date] : 0), 0);
}

/** The whole-browser daily counts, in the same shape as a site's counts. */
function browserDays() {
  return Object.fromEntries((state.overview?.blocking.series ?? []).map((day) => [day.date, day.count]));
}

/** Sums the per-day source maps over the selected time frame. */
function frameSourceTotals(dayHosts) {
  const totals = new Map();
  for (const date of frameDates()) {
    const hosts = dayHosts?.[date];
    if (!hosts || typeof hosts !== "object") continue;
    for (const [host, count] of Object.entries(hosts)) {
      if (typeof host !== "string" || !Number.isFinite(count) || count <= 0) continue;
      totals.set(host, (totals.get(host) ?? 0) + count);
    }
  }
  return totals;
}

/**
 * Source rows for the frame, most frequent first. If the stored source maps do
 * not cover the whole framed total (older data, requests with no page to
 * attribute), the remainder is shown as its own row so the list always adds up
 * to the number above it.
 */
function frameSourceRows(dayHosts, total) {
  const rows = [...frameSourceTotals(dayHosts)]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
  const covered = rows.reduce((sum, row) => sum + row.count, 0);
  if (total > covered) rows.push({ host: "Other / unattributed", count: total - covered, unattributed: true });
  return rows;
}

function sourceWord(count) {
  return count === 1 ? "source" : "sources";
}

/** All-sites mode: blocked requests and source count for each website. */
function frameWebsiteRows(total) {
  const rows = [];
  for (const entry of state.overview?.blocking.sites ?? []) {
    const siteTotal = frameTotal(entry.days ?? {});
    if (siteTotal <= 0) continue;
    rows.push({ host: entry.host, count: siteTotal, sources: frameSourceRows(entry.dayHosts, siteTotal).length });
  }
  rows.sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
  const covered = rows.reduce((sum, row) => sum + row.count, 0);
  if (total > covered) rows.push({ host: "Other / unattributed", count: total - covered, sources: 0, unattributed: true });
  return rows;
}

/** Top seven sources plus a single "Other" bar, so the chart totals the frame. */
function rankedSourceItems(dayHosts, total) {
  const rows = frameSourceRows(dayHosts, total);
  const items = rows.slice(0, 7).map((row) => ({ label: row.host, value: row.count }));
  const rest = rows.slice(7);
  if (rest.length > 0) {
    items.push({
      label: `Other (${rest.length} ${sourceWord(rest.length)})`,
      value: rest.reduce((sum, row) => sum + row.count, 0)
    });
  }
  return items;
}

/**
 * A blocked host row: the host on the left, its category, and its count on the
 * right. The "Other / unattributed" remainder is not a tracker, so it gets no
 * category label.
 */
function blockedRow(host, count, { unattributed = false } = {}) {
  const item = document.createElement("li");
  item.className = "blocked-row";
  const badge = text("span", formatCount(count), "blocked-count");
  badge.title = `${count} blocked request(s)`;
  const cells = [text("span", host, "blocked-host")];
  if (!unattributed) {
    const category = categorizeTrackerHost(host);
    cells.push(text("span", category.label, `tracker-badge tracker-badge--${category.id}`));
  }
  item.append(...cells, badge);
  return item;
}

/** One KPI tile: a small label, a large number, and an optional footnote. */
function kpiCard(label, value, hint, exact) {
  const item = document.createElement("li");
  item.className = "kpi";
  const number = text("strong", value, "kpi-value");
  // Compact numbers keep a five-digit total from overflowing the tile; the
  // exact value stays available on hover.
  if (exact !== undefined) number.title = String(exact);
  item.append(text("span", label, "kpi-label"), number);
  if (hint) item.append(text("span", hint, "kpi-hint"));
  return item;
}

function svgNode(name, attributes) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

/** Draws a column chart with plain SVG nodes; every label is set as text. */
function renderBarChart(container, items, label = "Chart") {
  clear(container);
  if (!items.length) {
    container.append(text("p", "No data yet.", "empty"));
    return;
  }
  const total = items.reduce((sum, item) => sum + (Number.isFinite(item.value) ? item.value : 0), 0);
  const model = barChartModel(items, { width: CHART_WIDTH, height: CHART_HEIGHT });
  const svg = svgNode("svg", {
    viewBox: `0 0 ${model.width} ${model.height}`,
    width: "100%",
    height: model.height,
    role: "img",
    "aria-label": `${label}: ${items.length} buckets, ${total} in total`
  });

  for (const tick of model.ticks) {
    svg.append(svgNode("line", { x1: model.plot.x, y1: tick.y, x2: model.plot.x + model.plot.width, y2: tick.y, class: "grid" }));
    const label = svgNode("text", { x: model.plot.x - 8, y: tick.y + 4, class: "tick", "text-anchor": "end" });
    label.textContent = String(tick.value);
    svg.append(label);
  }

  for (const bar of model.bars) {
    const rect = svgNode("rect", {
      x: bar.x,
      y: bar.y,
      width: bar.width,
      height: Math.max(bar.height, bar.value > 0 ? 1 : 0),
      rx: 4,
      class: "bar"
    });
    // Hovering a bar explains itself; the numbers are also rendered as text.
    const tooltip = svgNode("title", {});
    tooltip.textContent = `${bar.label}: ${bar.value}`;
    rect.append(tooltip);
    svg.append(rect);
    const valueLabel = svgNode("text", { x: bar.labelX, y: bar.y - 4, class: "value", "text-anchor": "middle" });
    valueLabel.textContent = bar.value > 0 ? String(bar.value) : "";
    svg.append(valueLabel);
    const axisLabel = svgNode("text", { x: bar.labelX, y: bar.labelY, class: "label", "text-anchor": "middle" });
    axisLabel.textContent = bar.label;
    svg.append(axisLabel);
  }

  container.append(svg);
}

/**
 * Ranked horizontal bars. Hostnames are long, so a label column keeps them from
 * piling on top of each other the way column-chart axis labels did.
 */
function renderRankedBars(container, items, label = "Chart") {
  clear(container);
  if (!items.length) {
    container.append(text("p", "No data yet.", "empty"));
    return;
  }
  const total = items.reduce((sum, item) => sum + (Number.isFinite(item.value) ? item.value : 0), 0);
  const model = horizontalBarModel(items, { width: CHART_WIDTH });
  const svg = svgNode("svg", {
    viewBox: `0 0 ${model.width} ${model.height}`,
    width: "100%",
    height: model.height,
    role: "img",
    "aria-label": `${label}: ${items.length} hosts, ${total} blocked requests`
  });

  for (const bar of model.bars) {
    const name = svgNode("text", { x: 0, y: bar.textY, class: "label" });
    name.textContent = bar.label.length > 30 ? `${bar.label.slice(0, 29)}…` : bar.label;
    const tooltip = svgNode("title", {});
    tooltip.textContent = `${bar.label}: ${bar.value}`;
    name.append(tooltip);
    svg.append(name);

    const rect = svgNode("rect", { x: bar.x, y: bar.y, width: Math.max(bar.width, bar.value > 0 ? 2 : 0), height: bar.height, rx: 4, class: "bar" });
    svg.append(rect);

    const valueLabel = svgNode("text", { x: bar.valueX, y: bar.textY, class: "value" });
    valueLabel.textContent = String(bar.value);
    svg.append(valueLabel);
  }

  container.append(svg);
}

async function send(message) {
  return chrome.runtime.sendMessage(message);
}

/** Hosts with recorded visits inside the selected frame, most visited first. */
function frameHosts() {
  const dates = new Set(frameDates());
  const totals = new Map();
  for (const day of state.overview?.history.days ?? []) {
    if (!dates.has(day.date)) continue;
    for (const entry of day.hosts ?? []) totals.set(entry.host, (totals.get(entry.host) ?? 0) + entry.count);
  }
  return [...totals.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
}

/** Selects a site in the picker, adding it if the frame does not list it. */
async function selectTarget(hostname) {
  const select = el("target-select");
  if (![...select.options].some((option) => option.value === hostname)) {
    const option = document.createElement("option");
    option.value = hostname;
    option.textContent = hostname;
    select.append(option);
  }
  select.value = hostname;
  state.target = hostname;
  await applyScope();
}

/**
 * The picker follows the time frame: it lists the sites visited in that frame,
 * plus open tabs (the site in front of the reader even if the frame does not
 * include its visit). There is no separate history list anywhere.
 */
function fillTargetSelect() {
  const select = el("target-select");
  clear(select);
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All sites";
  select.append(all);

  const openHosts = new Set((state.targets?.tabs ?? []).map((tab) => tab.hostname).filter(Boolean));
  const seen = new Set();
  for (const entry of frameHosts()) {
    seen.add(entry.host);
    const option = document.createElement("option");
    option.value = entry.host;
    option.textContent = `${entry.host} — ${entry.count} visit${entry.count === 1 ? "" : "s"}${openHosts.has(entry.host) ? " (open tab)" : ""}`;
    select.append(option);
  }
  for (const host of openHosts) {
    if (seen.has(host)) continue;
    const option = document.createElement("option");
    option.value = host;
    option.textContent = `${host} (open tab)`;
    select.append(option);
  }
  // The reader's choice survives a refresh, but only while the site is still offered.
  if (state.target && [...select.options].some((option) => option.value === state.target)) select.value = state.target;
  else state.target = null;
}

/** Label for the time frame currently selected in the header picker. */
function frameLabel() {
  if (state.frame === "yesterday") return "Blocked yesterday";
  if (state.frame === "week") return "Blocked (7 days)";
  return "Blocked today";
}

/** Overview tiles. With a site selected the blocked tile describes that site. */
function renderKpis() {
  const overview = state.overview;
  if (!overview) return;
  const stats = el("overview-stats");
  clear(stats);
  const site = state.target ? state.site : null;
  const days = site ? site.blocking?.days ?? {} : browserDays();
  const total = frameTotal(days);
  stats.append(kpiCard(frameLabel(), formatCount(total), site ? "on this site" : "requests stopped", total));
  // Visit totals belong to the all-sites view only. A selected site shows its
  // own panels, and none of them is a visit history.
  if (!site) {
    const visits = frameDates().reduce((sum, date) => {
      const day = overview.history.days.find((entry) => entry.date === date);
      return sum + (day?.count ?? 0);
    }, 0);
    const frameWords = state.frame === "week" ? "past 7 days" : state.frame;
    stats.append(kpiCard("Visits recorded", formatCount(visits), frameWords, visits));
  }
  stats.append(kpiCard("Blocking", overview.blocking.enabled ? "On" : "Off", `${overview.blocking.allowlist.length} allowlisted`));
}

/** Blocked-request charts follow the site picker; the frame sets the totals. */
function renderCharts() {
  const overview = state.overview;
  if (!overview) return;
  const site = state.target ? state.site : null;
  const days = site ? site.blocking?.days ?? {} : browserDays();
  renderBarChart(
    el("chart-blocked"),
    overview.blocking.series.map((day) => ({ label: day.date.slice(5), value: Number.isFinite(days[day.date]) ? days[day.date] : 0 })),
    "Blocked requests per day"
  );
  renderRankedBars(
    el("chart-trackers"),
    rankedSourceItems(site ? site.blocking?.dayHosts : overview.blocking.dayHosts, frameTotal(days)),
    "Top blocked hosts"
  );
}

async function loadOverview() {
  const overview = await send({ type: "webguard.dashboardOverview" });
  state.overview = overview;

  el("frame-select").value = state.frame;
  el("frame-select").disabled = false;

  renderKpis();
  renderCharts();

  // One compact freshness line in Settings instead of an Overview block.
  el("sync-status").textContent = overview.data.map((entry) => entry.text).join(" ");
  el("auto-lookup").checked = overview.settings.autoDomainLookup;
  renderPrivacy();

  const allowlistList = el("allowlist-list");
  clear(allowlistList);
  if (overview.blocking.allowlist.length === 0) {
    allowlistList.textContent = "No allowlisted sites.";
  } else {
    for (const host of overview.blocking.allowlist) allowlistList.append(listItem(host));
  }

  // A live refresh is debounced by a quarter second, so one that read the settings
  // just before a click on the switch can land just after it and flip the switch
  // back. While the change is being saved, the switch belongs to the user.
  if (!blockingToggleBusy) el("blocking-toggle").checked = overview.blocking.enabled;
  el("history-paused").checked = overview.history.paused;
  el("settings-retention-note").textContent = `Retention is ${dayLabel(overview.history.retentionHours)}. Data older than that is deleted automatically.`;

  const retentionSelect = el("retention-select");
  clear(retentionSelect);
  for (const hours of [24, 48, 72, 96, 120, 144, 168]) {
    const option = document.createElement("option");
    option.value = String(hours);
    option.textContent = dayLabel(hours);
    option.selected = hours === overview.history.retentionHours;
    retentionSelect.append(option);
  }

  // The picker is rebuilt from this overview so it always lists the frame's sites.
  fillTargetSelect();
}

/** Registry servers are many; name a few and count the rest. */
function hostSummary(hosts) {
  if (hosts.length <= 4) return hosts.join(", ");
  return `${hosts.slice(0, 3).join(", ")} and ${hosts.length - 3} more registry servers`;
}

/** Settings → Privacy: exactly what can leave this device and what is stored. */
function renderPrivacy() {
  const endpoints = el("privacy-endpoints");
  clear(endpoints);
  for (const endpoint of OUTBOUND_ENDPOINTS) {
    endpoints.append(listItem(
      `${endpoint.label} — ${endpoint.when} ${endpoint.detail} Servers: ${hostSummary(endpoint.hosts)}.`
    ));
  }

  const stored = el("privacy-stored");
  clear(stored);
  for (const entry of STORED_DATA) stored.append(listItem(`${entry.label}: ${entry.detail}`));

  const permissions = el("privacy-permissions");
  clear(permissions);
  for (const permission of PRIVACY_PERMISSIONS) permissions.append(listItem(`${permission.name} — ${permission.why}`));
}

/** A heading row inside the blocked list, so both breakdowns stay one list. */
function blockedGroup(value) {
  const item = document.createElement("li");
  item.className = "blocked-group";
  item.textContent = value;
  return item;
}

/** All-sites mode: one clickable row per website, with its blocked total. */
function websiteRow(entry) {
  const item = document.createElement("li");
  item.className = "blocked-row website-row";
  const label = `${entry.host} — ${entry.count} blocked (${entry.sources} ${sourceWord(entry.sources)})`;
  if (entry.unattributed) {
    item.append(text("span", label, "blocked-host"));
  } else {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "blocked-link";
    button.textContent = label;
    button.addEventListener("click", () => { void selectTarget(entry.host); });
    item.append(button);
  }
  const badge = text("span", formatCount(entry.count), "blocked-count");
  badge.title = `${entry.count} blocked request(s)`;
  item.append(badge);
  return item;
}

/** Fills the Ads section from the whole browser or from the selected site. */
async function loadBlockedForSite() {
  const countEl = el("block-count");
  const unitEl = el("block-unit");
  const list = el("blocked-list");
  const sourceEl = el("blocked-source");
  const site = state.target ? state.site : null;

  const days = site ? site.blocking?.days ?? {} : browserDays();
  const total = frameTotal(days);
  const rows = frameSourceRows(site ? site.blocking?.dayHosts : state.overview?.blocking.dayHosts, total);
  countEl.textContent = formatCount(total);
  countEl.title = `${total} blocked request(s)`;

  clear(list);

  if (site) {
    unitEl.textContent = `blocked requests from ${rows.length} ${sourceWord(rows.length)} on this site`;
    if (total === 0) {
      list.textContent = "No blocked requests recorded for this site in this time frame.";
    } else {
      // Every source, not a top ten: the rows add up to the number above.
      for (const row of rows) list.append(blockedRow(row.host, row.count, { unattributed: row.unattributed === true }));
    }
    sourceEl.textContent = "Every source blocked on this site in the selected time frame, most frequent first; the counts add up to the number above. Page URLs are never stored.";
    return;
  }

  const websites = frameWebsiteRows(total);
  const siteCount = websites.filter((entry) => !entry.unattributed).length;
  unitEl.textContent = siteCount > 0
    ? `blocked requests from ${rows.length} ${sourceWord(rows.length)} across ${siteCount} website${siteCount === 1 ? "" : "s"}`
    : `blocked requests from ${rows.length} ${sourceWord(rows.length)} in this browser`;

  if (total === 0) {
    list.textContent = "No blocked requests recorded in this time frame.";
    sourceEl.textContent = "Counts follow the selected time frame. Page URLs are never stored.";
    return;
  }

  // Both breakdowns are shown, and each adds up to the number above.
  list.append(blockedGroup("By website"));
  for (const entry of websites) list.append(websiteRow(entry));
  list.append(blockedGroup("By tracker source"));
  for (const row of rows) list.append(blockedRow(row.host, row.count, { unattributed: row.unattributed === true }));
  sourceEl.textContent = "By website and by tracker source, for the selected time frame; both lists add up to the number above. Not a full request log, and page URLs are never stored.";
}

async function loadSite(hostname) {
  const report = await send({ type: "webguard.siteReport", hostname });
  if (!report || report.status !== "ok") {
    state.site = null;
    el("target-summary").textContent = report?.reason ?? "Site details are unavailable.";
    return;
  }
  state.site = report;
  el("target-summary").textContent = `${report.hostname}${report.suspicious.isHttps === false ? " (plain HTTP)" : ""}`;
  el("allowlist-toggle").disabled = false;

  const hasRegistryData = report.domainInfo?.status === "ok";
  el("rdap-lookup").disabled = domainLookupInFlight;
  el("rdap-lookup").textContent = hasRegistryData ? "Refresh RDAP" : "Look up RDAP";

  const cookiesList = el("cookies-list");
  clear(cookiesList);
  const cookies = report.cookies;
  const cookieCount = cookies?.status === "ok" ? (cookies.cookies ?? []).length : 0;
  el("clear-site-cookies").disabled = cookieCount === 0;
  if (!cookies || cookies.status === "unavailable") {
    el("cookies-status").textContent = "Cookie details are unavailable on this page.";
    cookiesList.textContent = "";
  } else {
    const list = cookies.cookies ?? [];
    el("cookies-status").textContent = list.length === 0 ? "No cookies detected for this site." : `${list.length} cookie(s).`;
    if (list.length > 0) {
      for (const cookie of list) {
        cookiesList.append(listItem(`${cookie.name} — ${cookie.domain}; ${cookie.party}; expires: ${cookie.expiry}; Secure: ${cookie.secure}; HttpOnly: ${cookie.httpOnly}; SameSite: ${cookie.sameSite}`));
      }
    }
  }

  el("permissions-status").textContent = "";
  renderSitePermissions(report.permissions, report.permissionSettings);
  renderDomainDetails(report.domainInfo, report.hostname);

  // Registry data is loaded once a public domain is selected, so the reader gets
  // the registrar and dates without a second click. The Settings switch makes
  // that outbound request optional; IPs, local hosts and cached answers skip it.
  const autoLookup = state.overview?.settings?.autoDomainLookup !== false;
  if (autoLookup && !hasRegistryData && isPublicDomain(report.hostname)) void lookupSelectedDomain(report.hostname);

  el("ads-status").textContent = `Blocking is ${state.overview?.blocking.enabled ? "on" : "off"} for this browser.`;
  el("allowlist-status").textContent = report.allowlisted ? "This site is allowlisted, so blocking is skipped here." : "This site is not allowlisted.";
  el("allowlist-toggle").textContent = report.allowlisted ? "Remove from allowlist" : "Allowlist this site";

  el("risk-summary").textContent = `Risk score ${report.suspicious.score}/100 (${report.suspicious.level}).`;
  const reasons = el("risk-reasons");
  clear(reasons);
  for (const reason of report.suspicious.reasons) reasons.append(listItem(`${reason.weight > 0 ? `+${reason.weight} ` : ""}${reason.label}`));
  el("risk-disclaimer").textContent = report.suspicious.disclaimer;

  const breachSummary = el("breach-summary");
  const breachList = el("breach-list");
  clear(breachList);
  const breach = report.breach;
  if (!breach || breach.status === "unavailable") {
    breachSummary.textContent = `Breach data is unavailable${breach?.reason ? `: ${breach.reason}` : "."}`;
    breachList.textContent = "";
  } else if (breach.status === "not-found") {
    breachSummary.textContent = "This site was not found in the breach list. That is not proof it was never breached.";
    breachList.textContent = "";
  } else {
    breachSummary.textContent = `This site appeared in ${breach.matches.length} known breach(es) (matched ${breach.matchedDomain}).`;
    for (const match of breach.matches) {
      const flags = match.flagLabels?.length ? ` [${match.flagLabels.join(", ")}]` : "";
      breachList.append(listItem(`${match.title} — ${match.breachDate ?? "date unknown"}, ${match.pwnCount ?? "?"} records${flags}. ${match.description}`));
    }
  }
  const attribution = el("breach-attribution");
  clear(attribution);
  if (breach?.attribution) {
    const link = document.createElement("a");
    link.href = breach.attribution.url;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = breach.attribution.label;
    attribution.append(link);
  }
}

/** Paints the four permission rows from a page report or a live refresh. */
function renderSitePermissions(permissions, permissionSettings) {
  const permissionsList = el("permissions-list");
  clear(permissionsList);
  const permissionNames = Object.keys(permissions ?? {});
  const reportablePermissions = permissionNames.filter((name) => {
    const state = permissions[name];
    return state && state !== "unavailable";
  });
  const siteSettings = permissionSettings?.settings ?? {};
  if (reportablePermissions.length === 0) {
    permissionsList.textContent = "No usable permission data for this site.";
    return;
  }
  for (const name of reportablePermissions) {
    const state = permissions[name];
    const label = PERMISSION_STATE_LABELS[state] ?? "not given";
    const row = document.createElement("li");
    row.className = "permission-row";
    row.append(text("span", `${permissionLabel(name)}: ${label}`));

    // Chrome persists allow/ask/block per site; the state above is what the
    // page currently reported, which can differ until it asks again.
    const select = document.createElement("select");
    select.id = `permission-${name}`;
    select.setAttribute("aria-label", `${permissionLabel(name)} setting for this site`);
    const setting = siteSettings[name];
    for (const value of ["allow", "ask", "block"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = PERMISSION_SETTING_LABELS[value];
      option.selected = (setting ?? "ask") === value;
      select.append(option);
    }
    select.disabled = !setting || setting === "unavailable";
    select.addEventListener("change", () => { void savePermission(name, select); });
    row.append(select);
    permissionsList.append(row);
  }
  if (permissionSettings?.status !== "ok" && !el("permissions-status").textContent) {
    el("permissions-status").textContent = permissionSettings?.reason
      ?? "Chrome's site permission settings are unavailable here.";
  }
}

// Chrome's prompt writes a content setting, which fires no storage event. Polling
// the one section keeps the granted state and the dropdown current while the
// dashboard is open, without repainting the rest of the page.
let permissionTimer = null;
let permissionRefreshBusy = false;
async function refreshSitePermissions() {
  const host = state.target;
  if (!host || permissionRefreshBusy || document.visibilityState !== "visible") return;
  // Never rebuild a control the reader is using; the next tick will catch up.
  if (document.activeElement?.closest?.("#permissions-list")) return;
  permissionRefreshBusy = true;
  try {
    const result = await send({ type: "webguard.sitePermissions", hostname: host });
    if (state.target !== host || result?.status !== "ok") return;
    state.site = { ...state.site, permissions: result.permissions, permissionSettings: result.permissionSettings };
    renderSitePermissions(result.permissions, result.permissionSettings);
  } catch {
    // Keep the last known state; the next tick retries.
  } finally {
    permissionRefreshBusy = false;
  }
}

function startPermissionPolling() {
  clearInterval(permissionTimer);
  permissionTimer = window.setInterval(() => { void refreshSitePermissions(); }, 5_000);
}

/** A registry timestamp as a plain date; the time of day is never useful here. */
function registryDate(value) {
  if (typeof value !== "string") return "not reported";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : value;
}

/** Registry rows, painted from whatever RDAP answer is current. */
function renderDomainDetails(info, hostname, summary = null) {
  el("domain-summary").textContent = summary ?? (info
    ? `Cached registry data for ${hostname}.`
    : "No registry data yet.");
  const details = el("domain-details");
  clear(details);
  if (!info || info.status !== "ok") return;
  const ageDays = Number(info.ageDays);
  const statuses = Array.isArray(info.statuses) && info.statuses.length ? info.statuses.join(", ") : "not reported";
  for (const [key, value] of Object.entries({
    Registrar: info.registrar ?? "not reported",
    Registered: registryDate(info.registrationDate),
    Updated: registryDate(info.lastChangedDate),
    Expires: registryDate(info.expirationDate),
    "Domain age": Number.isFinite(ageDays) ? `${ageDays} day${ageDays === 1 ? "" : "s"}` : "unknown",
    Status: statuses,
    Source: info.source ?? "unknown"
  })) {
    const wrapper = document.createElement("div");
    wrapper.append(text("dt", key), text("dd", value));
    details.append(wrapper);
  }
}

// One registry request at a time: a re-render must not start a second lookup or
// re-enable the button while an answer is still in flight.
let domainLookupInFlight = false;

function domainResultSummary(result, hostname) {
  if (result?.status === "ok") return `Registry data for ${hostname} from ${result.source}.`;
  return result?.reason ?? "Domain information is unavailable.";
}

/**
 * Looks up the selected site's registry record and repaints Domain Info. The
 * background caches the answer, so a successful lookup is followed by one
 * re-read of the site report, which is what refreshes the risk score too.
 */
async function lookupSelectedDomain(hostname) {
  if (!hostname || domainLookupInFlight) return;
  domainLookupInFlight = true;
  const button = el("rdap-lookup");
  button.disabled = true;
  el("domain-summary").textContent = "Looking this domain up…";
  try {
    const result = await send({ type: "webguard.lookupDomain", hostname });
    // A scope change during the lookup must not paint another site's data.
    if (state.target !== hostname) return;
    button.textContent = result?.status === "ok" ? "Refresh RDAP" : "Look up RDAP";
    renderDomainDetails(result?.status === "ok" ? result : null, hostname, domainResultSummary(result, hostname));
    if (result?.status === "ok") await loadSite(hostname);
  } catch (error) {
    if (state.target === hostname) renderDomainDetails(null, hostname, "Registry data could not be loaded.");
  } finally {
    domainLookupInFlight = false;
    button.disabled = !state.target;
  }
}

/** "All sites" mode: site-only panels say so instead of showing stale details. */
function resetSiteSections() {
  state.site = null;
  el("target-summary").textContent = "Showing all sites recorded in this browser.";

  el("cookies-status").textContent = "Select a site above to see its cookies.";
  clear(el("cookies-list"));
  el("clear-site-cookies").disabled = true;

  const permissionsList = el("permissions-list");
  clear(permissionsList);
  permissionsList.textContent = "Select a site above to see its permissions.";
  el("permissions-status").textContent = "";

  el("allowlist-status").textContent = "Select a site above to allowlist it.";
  el("allowlist-toggle").disabled = true;
  el("allowlist-toggle").textContent = "Allowlist this site";

  el("domain-summary").textContent = "Select a site above to look up its registry data.";
  clear(el("domain-details"));
  el("rdap-lookup").textContent = "Look up RDAP";
  el("rdap-lookup").disabled = true;

  el("risk-summary").textContent = "Select a site above to see its risk score.";
  clear(el("risk-reasons"));
  el("risk-disclaimer").textContent = "";

  el("breach-summary").textContent = "Select a site above to check it against breach data.";
  clear(el("breach-list"));
  clear(el("breach-attribution"));

  el("ads-status").textContent = `Blocking is ${state.overview?.blocking.enabled ? "on" : "off"} for this browser.`;
}

/** All-sites mode hides the per-site panels and the site-only top-nav links. */
function setSiteMode(isSite) {
  // The header nav is the only section list now (the old #site-tabs strip is
  // gone), so it is pruned to the links that exist in the current mode.
  for (const id of SITE_ONLY_SECTIONS) el(id).hidden = !isSite;
  for (const link of document.querySelectorAll("header nav a[data-site-only]")) link.hidden = !isSite;
  syncNav();
}

/** Saves one Chrome site-permission setting, then re-reads the site report. */
async function savePermission(permission, select) {
  const host = state.target;
  if (!host) return;
  const setting = select.value;
  select.disabled = true;
  const result = await send({ type: "webguard.setPermission", hostname: host, permission, setting });
  // A scope change during the save must not write feedback about another site.
  if (state.target !== host) return;
  select.disabled = false;
  if (result?.status === "ok") await loadSite(host);
  el("permissions-status").textContent = result?.status === "ok"
    ? `${permissionLabel(permission)} is now "${setting}" for ${host}.`
    : (result?.reason ?? "That permission could not be changed.");
}

/** Applies the site picker to every panel, then re-renders the summary. */
async function applyScope() {
  setSiteMode(Boolean(state.target));
  if (state.target) await loadSite(state.target);
  else resetSiteSections();
  renderKpis();
  renderCharts();
  await loadBlockedForSite();
}

async function refresh() {
  try {
    state.targets = await send({ type: "webguard.dashboardTargets" });
    // loadOverview rebuilds the site picker from the frame's visit data.
    await loadOverview();
    await applyScope();
    el("status").textContent = "Loaded.";
    el("status").className = "is-ready";
  } catch (error) {
    el("status").textContent = "Dashboard data is unavailable.";
    el("status").className = "is-error";
    console.error("WebGuard dashboard failed to load.", error);
  } finally {
    // Keep the UI responsive even if a later step fails.
  }
}

// Highlight the section the reader is looking at, so the nav doubles as a
// position indicator on a long page.
const navLinks = [...document.querySelectorAll("header nav a")];

// The last section whose top has passed under the sticky header is the one being
// read. Measuring on scroll is deterministic at load, unlike an observer that
// needs a threshold to be crossed. Hidden sections are skipped: a display:none
// box reports top 0 and would otherwise win the comparison.
function syncNav() {
  const offset = 160;
  const sections = navLinks
    .filter((link) => !link.hidden)
    .map((link) => document.querySelector(link.getAttribute("href")))
    .filter((section) => section && !section.hidden);
  let active = sections[0] ?? null;
  for (const section of sections) {
    if (section.getBoundingClientRect().top <= offset) active = section;
  }
  for (const link of navLinks) {
    if (active && !link.hidden && link.getAttribute("href") === `#${active.id}`) link.setAttribute("aria-current", "true");
    else link.removeAttribute("aria-current");
  }
}

window.addEventListener("scroll", syncNav, { passive: true });
window.addEventListener("resize", syncNav);
syncNav();

el("target-select").addEventListener("change", async (event) => {
  state.target = event.target.value || null;
  await applyScope();
});

el("refresh-site").addEventListener("click", () => refresh());

el("blocking-toggle").addEventListener("change", async (event) => {
  blockingToggleBusy = true;
  try {
    await send({ type: "webguard.updateSettings", patch: { blockingEnabled: event.target.checked } });
    await loadOverview();
    await applyScope();
  } finally {
    blockingToggleBusy = false;
  }
});

el("history-paused").addEventListener("change", async (event) => {
  await send({ type: "webguard.updateSettings", patch: { historyPaused: event.target.checked } });
  await loadOverview();
});

el("retention-select").addEventListener("change", async (event) => {
  await send({ type: "webguard.updateSettings", patch: { historyRetentionHours: Number(event.target.value) } });
  await loadOverview();
});

el("auto-lookup").addEventListener("change", async (event) => {
  await send({ type: "webguard.updateSettings", patch: { autoDomainLookup: event.target.checked } });
  await loadOverview();
  await applyScope();
});

el("allowlist-toggle").addEventListener("click", async () => {
  if (!state.target) return;
  const allowlisted = !(state.overview?.blocking.allowlist ?? []).includes(state.target);
  await send({ type: "webguard.toggleAllowlist", hostname: state.target, allowlisted });
  await loadOverview();
  await applyScope();
});

el("expand-blocked").addEventListener("click", () => {
  const panel = el("blocked-panel");
  const button = el("expand-blocked");
  const open = panel.hidden;
  panel.hidden = !open;
  button.textContent = open ? "Hide blocked items" : "Show blocked items";
  button.setAttribute("aria-expanded", String(open));
});

el("frame-select").addEventListener("change", async (event) => {
  state.frame = event.target.value;
  // The frame decides which sites exist for the reader, so the picker is rebuilt
  // before the panels: a site outside the frame is no longer offered.
  fillTargetSelect();
  if (state.target) {
    await applyScope();
  } else {
    renderKpis();
    renderCharts();
    await loadBlockedForSite();
  }
});

el("rdap-lookup").addEventListener("click", () => {
  if (!state.target) return;
  void lookupSelectedDomain(state.target);
});

el("clear-site-cookies").addEventListener("click", async () => {
  if (!state.target) return;
  el("clear-site-cookies").disabled = true;
  const result = await send({ type: "webguard.clearSiteCookies", hostname: state.target });
  // Re-read the site so the cookie list, the count and the button all agree with
  // the browser; the confirmation is then written over the refreshed status.
  await loadSite(state.target);
  el("cookies-status").textContent = result?.ok
    ? `Cleared ${result.removed} cookie${result.removed === 1 ? "" : "s"} for this site.`
    : (result?.reason ?? "Cookies could not be cleared.");
});

el("clear-history").addEventListener("click", async () => {
  await send({ type: "webguard.clearHistory" });
  el("settings-feedback").textContent = "Visit records cleared.";
  await loadOverview();
  await applyScope();
});

el("clear-all").addEventListener("click", async () => {
  await send({ type: "webguard.clearAllData" });
  el("settings-feedback").textContent = "All WebGuard data cleared.";
  await loadOverview();
  await applyScope();
});

// Counts, history and settings change while the dashboard is open, so it has to
// re-read them instead of showing whatever was true when the tab was opened.
let liveTimer = null;
const LIVE_KEYS = ["blockingCounts", "settings", "historyEvents", "siteObservations", "dataLastSync", "domainInfoCache"];
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!LIVE_KEYS.some((key) => key in changes)) return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => { void refresh(); }, 250);
});

startPermissionPolling();
window.addEventListener("focus", () => { void refreshSitePermissions(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refreshSitePermissions();
});

void refresh();

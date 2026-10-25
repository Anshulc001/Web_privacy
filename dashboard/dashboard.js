import { barChartModel, CHART_HEIGHT, CHART_WIDTH, horizontalBarModel } from "./charts.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";
const state = { target: null, overview: null, site: null, frame: "today" };
const PERMISSION_STATE_LABELS = { granted: "allowed", denied: "not permitted", prompt: "not given" };

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

/** A blocked host row: the host on the left, its count in a badge on the right. */
function blockedRow(host, count) {
  const item = document.createElement("li");
  item.className = "blocked-row";
  item.append(text("span", host, "blocked-host"), text("span", count, "blocked-count"));
  return item;
}

/** One KPI tile: a small label, a large number, and an optional footnote. */
function kpiCard(label, value, hint) {
  const item = document.createElement("li");
  item.className = "kpi";
  item.append(text("span", label, "kpi-label"), text("strong", value, "kpi-value"));
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

function fillTargetSelect(targets) {
  const select = el("target-select");
  clear(select);
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All sites";
  select.append(all);
  const seen = new Set();
  for (const tab of targets.tabs ?? []) {
    if (seen.has(tab.hostname)) continue;
    seen.add(tab.hostname);
    const option = document.createElement("option");
    option.value = tab.hostname;
    option.textContent = `${tab.hostname} (open tab)`;
    select.append(option);
  }
  for (const host of targets.recentHosts ?? []) {
    if (seen.has(host)) continue;
    seen.add(host);
    const option = document.createElement("option");
    option.value = host;
    option.textContent = host;
    select.append(option);
  }
  // The reader's choice survives a refresh, but only while the site is still offered.
  if (state.target && seen.has(state.target)) select.value = state.target;
  else state.target = null;
}

/** Overview tiles. With a site selected the blocked tile describes that site. */
function renderKpis() {
  const overview = state.overview;
  if (!overview) return;
  const stats = el("overview-stats");
  clear(stats);
  const site = state.target ? state.site : null;
  const today = overview.blocking.series.at(-1)?.date ?? "";
  const siteDays = site?.blocking?.days ?? {};
  stats.append(kpiCard(
    "Blocked today",
    String(site ? (Number.isFinite(siteDays[today]) ? siteDays[today] : 0) : overview.blocking.today),
    site ? "on this site" : "requests stopped"
  ));
  stats.append(kpiCard("Sites recorded", String(overview.history.totalEvents), `last ${dayLabel(overview.history.retentionHours)}`));
  stats.append(kpiCard("Blocking", overview.blocking.enabled ? "On" : "Off", `${overview.blocking.allowlist.length} allowlisted`));
  stats.append(kpiCard("History", overview.history.paused ? "Paused" : "Recording", `${dayLabel(overview.history.retentionHours)} retention`));
}

/** Charts follow the picker: all sites, or only the selected one. */
function renderCharts() {
  const overview = state.overview;
  if (!overview) return;
  const site = state.target ? state.site : null;
  el("chart-sites-heading").textContent = site ? "Visits per day" : "Sites per day";

  if (site) {
    // Both charts share the same seven-day axis, so their bars line up.
    const visitsByDay = new Map(overview.history.days.map((day) => [
      day.date,
      day.hosts.find((entry) => entry.host === state.target)?.count ?? 0
    ]));
    renderBarChart(
      el("chart-sites"),
      overview.blocking.series.map((day) => ({ label: day.date.slice(5), value: visitsByDay.get(day.date) ?? 0 })),
      "Visits per day"
    );
    const days = site.blocking?.days ?? {};
    renderBarChart(
      el("chart-blocked"),
      overview.blocking.series.map((day) => ({ label: day.date.slice(5), value: Number.isFinite(days[day.date]) ? days[day.date] : 0 })),
      "Blocked requests per day"
    );
    renderRankedBars(
      el("chart-trackers"),
      (site.blocking?.hosts ?? []).slice(0, 7).map((entry) => ({ label: entry.host, value: entry.count })),
      "Top blocked hosts"
    );
    return;
  }

  renderBarChart(
    el("chart-sites"),
    overview.history.days.map((day) => ({ label: day.date.slice(5), value: day.count })),
    "Sites per day"
  );
  renderBarChart(
    el("chart-blocked"),
    overview.blocking.series.map((day) => ({ label: day.date.slice(5), value: day.count })),
    "Blocked requests per day"
  );
  renderRankedBars(
    el("chart-trackers"),
    overview.blocking.topHosts.slice(0, 7).map((entry) => ({ label: entry.host, value: entry.count })),
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

  const dataList = el("data-status");
  clear(dataList);
  for (const entry of overview.data) dataList.append(listItem(entry.text));

  const allowlistList = el("allowlist-list");
  clear(allowlistList);
  if (overview.blocking.allowlist.length === 0) {
    allowlistList.textContent = "No allowlisted sites.";
  } else {
    for (const host of overview.blocking.allowlist) allowlistList.append(listItem(host));
  }

  el("blocking-toggle").checked = overview.blocking.enabled;
  el("history-paused").checked = overview.history.paused;
  el("history-retention").textContent = `Only the last ${dayLabel(overview.history.retentionHours)} of hostnames are kept, and older entries are pruned automatically.`;
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

  const dateSelect = el("history-date");
  clear(dateSelect);
  for (const date of overview.history.selectableDays) {
    const option = document.createElement("option");
    option.value = date;
    option.textContent = date;
    dateSelect.append(option);
  }

  if (dateSelect.value) {
    await loadHistoryDay(dateSelect.value);
  }
}

/** Fills the Ads section from the whole browser or from the selected site. */
async function loadBlockedForSite() {
  const countEl = el("block-count");
  const unitEl = el("block-unit");
  const list = el("blocked-list");
  const sourceEl = el("blocked-source");
  const site = state.target ? state.site : null;

  const days = site ? site.blocking?.days ?? {} : browserDays();
  countEl.textContent = String(frameTotal(days));
  unitEl.textContent = site ? "blocked requests on this site" : "blocked requests in this browser";

  clear(list);
  const hosts = site ? site.blocking?.hosts ?? [] : state.overview?.blocking.topHosts ?? [];
  if (hosts.length === 0) {
    list.textContent = site ? "No blocked requests recorded for this site yet." : "No blocked hosts recorded yet.";
  } else {
    for (const entry of hosts.slice(0, 10)) list.append(blockedRow(entry.host, entry.count));
  }
  sourceEl.textContent = site
    ? "Hosts blocked while this site was open, most frequent first. Page URLs are never stored."
    : "Host-level block counts recorded in this browser, most frequent first. Not a full request log, and page URLs are never stored.";
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
  el("expected-toggle").disabled = false;
  el("allowlist-toggle").disabled = false;
  el("rdap-lookup").disabled = false;

  const cookiesList = el("cookies-list");
  clear(cookiesList);
  const cookies = report.cookies;
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

  const permissionsList = el("permissions-list");
  clear(permissionsList);
  const permissionNames = Object.keys(report.permissions ?? {});
  const reportablePermissions = permissionNames.filter((name) => {
    const state = report.permissions[name];
    return state && state !== "unavailable";
  });
  if (reportablePermissions.length === 0) {
    permissionsList.textContent = "No usable permission data for this site.";
  } else {
    for (const name of reportablePermissions) {
      const state = report.permissions[name];
      const label = PERMISSION_STATE_LABELS[state] ?? "not given";
      permissionsList.append(listItem(`${name.charAt(0).toUpperCase()}${name.slice(1)}: ${label}`));
    }
  }
  el("permissions-alerts").textContent = report.permissionAlerts.length
    ? report.permissionAlerts.map((alert) => alert.message).join(" ")
    : "No unusual permission pattern detected. This is not a safety verdict.";
  const expectedButton = el("expected-toggle");
  expectedButton.textContent = report.expected ? "Mark site as not expected" : "Mark site as expected";
  expectedButton.dataset.expected = String(report.expected);

  el("domain-summary").textContent = report.domainInfo
    ? `Cached registry data for ${report.hostname}.`
    : "No registry data yet. Use the button to look this domain up.";
  const details = el("domain-details");
  clear(details);
  if (report.domainInfo && report.domainInfo.status === "ok") {
    const ageDays = Number(report.domainInfo.ageDays);
    for (const [key, value] of Object.entries({
      Registrar: report.domainInfo.registrar ?? "not reported",
      Registered: report.domainInfo.registrationDate ?? "not reported",
      Age: Number.isFinite(ageDays) ? `${ageDays} day${ageDays === 1 ? "" : "s"}` : "unknown",
      "Source": report.domainInfo.source ?? "unknown"
    })) {
      const wrapper = document.createElement("div");
      wrapper.append(text("dt", key), text("dd", value));
      details.append(wrapper);
    }
  }
  el("tls-note").textContent = report.suspicious.isHttps === null
    ? "HTTPS status is unavailable for this site."
    : "TLS certificate details are not available to browser extensions, so they are not shown here.";

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
    attribution.append(text("span", "Source: "), link);
  }
  renderSelfCheckLinks(breach);
}

const DEFAULT_SELF_CHECK_LINKS = [
  { label: "Have I Been Pwned", url: "https://haveibeenpwned.com" },
  { label: "Mozilla Monitor", url: "https://monitor.mozilla.org" },
  { label: "Google Password Checkup", url: "https://passwords.google.com/checkup" }
];

function renderSelfCheckLinks(breach) {
  const links = el("self-check-links");
  clear(links);
  for (const entry of breach?.selfCheckLinks ?? DEFAULT_SELF_CHECK_LINKS) {
    const link = document.createElement("a");
    link.href = entry.url;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = entry.label;
    const item = document.createElement("li");
    item.append(link);
    links.append(item);
  }
}

/** "All sites" mode: site-only panels say so instead of showing stale details. */
function resetSiteSections() {
  state.site = null;
  el("target-summary").textContent = "Showing all sites recorded in this browser.";

  el("cookies-status").textContent = "Select a site above to see its cookies.";
  clear(el("cookies-list"));

  const permissionsList = el("permissions-list");
  clear(permissionsList);
  permissionsList.textContent = "Select a site above to see its permissions.";
  el("permissions-alerts").textContent = "";
  const expectedButton = el("expected-toggle");
  expectedButton.disabled = true;
  expectedButton.textContent = "Mark site as expected";
  expectedButton.dataset.expected = "false";

  el("allowlist-status").textContent = "Select a site above to allowlist it.";
  el("allowlist-toggle").disabled = true;
  el("allowlist-toggle").textContent = "Allowlist this site";

  el("domain-summary").textContent = "Select a site above to look up its registry data.";
  clear(el("domain-details"));
  el("rdap-lookup").disabled = true;
  el("tls-note").textContent = "";

  el("risk-summary").textContent = "Select a site above to see its risk score.";
  clear(el("risk-reasons"));
  el("risk-disclaimer").textContent = "";

  el("breach-summary").textContent = "Select a site above to check it against breach data.";
  clear(el("breach-list"));
  clear(el("breach-attribution"));
  renderSelfCheckLinks(null);

  el("ads-status").textContent = `Blocking is ${state.overview?.blocking.enabled ? "on" : "off"} for this browser.`;
}

/** Applies the site picker to every panel, then re-renders the summary. */
async function applyScope() {
  if (state.target) await loadSite(state.target);
  else resetSiteSections();
  renderKpis();
  renderCharts();
  await loadBlockedForSite();
}

async function loadHistoryDay(date) {
  const result = await send({ type: "webguard.historyFor", date });
  const list = el("history-list");
  clear(list);
  if (!result || result.status !== "ok") {
    list.append(listItem(result?.reason ?? "History for that day is unavailable."));
    return;
  }
  el("history-retention").textContent = `Only the last ${dayLabel(state.overview?.history.retentionHours ?? 48)} of hostnames are kept.`;
  if (result.hosts.length === 0) {
    list.textContent = "No sites recorded for this day.";
    return;
  }
  for (const entry of result.hosts) list.append(listItem(`${entry.host} — ${entry.count} visit(s)`));
}

async function refresh() {
  try {
    const targets = await send({ type: "webguard.dashboardTargets" });
    fillTargetSelect(targets);
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
const navLinks = [...document.querySelectorAll("nav a")];
const navSections = navLinks
  .map((link) => document.querySelector(link.getAttribute("href")))
  .filter(Boolean);

// The last section whose top has passed under the sticky header is the one being
// read. Measuring on scroll is deterministic at load, unlike an observer that
// needs a threshold to be crossed.
function syncNav() {
  const offset = 160;
  let active = navSections[0];
  for (const section of navSections) {
    if (section.getBoundingClientRect().top <= offset) active = section;
  }
  for (const link of navLinks) {
    if (active && link.getAttribute("href") === `#${active.id}`) link.setAttribute("aria-current", "true");
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

el("history-date").addEventListener("change", async (event) => {
  await loadHistoryDay(event.target.value);
});

el("blocking-toggle").addEventListener("change", async (event) => {
  await send({ type: "webguard.updateSettings", patch: { blockingEnabled: event.target.checked } });
  await loadOverview();
  await applyScope();
});

el("history-paused").addEventListener("change", async (event) => {
  await send({ type: "webguard.updateSettings", patch: { historyPaused: event.target.checked } });
  await loadOverview();
});

el("retention-select").addEventListener("change", async (event) => {
  await send({ type: "webguard.updateSettings", patch: { historyRetentionHours: Number(event.target.value) } });
  await loadOverview();
});

el("expected-toggle").addEventListener("click", async (event) => {
  if (!state.target) return;
  const expected = event.target.dataset.expected !== "true";
  await send({ type: "webguard.setExpectedSite", hostname: state.target, expected });
  await loadSite(state.target);
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
  renderKpis();
  await loadBlockedForSite();
});

el("rdap-lookup").addEventListener("click", async () => {
  if (!state.target) return;
  el("domain-summary").textContent = "Looking this domain up…";
  const result = await send({ type: "webguard.lookupDomain", hostname: state.target });
  el("domain-summary").textContent = result.status === "ok"
    ? `Registry data for ${result.hostname} from ${result.source}.`
    : result.reason ?? "Domain information is unavailable.";
  await loadSite(state.target);
});

el("clear-history").addEventListener("click", async () => {
  await send({ type: "webguard.clearHistory" });
  el("settings-feedback").textContent = "History cleared.";
  await loadOverview();
  await applyScope();
});

el("clear-all").addEventListener("click", async () => {
  await send({ type: "webguard.clearAllData" });
  el("settings-feedback").textContent = "All WebGuard data cleared.";
  await loadOverview();
  await applyScope();
});

void refresh();

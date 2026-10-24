import { barChartModel, CHART_HEIGHT, CHART_WIDTH } from "./charts.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";
const state = { target: null, overview: null };

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

async function send(message) {
  return chrome.runtime.sendMessage(message);
}

function fillTargetSelect(targets) {
  const select = el("target-select");
  clear(select);
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
  if (!select.options.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No sites recorded yet";
    select.append(option);
  }
  state.target = select.value || null;
}

async function loadOverview() {
  const overview = await send({ type: "webguard.dashboardOverview" });
  state.overview = overview;

  const stats = el("overview-stats");
  clear(stats);
  stats.append(kpiCard("Blocked today", String(overview.blocking.today), "requests stopped"));
  stats.append(kpiCard("Sites recorded", String(overview.history.totalEvents), `last ${overview.history.retentionHours} h`));
  stats.append(kpiCard("Blocking", overview.blocking.enabled ? "On" : "Off", `${overview.blocking.allowlist.length} allowlisted`));
  stats.append(kpiCard("History", overview.history.paused ? "Paused" : "Recording", `${overview.history.retentionHours} h retention`));

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
  renderBarChart(
    el("chart-trackers"),
    overview.blocking.topHosts.slice(0, 7).map((entry) => ({ label: entry.host, value: entry.count })),
    "Top blocked hosts"
  );

  const dataList = el("data-status");
  clear(dataList);
  for (const entry of overview.data) dataList.append(listItem(entry.text));

  const settingsData = el("settings-data");
  clear(settingsData);
  for (const entry of overview.data) settingsData.append(listItem(entry.text));

  const topHosts = el("top-hosts");
  clear(topHosts);
  if (overview.blocking.topHosts.length === 0) topHosts.append(listItem("No blocked requests recorded yet."));
  for (const entry of overview.blocking.topHosts) topHosts.append(listItem(`${entry.host} — ${entry.count}`));

  const allowlistList = el("allowlist-list");
  clear(allowlistList);
  if (overview.blocking.allowlist.length === 0) allowlistList.append(listItem("No allowlisted sites."));
  for (const host of overview.blocking.allowlist) allowlistList.append(listItem(host));

  el("blocking-toggle").checked = overview.blocking.enabled;
  el("history-paused").checked = overview.history.paused;
  el("history-retention").textContent = `Only the last ${overview.history.retentionHours} hours of hostnames are kept, and older entries are pruned automatically.`;
  el("settings-retention-note").textContent = `Retention is ${overview.history.retentionHours} hours. Data older than that is deleted automatically.`;

  const retentionSelect = el("retention-select");
  clear(retentionSelect);
  for (const hours of [24, 48, 72, 96, 120, 144, 168]) {
    const option = document.createElement("option");
    option.value = String(hours);
    option.textContent = hours === 24 ? "1 day (24 hours)" : `${hours / 24} days (${hours} hours)`;
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

  if (state.target) await loadSite(state.target);
  if (dateSelect.value) await loadHistoryDay(dateSelect.value);
}

async function loadSite(hostname) {
  const report = await send({ type: "webguard.siteReport", hostname });
  if (!report || report.status !== "ok") {
    el("target-summary").textContent = report?.reason ?? "Site details are unavailable.";
    return;
  }
  el("target-summary").textContent = `${report.hostname}${report.suspicious.isHttps === false ? " (plain HTTP)" : ""}`;

  const cookiesList = el("cookies-list");
  clear(cookiesList);
  const cookies = report.cookies;
  if (!cookies || cookies.status === "unavailable") {
    el("cookies-status").textContent = "Cookie details are unavailable.";
  } else {
    const list = cookies.cookies ?? [];
    el("cookies-status").textContent = list.length === 0 ? "0 cookies found for this site." : `${list.length} cookie(s).`;
    for (const cookie of list) {
      cookiesList.append(listItem(`${cookie.name} — ${cookie.domain}; ${cookie.party}; expires: ${cookie.expiry}; Secure: ${cookie.secure}; HttpOnly: ${cookie.httpOnly}; SameSite: ${cookie.sameSite}`));
    }
  }

  const permissionsList = el("permissions-list");
  clear(permissionsList);
  for (const [name, value] of Object.entries(report.permissions ?? {})) permissionsList.append(listItem(`${name}: ${value}`));
  el("permissions-alerts").textContent = report.permissionAlerts.length
    ? report.permissionAlerts.map((alert) => alert.message).join(" ")
    : "No heuristic permission alert. This is not a safety verdict.";
  const expectedButton = el("expected-toggle");
  expectedButton.textContent = report.expected ? "Mark site as not expected" : "Mark site as expected";
  expectedButton.dataset.expected = String(report.expected);

  el("domain-summary").textContent = report.domainInfo
    ? `Cached registry data for ${report.hostname}.`
    : "No registry data yet. Use the button to look this domain up.";
  const details = el("domain-details");
  clear(details);
  if (report.domainInfo && report.domainInfo.status === "ok") {
    for (const [key, value] of Object.entries({
      Registrar: report.domainInfo.registrar ?? "not reported",
      Registered: report.domainInfo.registrationDate ?? "not reported",
      "Age (days)": report.domainInfo.ageDays ?? "unknown",
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
  } else if (breach.status === "not-found") {
    breachSummary.textContent = "This site was not found in the breach list. That is not proof it was never breached.";
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
  const links = el("self-check-links");
  clear(links);
  for (const entry of breach?.selfCheckLinks ?? [
    { label: "Have I Been Pwned", url: "https://haveibeenpwned.com" },
    { label: "Mozilla Monitor", url: "https://monitor.mozilla.org" },
    { label: "Google Password Checkup", url: "https://passwords.google.com/checkup" }
  ]) {
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

async function loadHistoryDay(date) {
  const result = await send({ type: "webguard.historyFor", date });
  const list = el("history-list");
  clear(list);
  if (!result || result.status !== "ok") {
    list.append(listItem(result?.reason ?? "History for that day is unavailable."));
    return;
  }
  el("history-retention").textContent = `Only the last ${state.overview?.history.retentionHours ?? 48} hours of hostnames are kept.`;
  if (result.hosts.length === 0) {
    list.append(listItem("No sites recorded for this day."));
    return;
  }
  for (const entry of result.hosts) list.append(listItem(`${entry.host} — ${entry.count} visit(s)`));
}

async function refresh() {
  try {
    const targets = await send({ type: "webguard.dashboardTargets" });
    fillTargetSelect(targets);
    await loadOverview();
    el("status").textContent = "Loaded.";
    el("status").className = "is-ready";
  } catch (error) {
    el("status").textContent = "Dashboard data is unavailable.";
    el("status").className = "is-error";
    console.error("WebGuard dashboard failed to load.", error);
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
  if (state.target) await loadSite(state.target);
});

el("refresh-site").addEventListener("click", () => refresh());

el("history-date").addEventListener("change", async (event) => {
  await loadHistoryDay(event.target.value);
});

el("blocking-toggle").addEventListener("change", async (event) => {
  await send({ type: "webguard.updateSettings", patch: { blockingEnabled: event.target.checked } });
  await loadOverview();
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
});

el("clear-all").addEventListener("click", async () => {
  await send({ type: "webguard.clearAllData" });
  el("settings-feedback").textContent = "All WebGuard data cleared.";
  await loadOverview();
});

void refresh();

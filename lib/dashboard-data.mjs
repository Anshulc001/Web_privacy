export const MAX_CHART_DAYS = 7;
export const STALE_DATA_DAYS = 7;

function dayKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function todayKey(now = Date.now()) {
  return dayKey(now);
}

/** Groups history events into per-day buckets inside the retention window. */
export function groupHistoryByDay(events, retentionHours, now = Date.now()) {
  const list = Array.isArray(events) ? events : [];
  const hours = Number.isInteger(retentionHours) && retentionHours > 0 ? retentionHours : 48;
  const cutoff = now - hours * 3_600_000;

  const buckets = new Map();
  for (const event of list) {
    if (!event || typeof event.hostname !== "string" || !Number.isFinite(event.timestamp)) continue;
    if (event.timestamp < cutoff || event.timestamp > now) continue;
    const date = dayKey(event.timestamp);
    if (!buckets.has(date)) buckets.set(date, { date, count: 0, hosts: new Map() });
    const bucket = buckets.get(date);
    bucket.count += 1;
    bucket.hosts.set(event.hostname, (bucket.hosts.get(event.hostname) ?? 0) + 1);
  }

  return [...buckets.values()]
    .map((bucket) => ({
      date: bucket.date,
      count: bucket.count,
      hosts: [...bucket.hosts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([host, count]) => ({ host, count }))
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Days the date picker may offer: only inside the retention window. */
export function selectableDays(retentionHours, now = Date.now()) {
  const hours = Number.isInteger(retentionHours) && retentionHours > 0 ? retentionHours : 48;
  const days = Math.max(1, Math.ceil(hours / 24));
  const result = [];
  for (let offset = 0; offset < days; offset += 1) result.push(dayKey(now - offset * 86_400_000));
  return result;
}

export function eventsForDay(events, date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  return (Array.isArray(events) ? events : []).filter((event) => Number.isFinite(event?.timestamp) && dayKey(event.timestamp) === date);
}

/** Daily blocked counts for the last week, oldest first, with empty days filled in. */
export function blockingSeries(counts, now = Date.now(), days = MAX_CHART_DAYS) {
  const dayCounts = counts && typeof counts === "object" ? counts.days ?? {} : {};
  const total = Number.isInteger(days) && days > 0 ? Math.min(days, 31) : MAX_CHART_DAYS;
  const series = [];
  for (let offset = total - 1; offset >= 0; offset -= 1) {
    const date = dayKey(now - offset * 86_400_000);
    const value = Number.isFinite(dayCounts[date]) ? dayCounts[date] : 0;
    series.push({ date, count: value });
  }
  return series;
}

/** Top blocked hosts sorted by count, bounded for display. */
export function topBlockedHosts(counts, limit = 10) {
  const hosts = counts && typeof counts === "object" ? counts.hosts ?? {} : {};
  const max = Number.isInteger(limit) && limit > 0 ? limit : 10;
  return Object.entries(hosts)
    .filter(([host, count]) => typeof host === "string" && Number.isFinite(count) && count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([host, count]) => ({ host, count }));
}

export function dataAgeDays(lastSyncIso, now = Date.now()) {
  if (typeof lastSyncIso !== "string") return null;
  const parsed = Date.parse(lastSyncIso);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((now - parsed) / 86_400_000));
}

/** Describes one data file for the Settings and Overview sections. */
export function describeData({ key, label, lastSync, buildDate, available }, now = Date.now()) {
  const ageDays = dataAgeDays(lastSync ?? buildDate, now);
  if (!available) {
    return { key, label, status: "unavailable", text: `${label}: unavailable.`, ageDays: null };
  }
  if (ageDays === null) {
    return { key, label, status: "unknown", text: `${label}: age unknown.`, ageDays: null };
  }
  if (ageDays > STALE_DATA_DAYS) {
    return { key, label, status: "outdated", text: `${label}: ${ageDays} days old (outdated).`, ageDays };
  }
  return { key, label, status: "fresh", text: `${label}: ${ageDays === 0 ? "updated today" : `${ageDays} day(s) old`}.`, ageDays };
}

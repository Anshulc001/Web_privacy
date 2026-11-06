/** Compact number for tight UI (1.2k, 55k), with the exact value kept elsewhere. */
export function formatCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) return "0";
  const whole = Math.round(count);
  if (whole < 1_000) return String(whole);
  // Round in tenths first: toFixed(1) turns 1450 into "1.4" because 1.45 is
  // stored slightly below the decimal value.
  if (whole < 9_950) return `${(Math.round(whole / 100) / 10).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(whole / 1_000)}k`;
}

/** Chrome clips a badge past four glyphs, so anything over 999 is shown as 999+. */
export function formatBadgeCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return "";
  return count > 999 ? "999+" : String(Math.round(count));
}

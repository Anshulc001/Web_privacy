import assert from "node:assert/strict";
import test from "node:test";
import { categorizeTrackerHost } from "../lib/tracker-categories.mjs";

test("labels ad networks as Ads", () => {
  for (const host of ["doubleclick.net", "ad.doubleclick.net", "securepubads.g.doubleclick.net", "criteo.net", "c.amazon-adsystem.com", "taboola.com"]) {
    assert.deepEqual(categorizeTrackerHost(host), { id: "ads", label: "Ads" }, host);
  }
});

test("labels measurement vendors as Analytics", () => {
  for (const host of ["google-analytics.com", "www.googletagmanager.com", "sb.scorecardresearch.com", "pixel.quantserve.com", "demdex.net"]) {
    assert.deepEqual(categorizeTrackerHost(host), { id: "analytics", label: "Analytics" }, host);
  }
});

test("labels session recorders as Session Replay", () => {
  for (const host of ["script.hotjar.com", "www.fullstory.com", "clarity.ms", "cdn.logrocket.io"]) {
    assert.deepEqual(categorizeTrackerHost(host), { id: "replay", label: "Session Replay" }, host);
  }
});

test("labels social widgets as Social", () => {
  for (const host of ["connect.facebook.net", "platform.twitter.com", "px.ads.linkedin.com", "www.tiktok.com"]) {
    assert.deepEqual(categorizeTrackerHost(host), { id: "social", label: "Social" }, host);
  }
});

test("uses the ad host prefixes even outside the known domains", () => {
  for (const host of ["ad.example-media.test", "ads.example-media.test", "adserver.news.test"]) {
    assert.deepEqual(categorizeTrackerHost(host), { id: "ads", label: "Ads" }, host);
  }
  assert.deepEqual(categorizeTrackerHost("metrics.example.test"), { id: "analytics", label: "Analytics" });
  assert.deepEqual(categorizeTrackerHost("telemetry.example.test"), { id: "analytics", label: "Analytics" });
});

test("does not treat a domain that merely contains a known name as a match", () => {
  // "notdoubleclick.net" and "criteo.net.example.test" are different sites.
  assert.deepEqual(categorizeTrackerHost("notdoubleclick.net"), { id: "tracker", label: "Tracker" });
  assert.deepEqual(categorizeTrackerHost("criteo.net.example.test"), { id: "tracker", label: "Tracker" });
});

test("falls back to a plain Tracker label for unknown or empty hosts", () => {
  for (const host of ["tracker.example.test", "", null, undefined, "  "]) {
    assert.deepEqual(categorizeTrackerHost(host), { id: "tracker", label: "Tracker" }, String(host));
  }
});

test("normalizes case, surrounding space and a trailing dot", () => {
  assert.deepEqual(categorizeTrackerHost("  WWW.GoogLeTagManager.COM. "), { id: "analytics", label: "Analytics" });
});

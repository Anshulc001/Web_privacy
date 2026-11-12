import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function read(relPath) {
  return readFileSync(join(ROOT, relPath), 'utf8');
}

function readJson(relPath) {
  return JSON.parse(read(relPath));
}

describe('WebGuard browser + extension checks', () => {
  it('bundled ad/tracker rules are valid and stay inside the static ruleset budget', () => {
    const rules = readJson('data/ad-tracker-rules.json');
    assert(Array.isArray(rules), 'rules should be an array');
    // Chrome guarantees 30,000 static rules; a larger ruleset can be rejected and
    // leave the extension blocking nothing at all.
    assert.ok(rules.length > 20_000, `expected a full ruleset, got ${rules.length}`);
    assert.ok(rules.length <= 30_000, `ruleset is over the 30,000 budget: ${rules.length}`);

    let hostRules = 0;
    let pathRules = 0;
    for (const rule of rules) {
      assert(typeof rule.id === 'number', 'rule.id must be a number');
      assert.strictEqual(rule.priority, 1, 'rule.priority must be 1');
      assert.strictEqual(rule.action?.type, 'block', 'rule.action.type must be block');
      assert(Array.isArray(rule.condition?.resourceTypes), 'condition.resourceTypes must be an array');
      const filter = rule.condition?.urlFilter ?? '';
      assert.ok(filter.startsWith('||'), 'urlFilter must be host-anchored');
      assert.ok(/^\|\|[a-z0-9.-]+(?:\^|\/)/i.test(filter), `unexpected urlFilter ${filter}`);
      if (filter.endsWith('^')) hostRules += 1;
      else pathRules += 1;
    }
    assert.ok(hostRules > 0, 'a host-anchored rule blocks the whole domain');
    assert.ok(pathRules > 0, 'a path-anchored rule blocks one path on an otherwise working site');
    // The same urlFilter may appear with different conditions (a third-party-only
    // block next to a first-party one); a fully repeated rule is what wastes a slot.
    const bodies = rules.map((rule) => JSON.stringify([
      rule.condition.urlFilter,
      rule.condition.resourceTypes,
      rule.condition.domainType,
      rule.condition.initiatorDomains,
      rule.condition.excludedInitiatorDomains,
    ]));
    assert.strictEqual(new Set(bodies).size, rules.length, 'a repeated rule wastes a rule slot');
  });

  it('manifest references the ad_tracker_rules ruleset and declares the CSP/permissions', () => {
    const manifest = readJson('manifest.json');
    assert.strictEqual(manifest.manifest_version, 3);
    assert.ok(Array.isArray(manifest.declarative_net_request?.rule_resources));
    const rr = manifest.declarative_net_request.rule_resources.find((r) => r.id === 'ad_tracker_rules');
    assert.ok(rr, 'manifest must declare the ad_tracker_rules ruleset');
    assert.strictEqual(rr.path, 'data/ad-tracker-rules.json');
    assert.strictEqual(rr.enabled, true);
    assert.ok(manifest.content_security_policy?.extension_pages?.includes("script-src 'self'"));
    assert.ok(manifest.content_security_policy?.extension_pages?.includes("object-src 'self'"));
    assert.ok(manifest.host_permissions.includes('<all_urls>'));
    assert.ok(manifest.permissions.includes('declarativeNetRequest'));
    assert.ok(manifest.permissions.includes('webRequest'));
    assert.ok(manifest.key, 'manifest should carry a stable extension key');
    assert.strictEqual(manifest.key.length, 392, 'key should be a 2048-bit RSA SPKI DER in base64');
    assert.ok(/^[A-Za-z0-9+\/]+$/.test(manifest.key), 'key should be valid base64 DER (no padding)');
  });

  it('popup HTML contains every expected element by id and has no inline scripts', () => {
    const html = read('popup/popup.html');
    const requiredIds = [
      'status', 'blocking-toggle', 'tab-count', 'see-blocked', 'blocked-panel', 'blocked-list',
      'allowlist-toggle', 'cookies-heading', 'cookie-total', 'cookie-unit', 'cookie-empty',
      'see-cookies', 'cookies-panel', 'cookie-summary', 'cookies',
      'permissions-heading', 'permissions', 'breach-heading', 'breach-chip', 'breach-card',
      'cookie-more', 'open-dashboard', 'strict-row', 'strict-toggle', 'strict-hint',
    ];
    for (const id of requiredIds) {
      assert.ok(new RegExp(`id=["']${id}["']`).test(html), `popup.html must contain element #${id}`);
    }
    // The redesign dropped the noisy lines and the expected-site button.
    for (const id of ['blocking-status', 'blocking-data', 'blocking-top-hosts', 'permission-alerts', 'expected-site']) {
      assert.ok(!new RegExp(`id=["']${id}["']`).test(html), `popup.html must not contain element #${id}`);
    }
    const moduleScriptTag = /<script[^>]*type=["']module["'][^>]*>[\s\S]*?<\/script>/i;
    assert.ok(moduleScriptTag.test(html), 'popup.html must load popup.js as a module');
    const withoutModule = html.replace(moduleScriptTag, '');
    assert.ok(!/<script[^>]*>[\s\S]*?<\/script>/i.test(withoutModule), 'popup.html must not contain inline script bodies');
  });

  it('popup.js parses without syntax errors', () => {
    execFileSync(process.execPath, ['--check', join(ROOT, 'popup', 'popup.js')], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  });

  it('popup.css is non-empty and looks like CSS', () => {
    const css = read('popup/popup.css');
    assert.ok(css.length > 0, 'popup.css should not be empty');
    assert.ok(/[{:;]/.test(css), 'popup.css should contain CSS declarations');
  });

  it('popup render sets text via textContent, never innerHTML, for site details', () => {
    const js = read('popup/popup.js');
    // Blocked hosts, cookies and permissions all come from page data, so they must
    // be written as text rather than parsed markup.
    assert.ok(/textContent\s*=/.test(js), 'popup should render via textContent');
    assert.ok(!/\.innerHTML\s*=/.test(js), 'popup should never write innerHTML from page data');
  });
});

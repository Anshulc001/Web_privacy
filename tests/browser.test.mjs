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
  it('bundled ad/tracker rules file is valid and contains 25000 rules', () => {
    const rules = readJson('data/ad-tracker-rules.json');
    assert(Array.isArray(rules), 'rules should be an array');
    assert.strictEqual(rules.length, 25000, 'should bundle 25000 host-level rules');

    for (const rule of rules) {
      assert(typeof rule.id === 'number', 'rule.id must be a number');
      assert.strictEqual(rule.priority, 1, 'rule.priority must be 1');
      assert.strictEqual(rule.action?.type, 'block', 'rule.action.type must be block');
      assert(Array.isArray(rule.condition?.resourceTypes), 'condition.resourceTypes must be an array');
      assert.ok(rule.condition?.urlFilter?.startsWith('||'), 'urlFilter must start with ||');
      assert.ok(rule.condition?.urlFilter?.endsWith('^'), 'urlFilter must end with ^');
    }
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
      'status', 'blocking-status', 'blocking-data', 'blocking-top-hosts',
      'blocking-toggle', 'allowlist-toggle',
      'cookies-heading', 'cookies',
      'permissions-heading', 'permissions', 'permission-alerts', 'expected-site',
      'open-dashboard',
    ];
    for (const id of requiredIds) {
      assert.ok(new RegExp(`id=["']${id}["']`).test(html), `popup.html must contain element #${id}`);
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

  it('popup render sets text via textContent, never innerHTML, for blocking summary lines', () => {
    const js = read('popup/popup.js');
    // The popup builds blocking-status, blocking-data and blocking-top-hosts text using
    // template literals assigned to element.textContent. Confirm no innerHTML writes exist.
    assert.ok(/textContent\s*=/.test(js), 'popup should render via textContent');
    assert.ok(!/\.innerHTML\s*=/.test(js), 'popup should never write innerHTML from page data');
  });
});

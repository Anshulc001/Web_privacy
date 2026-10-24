# WebGuard

A Chrome (Manifest V3) extension that gives you a privacy and security overview of the sites you
visit, blocks known ad and tracker hosts, and keeps a short local history with a dashboard.

Everything stays on your device. There is no account, no analytics and no telemetry.

---

## Quick start

See [INSTALL.md](INSTALL.md). Short version: open `chrome://extensions`, turn on **Developer mode**,
press **Load unpacked**, and pick this folder.

---

## What it does

| Area | What you get |
| --- | --- |
| **Cookies** | Every cookie for the current site: name, domain, expiry, Secure, HttpOnly, SameSite, and first- versus third-party. Cookie **values are never read, stored or displayed**. |
| **Permissions** | Camera, microphone, geolocation and notification states (granted / denied / prompt / unavailable), plus clearly-labelled heuristic alerts and a "mark as expected" control. |
| **Domain info** | Hostname and HTTPS status, plus registry data (registrar, registration date, "registered less than 30 days ago") fetched over RDAP **only when you press the button**. |
| **Ads & trackers** | 25,000 host-level blocking rules built from EasyList and EasyPrivacy, a global on/off switch, a per-site allowlist, blocked counts per tab and per day, and a top-blocked-hosts list. |
| **Suspicious** | One explainable 0–100 score from local URL checks, an offline phishing blocklist and the RDAP new-domain flag. Every point is listed with its reason. |
| **Breach & OSINT** | Offline matching against Have I Been Pwned breach data, with plain-language flags and links so you can check your own email. |
| **History** | Hostnames and timestamps only, kept for 48 hours by default (adjustable 1–7 days), with pause and clear controls. Incognito tabs are skipped. |
| **Dashboard** | A full-tab page with nine sections and SVG charts (sites per day, blocked per day, top trackers). No chart library. |

---

## Permissions and why each one is needed

| Permission | Why |
| --- | --- |
| `storage` | Keep settings, history, counters and downloaded blocklists locally. |
| `alarms` | Schedule the daily blocklist update and the hourly history cleanup. |
| `webNavigation` | Notice top-level navigations so history can record the hostname. |
| `scripting` | Inject the small content script that reads permission states and third-party hosts. |
| `activeTab` | Read details of the current tab when you open the popup. |
| `cookies` | List cookie metadata for a site. Values are never read. |
| `declarativeNetRequest` | Block requests to known ad and tracker hosts. |
| `webRequest` | Count blocked requests by observing `ERR_BLOCKED_BY_CLIENT`. It never modifies a request. |
| `<all_urls>` (host) | Required to inspect cookies and block trackers on any site you visit. |

Chrome will warn that the extension can "read and change all your data on all websites". In practice
WebGuard **does not** read page content, form data, passwords or cookie values. It reads cookie
metadata, counts blocked requests and reads permission states.

---

## Privacy

WebGuard makes exactly two kinds of network request:

1. **Daily blocklist downloads** from this project's public repository
   (`https://raw.githubusercontent.com/Anshulc001/Web_privacy/main/data/...`). These are plain file
   downloads; no personal data is sent.
2. **RDAP lookups**, and only when you press the lookup button. That sends the hostname to the
   official registry for its top-level domain.

There is no analytics, no telemetry, no remote logging and no account system. All history, settings
and cached data live in `chrome.storage.local` on your machine and can be deleted from
**Dashboard → Settings → Clear all WebGuard data**.

History stores **hostnames only** — never full URLs, query strings or fragments. Stored and displayed
URLs have credentials, query and fragment removed.

---

## Data, freshness and failure handling

Three data files are rebuilt daily by a GitHub Action:

| File | Source | Used for |
| --- | --- | --- |
| `data/ad-tracker-rules.json` | EasyList + EasyPrivacy | The static blocking ruleset |
| `data/breach-data.json` | Have I Been Pwned | Offline breach matching |
| `data/threat-list.json` | Phishing.Database | Offline phishing matching |

Breach entries that have an empty `Domain` field (54 of them when this data was built) are skipped,
because a breach with no domain cannot be mapped to a site you visit. Breach logos are never
referenced, so opening the dashboard never contacts Have I Been Pwned.

Each file carries a version, a build date and a SHA-256 checksum. Before use, the extension validates
the schema, the size limit and the checksum. If a download fails or the file is corrupt, the last
good copy is kept and the UI shows **outdated** or **unavailable** — blocking continues with the
bundled rules. A first copy of every file ships inside the package so the extension works offline on
first install; friends who install the ZIP never need to touch GitHub or run a build script.

---

## Attribution

Ad and tracker blocking rules derived from **EasyList** and **EasyPrivacy**, © The EasyList Authors
(https://easylist.to/), licensed under CC BY-SA 3.0 / GPL v3.

Phishing domain data from **Phishing.Database**
(https://github.com/mitchellkrogza/Phishing.Database), © 2018-2025 Mitchell Krog, Nissar Chababy, and
contributors, licensed under MIT.

Breach data source: **Have I Been Pwned** by Troy Hunt (https://haveibeenpwned.com), licensed under
CC BY 4.0.

---

## Known limitations

These are real and are not going to be fixed by configuration:

1. **YouTube video ads cannot be blocked.** They are served from the same domain as the video itself,
   so blocking them needs cosmetic filtering with far broader access. WebGuard deliberately does not
   do that. Use AdGuard or uBlock Origin alongside WebGuard if YouTube ads matter to you.
2. **Blocking is domain-level only.** There is no cosmetic filtering, so ad placeholders and empty
   boxes can still appear.
3. **Blocklists only catch known threats.** A brand-new phishing site will not be listed until the
   lists update, which is usually a day or two.
4. **A breach match means the site was breached, not that your account was leaked.** Use the provided
   checkers to test your own email; WebGuard never asks for it.
5. **No real-time threat intelligence.** Matching is entirely offline against the downloaded lists.
6. **A site can never be declared safe.** "Not found in the list" only means it was not found — it is
   not a verdict.
7. **The GitHub Action can auto-disable** after 60 days without repository activity. See
   `keepalive.yml` below.

---

## Development

```bash
npm install          # Playwright, used only by the browser tests
npm test             # node --test: unit, integration and live browser tests
npm run build:data   # rebuild all three data files (needs network)
npm run package      # build dist/webguard-<version>.zip
```

Layout:

```
manifest.json
background/   service-worker.js (wiring only), history-store, blocking-manager,
              blocking-counter, data-sync, alarms, permission-auditor, messages,
              dashboard-service
content/      content-script.js (third-party hosts + permission states)
lib/          url-checks, risk-score, cookie-inspector, domain-info,
              breach-checker, threat-checker, host-match, sanitize,
              storage-settings, data-integrity, dashboard-data
popup/        popup.html / css / js
dashboard/    dashboard.html / css / js, charts.mjs
data/         bundled + downloaded data files
tools/        build-ad-rules, build-breach-data, build-threat-list, package-extension
tests/        *.test.mjs (node --test)
.github/workflows/  update-data.yml, keepalive.yml
```

The tests include **live Chrome tests** that load the unpacked extension, verify that tracker hosts
really fail with `ERR_BLOCKED_BY_CLIENT`, and open the real dashboard and popup pages.

### Development MCP servers (optional, dev only)

Three MCP servers are available for working on this project. They are **not** part of the extension
and are never packaged:

| Server | Install | Used for |
| --- | --- | --- |
| Context7 | `npm install` (`@upstash/context7-mcp`) | Up-to-date Chrome extension and library documentation |
| Playwright | `npm install` (`@playwright/mcp`) | Driving a browser while developing |
| Code review graph | `pip install code-review-graph` | Structural review context and blast radius for a change |

Run `npm run mcp:check` to start each server, list its tools and make one real tool call. The script
reports PASS, BLOCKED or FAIL per server, and SKIPPED when an optional server is not installed.

The code review graph is [tirth8205/code-review-graph](https://github.com/tirth8205/code-review-graph),
a local Python server that parses the repository with Tree-sitter and answers review questions from
a SQLite graph instead of re-reading the codebase. Build the graph once before using it:

```bash
pip install code-review-graph
code-review-graph build        # writes .code-review-graph/graph.db, which is gitignored
npm run mcp:check              # reports the graph statistics it reads back
```

Nothing in it calls a model or leaves the machine, and no API key is involved.

The extension ID is fixed by the `key` in `manifest.json`, so it stays
`mkemflphgmnjjdebbcgioplolpgeclii` across reloads and re-packs. The matching private key
(`extension-key.pem`) is gitignored and never committed.

---

## Keeping the data pipeline alive

GitHub disables scheduled workflows in public repositories after 60 days without activity.
`.github/workflows/keepalive.yml` commits a timestamp once a month to prevent that. If the workflow
shows as disabled, open **Actions → Keepalive → Enable workflow** and run it once manually.

---

## License

MIT. See [LICENSE](LICENSE).

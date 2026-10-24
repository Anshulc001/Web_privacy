# Installing WebGuard

WebGuard is not on the Chrome Web Store. You install it from a folder or a ZIP file, which Chrome
calls "Load unpacked". This takes about a minute.

---

## Option A — install with Load unpacked (recommended for development)

1. Download or clone this repository, or unzip `webguard-<version>.zip` somewhere permanent.
   Do not put it in a temporary folder or Downloads that you might clean out, because Chrome reads
   the files from that exact location every time it starts.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Press **Load unpacked**.
5. Select the folder that contains `manifest.json` — that is the project root, not `dist`.
6. WebGuard appears in the list with the ID `mkemflphgmnjjdebbcgioplolpgeclii`.
7. Pin it: click the puzzle-piece icon in the toolbar and press the pin next to WebGuard.

---

## Option B — install the ZIP for friends

1. Send `dist/webguard-<version>.zip`.
2. Your friend unzips it to a permanent folder.
3. They follow the same steps 2–7 above, selecting the unzipped folder.

The extension ID is fixed by the `key` in `manifest.json`, so everyone who installs the same build
gets the same ID. That keeps settings and history stable across reloads.

---

## First run

1. Open any normal website, for example `https://example.com`.
2. Click the WebGuard icon in the toolbar.
3. The popup shows the site name, the blocked count for that tab and for today, the age of the
   blocklist data, and a short list of blocked hosts.
4. Press **Open Dashboard** to see all sections, charts and settings.

---

## What to expect on first install

- **Blocklist data** may read "updated today" or "unavailable" for a moment. A first copy ships
  inside the package, so blocking works immediately even with no network.
- **Breach data** is seeded from the bundled file and then refreshed daily.
- **Domain info** stays empty until you press **Look up RDAP**. That is intentional: the lookup sends
  the hostname to the registry, so it only happens when you ask.
- **History** starts empty and fills as you browse. It keeps 48 hours by default.

---

## Updating

- **Load unpacked:** replace the files in the same folder, then press the reload arrow on the
  WebGuard card in `chrome://extensions`.
- **ZIP:** unzip the new build over the old folder and press reload. Because the ID is fixed, your
  settings and history survive.

The three data files (rules, breach, phishing) refresh on their own once a day; you do not need to
reinstall for those.

---

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| "Manifest file is missing or unreadable" | You selected a parent folder. Select the folder that directly contains `manifest.json`. |
| The extension disappeared after restarting Chrome | The folder moved or was deleted. Put it somewhere permanent and load it again. |
| Nothing is blocked | Open the popup and check that blocking is on for this browser, and that the site is not on your allowlist. |
| "Blocklist data: outdated" | A download failed. Blocking still works with the last good list. It retries daily. |
| "Current-site privacy details are unavailable" | You are on a non-web page (`chrome://`, the New Tab page, or the extension's own pages). Open a normal website. |
| Domain info says "unavailable" | The registry refused or timed out, or the TLD publishes no RDAP service. It is never shown as "safe". |
| Console shows errors | Open `chrome://extensions`, press **service worker** under WebGuard to inspect it, and check the popup with right-click → **Inspect**. |

---

## Uninstalling

`chrome://extensions` → WebGuard → **Remove**. To delete stored data first, use
**Dashboard → Settings → Clear all WebGuard data**.

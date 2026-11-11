/**
 * Runs in the page's own world at document_start, before the site's scripts.
 *
 * Its only job is to name the permissions a site actually asks for, because
 * the Permissions API cannot be enumerated: `navigator.permissions.query()`
 * needs a name up front, and Chrome reports "prompt" for every name a site has
 * never mentioned. Wrapping the requesting APIs is the only honest way to learn
 * the real set, so the dashboard can show those rows instead of a fixed four.
 *
 * Nothing here reads page content or arguments beyond deciding video vs audio,
 * and every wrapper reports and then calls straight through, so a failing
 * wrapper can never change what the site sees.
 */
(() => {
  const reported = new Set();

  function report(names) {
    const fresh = (Array.isArray(names) ? names : [names])
      .filter((name) => typeof name === "string" && name && !reported.has(name));
    if (fresh.length === 0) return;
    for (const name of fresh) reported.add(name);
    try {
      window.postMessage({ __webguard: "permissionRequest", names: fresh }, "*");
    } catch {
      // A page that cannot post messages simply goes unobserved.
    }
  }

  /** Wraps one method so the request is reported, then behaves normally. */
  function wrap(owner, key, mapper) {
    try {
      const original = owner && owner[key];
      if (typeof original !== "function") return;
      const wrapped = function (...args) {
        try {
          report(mapper(args, this));
        } catch {
          // Reporting must never break the call itself.
        }
        return original.apply(this, args);
      };
      Object.defineProperty(owner, key, {
        ...(Object.getOwnPropertyDescriptor(owner, key) ?? {}),
        value: wrapped,
        configurable: true
      });
    } catch {
      // A frozen or missing API is skipped, not fatal.
    }
  }

  function streamNames(constraints) {
    const names = [];
    if (constraints && constraints.video) names.push("camera");
    if (constraints && constraints.audio) names.push("microphone");
    return names;
  }

  wrap(typeof Notification === "undefined" ? null : Notification, "requestPermission", () => ["notifications"]);
  wrap(navigator.mediaDevices, "getUserMedia", (args) => streamNames(args[0]));
  wrap(navigator.mediaDevices, "getDisplayMedia", () => ["display-capture"]);
  wrap(navigator.geolocation, "getCurrentPosition", () => ["geolocation"]);
  wrap(navigator.geolocation, "watchPosition", () => ["geolocation"]);
  wrap(navigator.permissions, "query", (args) => [args[0] && args[0].name]);
  wrap(navigator.clipboard, "read", () => ["clipboard-read"]);
  wrap(navigator.clipboard, "readText", () => ["clipboard-read"]);
  wrap(navigator.clipboard, "write", () => ["clipboard-write"]);
  wrap(navigator.clipboard, "writeText", () => ["clipboard-write"]);
  wrap(navigator, "requestMIDIAccess", () => ["midi"]);
  wrap(navigator.wakeLock, "request", () => ["screen-wake-lock"]);
  wrap(navigator.storage, "persist", () => ["persistent-storage"]);
  wrap(navigator, "getScreenDetails", () => ["window-management"]);
  wrap(navigator.fonts, "query", () => ["local-fonts"]);
  wrap(navigator.idle, "query", () => ["idle-detection"]);
  wrap(document, "requestStorageAccess", () => ["storage-access"]);
  wrap(Element.prototype, "requestPointerLock", () => ["pointer-lock"]);
  // Chrome keeps its own fullscreen and popup settings per site, and both are
  // requested through APIs rather than the Permissions API.
  wrap(Element.prototype, "requestFullscreen", () => ["fullscreen"]);
  wrap(Element.prototype, "webkitRequestFullscreen", () => ["fullscreen"]);
  wrap(window, "open", () => ["popups"]);

  // Constructors cannot be shadowed with a plain function without changing
  // instanceof behaviour, so they are reported through a construct trap.
  for (const [globalName, permissionName] of [
    ["Accelerometer", "accelerometer"],
    ["Gyroscope", "gyroscope"],
    ["Magnetometer", "magnetometer"],
    ["PaymentRequest", "payment-handler"]
  ]) {
    try {
      const Original = window[globalName];
      if (typeof Original !== "function") continue;
      window[globalName] = new Proxy(Original, {
        construct(target, args, newTarget) {
          try {
            report([permissionName]);
          } catch {
            // Ignore and construct normally.
          }
          return Reflect.construct(target, args, newTarget);
        }
      });
    } catch {
      // Leave the constructor alone when it cannot be proxied.
    }
  }
})();

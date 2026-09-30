# IRMS-Modules

First-party runtime modules for the [IRMS app](https://github.com/yuhina0515/IRMS). A module
can be updated without shipping a new app build. Only pure front-end logic can be a module:
BLE, database, OTA and app updates are compiled into the app and can never be loaded this
way (IRMS 2026-09-11 ruling; third-party modules are out of scope).

## How a module reaches the app

1. Edit `modules/<id>/index.js` and bump `version` in `modules/<id>/module.json`.
2. Push a tag `vYYYY.MM.DD` (or any `v*`). `release.yml` builds `dist/`: one
   `<id>-<version>.js` per module and `index.json` (id, version, name, file, size, SHA-256,
   optional `minAppVersion`), signed with Ed25519 (`MODULES_SIGNING_KEY` secret).
3. The IRMS app (1.2.0-beta.13+) fetches `releases/latest`, verifies `index.json.sig` with
   its compiled-in public key, downloads each module, checks its SHA-256, stores it under the
   app data `modules/` folder and imports it through Tauri's `asset:` protocol (scoped to that
   folder only; no `unsafe-eval`, no blob URLs). Stored files are re-hashed before every load.
   Users can disable any module in Settings.

## Module contract

```js
export default {
  activate(ctx) {
    ctx.appVersion        // string
    ctx.registerTip(text) // show a short tip in Settings → Modules
    ctx.log(message)      // app log (also telemetry when the user enabled it)
  }
}
```

A module must not `import` anything (the build rejects it); everything it can touch comes
through `ctx`. New capabilities are added to `ctx` by an app release, never by a module.

## Keys

Private key: `IRMS_secrets/irms_modules_ed25519.pem` and the `MODULES_SIGNING_KEY` secret.
Public key (raw, base64): `rmTFnYTSMzLCrqDW0Hv3e6gKKXFODYhxd1zkvmWceG0=` — embedded in
`IRMS_App_Tauri/src-tauri/src/modules.rs`.

## Local check

`node scripts/build-index.mjs --no-sign` validates ids, versions and the no-import rule.

## Panels and live share (App 1.2.0-beta.16+)

Additive to API v2 (`ctx.apiVersion` stays `2`; check for the fields instead):

- `ctx.registerPanel({ mount(el) { ...; return cleanup } })` — any module may register one
  panel, rendered on the app's Tools page (Settings → Modules only manages: enable, check for updates, open the tool). Modules cannot import React, so they get
  an empty DOM element and may use the app's CSS classes. Always use `textContent`/DOM nodes for
  text that came from the network.
- `ctx.liveShare` — only for the `live-share` module (undefined for every other id):
  `snapshot()`, `subscribe(fn) → unsubscribe` (≤ 5 Hz), `telemetry() → { enabled, runId,
  endpoint }`, `request({ method, path, token?, body?, timeoutMs? }) → { status, body }` (native
  bridge limited to the collector's `/v1/share` API) and `applyParams(params) → { ok, error? }`
  (the app clamps values and refuses while a session is running). The snapshot carries no action
  name or other user-typed text.

`live-share` 1.0.0 uses this to share a telemetry-uploading device by code. The server side is
`IRMS_Telemetry/share.mjs` in the IRMS repo (API documented in its README).

## License

Source-available; see [LICENSE](LICENSE). No patent license is granted; all patent rights are reserved by IRMS Team.

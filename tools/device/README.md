# ldev — Android debug-device CLI

Single-agent, standalone developer tooling for the LoopDeck3 **debug** build on one physical
Android phone. It is not a device broker, lease system, or multi-user arbiter.

```
npm run device -- <command> [options]      # or: node scripts/ldev.mjs <command> ...
```

`scripts/ldev.mjs` compiles `tools/device/*.ts` with the repository's TypeScript into
`qa-results/device-cli/<content-key>/` (ignored) and imports it. Each distinct source state gets
its own directory, published by atomic rename; an existing build is never replaced or deleted
while another invocation might be loading it (stale directories older than a day are pruned, with
every removal path validated to be inside that root). Type checking and tests run in
`npm run lint` / `npm run typecheck` (`tsconfig.device.json`) and `npm test` (`tests/device*.test.ts`).

Fixed targets: package `com.loopdeck3.app.debug`, component
`com.loopdeck3.app.debug/com.loopdeck3.app.MainActivity`, page
`https://appassets.androidplatform.net/assets/loopdeck/index.html`, IndexedDB `loopdeck3-learning`.
Release builds are never touched.

## Commands

Every command prints exactly one JSON envelope on stdout
(`{ok, command, exitCode, data | error{code,message,details}}`) and one human line on stderr.
Options are parsed strictly with `util.parseArgs`; unknown or misplaced options are usage errors
(exit 2) raised before any process is started.

| Command                                                                                                     | Purpose                                                                                                          |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `devices`                                                                                                   | adb transport discovery only.                                                                                    |
| `prepare --serial S [--launch] [--session DIR]`                                                             | Pin the physical `ro.serialno`, record original `accelerometer_rotation`/`user_rotation`, write a DIRTY session. |
| `attach`                                                                                                    | Capability probe: forward, CDP connect, read viewport, disconnect.                                               |
| `inspect [--dom] [--ui] [--compact] [--diff]`                                                               | DOM / Android UI listing (stdout contains device text).                                                          |
| `state`                                                                                                     | Read-only IndexedDB record count + canonical SHA-256.                                                            |
| `tap (--role R --name N \| --locator CSS) [--native]`                                                       | Playwright `getByRole(exact)` or CSS; DOM click, or ADB tap via mapped coordinates.                              |
| `swipe (--role/--name \| --locator) --direction up\|down\|left\|right [--distance CSSPX] [--duration-ms N]` | Native swipe clipped inside the visible target.                                                                  |
| `picker inspect` / `picker select (--text T \| --resource-id ID)`                                           | Android DocumentsUI only; exact match, exactly one element.                                                      |
| `key KEY`                                                                                                   | Allowlist: BACK ENTER TAB ESCAPE DPAD_* PAGE_UP PAGE_DOWN.                                                       |
| `lifecycle background\|resume\|relaunch`                                                                    | Debug package only; relaunch = `am force-stop` + start + UI-ready wait.                                          |
| `rotate portrait\|landscape`                                                                                | Records intent first; `finish` restores originals.                                                               |
| `expect (--text EXACT \| --locator CSS) [--timeout-ms N]`                                                   | Bounded polling; exit 1 if not met.                                                                              |
| `collect LABEL [--compare-to PATH [--expect-same]]`                                                         | Evidence under `<session>/artifacts/LABEL`.                                                                      |
| `compare A B`                                                                                               | Offline state comparison of two summaries (count + digest).                                                      |
| `artifacts --apk F --html F`                                                                                | Offline: does the APK embed exactly this HTML (bytes, SHA-256)? Mismatch exits 1.                                |
| `finish [--accept-unowned-forward]`                                                                         | Restore, verify, remove owned forwards; stays DIRTY on any failure.                                              |

There is deliberately **no** raw `adb`/shell passthrough, no install, uninstall, `pm clear`,
root, or adb-server restart.

Exit codes: 0 ok · 1 check failed (expectation, differing state, APK/HTML mismatch) · 2 usage ·
3 refused (session/lock/identity/unsafe) · 4 device/adb/UI/WebView/timeout/cleanup failure ·
5 incomplete evidence · 70 internal.

## `run` — scenarios with a verdict

```
npm run device -- run <scenario.json> --serial <S> [--out DIR]     # serial falls back to $LDEV_SERIAL
```

One process prepares its own session (inside the run directory), launches the debug app, holds
**one** CDP connection for the whole run, executes the steps, records JS errors (`pageerror`,
`console.error`, renderer crash), new error entries of `loopdeck3.diagnostics` and the startup
error screen after every step, judges the run, captures failure evidence over the same
connection, then finishes the session (rotation restored, the forward removed, CLEAN).
`run` refuses while the default CLI session (`qa-results/android`) is DIRTY.

Scenario (JSON, unknown keys rejected, errors name the path such as `steps[3].target`):

```json
{
  "schema": 1,
  "id": "launch-home",
  "title": "...",
  "allowConsoleErrors": [{ "pattern": "regex", "reason": "why this is expected" }],
  "steps": [{ "do": "launch" }, { "check": "expectVisible", "target": { "css": ".home-screen" } }]
}
```

- Steps (`do`): `launch`, `navigate {route:"#…"}`, `tap {target, native?}`, `swipe {target, direction, distance?, durationMs?}`,
  `type {target, text}`, `key {key}`, `rotate {to}`, `lifecycle {action: background|resume|relaunch}`, `wait {ms 1..30000}`,
  `snapshotState {label}`, `injectError {message}` (makes the scenario `testClass: harness`).
- Checks (`check`): `expectVisible {target | text, timeoutMs?}`, `expectNoErrorScreen`, `expectStateSame {a, b}` (`b` may be `"now"`).
- `target` is `{role, name}` (exact accessible name) or `{css}`.

Verdict: **FAIL** (a check failed, or an anomaly not allowed by `allowConsoleErrors`) › **ERROR**
(steps could not be run to the end) › **INCONCLUSIVE** (no passing check, a check not evaluated,
an observation channel `unavailable`/`interrupted`, incomplete state) › **PASS**. The first FAIL or
infrastructure error stops the run; remaining checks are `NOT_EVALUATED`.

Exit codes: PASS 0 · FAIL 1 · ERROR 4 · INCONCLUSIVE 5 (usage problems 2).

Evidence lives outside the repository under `$LDEV_HOME/runs/<YYYYMMDD-HHMMSS>-<id>/`
(`LDEV_HOME`, else `%LOCALAPPDATA%/LoopDeck3/ldev`, else `~/.loopdeck3-ldev`):
`scenario.json`, `events.ndjson` (raw events, may contain device text), `summary.json`
(kinds and counts only, safe to quote), `session/`, and on non-PASS `failure/`
(`screenshot.png`, `dom.json`, `state.json`, `diagnostics.json`, `logcat.txt`, `capture.json`).

## Sessions, locking, recovery

- `--session DIR` (default `qa-results/android`) holds `session.json`, `session.lock`,
  `artifacts/`. `prepare` refuses while a DIRTY session exists. Writes are atomic
  (temp + fsync + rename) and every mutation intent is persisted **before** it runs.
- The session stays **DIRTY** until `finish` has restored and re-read the original rotation values
  (deleting a setting that was originally unset), removed the forwards the session owns, and
  verified both. Any failure keeps it DIRTY with the reason in `notes`.
- The physical `ro.serialno` is re-checked before every device operation; a transport that starts
  answering for a different phone is refused.
- An exclusive host lock serializes ldev invocations on one session directory. It is **never
  stolen**: after a killed process, confirm it is gone and delete `session.lock` yourself. The
  lock is local to this checkout/directory; it does not arbitrate the phone against other tools.
- WebView attach is per command: single app PID, `/proc/net/unix` listener named for exactly that
  PID, `adb forward tcp:0`, ownership persisted **before** CDP connect, exactly one page at the app
  origin/path, disconnect (never closes the app), forward removed only after confirming it is still
  the same mapping. If allocation fails or is interrupted, a pending marker is retained and nothing
  is guessed or adopted; `finish` refuses to proceed past a matching foreign forward unless you pass
  `--accept-unowned-forward` (which leaves it untouched).

## Native input

`tap --native` and `swipe` map the DOM element to screen pixels using the Android UI WebView bounds
and the DOM visual viewport. They require the app to be the foreground window, exactly one app
WebView, scale 1, `bounds == viewport × devicePixelRatio` within rounding, matching orientation,
and an `elementFromPoint` hit on the target. Anything ambiguous (zoom, inset that does not add up,
split screen, covered element) is refused. UI hierarchy is read with `uiautomator dump` into a
private `/data/local/tmp/ldev-ui-*.xml` (the `/dev/tty` form emits no XML on the moto g13), read
back and removed; a null root is retried a bounded number of times.

## Evidence and state

`collect` writes raw screenshot/UI XML/DOM/log files to ignored `qa-results/android/artifacts/LABEL`
and a `summary.json` with only statuses, counts, hashes, package/revision. Capture failures are
explicit; any failure yields `INCOMPLETE` (exit 5), never PASS. State capture lists databases
(requires exactly one existing `loopdeck3-learning`, aborts any `upgradeneeded` so nothing is
created), reads **all stores in one readonly transaction** (records, then hashes after it
completes), encodes keys and values with type tags/length prefixes/sorted keys/content digests for
binary data, and fails closed on unsupported values or when a record/byte bound is reached
(including when the last record is what exceeds it). Comparison uses record count and canonical
digest only; an incomplete or missing side is `incomplete`, never `same`.

## Scripts

`tools/device/fixture.ts` exports `withDeviceSession({ serial }, async (api) => …)`: prepare, run a
finite script with typed `tap/swipe/expectVisible/rotate/lifecycle/collect/webView`, then `finish`
in `finally`. If the process is killed the DIRTY record remains for `ldev finish`.

## Not implemented / limits

- No APK install or signature verification. `artifacts` checks an APK file against an HTML file
  offline; it does **not** prove what is installed on the phone.
- No release-build coverage (release has no debuggable WebView).
- Page `role`/`name` listing in `inspect` is an approximation for reading; actions use Playwright.
- Foreground detection is from the active window's UI dump, not `dumpsys`.
- Physical identity is re-checked before each operation, but a swap between check and command is
  not excluded.
- Physical acceptance on moto g13 / Android 14 is recorded in `docs/android-device-tool.md`.
  Full native file import/save and release-build QA remain separate checks.

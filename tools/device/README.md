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
| `lifecycle background\|resume\|relaunch\|kill`                                                              | Debug package only; relaunch = `am force-stop` + start + UI-ready wait; kill = force-stop only.                  |
| `rotate portrait\|landscape`                                                                                | Records intent first; `finish` restores originals.                                                               |
| `expect (--text EXACT \| --locator CSS) [--timeout-ms N]`                                                   | Bounded polling; exit 1 if not met.                                                                              |
| `collect LABEL [--compare-to PATH [--expect-same]]`                                                         | Evidence under `<session>/artifacts/LABEL`.                                                                      |
| `compare A B`                                                                                               | Offline state comparison of two summaries (count + digest).                                                      |
| `diff RUN:LABEL RUN:LABEL [--ignore-local-storage K,P*] [--expect-same]`                                     | Offline record-level IndexedDB + localStorage diff of two saved snapshots (see "State deltas").               |
| `artifacts --apk F --html F`                                                                                | Offline: does the APK embed exactly this HTML (bytes, SHA-256)? Mismatch exits 1.                                |
| `install --apk F [--replace-incompatible]`                                                                  | `adb install -r` of a debug APK (see "Managing the app").                                                        |
| `reset`                                                                                                     | `pm clear` the debug app, relaunch, verify no learner data remains.                                              |
| `setting uimode yes\|no\|auto` / `setting font-scale 0.5..2.0`                                              | Change dark mode / text size; the original is recorded first and `finish` restores it.                           |
| `shell -- <command> [args...]`                                                                              | One command on the pinned phone through an argv allowlist; journaled (see "Managing the app").                   |
| `lifecycle kill`                                                                                            | `am force-stop` the debug app and confirm by pid; does not start it again.                                       |
| `finish [--accept-unowned-forward]`                                                                         | Restore, verify, remove owned forwards; stays DIRTY on any failure.                                              |

`install`, `reset`, `setting`, `shell` and `lifecycle` accept `--serial S` (or `$LDEV_SERIAL`). With an
active session the serial must be that session's device (anything else is refused before a byte is
sent); with none, they pin the phone exactly like `prepare` (DIRTY until `finish`). A serial is never
guessed from `adb devices`. There is no root, no adb-server restart, and no host-level `adb`
passthrough.

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
  `type {target, text}`, `key {key}`, `rotate {to}`, `lifecycle {action: background|resume|relaunch|kill}`, `wait {ms 1..30000}`,
  `snapshotState {label}`, `injectError {message}` (makes the scenario `testClass: harness`),
  `reset`, `setting {key: "uimode"|"font-scale", value}`, `installApk {file, replaceIncompatible?}`.
- Checks (`check`): `expectVisible {target | text, timeoutMs?}`, `expectNoErrorScreen`, `expectStateSame {a, b}` (`b` may be `"now"`),
  `expectStateDelta {a, b, counts?, updated?, otherStores?, localStorage?, ignoreLocalStorage?}` (see "State deltas").
- `target` is `{role, name}` (exact accessible name) or `{css}`.

`reset`, `installApk` and `lifecycle kill` end the app process on purpose, so the WebView connection is dropped
first and the logcat channel is told the death is expected. `reset` relaunches the app, reconnects, and
verifies the fresh state (a failure is an ERROR and the later checks stay `NOT_EVALUATED`); diagnostics
read after it are all treated as new, even when their ids repeat old ones. `setting` reconnects if a page
was attached. `installApk` does not start the app and `kill` does not either: add a `launch` step before
anything that needs the page. `file` is relative to the working directory; every `installApk` file is checked
(ZIP, package name, debuggable) before the phone is touched, and `finish` restores any `setting` at the end
(a failed restore turns the run into ERROR).

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

### Android log channel (`logcat`)

For the whole run `run` keeps one `adb -s <S> logcat -v epoch,uid -b main,system,crash,events -T <device now>`
stream (started before the app is touched, stopped in `finally`, and killed on Ctrl+C / SIGTERM so no
child is left behind). It is **not** `--pid`-filtered: the process may die and come back with another
pid, and the lines around its death are the evidence. A line is the app's when its uid is the app's, its
pid was ever seen as the app's (old pids are kept), or it names the package. Package names are compared
exactly, so other apps' crashes (and look-alike packages) never count.

| Seen in the stream                                                                          | Anomaly                 |
| ------------------------------------------------------------------------------------------- | ----------------------- |
| `FATAL EXCEPTION` whose process is the app                                                  | `androidFatalException` |
| `am_crash` for the app (also native crashes)                                                | `androidCrash`          |
| `am_anr` for the app                                                                        | `androidAnr`            |
| `am_proc_died` for the app that no crash/ANR explains and no `lifecycle relaunch` asked for | `androidProcessDied`    |

Channel `logcat` in `summary.json` carries `status`, a fixed-text `detail` and counts
(`lines`, `appLines`, `writtenLines`, `droppedLines`, `pidsSeen`); never log text. Cannot start or ends
before any output → `unavailable`; ends mid-run or the 8 MiB raw-log cap is hit → `interrupted`; both make the run
INCONCLUSIVE (a FAIL still wins). A healthy but quiet stream is not a failure. Raw lines are in
`logcat-stream.log`, warnings/errors and every detected event in `events.ndjson` (`src: "logcat"`, with
`hostMs` arrival time and the device time).

## Managing the app

`install --apk F [--replace-incompatible]`: before anything is sent to the phone the APK must exist, be a
ZIP with an `AndroidManifest.xml`, be debuggable, and `aapt2 dump badging` must name exactly
`com.loopdeck3.app.debug` (the release package and everything else are refused). `aapt2` is found through
`LDEV_AAPT2`, then `ANDROID_HOME` / `ANDROID_SDK_ROOT` / `%LOCALAPPDATA%/Android/Sdk` (newest build-tools); if none
is found `install` stops with an error instead of skipping the check. It then runs `adb install -r`. Only if
Android answers `INSTALL_FAILED_UPDATE_INCOMPATIBLE` (signature) or `INSTALL_FAILED_VERSION_DOWNGRADE`, **and**
`--replace-incompatible` was given, the debug package is uninstalled (its data goes with it) and installed again.
Any other failure is reported and nothing is uninstalled. Afterwards the installed `base.apk` is hashed on the phone
and must equal the supplied file, and package name / version / hash / `lastUpdateTime` are reported and stored in
the session as the expected APK. Works on a phone where the app is not installed yet.

A Google Play Protect "send app for scanning?" dialog on the phone can hold an `adb install` until someone
taps it. `install` then fails with a TIMEOUT that names Play Protect; dismiss the dialog on the phone. ldev does
not tap it, and does not change the device's Play Protect / `verifier_verify_adb_installs` setting.

`reset`: exact-package `pm clear`, relaunch (45 s allowed for the first start), attach, then read IndexedDB
(`attempts`, `bookmarks`, `packs`, `packAssets`, `reviewCards`, `reviewLogs`: every one must be present and 0) and the
localStorage key names (learner keys such as `loopdeck3.session.*`, `loopdeck3.preferences.*`, `loopdeck3.library.folders.*`,
`loopdeck3.library.last-module`, `loopdeck3.review.scope` must be absent). What the app writes by itself while
starting (`contentMetadata`, `loopdeck3.diagnostics`, `loopdeck3.library.in-player`) is reported under `appMetadata`
and is not a failure. Leftovers are an ERROR (exit 4) with the leftover names and the possible causes known to ldev
(process not restarted; `ALLOW_BACKUP` is set on the debug app, so Android Auto Backup may restore data). Which
`loopdeck3.*` keys are learner data lives in `constants.ts`; a test fails if `src/` gains a key in neither list.

`setting`: `uimode` uses `cmd uimode night yes|no|auto` (read back from `cmd uimode night`), `font-scale` uses
`settings put system font_scale`. The first original value of each is written to the session before the change;
`finish` restores it and re-reads it. A setting that cannot be restored keeps the session DIRTY. Sessions written
before this change have no such field and still load. The app has no dark theme of its own, so `uimode` changes the
OS state (and anything that follows `prefers-color-scheme`), not necessarily the app's colours.

`shell -- <command> [args...]` runs one command through `adb shell` after the physical identity check. Every
argument is quoted separately, so `;`, `|`, `$()` and redirections are plain text and commands cannot be chained.
The command is checked against an **argv allowlist** first (`shellPolicy.ts`): read-style commands, `input`,
`am start|broadcast|…`, `dumpsys`, `pm list|path|dump`, and file commands only inside `/sdcard/Download/ldev/`,
`/data/local/tmp/ldev-*` and the debug app's external directory. `pm clear|uninstall|grant|…` and `am force-stop|kill|crash`
accept only `com.loopdeck3.app.debug` (release `com.loopdeck3.app`, Clocky and every other package are refused);
`pm install`, `cmd` (other than `package`, `activity` and the `uimode night` query), `settings put`, `wm` changes, `svc`,
`setprop`, shells/`su`/`run-as`, and anything mentioning reboot, recovery, fastboot, bootloader, factory reset or
wipe are refused. Each call, result (exit code, stdout, stderr; 16 KiB each) and refusal is appended to
`<session>/shell.ndjson`. A non-zero exit code of the device command is returned as an ERROR (exit 4) with the
result attached.

What this does **not** guarantee: it is not a sandbox. Allowed commands still act on the real phone with the
shell user's rights (`input`, `am start`, `am broadcast`, `dumpsys` can all change state), the check reads argument
text only, and the phone can change between the check and the command. It limits what an agent can do by
accident; it cannot isolate the device.

`run --apk F` only compares: `F`'s SHA-256 against the installed `base.apk`; it never installs. Without it (and
without an `installApk` step) the provenance is `unverified` and does not block a PASS. A mismatch or an unreadable
installed hash makes the run INCONCLUSIVE, and then no step is executed at all unless the scenario installs an APK
itself. `summary.json` gets an `apk` object: `applicationId`, `versionName`, `versionCode`, `lastUpdateTime`,
installed `sha256`, `apkFileCount`, `webView {package, version}` and `provenance {status, reason, expected}`
next to the existing `git {revision, dirty}`.

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

- Signatures are not verified by ldev: Android decides that when it installs. `artifacts` checks an APK
  file against an HTML file offline; the installed APK is identified by `install` / `run` (SHA-256 of the
  installed `base.apk`), not by `artifacts`.
- No release-build coverage (release has no debuggable WebView).
- Page `role`/`name` listing in `inspect` is an approximation for reading; actions use Playwright.
- Foreground detection is from the active window's UI dump, not `dumpsys`.
- Physical identity is re-checked before each operation, but a swap between check and command is
  not excluded.
- A replace-install (uninstall + install) changes the app's uid, which the running logcat channel does not
  re-read; lines are still matched by pid and package name.
- `shell` is not available as a scenario step yet.
- Physical acceptance on moto g13 / Android 14 is recorded in `docs/android-device-tool.md`.
  Full native file import/save and release-build QA remain separate checks.

## State deltas (record level)

`snapshotState` stores, besides the in-memory copy, `<run>/snapshots/<label>.json` (outside the repository, under
`$LDEV_HOME`). It holds **digests only**: per IndexedDB record `[sha256(key), sha256(value)]` (same canonical encoding as
`state`), per localStorage entry `[key, sha256(value)]`. No question text, answer or localStorage value is stored.
`expectStateDelta` with `b: "now"` also saves the current state as `<stepId>.now` (e.g. `s3.now`).

```json
{ "check": "expectStateDelta", "a": "before", "b": "now",
  "counts": { "attempts": 1 }, "otherStores": "unchanged",
  "localStorage": "unchanged", "ignoreLocalStorage": ["loopdeck3.diagnostics", "loopdeck3.catalog-changes"] }
```

- `counts`: net record change per store (added - removed), an integer. `updated`: exact number of records whose value
  changed in place (a store not named in `updated` is not restricted on updates unless `otherStores` applies to it).
- `otherStores: "unchanged"` (default `"any"`): every store not named in `counts`/`updated` must have no added, removed or
  updated record, and the database version / store set / key and index structure must not change.
- `localStorage: "unchanged"` (default `"any"`): no added, removed or changed key outside `ignoreLocalStorage`.
  `ignoreLocalStorage` entries are exact keys or `prefix*`; each pattern and the number of keys it hid is recorded in
  `summary.json` (`stateDeltas[].localStorage.excluded`). Nothing is ignored by default.
- Unknown labels are rejected when the scenario is parsed. A check with nothing to assert is rejected too.
- Verdicts: expected change -> PASS; different change -> FAIL; IndexedDB capture incomplete (bounds, missing DB),
  a missing snapshot, or localStorage unreadable while `localStorage: "unchanged"` -> INCONCLUSIVE.
- `summary.json` -> `stateDeltas[]` and the `check` events in `events.ndjson` carry store counts (before/after/added/
  removed/updated/unchanged) and localStorage counts, never record or localStorage content.

`ldev diff <runA:label> <runB:label>` compares two saved snapshots offline (no adb, writes nothing). `run` is a run
directory (absolute or relative) or a run id under `$LDEV_HOME/runs`; the label is split at the **last** colon, so
`C:\runs\20260101-x:before` works. Output: per-store counts and added/removed/updated, schema changes, localStorage
key names that were added/removed/updated. Differences exit 0 (use `--expect-same` for exit 1); an incomplete or legacy
(schema 1, counts only) snapshot exits 5 with the reason; a missing snapshot is a usage error (exit 2).

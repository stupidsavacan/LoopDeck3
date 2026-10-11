# Android device QA tooling

`ldev` turns the earlier temporary ADB/CDP scripts into repository-owned developer tooling for a
**single agent working with one phone**. It targets the debug package `com.loopdeck3.app.debug` and
the real WebView at `https://appassets.androidplatform.net/assets/loopdeck/index.html`. Chrome QA
remains a separate check.

It uses the existing TypeScript, Node.js and Playwright toolchain. ADB owns native input, activity
transitions, screenshots and Android system UI; CDP observes the debug WebView and its IndexedDB.
No application dependency or production bridge is added. Command reference, exit codes and design
notes live in [`tools/device/README.md`](../tools/device/README.md).

```
npm run device -- prepare --serial <adb serial>
npm run device -- inspect --ui --compact
npm run device -- collect before
npm run device -- finish
```

## Scope

This is not a shared-device broker. There is no lease, no cross-tool arbitration and no integration
with any other device-management system. The per-session lock file only serializes ldev invocations
that use the same session directory on this machine, and it is never stolen. Do not run other tools
against the phone while a session is active.

## Recovery and evidence

A session records the device's physical identity and the original rotation settings before any
mutation and stays DIRTY until restoration is verified. Only forwards created by that session are
removed; a foreign forward on a reused port is left alone. If an attach is interrupted before
ownership is recorded, `finish` refuses to guess and reports the matching forwards; remove them by
hand or re-run with `--accept-unowned-forward`. After a killed process, confirm it is gone, remove
its stale `session.lock`, and run `finish`.

Raw screenshots, UI XML, DOM labels, IndexedDB-derived artifacts and app logs stay in ignored
`qa-results/android`. Reviewable summaries contain capture status, counts and hashes; they do not
contain device identity or user data. Missing or incomplete state is never equivalent to an empty
database or to equality.

`ldev artifacts --apk <file> --html <LoopDeck3.html>` checks offline that an APK embeds exactly the
single-file HTML (bytes and SHA-256). It does not prove which build is installed on the phone.

## Managing the app and the phone

`ldev install`, `reset`, `setting`, `shell` and `lifecycle kill` (and the matching `ldev run` steps
`installApk`, `reset`, `setting`, `lifecycle kill`) let an agent rebuild the app's state between
reproduction attempts. They only ever target `com.loopdeck3.app.debug`; release, Clocky and every other
package are refused. The phone is a development-only device whose debug data may be erased by these
commands, but device-wide settings are restored by `finish` and device-wide operations (reboot, recovery,
fastboot, factory reset) are not available. Details, exact boundaries of the raw `shell`, APK provenance in
`summary.json` and the known Google Play Protect prompt are in
[`tools/device/README.md`](../tools/device/README.md#managing-the-app).

## Verification scope

Host tests (`tests/device*.test.ts`) use a scripted fake `adb` and fake CDP page, `fake-indexeddb`
and jsdom. They cover identity pinning and swap refusal, strict option handling before any process
starts, forward ownership and cleanup, restoration failures leaving the session DIRTY, ambiguous
sockets/pages, UI null-root retries, coordinate mapping (inset, landscape, out of range), swipe
clipping, state hashing (order, type tags, single transaction, bounds) and incomplete-state
comparison, offline compare/artifact checks, and bootstrap build safety. They do not operate a phone.

### Physical acceptance: 2026-10-11

Verified on moto g13 / Android 14, installed `0.3.1-debug` (versionCode 3001):

- `prepare` → `attach` connected to the pinned debug process, then disconnected without closing the app.
  Ambiguous same-URL pages were refused and the newly allocated forward was removed. An explicit
  debug-only `lifecycle relaunch` resolved the pre-existing duplicate Activities. Resume now uses
  launcher flags to reuse the task.
- `npm run qa:android -- --serial <serial> --session <ignored-directory>` passed all 16 faces of
  the existing eight-card overflow fixture. Native flips, visible-face-only long-content scrolling,
  KNOWN/AGAIN swipes, result counts, portrait/landscape refitting and lifecycle persistence passed.
  The fixture intentionally writes QA material and learning results to the debug database.
- Baseline, background/resume and process-relaunch evidence were all PASS: 76 records with the same
  canonical SHA-256. A separate check changed only the QA pack title, detected `different`, restored
  it, and detected `same` again.
- A native tap in landscape opened `com.google.android.documentsui`. Exact resource-id selection
  opened its search UI. BACK cancelled search and the picker; the app's import screen returned
  with no file selected. This checks picker observation/navigation/cancellation, not a full native
  file import or save dialog workflow.
- Both acceptance sessions finished CLEAN after restoration was read back; owned forwards and
  temporary UI XML were removed. A transient ADB disconnect during an additional UI inspection
  was refused, and retry after reconnection succeeded. Session-local locking does not prevent
  other software or the user from subsequently changing device settings.
- `ldev artifacts --apk LoopDeck3.apk --html LoopDeck3.html` confirmed byte-for-byte equality of
  the local APK's embedded HTML (6,053,011 bytes). This offline check does not establish the
  installed APK identity.

Raw evidence remains in ignored `qa-results/android`; no screenshots, account labels, device
identifiers or logs are included in this change. Host validation passed `npm run verify`
(619 tests, lint/typecheck and production build) and `npm run qa:chrome` (56 checks).
Android release builds cannot be observed through the debug CDP path and are not covered.

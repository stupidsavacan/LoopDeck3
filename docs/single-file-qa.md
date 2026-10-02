# Single-file release QA (Chrome)

Issue #42. Desktop browser scope is **Google Chrome only**, per the requested scope; Edge and Firefox are excluded. Chrome device-size emulation does not certify iPad Safari or Android WebView.

## Repeatable automation

Install Node dependencies with `npm ci` and install Google Chrome. Run:

```sh
npm run qa:chrome
npm run qa:chrome:report
```

The command builds a fresh `LoopDeck3.html` and opens its **file URL**, using disposable Playwright contexts (not the user's Chrome profile). No production test hooks are installed. The fixtures write the application's actual IndexedDB stores after startup. A missing artifact or unavailable Chrome is an error, not a fallback to another browser.

For an existing release artifact, set `QA_ARTIFACT` to its absolute filename, then run `npx playwright test`. The test attachments record artifact SHA-256, Chrome version, OS platform and URL. Record the source commit and device/OS version alongside these attachments. `QA_HEADED=1` runs visible Chrome for an assisted PC pass. `QA_SCREENSHOTS=all` captures each checkpoint; by default home and quiz-result screenshots plus failure screenshots/traces are retained. Reports are in `qa-report/` and `qa-results/`; `QA_REPORT_DIR` and `QA_RESULTS_DIR` select separate run directories. Traces can contain imported fixture contents.

For web-build comparison, run `npm run build`, serve `dist` with `npm run preview -- --host 127.0.0.1`, and set `QA_BASE_URL=http://127.0.0.1:4173/` before running Playwright. Keep web and single-file results separate. Web comparison mode does not require `LoopDeck3.html` to exist and therefore omits the single-file SHA-256 attachment. The shared inline-asset assertion is single-file-specific.

## Automated matrix

- Phone: 320×568, 360×800, 390×844, 412×915.
- Small tablet: 600×960, 744×1133, 768×1024.
- iPad-sized: 810×1080, 820×1180, 834×1194, 1024×768, 1180×820, 1194×834.
- PC: 1024×600, 1280×720, 1366×768, 1440×900, 1920×1080, 2560×1080.
- CSS boundaries: widths 359/361, 419/420/421, 759/760/761, 899/900/901, 999/1000/1001, height 800.

Every size visits home/folder, module, input quiz, wrong-answer result, long-choice quiz, review, graphs, import, PDF controls and debug log. Fixture content includes Japanese, combining Unicode, emoji, long unbroken English, multiline text, 48 modules, 576 questions/bookmarks/due cards and 3,000 attempts. Debug fixtures fill the 200-entry log.

Separate interaction cases cover all three question types, answer double-clicks (exactly 12 saved attempts for 12 answers), reload/resume, image decode, wide/tall/square/high-resolution/tiny/dense images, missing assets, rotation-like resize and 390×300 reduced-height input. Import tests cover invalid JSON recovery, valid installation, merge-preview availability, JSON/ZIP/backup downloads and PDF signature. Four built-in image payloads must decode and appear exactly once. Single-file HTTP(S) requests are blocked and fail the run. Uncaught errors and console errors fail every case.

The 80/100/125/150/175/200% reflow case divides a 1280×720 viewport by each scale. **It is not actual browser zoom or OS scaling evidence.** Screenshots are diagnostic captures, not approved pixel-diff baselines. Fixture IDs/text/counts are stable; history timestamps remain relative to execution time so due/recent-history behavior stays representative.

## Remaining release gates / manual worksheet

Do not mark issue #42 complete solely because automation passes. Record each gate as PASS, FAIL or NOT RUN with evidence:

| Gate | Required evidence |
| --- | --- |
| Windows PC Chrome | Human mouse/keyboard pass, actual Chrome zoom 80/100/125/150/175/200%, device and browser version, actual Windows scaling where practical |
| iPad Safari | Portrait/landscape, software keyboard, repeated rotation, Split View, actual downloaded-HTML opening path |
| Android | Chrome and packaged WebView separately, version/device and opening path |
| Independent tester A and B | Two independent human exploratory reports; automated agents do not satisfy this gate |
| Visual review | Readability, clipped text inside containers, overlays, long choices, dense image labels and primary-control reachability; document overflow alone cannot establish these |
| Remaining interactions | Real background/foreground auto-reveal timing, near-miss UI, rapid routes while reads are pending, bookmark transitions, SRS reset/delete, clipboard, cancel/retry, backup restore and ZIP reimport contents, many distinct packs/assets, one-attempt graph, unsupported PDF items |

Give testers goals rather than a fixed script: study and deliberately fail, bookmark/review, import/export, produce a worksheet, reopen mid-session, resize/zoom, and try unusual action orders. Each finding records artifact hash/commit, device/OS/browser, viewport/zoom/orientation, route, exact steps, expected/actual, reproduction frequency, screenshot/video/log, and severity. P0=data loss/security/unrecoverable; P1=core flow unusable; P2=major breakage with workaround; P3=cosmetic. Keep unrelated findings separate. Publish focused follow-up issues only when authorized; local findings below are ready for review.

## Finding QA-001 — unbroken quiz text creates page-wide overflow

- Severity: P2. Reproduced on Chrome at 320px, 390px and 844px widths.
- Steps: seed the hostile fixture, open `#module/qa-module-0`, disable shuffle/auto-next, start, answer incorrectly, then advance to the long-choice question.
- Before: result scroll width 2,616px at 320px; choice scroll width about 2,805px. Long text escaped the usable reading width.
- Cause: intrinsic minimum sizing of nested grids and no arbitrary wrapping for choices/result text.
- Fix: `minmax(0, 1fr)` tracks in the answer/choice grids, `min-width: 0` on choices, and `overflow-wrap: anywhere` on choices/results. Text remains available rather than being clipped or ellipsized.
- Regression: all matrix cases assert document scroll width; result screenshots support visual inspection.

## Finding QA-002 — web build requests a missing favicon

- Severity: P3. Chrome requested `/favicon.ico` on startup and logged HTTP 404; reproduced against the production preview.
- Fix: an explicit empty data-URL favicon in the HTML prevents the unsolicited missing-resource request and keeps the single-file build self-contained.
- Regression: console-error assertions remain strict for both transports.

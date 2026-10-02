# LoopDeck3 architecture

## Product boundary

One offline HTML application, two delivery formats. TypeScript owns study behavior, routes, data validation and rendering. Android owns only WebView hosting and system file import/export. There is no separate native study UI, server, account system or old internal API compatibility requirement.

Initial reference: LoopDeck2 PR #115, commit `656ed528419a8e6f35294f258b7604fe2bb59d42`. Existing learning behavior is the starting point, not an obligation to preserve every old implementation detail.

## Source ownership

- `src/core/`: question models, answer judgment, session and review logic.
- `src/storage/`: IndexedDB, session state, study preferences, backup validation and persistence.
- `src/packs/`: built-in/imported data and asset resolution.
- `src/main.ts`: mounts one application instance.
- `src/app/`: application lifetime, route ownership and per-screen context.
- `src/screens/`, `src/ui/`: rendering and reusable controls.
- `src/platform/`: browser downloads and the Android system-file bridge.
- `android/`: host and signing/build configuration.
- `scripts/code-map.mjs`: generated dependency/export/function index.

Size and formatting are not correctness gates. Type safety, asynchronous error handling, dependency cycles, behavior tests and artifact validation remain gates. Run `npm run code:map` after edits to regenerate the ignored JSON index.

## Single distribution source

`npm run build:single` bundles scripts, styles, fonts and images into `LoopDeck3.html`. The APK bundles the exact same bytes as `assets/loopdeck/index.html`. Gradle fails if the HTML has not been built. Release checks compare the file extracted from the APK with the downloadable HTML.

The Android WebView loads it from `https://appassets.androidplatform.net/assets/loopdeck/index.html` through AndroidX WebViewAssetLoader. File-origin access is disabled; unmatched network resources and navigation outside the local document are blocked. AndroidX WebKit 1.12.1 is pinned for compatibility with the inherited compileSdk 35 build toolchain. See [Android local-content guidance](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content).

## Data boundary

The Android package has its own browser storage and app data. `LocalDatabase` owns a fresh `loopdeck3-learning` database at schema 1. `StudyRepository` owns persistence commands and snapshots; no old database API facade or migration path is provided. Backups carry `format: "loopdeck3.backup"` and `schema: 1`; old backup formats are rejected before any writes. All six collections are exported in one readonly transaction and restored atomically.

Session checkpoints use `loopdeck3.session` version 1 and exact canonical question content revisions. Changed material cannot resume a checkpoint against an old question with the same ID. Preferences and folder expansion use fresh storage keys. Neither LoopDeck2 nor LoopDeck3 0.1.x user data is read. Built-in material is canonical validated JSON, with no runtime legacy conversion. Imported packs are data, not executable HTML/JavaScript.

Each screen receives a `ScreenContext` containing its catalog, image resolver, navigation and route lease. Navigation and catalog refresh are bound to that lease. Disposing the application invalidates pending renders and removes listeners/timers. Diagnostics are a visible home button. Android file saves use the `LoopDeck3Host` bridge and `loopdeck3-save-result` event.

## Release contract

A version tag triggers verification, browser QA, signed APK creation and signature verification before publishing both assets plus checksums. The app label, HTML title and repository identify LoopDeck3. The displayed web version comes from package.json; Android versionName and versionCode are supplied by the release workflow. Signing uses one persistent repository-specific key, never a newly generated per-run key.

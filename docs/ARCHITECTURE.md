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

Source size, compression, formatting and dependency layout are not mandatory correctness gates. Type checks, asynchronous error handling, behavior tests and artifact validation remain. `npm run code:map` is an optional navigation aid.

## Single distribution source

`npm run build:single` bundles scripts, styles, fonts and images into `LoopDeck3.html`. The APK bundles the exact same bytes as `assets/loopdeck/index.html`. Gradle fails if the HTML has not been built. Release checks compare the file extracted from the APK with the downloadable HTML.

The Android WebView loads it from `https://appassets.androidplatform.net/assets/loopdeck/index.html` through AndroidX WebViewAssetLoader. File-origin access is disabled; unmatched network resources and navigation outside the local document are blocked. AndroidX WebKit 1.12.1 is pinned for compatibility with the inherited compileSdk 35 build toolchain. See [Android local-content guidance](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content).

## Data boundary

The Android package has its own browser storage and app data. `LocalDatabase` owns a fresh `loopdeck3-learning` database at schema 2. `StudyRepository` owns persistence commands and snapshots; no old database API facade is provided; upgrades migrate earlier schemas only within the LoopDeck3 namespace. Backups carry `format: "loopdeck3.backup"` and `schema: 1`; old backup formats are rejected before any writes. All six collections are exported in one readonly transaction and restored atomically.

Session checkpoints use `loopdeck3.session` version 1 and exact canonical question content revisions. Changed material cannot resume a checkpoint against an old question with the same ID. Preferences and folder expansion use fresh storage keys. LoopDeck2 user data is not read. Built-in material is canonical validated JSON, with no runtime legacy conversion. Imported packs are data, not executable HTML/JavaScript.

Each screen receives a `ScreenContext` containing its repository, catalog, image resolver, navigation and route lease. Navigation and catalog refresh are bound to that lease. Disposing the application invalidates pending renders and removes listeners/timers. Diagnostics are a visible home button. Android file saves use the `LoopDeck3Host` bridge and `loopdeck3-save-result` event.

## Study runtime and persistence ownership

`QuizController` owns the question lifecycle: answering, pending, saving, failed, saved, advanced and disposed. It owns timing, checkpoints, retries and auto-advance, with no DOM or IndexedDB dependency. The inline quiz renderer owns controls, feedback, visibility events and idle-reveal observation. Existing scoring, answer judgment and review rules remain in the core modules.

`StudyRepository.recordAnswer` checks the attempt identity, reads the latest review card and writes the attempt, card and log in one readwrite transaction. Independent browser tabs therefore cannot overwrite each other's review counters. Repeating an already committed attempt is a no-op. Answer log identities derive from attempt identities, not a random value. A synchronous transaction failure preserves its original cause when rolling back.

Each repository owns an explicit `LocalDatabase`; pack/asset operations and snapshot restore use that same database. Only the application composition imports the default repository singleton. Screens, bookmarks, image resolution and ZIP generation receive their dependencies explicitly; the existing design avoids global repository imports outside the composition; the optional architecture audit can help inspect changes. This enables isolated repository and headless runtime tests without adding a user-facing profile feature.

ZIP creation is a pure archive operation over supplied data. `collectPackExportAssets` resolves resources against the exported pack itself, so inactive packs and built-in embedded images retain their own assets. Shared image references produce one ZIP entry.

## Release contract

A version tag triggers verification, browser QA, signed APK creation and signature verification before publishing both assets plus checksums. The app label, HTML title and repository identify LoopDeck3. The displayed web version comes from package.json; Android versionName and versionCode are supplied by the release workflow. Signing uses one persistent repository-specific key, never a newly generated per-run key.

The learning database uses schema 2 in the `loopdeck3-learning` namespace. Its upgrade repairs recoverable earlier LoopDeck3 review records and moves review cards to `(questionId, questionMode)` keys; unrecoverable progress is removed with diagnostics. LoopDeck2 databases and backup formats remain separate. Image asset keys encode the pack/path pair without delimiter collisions.

Answers read and update their directional review card atomically. The quiz carries its original content revision, pack installation revision, image bytes and reset epoch; persistence validates these inside the same transaction before checking retries. A replace restore changes a durable epoch outside backup data, invalidating old quizzes even for unchanged built-in material. Installing or deleting changed active content retires past attempts for export and removes current bookmarks and SRS state. Incoming merge-backup state remains authoritative after retirement. Exact canonical question revisions, including presentation fields, remain LoopDeck3's content identity.

Snapshot export reads all user stores in one transaction, normalizes valid records and excludes corrupt/orphan assets. Backups reject duplicate keys, impossible scheduler counters, conflicting active ownership, and mismatched attempt/log pairs. Historical records with missing content may remain archived; live module/direction mismatches are rejected.

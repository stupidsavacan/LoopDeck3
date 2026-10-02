# LoopDeck3 architecture

## Product boundary

One offline HTML application, two delivery formats. TypeScript owns study behavior, routes, data validation and rendering. Android owns only WebView hosting and system file import/export. There is no separate native study UI, server, account system or old internal API compatibility requirement.

Initial reference: LoopDeck2 PR #115, commit `656ed528419a8e6f35294f258b7604fe2bb59d42`. Existing learning behavior is the starting point, not an obligation to preserve every old implementation detail.

## Source ownership

- `src/core/`: question models, answer judgment, session and review logic.
- `src/storage/`: IndexedDB, session state, study preferences, backup validation and persistence.
- `src/packs/`: built-in/imported data and asset resolution.
- `src/screens/`, `src/ui/`, `src/main.ts`: HTML application and navigation.
- `src/platform/`: browser downloads and the Android system-file bridge.
- `android/`: host and signing/build configuration.
- `scripts/code-map.mjs`: generated dependency/export/function index.

Size and formatting are not correctness gates. Type safety, asynchronous error handling, dependency cycles, behavior tests and artifact validation remain gates. Run `npm run code:map` after edits to regenerate the ignored JSON index.

## Single distribution source

`npm run build:single` bundles scripts, styles, fonts and images into `LoopDeck3.html`. The APK bundles the exact same bytes as `assets/loopdeck/index.html`. Gradle fails if the HTML has not been built. Release checks compare the file extracted from the APK with the downloadable HTML.

The Android WebView loads it from `https://appassets.androidplatform.net/assets/loopdeck/index.html` through AndroidX WebViewAssetLoader. File-origin access is disabled; unmatched network resources and navigation outside the local document are blocked. AndroidX WebKit 1.12.1 is pinned for compatibility with the inherited compileSdk 35 build toolchain. See [Android local-content guidance](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content).

## Data boundary

The new Android package has its own browser storage and app data. The web app also uses a separate `loopdeck3-db` database and `loopdeck3_` storage keys, even when two HTML files share a browser origin. No automatic LoopDeck2 storage migration is attempted. The inherited validated backup import is the explicit migration path. Imported packs are data, not executable HTML/JavaScript. Compatibility applies to supported data formats, not old internal TypeScript APIs.

## Release contract

A version tag triggers verification, browser QA, signed APK creation and signature verification before publishing both assets plus checksums. The app label, HTML title and repository identify LoopDeck3. The displayed web version comes from package.json; Android versionName and versionCode are supplied by the release workflow. Signing uses one persistent repository-specific key, never a newly generated per-run key.

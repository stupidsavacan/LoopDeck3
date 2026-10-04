# LoopDeck3 Android host

Build `LoopDeck3.html` first with `npm run build:single`. Then run Gradle `assembleDebug` in this directory, or use the debug workflow. The Android application ID is `com.loopdeck3.app` (debug adds `.debug`).

Every push/merge to main and manual release runs use four GitHub Actions secrets:

- `ANDROID_KEYSTORE_BASE64`
- `KEYSTORE_PASSWORD`
- `KEY_ALIAS`
- `KEY_PASSWORD`

The initial LoopDeck3 signing key is backed up locally at `C:/Users/gamit/AndroidKeys/LoopDeck3/release.jks`. Its password is saved with Windows DPAPI in `password.dpapi.xml` beside it, bound to the current Windows user. These files are outside the repository. Preserve the key and arrange a separate secure backup before changing computers; do not replace it for subsequent releases.

Signing material is prepared only inside CI and removed afterwards. Never commit keys or passwords. Releases verify the APK signature and compare the packaged HTML byte-for-byte with the HTML download.

No native learning screen is implemented. WebView hosts the same offline HTML used in the browser; the inherited bounded file-save bridge remains for Android's system document picker. Runtime behavior on actual Android devices still needs separate testing.

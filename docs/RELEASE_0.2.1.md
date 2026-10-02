# 0.2.1 — application and storage redesign

- Application lifetime, URL navigation, catalog loading and screen leases are owned by `StudyApplication`.
- Screens consume one `ScreenContext`; navigation and image resolution no longer use a global active catalog.
- Fresh IndexedDB schema, preferences, library keys and session checkpoints. No LoopDeck2 or LoopDeck3 0.1.x user-data migration or old API facade.
- New validated backup marker and atomic restore. Snapshot export reads all six collections in one transaction.
- Checkpoints include exact canonical question revisions; changed questions with reused IDs cannot resume stale sessions.
- Built-in material is canonical JSON, without runtime legacy normalization.
- Review suspension is a flag rather than a duplicated scheduling state.
- Invalid history URLs are replaced with a canonical route without adding a back-navigation loop.
- Visible diagnostics and one current Android file-save bridge.

Verified locally: static/type/dependency/dead-code checks, 318 unit tests, production build and 40 single-file Chrome QA cases plus a browser regression for invalid history navigation. Release CI additionally validates APK signing and byte-for-byte HTML payload equality. Native Android picker/save/rotation behavior has not been exercised on a physical device for this release.

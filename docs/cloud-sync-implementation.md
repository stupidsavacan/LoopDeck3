# Cloud sync implementation — 2026-10-22

Base: GitHub main dbf9d5821ae79df08bfab9a1658dbb37d30bb8d8. Branch: feat/pack-cloud-sync.
Authoritative requirements: supplied 2026-10-22 launch prompt and implementation specification. Prior Phase 1/2 reports are evidence, not production completion.

## Preserved boundaries

- One shared passphrase/library, per-device revocable sessions; no account UI.
- Pack data only. packLearningState.ts retirement/SRS semantics remain unchanged.
- No production deployment, Secret mutations, data removal, Issue/PR creation or main push without explicit user approval.
- Experiment data is never migrated implicitly to the production library.

## Observed persistence paths

| Trigger                 | Persistence                                              | Existing reconciliation                                           | Sync treatment                                           |
| ----------------------- | -------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| Direct ZIP/JSON replace | saveImportedPackWithAssets → savePackWithAssets(replace) | putPacksInInstallOrder(reconcile=true), changed images retire IDs | Atomic local intent                                      |
| Pack/module merge       | same upsert, final merged Pack                           | Same reconciliation; image collisions abort                       | Saved final Pack/assets snapshot                         |
| saveImportedPack        | savePackWithAssets(upsert)                               | Same reconciliation                                               | Explicit local origin                                    |
| Delete                  | deletePackAndAssets                                      | Reconcile learning before delete                                  | Atomic tombstone + job invalidation                      |
| Backup merge/replace    | importBackup → putPacksInInstallOrder                    | Existing backup relationships/retirement; replacement epoch       | No upload; restored IDs localOnly; invalidate stale jobs |
| Cloud apply             | existing savePackWithAssets(replace)                     | Identical retirement                                              | Atomic remote revision; no echo upload                   |

## Design

D1 transactional head/receipt commit, R2 staging with durable orphan/deletion journal. Last committed distinct fingerprint wins; restore always creates a revision. Retain current+9 older versions.
Shared fingerprint = normalized Pack canonical JSON + sorted referenced image byte hashes. ZIP SHA-256 is separate.
IndexedDB schema3 adds sync states, durable mutation snapshots/jobs, staged downloads/config. Per-pack generation invalidates stale in-flight operations. No learner records in transfer snapshots.
Native Android owns protected auth + ZIP transfer/staging, never learning IndexedDB. Actual Wi-Fi transport is checked separately from unmetered status.

## Status

3A–3D have implementation and successful local/public acceptance evidence on the experimental branch: an approved dedicated public Sites/D1/R2 instance, PC file:// ↔ physical Android automatic Pack sync, 32 MiB foreground/background transfer, real cellular 5 MiB boundary, Wi-Fi loss/retry, actual reboot, forced deep Doze and standard Android background restriction recovery. Production release/main integration (3E) remains partial. Refer to the distributed REPORT.md, MOBILE-RESULTS.md and SECURITY-RESTORE-RESULTS.md for exact successful and unverified scopes. This is an experimental public Site, not an approved production migration. Shared Pack validation is generated from canonical sources into server/generated with source hashes and sourcemap, allowing an independently buildable Sites checkout.

## Android OS backup boundary

CloudCredentials stores its AES/GCM envelope in Context.getNoBackupFilesDir(); CloudFiles places transfer ZIPs, receipts and native mirror there as well. IndexedDB stores only the @android-keystore reference, not the native token. If ordinary app data is restored without that excluded file/key, CloudStore.settings returns no usable token; the login UI remains available. The foreground app retains its Pack data and pending intent, and Native never writes the learning IndexedDB.

API 35 disposable emulator LocalTransport full backup/clear/restore verified that a normally imported dummy Pack and pending IndexedDB intent are restored, while encrypted credentials and native transfer ZIP/job are absent before first launch. Login form availability was verified offline with a fake token only; this does not prove real Google/OEM cloud backup or physical device migration. No real phone was cleared. The existing allowBackup policy was preserved; no extra backup component or production dependency was introduced.

## Signed release QA

Signing can use the existing keystore.properties or the four LOOPDECK_KEYSTORE_FILE / LOOPDECK_KEYSTORE_PASSWORD / LOOPDECK_KEY_ALIAS / LOOPDECK_KEY_PASSWORD environment variables (environment takes precedence). No signing credentials are added to the repository. syncPreview=true also isolates release builds as com.loopdeck3.app.syncpreview.release; ordinary production IDs remain unchanged. releaseQa=true selects the separate same-signed androidTest instrumentation. It requires the dedicated QA package and a bounded credential payload over a random local ADB socket, never secrets in arguments or logs.

Signed non-debuggable Native HTTP/Keystore/ZIP roundtrip was measured on API 35; the same APK was launched on stock physical Android and its WebView debugging socket was absent. Userdebug emulator debugging behavior is reported separately. Physical signed release UI login (POST 200), initial builtin receive (1112 questions/4 assets), normal-import automatic upload (POST 201) and startup receive of another client revision also passed using same-signed instrumentation with CDP disabled and no direct IndexedDB writes. The helper APK was removed afterward; app data/session were retained. Physical release WorkManager and OEM migration remain unverified; see distributed RELEASE-RESULTS.md.

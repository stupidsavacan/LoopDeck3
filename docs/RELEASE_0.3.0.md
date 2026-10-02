# 0.3.0 — study runtime and data ownership

- A headless question state machine owns answering, save gating, retries, timing, checkpoints, auto-advance and disposal.
- The application supplies its repository to screens, quizzes, bookmarks, images and exports. Repositories can own separate database instances for deterministic tests. Static checks enforce the composition boundary.
- Recording an answer reads and updates its review card inside one transaction. Concurrent browser tabs cannot lose review counters; retries cannot rate the same committed attempt twice.
- Answer log identities derive from attempt identities. Random collisions cannot prevent distinct answers from being recorded. Rollback preserves the original synchronous error cause.
- Pack ZIP exports resolve the exported pack's own resources and include built-in embedded images once.

Learning rules, visible controls and the HTML/WebView delivery model remain the same. No new production dependency was added. Android device-level picker/save/rotation behavior still requires physical-device verification.

Local validation: static/type/architecture/dead-code checks, 334 unit tests and 43 single-file Chrome QA cases, including concurrent tabs and built-in ZIP image exports. Release CI verifies the exact HTML, APK signing and identical packaged HTML before publishing.

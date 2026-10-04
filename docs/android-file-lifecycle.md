# Android file lifecycle

The native host acknowledges saves only after writing the selected document. The JavaScript timeout covers byte transfer, not time spent choosing a destination. Page disposal cancels unfinished transfers and pending save pickers. File chooser callbacks receive a cancellation result on launch failure or activity destruction; stale picker results cannot complete a newer request. Activity recreation discards interrupted operations because the new WebView has no matching JavaScript promise.

LoopDeck3 retains its HTTPS WebViewAssetLoader origin, restricted file access, independent `com.loopdeck3.app` identity, `LoopDeck3Host` bridge, and single-HTML asset packaging. It does not need LoopDeck2's additional file-origin image map generation step. Pack export uses embedded image bytes in this HTML; normal web builds resolve image files through the export service. ZIP export fails when referenced images are missing or malformed, and JSON export requires image-free packs.

Debug CI builds use `3000 + runNumber * 100 + runAttempt` for increasing version codes and `0.3.0+runNumber.runAttempt.commit` for source identification. The existing `.debug` application ID suffix separates debug installs from release installs. Release versions continue to follow the existing package-version calculation and signing workflow.

Automated coverage includes native save promises, cancellation, stalled transfer, destination-picker timing, image byte preservation, malformed import/export, rotation configuration, and debug version generation. Android picker behavior, cancellation during actual provider writes, process death, and background transitions require physical-device QA; no physical-device result is claimed here.

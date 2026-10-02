package com.loopdeck3.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebChromeClient.FileChooserParams;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import androidx.webkit.WebViewAssetLoader;
import java.io.ByteArrayInputStream;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 2410;
    private static final int SAVE_FILE_REQUEST = 2411;
    private static final String ASSET_BASE_URL = "https://appassets.androidplatform.net/assets/loopdeck/";

    private static final int SAVE_RAW_CHUNK_BYTES = 48 * 1024;
    private static final int MAX_SAVE_BYTES = 256 * 1024 * 1024;
    private static final int MAX_CONCURRENT_SAVE_SESSIONS = 2;
    private static final int MAX_BASE64_CHUNK_CHARS = 4 * ((SAVE_RAW_CHUNK_BYTES + 2) / 3);
    private static final long SAVE_SESSION_IDLE_TIMEOUT_MS = 120_000L;

    private static final String STATE_SAVE_ID = "loopdeck.pendingSave.id";
    private static final String STATE_SAVE_FILENAME = "loopdeck.pendingSave.filename";
    private static final String STATE_SAVE_MIME = "loopdeck.pendingSave.mime";
    private static final String STATE_SAVE_PATH = "loopdeck.pendingSave.path";
    private static final String STATE_SAVE_BYTES = "loopdeck.pendingSave.bytes";

    private final Object saveLock = new Object();
    private final Map<String, PendingSaveBuffer> pendingSaveBuffers = new HashMap<>();
    private final Handler saveSessionHandler = new Handler(Looper.getMainLooper());

    private ValueCallback<Uri[]> filePathCallback;
    private PendingSave pendingSave;
    private WebView webView;

    private static final class PendingSave {
        final String saveId;
        final String filename;
        final String mimeType;
        final File tempFile;
        final int expectedBytes;

        PendingSave(String saveId, String filename, String mimeType, File tempFile, int expectedBytes) {
            this.saveId = saveId;
            this.filename = filename;
            this.mimeType = mimeType;
            this.tempFile = tempFile;
            this.expectedBytes = expectedBytes;
        }
    }

    private static final class PendingSaveBuffer {
        final String saveId;
        final String filename;
        final String mimeType;
        final int expectedBytes;
        final int expectedChunks;
        final File tempFile;
        final FileOutputStream output;
        int receivedChunks = 0;
        int receivedBytes = 0;
        long lastTouchedMs = SystemClock.elapsedRealtime();

        PendingSaveBuffer(
                String saveId,
                String filename,
                String mimeType,
                int expectedBytes,
                int expectedChunks,
                File tempFile,
                FileOutputStream output
        ) {
            this.saveId = saveId;
            this.filename = filename;
            this.mimeType = mimeType;
            this.expectedBytes = expectedBytes;
            this.expectedChunks = expectedChunks;
            this.tempFile = tempFile;
            this.output = output;
        }
    }

    public final class LoopDeckBridge {
        @JavascriptInterface
        public boolean beginSaveFile(String saveId, String filename, String mimeType, int expectedBytes, int expectedChunks) {
            if (saveId == null || saveId.trim().isEmpty()) return false;
            if (expectedBytes <= 0 || expectedBytes > MAX_SAVE_BYTES) return false;
            int requiredChunks = (expectedBytes + SAVE_RAW_CHUNK_BYTES - 1) / SAVE_RAW_CHUNK_BYTES;
            if (expectedChunks != requiredChunks) return false;

            final PendingSaveBuffer buffer;
            synchronized (saveLock) {
                if (pendingSaveBuffers.containsKey(saveId)) return false;
                if (stagedSaveCountLocked() >= MAX_CONCURRENT_SAVE_SESSIONS) return false;
                if ((long) stagedBytesLocked() + expectedBytes > MAX_SAVE_BYTES) return false;
                try {
                    File tempFile = File.createTempFile("loopdeck-export-", ".part", getCacheDir());
                    buffer = new PendingSaveBuffer(
                            saveId,
                            safeFilename(filename),
                            safeMimeType(mimeType),
                            expectedBytes,
                            expectedChunks,
                            tempFile,
                            new FileOutputStream(tempFile)
                    );
                    pendingSaveBuffers.put(saveId, buffer);
                } catch (IOException error) {
                    return false;
                }
            }
            scheduleSaveSessionExpiry(saveId);
            return true;
        }

        @JavascriptInterface
        public boolean appendSaveFileChunk(String saveId, int chunkIndex, String base64Chunk) {
            if (saveId == null || base64Chunk == null || base64Chunk.isEmpty()) return false;
            if (base64Chunk.length() > MAX_BASE64_CHUNK_CHARS) return false;

            final byte[] decoded;
            try {
                decoded = Base64.decode(base64Chunk, Base64.NO_WRAP);
            } catch (IllegalArgumentException error) {
                return false;
            }
            if (decoded.length <= 0 || decoded.length > SAVE_RAW_CHUNK_BYTES) return false;

            synchronized (saveLock) {
                PendingSaveBuffer buffer = pendingSaveBuffers.get(saveId);
                if (buffer == null) return false;
                if (isExpired(buffer)) {
                    pendingSaveBuffers.remove(saveId);
                    cleanupBuffer(buffer);
                    return false;
                }
                if (chunkIndex != buffer.receivedChunks || chunkIndex >= buffer.expectedChunks) return false;

                int expectedChunkBytes = Math.min(
                        SAVE_RAW_CHUNK_BYTES,
                        buffer.expectedBytes - (chunkIndex * SAVE_RAW_CHUNK_BYTES)
                );
                if (decoded.length != expectedChunkBytes) return false;
                if ((long) buffer.receivedBytes + decoded.length > buffer.expectedBytes) return false;

                try {
                    buffer.output.write(decoded);
                } catch (IOException error) {
                    pendingSaveBuffers.remove(saveId);
                    cleanupBuffer(buffer);
                    return false;
                }
                buffer.receivedBytes += decoded.length;
                buffer.receivedChunks += 1;
                buffer.lastTouchedMs = SystemClock.elapsedRealtime();
            }
            return true;
        }

        @JavascriptInterface
        public boolean finishSaveFile(String saveId) {
            if (saveId == null) return false;
            final PendingSaveBuffer buffer;
            final PendingSave readySave;
            synchronized (saveLock) {
                buffer = pendingSaveBuffers.remove(saveId);
                if (buffer == null) return false;
                if (isExpired(buffer)) {
                    cleanupBuffer(buffer);
                    reportSaveResult(buffer.saveId, false, "SAV-A022", "Android保存セッションがタイムアウトしました。", 0);
                    return false;
                }
                if (buffer.receivedChunks != buffer.expectedChunks || buffer.receivedBytes != buffer.expectedBytes) {
                    cleanupBuffer(buffer);
                    reportSaveResult(buffer.saveId, false, "SAV-A021", "保存データのchunk数またはbyte数が一致しません。", buffer.receivedBytes);
                    return false;
                }
                try {
                    buffer.output.flush();
                    buffer.output.close();
                } catch (IOException error) {
                    cleanupFile(buffer.tempFile);
                    reportSaveResult(buffer.saveId, false, "SAV-A023", "一時保存データを確定できませんでした。", buffer.receivedBytes);
                    return false;
                }
                if (pendingSave != null) {
                    cleanupFile(buffer.tempFile);
                    reportSaveResult(buffer.saveId, false, "SAV-A003", "別の保存処理が完了するまで待ってください。", 0);
                    return false;
                }
                readySave = new PendingSave(buffer.saveId, buffer.filename, buffer.mimeType, buffer.tempFile, buffer.expectedBytes);
                pendingSave = readySave;
            }
            runOnUiThread(() -> launchSavePicker(readySave));
            return true;
        }

        @JavascriptInterface
        public void cancelSaveFile(String saveId) {
            if (saveId == null) return;
            final PendingSaveBuffer buffer;
            synchronized (saveLock) {
                buffer = pendingSaveBuffers.remove(saveId);
            }
            if (buffer != null) cleanupBuffer(buffer);
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        restorePendingSave(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true); // Bundled LoopDeck app code only; imported study content is data.
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        // LoopDeck3 starts with its own HTTPS origin; no old file-origin migration.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }

        webView.addJavascriptInterface(new LoopDeckBridge(), "LoopDeckAndroid");
        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse local = assetLoader.shouldInterceptRequest(request.getUrl());
                return local != null ? local : new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", null, new ByteArrayInputStream(new byte[0]));
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return shouldBlockNavigation(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return shouldBlockNavigation(Uri.parse(url));
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                    WebView webView,
                    ValueCallback<Uri[]> callback,
                    FileChooserParams fileChooserParams
            ) {
                if (MainActivity.this.filePathCallback != null) {
                    MainActivity.this.filePathCallback.onReceiveValue(null);
                }
                MainActivity.this.filePathCallback = callback;

                Intent intent = fileChooserParams.createIntent();
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                } catch (Exception error) {
                    MainActivity.this.filePathCallback = null;
                    return false;
                }
                return true;
            }
        });

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        }

        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(ASSET_BASE_URL + "index.html");
        }
    }

    private boolean shouldBlockNavigation(Uri uri) {
        if (uri == null) return true;
        String url = uri.toString();
        String scheme = uri.getScheme();
        if ("file".equals(scheme)) return !url.startsWith(ASSET_BASE_URL);
        if ("about".equals(scheme) || "blob".equals(scheme)) return false;
        return true;
    }

    private int stagedSaveCountLocked() {
        return pendingSaveBuffers.size() + (pendingSave == null ? 0 : 1);
    }

    private int stagedBytesLocked() {
        long total = pendingSave == null ? 0 : pendingSave.expectedBytes;
        for (PendingSaveBuffer buffer : pendingSaveBuffers.values()) total += buffer.expectedBytes;
        return total > Integer.MAX_VALUE ? Integer.MAX_VALUE : (int) total;
    }

    private boolean isExpired(PendingSaveBuffer buffer) {
        return SystemClock.elapsedRealtime() - buffer.lastTouchedMs >= SAVE_SESSION_IDLE_TIMEOUT_MS;
    }

    private void scheduleSaveSessionExpiry(String saveId) {
        saveSessionHandler.postDelayed(() -> expireSaveSessionIfIdle(saveId), SAVE_SESSION_IDLE_TIMEOUT_MS);
    }

    private void expireSaveSessionIfIdle(String saveId) {
        PendingSaveBuffer expired = null;
        long retryDelay = -1L;
        synchronized (saveLock) {
            PendingSaveBuffer buffer = pendingSaveBuffers.get(saveId);
            if (buffer == null) return;
            long idleMs = SystemClock.elapsedRealtime() - buffer.lastTouchedMs;
            if (idleMs >= SAVE_SESSION_IDLE_TIMEOUT_MS) {
                expired = pendingSaveBuffers.remove(saveId);
            } else {
                retryDelay = SAVE_SESSION_IDLE_TIMEOUT_MS - idleMs;
            }
        }
        if (expired != null) {
            cleanupBuffer(expired);
            reportSaveResult(saveId, false, "SAV-A022", "Android保存セッションがタイムアウトしました。", 0);
        } else if (retryDelay >= 0L) {
            saveSessionHandler.postDelayed(() -> expireSaveSessionIfIdle(saveId), retryDelay);
        }
    }

    private void cleanupBuffer(PendingSaveBuffer buffer) {
        try {
            buffer.output.close();
        } catch (IOException ignored) {
            // Best effort cleanup.
        }
        cleanupFile(buffer.tempFile);
    }

    private void cleanupFile(File file) {
        if (file != null && file.exists() && !file.delete()) file.deleteOnExit();
    }

    private String safeFilename(String filename) {
        String fallback = "loopdeck-export";
        if (filename == null || filename.trim().isEmpty()) return fallback;
        String cleaned = filename.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        return cleaned.isEmpty() ? fallback : cleaned;
    }

    private String safeMimeType(String mimeType) {
        if (mimeType == null || mimeType.isEmpty() || mimeType.length() > 120) return "application/octet-stream";
        String cleaned = mimeType.replaceAll("[^A-Za-z0-9!#$&^_.+\\-;/=]", "");
        return cleaned.isEmpty() ? "application/octet-stream" : cleaned;
    }

    private String errorText(Exception error) {
        String message = error.getMessage();
        return error.getClass().getSimpleName() + (message == null || message.isEmpty() ? "" : ": " + message);
    }

    private void reportSaveResult(String saveId, boolean ok, String code, String message, int bytes) {
        if (webView == null || saveId == null || saveId.isEmpty()) return;
        try {
            JSONObject detail = new JSONObject();
            detail.put("id", saveId);
            detail.put("ok", ok);
            detail.put("code", code);
            detail.put("message", message);
            detail.put("bytes", bytes);
            String script = "window.dispatchEvent(new CustomEvent('loopdeck-native-save-result',{detail:" + detail.toString() + "}))";
            webView.post(() -> webView.evaluateJavascript(script, null));
        } catch (Exception ignored) {
            // Best effort only.
        }
    }

    private void launchSavePicker(PendingSave save) {
        synchronized (saveLock) {
            if (pendingSave != save) return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(save.mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, save.filename);
        try {
            startActivityForResult(intent, SAVE_FILE_REQUEST);
        } catch (Exception error) {
            synchronized (saveLock) {
                if (pendingSave == save) pendingSave = null;
            }
            cleanupFile(save.tempFile);
            reportSaveResult(save.saveId, false, "SAV-A002", "保存先を開けませんでした: " + errorText(error), 0);
            Toast.makeText(this, "[SAV-A002] 保存先を開けませんでした。", Toast.LENGTH_LONG).show();
        }
    }

    private void completeSaveFile(Uri uri) {
        final PendingSave save;
        synchronized (saveLock) {
            save = pendingSave;
        }
        if (save == null) return;

        int bytesWritten = 0;
        try (FileInputStream input = new FileInputStream(save.tempFile);
             OutputStream output = getContentResolver().openOutputStream(uri)) {
            if (output == null) throw new IllegalStateException("No output stream");
            if (save.tempFile.length() != save.expectedBytes) {
                throw new IllegalStateException("Staged bytes " + save.tempFile.length() + " did not match expected " + save.expectedBytes);
            }

            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
                bytesWritten += read;
            }
            output.flush();
            if (bytesWritten != save.expectedBytes) {
                throw new IllegalStateException("Written bytes " + bytesWritten + " did not match expected " + save.expectedBytes);
            }
            Toast.makeText(this, "書き出しました。", Toast.LENGTH_SHORT).show();
            reportSaveResult(save.saveId, true, "SAV-OK", "保存に成功しました。", bytesWritten);
        } catch (Exception error) {
            reportSaveResult(save.saveId, false, "SAV-A005", "書き出しに失敗しました: " + errorText(error), bytesWritten);
            Toast.makeText(this, "[SAV-A005] 書き出しに失敗しました。", Toast.LENGTH_LONG).show();
        } finally {
            synchronized (saveLock) {
                if (pendingSave == save) pendingSave = null;
            }
            cleanupFile(save.tempFile);
        }
    }

    private void restorePendingSave(Bundle savedInstanceState) {
        if (savedInstanceState == null) return;
        String saveId = savedInstanceState.getString(STATE_SAVE_ID);
        String filename = savedInstanceState.getString(STATE_SAVE_FILENAME);
        String mimeType = savedInstanceState.getString(STATE_SAVE_MIME);
        String path = savedInstanceState.getString(STATE_SAVE_PATH);
        int expectedBytes = savedInstanceState.getInt(STATE_SAVE_BYTES, -1);
        if (saveId == null || filename == null || mimeType == null || path == null || expectedBytes <= 0) return;

        File tempFile = new File(path);
        File parent = tempFile.getParentFile();
        if (parent == null || !parent.equals(getCacheDir()) || !tempFile.isFile() || tempFile.length() != expectedBytes) return;
        pendingSave = new PendingSave(saveId, filename, mimeType, tempFile, expectedBytes);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) webView.saveState(outState);
        synchronized (saveLock) {
            if (pendingSave != null) {
                outState.putString(STATE_SAVE_ID, pendingSave.saveId);
                outState.putString(STATE_SAVE_FILENAME, pendingSave.filename);
                outState.putString(STATE_SAVE_MIME, pendingSave.mimeType);
                outState.putString(STATE_SAVE_PATH, pendingSave.tempFile.getAbsolutePath());
                outState.putInt(STATE_SAVE_BYTES, pendingSave.expectedBytes);
            }
        }
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == SAVE_FILE_REQUEST) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                completeSaveFile(data.getData());
            } else {
                final PendingSave cancelled;
                synchronized (saveLock) {
                    cancelled = pendingSave;
                    pendingSave = null;
                }
                if (cancelled != null) {
                    cleanupFile(cancelled.tempFile);
                    reportSaveResult(cancelled.saveId, false, "SAV-A004", "保存がキャンセルされました。", 0);
                }
            }
            return;
        }

        if (requestCode != FILE_CHOOSER_REQUEST || filePathCallback == null) return;

        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                results = new Uri[count];
                for (int i = 0; i < count; i++) {
                    results[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else if (data.getData() != null) {
                results = new Uri[]{data.getData()};
            }
        }
        filePathCallback.onReceiveValue(results);
        filePathCallback = null;
    }

    @Override
    protected void onDestroy() {
        PendingSaveBuffer[] buffers;
        PendingSave saveToDelete = null;
        synchronized (saveLock) {
            buffers = pendingSaveBuffers.values().toArray(new PendingSaveBuffer[0]);
            pendingSaveBuffers.clear();
            if (!isChangingConfigurations()) {
                saveToDelete = pendingSave;
                pendingSave = null;
            }
        }
        for (PendingSaveBuffer buffer : buffers) cleanupBuffer(buffer);
        if (saveToDelete != null) cleanupFile(saveToDelete.tempFile);

        if (webView != null) {
            webView.removeJavascriptInterface("LoopDeckAndroid");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }
}

package com.loopdeck3.app;

import android.content.Context;
import android.webkit.JavascriptInterface;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.security.MessageDigest;

/** Available only in the bundled, navigation-restricted WebView. No IndexedDB access. */
public final class CloudBridge {
    private final Context context;
    CloudBridge(Context context) { this.context = context.getApplicationContext(); }
    @JavascriptInterface public String origin() { return BuildConfig.SYNC_API_ORIGIN; }
    @JavascriptInterface public String token() { try { JSONObject c = new CloudCredentials(context).load(); return c == null ? "" : c.getString("token"); } catch (Exception failure) { return ""; } }
    @JavascriptInterface public boolean credentials(String origin, String token) { try { new CloudCredentials(context).save(origin, token); CloudWorker.schedule(context); return true; } catch (Exception failure) { return false; } }
    @JavascriptInterface public void logout() { new CloudCredentials(context).clear(); }
    @JavascriptInterface public String ack(String op) { if (op == null || !op.matches("[a-f0-9-]{36}")) return ""; synchronized (CloudFiles.LOCK) { try { File file = CloudFiles.file(context, op + ".ack.json"); return file.exists() ? CloudFiles.json(file).toString() : ""; } catch (Exception failure) { return ""; } } }
    @JavascriptInterface public boolean mirror(String raw) {
        if (raw == null || raw.length() > 1024 * 1024) return false;
        synchronized (CloudFiles.LOCK) {
            try {
                JSONObject state = new JSONObject(raw); if (state.optJSONObject("jobs") == null || state.optJSONObject("states") == null) return false;
                CloudFiles.json(CloudFiles.file(context, "state.json"), state);
                File[] files = CloudFiles.root(context).listFiles();
                if (files != null) for (File file : files) {
                    String name = file.getName();
                    if (name.endsWith(".job.json") || name.endsWith(".ack.json") || name.endsWith(".stage.json") || name.matches("[a-f0-9-]{36}\\.(zip|part)")) {
                        String op = name.substring(0, name.indexOf('.')); if (!state.getJSONObject("jobs").has(op)) file.delete();
                    }
                    if (name.endsWith(".remote.json")) {
                        JSONObject metadata = CloudFiles.json(file), mode = state.getJSONObject("states").optJSONObject(metadata.getJSONObject("head").getString("packId"));
                        if (mode != null && (!"enabled".equals(mode.optString("mode")) || CloudFiles.unresolved(context, state, metadata.getJSONObject("head").getString("packId")) || mode.optLong("generation") != metadata.optLong("expectedGeneration") || mode.optLong("remoteRevision") >= metadata.getJSONObject("head").getLong("revision"))) {
                            CloudFiles.file(context, metadata.getString("key") + ".zip").delete(); file.delete();
                        }
                    }
                }
                CloudWorker.schedule(context); return true;
            } catch (Exception failure) { return false; }
        }
    }
    @JavascriptInterface public boolean begin(String raw) {
        if (raw == null || raw.length() > 8192) return false;
        synchronized (CloudFiles.LOCK) {
            try {
                JSONObject job = new JSONObject(raw); String op = job.getString("opId"); long size = job.getLong("size");
                if (!op.matches("[a-f0-9-]{36}") || size <= 0 || size > CloudPolicy.MAX_ZIP || !job.getString("sha256").matches("[a-f0-9]{64}") || !job.getString("fingerprint").matches("[a-f0-9]{64}")) return false;
                File existing = CloudFiles.file(context, op + ".job.json");
                if (existing.exists()) return CloudFiles.json(existing).getString("sha256").equals(job.getString("sha256"));
                CloudFiles.json(CloudFiles.file(context, op + ".stage.json"), job);
                try (FileOutputStream out = new FileOutputStream(CloudFiles.file(context, op + ".part"))) { out.getFD().sync(); }
                return true;
            } catch (Exception failure) { return false; }
        }
    }
    @JavascriptInterface public boolean append(String op, int offset, String base64) {
        if (op == null || !op.matches("[a-f0-9-]{36}") || base64 == null || base64.length() > 65536) return false;
        synchronized (CloudFiles.LOCK) {
            try {
                if (CloudFiles.file(context, op + ".job.json").exists()) return true;
                File part = CloudFiles.file(context, op + ".part"); JSONObject job = CloudFiles.json(CloudFiles.file(context, op + ".stage.json")); byte[] bytes = Base64.decode(base64, Base64.NO_WRAP);
                if (offset != part.length() || bytes.length > 49152 || offset + bytes.length > job.getLong("size")) return false;
                try (FileOutputStream out = new FileOutputStream(part, true)) { out.write(bytes); } return true;
            } catch (Exception failure) { return false; }
        }
    }
    @JavascriptInterface public boolean finish(String op) {
        if (op == null || !op.matches("[a-f0-9-]{36}")) return false;
        synchronized (CloudFiles.LOCK) {
            try {
                if (CloudFiles.file(context, op + ".job.json").exists()) return true;
                if (!CloudFiles.json(CloudFiles.file(context, "state.json")).getJSONObject("jobs").has(op)) return false;
                JSONObject job = CloudFiles.json(CloudFiles.file(context, op + ".stage.json")); File part = CloudFiles.file(context, op + ".part");
                if (part.length() != job.getLong("size")) return false;
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                try (FileInputStream in = new FileInputStream(part)) { byte[] bytes = new byte[49152]; int n; while ((n = in.read(bytes)) >= 0) digest.update(bytes, 0, n); }
                if (!CloudFiles.hex(digest.digest()).equals(job.getString("sha256"))) return false;
                if (!part.renameTo(CloudFiles.file(context, op + ".zip"))) return false;
                CloudFiles.json(CloudFiles.file(context, op + ".job.json"), job); CloudFiles.file(context, op + ".stage.json").delete(); CloudWorker.schedule(context); return true;
            } catch (Exception failure) { return false; }
        }
    }
    @JavascriptInterface public String staged() {
        synchronized (CloudFiles.LOCK) {
            try { JSONArray values = new JSONArray(); File[] files = CloudFiles.root(context).listFiles((dir, name) -> name.endsWith(".remote.json")); if (files != null) for (File f : files) values.put(CloudFiles.json(f)); return values.toString(); }
            catch (Exception failure) { return "[]"; }
        }
    }
    @JavascriptInterface public String read(String key, int offset) {
        if (key == null || !key.matches("remote-[a-f0-9]{64}-[0-9]+") || offset < 0) return "";
        synchronized (CloudFiles.LOCK) {
            try (RandomAccessFile file = new RandomAccessFile(CloudFiles.file(context, key + ".zip"), "r")) {
                if (offset >= file.length()) return ""; file.seek(offset); byte[] bytes = new byte[(int) Math.min(49152, file.length() - offset)]; file.readFully(bytes); return Base64.encodeToString(bytes, Base64.NO_WRAP);
            } catch (Exception failure) { return ""; }
        }
    }
    @JavascriptInterface public void discard(String key) { if (key != null && key.matches("remote-[a-f0-9]{64}-[0-9]+")) synchronized (CloudFiles.LOCK) { CloudFiles.file(context, key + ".zip").delete(); CloudFiles.file(context, key + ".remote.json").delete(); } }
}

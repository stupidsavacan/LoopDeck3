package com.loopdeck3.app;

import org.json.JSONObject;
import javax.net.ssl.HttpsURLConnection;
import java.net.URL;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** No automatic redirects. All buffers are fixed size; credentials never enter diagnostics. */
final class CloudTransfer {
    static final class Failure extends IOException {
        final int status; final long retryAfter;
        Failure(int status, long retryAfter) { super("Cloud HTTP " + status); this.status = status; this.retryAfter = retryAfter; }
    }
    private final String origin, token;
    private final android.net.Network network;
    CloudTransfer(JSONObject credentials) throws Exception { origin = credentials.getString("origin"); token = credentials.getString("token"); network = null; }
    private CloudTransfer(String origin, String token, android.net.Network network) { this.origin = origin; this.token = token; this.network = network; }
    CloudTransfer on(android.net.Network wifi) { return new CloudTransfer(origin, token, wifi); }
    private HttpsURLConnection open(String path, String method) throws Exception {
        String url = origin + "/api/v1" + path;
        if (!CloudPolicy.permits(BuildConfig.SYNC_API_ORIGIN, url, method)) throw new SecurityException("Cloud URL rejected");
        // Pin large background transfers to the selected Wi-Fi network. A
        // mid-transfer Wi-Fi loss must fail instead of falling back to cellular.
        HttpsURLConnection c = (HttpsURLConnection) (network == null ? new URL(url).openConnection() : network.openConnection(new URL(url)));
        c.setInstanceFollowRedirects(false); c.setConnectTimeout(30000); c.setReadTimeout(60000); c.setRequestMethod(method);
        c.setRequestProperty("Authorization", "Bearer " + token); c.setRequestProperty("Cache-Control", "no-store"); return c;
    }
    private void status(HttpsURLConnection c) throws Exception {
        int status = c.getResponseCode(); if (status >= 200 && status < 300) return;
        long retry = 0; try { retry = Long.parseLong(c.getHeaderField("Retry-After")) * 1000; } catch (Exception ignored) {}
        throw new Failure(status, Math.max(0, retry));
    }
    private JSONObject response(HttpsURLConnection c) throws Exception {
        status(c); ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[16384];
        try (InputStream in = c.getInputStream()) { int n; while ((n = in.read(buffer)) >= 0) { if (out.size() + n > 1024 * 1024) throw new IOException("Response too large"); out.write(buffer, 0, n); } }
        return new JSONObject(out.toString("UTF-8"));
    }
    JSONObject get(String path) throws Exception { HttpsURLConnection c = open(path, "GET"); try { return response(c); } finally { c.disconnect(); } }
    JSONObject upload(JSONObject job, File zip) throws Exception {
        if (zip.length() > CloudPolicy.MAX_ZIP || zip.length() != job.getLong("size")) throw new IOException("ZIP size mismatch");
        HttpsURLConnection c = open("/packs/" + android.net.Uri.encode(job.getString("packId")) + "/revisions", "POST");
        try {
            c.setDoOutput(true); c.setFixedLengthStreamingMode(zip.length()); c.setRequestProperty("Content-Type", "application/zip");
            c.setRequestProperty("Idempotency-Key", job.getString("opId")); c.setRequestProperty("X-Content-Fingerprint", job.getString("fingerprint"));
            if (job.optBoolean("onlyIfAbsent")) c.setRequestProperty("If-None-Match", "*");
            try (InputStream in = new FileInputStream(zip); OutputStream out = c.getOutputStream()) { byte[] bytes = new byte[49152]; int n; while ((n = in.read(bytes)) >= 0) out.write(bytes, 0, n); }
            JSONObject result = response(c);
            if (!job.getString("packId").equals(result.getString("packId")) || !job.getString("fingerprint").equals(result.getString("contentFingerprint"))) throw new IOException("Upload receipt mismatch");
            return result;
        } finally { c.disconnect(); }
    }
    void download(JSONObject head, File destination) throws Exception {
        long expected = head.getLong("size"); if (expected > CloudPolicy.MAX_ZIP || expected < 0) throw new IOException("Invalid ZIP size");
        HttpsURLConnection c = open("/packs/" + android.net.Uri.encode(head.getString("packId")) + "/revisions/" + head.getLong("revision") + "/download", "GET");
        AtomicDownload result = new AtomicDownload(destination);
        try {
            status(c); MessageDigest digest = MessageDigest.getInstance("SHA-256"); long size = 0;
            try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(result.part)) {
                byte[] buffer = new byte[49152]; int n; while ((n = in.read(buffer)) >= 0) { size += n; if (size > expected) throw new IOException("ZIP too large"); digest.update(buffer, 0, n); out.write(buffer, 0, n); } out.getFD().sync();
            }
            if (size != expected || !CloudFiles.hex(digest.digest()).equals(head.getString("sha256"))) throw new IOException("ZIP checksum mismatch");
            if (!result.part.renameTo(destination)) throw new IOException("Cannot commit staged download");
        } finally { c.disconnect(); if (result.part.exists()) result.part.delete(); }
    }
    private static class AtomicDownload { final File part; AtomicDownload(File destination) { part = new File(destination.getPath() + ".part"); } }
}

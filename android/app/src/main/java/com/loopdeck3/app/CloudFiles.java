package com.loopdeck3.app;

import android.content.Context;
import android.util.AtomicFile;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

final class CloudFiles {
    static final Object LOCK = new Object();
    static File root(Context c) { File f = new File(c.getNoBackupFilesDir(), "cloud-sync"); if (!f.exists() && !f.mkdirs()) throw new IllegalStateException("Cannot create sync directory"); return f; }
    static File file(Context c, String name) { if (!name.matches("[A-Za-z0-9_.-]+")) throw new SecurityException("Invalid staging name"); return new File(root(c), name); }
    static void json(File file, JSONObject value) throws Exception {
        AtomicFile atomic = new AtomicFile(file); FileOutputStream out = atomic.startWrite();
        try { out.write(value.toString().getBytes(StandardCharsets.UTF_8)); atomic.finishWrite(out); }
        catch (Exception failure) { atomic.failWrite(out); throw failure; }
    }
    static JSONObject json(File file) throws Exception { return new JSONObject(new String(new AtomicFile(file).readFully(), StandardCharsets.UTF_8)); }
    static String hex(byte[] bytes) { StringBuilder out = new StringBuilder(); for (byte b : bytes) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 255)); return out.toString(); }
    static String id(String value) throws Exception { return hex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
    static boolean unresolved(Context context, JSONObject state, String packId) throws Exception {
        JSONObject mode = state.getJSONObject("states").optJSONObject(packId);
        if (mode == null || !mode.optBoolean("dirty")) return false;
        JSONObject jobs = state.getJSONObject("jobs"); boolean found = false;
        java.util.Iterator<String> keys = jobs.keys();
        while (keys.hasNext()) {
            String op = keys.next(); if (!packId.equals(jobs.getJSONObject(op).optString("packId"))) continue;
            found = true; if (!file(context, op + ".ack.json").exists()) return true;
        }
        return !found;
    }
}

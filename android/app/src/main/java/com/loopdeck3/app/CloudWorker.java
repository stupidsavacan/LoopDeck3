package com.loopdeck3.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import androidx.annotation.NonNull;
import androidx.work.*;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.util.Arrays;
import java.util.Comparator;
import java.util.concurrent.TimeUnit;

public final class CloudWorker extends Worker {
    public CloudWorker(@NonNull Context context, @NonNull WorkerParameters parameters) { super(context, parameters); }
    static void schedule(Context c) {
        if (BuildConfig.SYNC_API_ORIGIN.isEmpty()) return;
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        WorkManager manager = WorkManager.getInstance(c);
        manager.enqueueUniqueWork("loopdeck-cloud-now", ExistingWorkPolicy.KEEP, new OneTimeWorkRequest.Builder(CloudWorker.class)
                .setConstraints(constraints).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build());
        manager.enqueueUniquePeriodicWork("loopdeck-cloud-periodic", ExistingPeriodicWorkPolicy.KEEP, new PeriodicWorkRequest.Builder(CloudWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(constraints).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build());
    }
    static android.net.Network wifi(Context c) {
        ConnectivityManager manager = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
        android.net.Network selected = manager.getActiveNetwork();
        NetworkCapabilities network = manager.getNetworkCapabilities(selected);
        boolean wifi = network != null && network.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                && network.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                && !network.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
        return wifi ? selected : null;
    }
    private JSONObject state() throws Exception { return CloudFiles.json(CloudFiles.file(getApplicationContext(), "state.json")); }
    private boolean allowedJob(JSONObject state, String op) { return state.optJSONObject("jobs") != null && state.optJSONObject("jobs").has(op); }
    private boolean unresolved(JSONObject state, String packId) throws Exception {
        // Acknowledgements resolve native transfers without writing IndexedDB.
        // The foreground engine will consume the same receipts before applying.
        return CloudFiles.unresolved(getApplicationContext(), state, packId);
    }
    @NonNull @Override public Result doWork() {
        // Periodic and immediate WorkRequests can overlap. One OS-backed lease
        // protects staging files and operation ordering, including process death.
        try (java.io.RandomAccessFile file = new java.io.RandomAccessFile(CloudFiles.file(getApplicationContext(), "worker.lock"), "rw");
             java.nio.channels.FileChannel channel = file.getChannel()) {
            java.nio.channels.FileLock lease;
            try { lease = channel.tryLock(); } catch (java.nio.channels.OverlappingFileLockException busy) { return Result.retry(); }
            if (lease == null) return Result.retry();
            try { return transferWork(); } finally { lease.release(); }
        } catch (Exception unavailable) { return Result.retry(); }
    }
    private Result transferWork() {
        Context c = getApplicationContext(); boolean waiting = false;
        try {
            JSONObject credentials = new CloudCredentials(c).load(); if (credentials == null) return Result.success();
            JSONObject state = state(); if (!state.optBoolean("setupComplete")) return Result.success();
            CloudTransfer transfer = new CloudTransfer(credentials);
            File[] jobs = CloudFiles.root(c).listFiles((dir, name) -> name.endsWith(".job.json"));
            if (jobs == null) jobs = new File[0];
            Arrays.sort(jobs, Comparator.comparingLong(file -> { try { return CloudFiles.json(file).getLong("createdAt"); } catch (Exception invalid) { return Long.MAX_VALUE; } }));
            java.util.Set<String> blocked = new java.util.HashSet<>();
            for (File file : jobs) {
                if (isStopped()) return Result.retry();
                JSONObject job = CloudFiles.json(file); String op = job.getString("opId");
                synchronized (CloudFiles.LOCK) { if (!allowedJob(state(), op)) continue; }
                File zip = CloudFiles.file(c, op + ".zip"), ack = CloudFiles.file(c, op + ".ack.json");
                if (ack.exists()) continue;
                String pack = job.getString("packId"); if (blocked.contains(pack)) continue;
                if (job.optBoolean("permanent")) { blocked.add(pack); waiting = true; continue; }
                if (job.optLong("notBefore") > System.currentTimeMillis()) { blocked.add(pack); waiting = true; continue; }
                android.net.Network wifi = wifi(c); boolean large = CloudPolicy.needsWifi(job.getLong("size"));
                if (large && wifi == null) { blocked.add(pack); waiting = true; continue; }
                try { JSONObject receipt = (large ? transfer.on(wifi) : transfer).upload(job, zip); synchronized (CloudFiles.LOCK) { if (allowedJob(state(), op)) CloudFiles.json(ack, receipt); } }
                catch (CloudTransfer.Failure failure) {
                    if (failure.status == 412 && job.optBoolean("onlyIfAbsent")) { synchronized (CloudFiles.LOCK) { if (allowedJob(state(), op)) CloudFiles.json(ack, new JSONObject().put("creationConflict", true)); } continue; }
                    if (failure.status == 401) { new CloudCredentials(c).clear(); return Result.success(); }
                    int attempts = job.optInt("attempts") + 1;
                    job.put("attempts", attempts).put("notBefore", System.currentTimeMillis() + Math.max(failure.retryAfter, Math.min(3600000, 1000L << Math.min(attempts, 12))))
                            .put("permanent", failure.status == 400 || failure.status == 409 || failure.status == 413 || failure.status == 415 || failure.status == 422);
                    synchronized (CloudFiles.LOCK) { if (allowedJob(state(), op)) CloudFiles.json(file, job); }
                    waiting = true;
                    blocked.add(pack);
                }
            }
            String cursor = null; java.util.Set<String> cursors = new java.util.HashSet<>();
            do {
                JSONObject page = transfer.get("/packs" + (cursor == null ? "" : "?after=" + android.net.Uri.encode(cursor)));
                JSONArray heads = page.getJSONArray("packs");
                for (int i = 0; i < heads.length(); i++) {
                    if (isStopped()) return Result.retry();
                    JSONObject head = heads.getJSONObject(i); String id = head.getString("packId");
                    state = state(); JSONObject modes = state.optJSONObject("states"), mode = modes == null ? null : modes.optJSONObject(id);
                    if (mode != null && (!"enabled".equals(mode.optString("mode")) || unresolved(state, id) || mode.optLong("remoteRevision") >= head.getLong("revision"))) continue;
                    android.net.Network wifi = wifi(c); boolean large = CloudPolicy.needsWifi(head.getLong("size"));
                    if (large && wifi == null) { waiting = true; continue; }
                    String key = "remote-" + CloudFiles.id(id) + "-" + head.getLong("revision"); File zip = CloudFiles.file(c, key + ".zip"), metadata = CloudFiles.file(c, key + ".remote.json");
                    if (zip.exists() && metadata.exists()) continue;
                    (large ? transfer.on(wifi) : transfer).download(head, zip);
                    synchronized (CloudFiles.LOCK) {
                        JSONObject latestState = state(), current = latestState.getJSONObject("states").optJSONObject(id);
                        long generation = mode == null ? 0 : mode.optLong("generation");
                        if (current != null && (!"enabled".equals(current.optString("mode")) || unresolved(latestState, id) || current.optLong("generation") != generation)) { zip.delete(); continue; }
                        CloudFiles.json(metadata, new JSONObject().put("head", head).put("key", key).put("expectedGeneration", generation));
                        File[] old = CloudFiles.root(c).listFiles((dir, name) -> name.endsWith(".remote.json"));
                        if (old != null) for (File f : old) {
                            if (f.equals(metadata)) continue;
                            JSONObject previous = CloudFiles.json(f);
                            if (id.equals(previous.getJSONObject("head").getString("packId")) && previous.getJSONObject("head").getLong("revision") < head.getLong("revision")) { CloudFiles.file(c, previous.getString("key") + ".zip").delete(); f.delete(); }
                        }
                    }
                }
                cursor = page.isNull("nextCursor") ? null : page.getString("nextCursor");
                if (cursor != null && !cursors.add(cursor)) throw new IllegalStateException("Repeated cursor");
            } while (cursor != null);
            return waiting ? Result.retry() : Result.success();
        } catch (CloudTransfer.Failure failure) {
            if (failure.status == 401) { new CloudCredentials(c).clear(); return Result.success(); }
            return Result.retry();
        } catch (Exception failure) { return Result.retry(); }
    }
}

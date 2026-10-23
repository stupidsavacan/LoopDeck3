package com.loopdeck3.app;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Bundle;
import android.util.Base64;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Separate, same-signed test APK. No secrets are compiled into either APK. */
public final class ReleaseSmokeInstrumentation extends Instrumentation {
    private String socketName;
    private boolean uiMode;
    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        socketName = arguments.getString("socket");
        uiMode = "true".equals(arguments.getString("ui"));
        start();
    }
    private static void check(boolean condition) throws Exception {
        if (!condition) throw new Exception("Release QA check failed");
    }
    @Override public void onStart() {
        if (uiMode) {
            ReleaseUiHarness.run(this, socketName);
            return;
        }
        Bundle result = new Bundle();
        String stage = "initialize";
        try {
            Context context = getTargetContext();
            check(context.getPackageName().equals("com.loopdeck3.app.syncpreview.release"));
            check((context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0);
            check(!BuildConfig.DEBUG);
            check(socketName != null && socketName.matches("loopdeck-release-qa-[a-f0-9-]{36}"));
            stage = "socket";
            JSONObject input;
            try (LocalServerSocket server = new LocalServerSocket(socketName)) {
                Bundle ready = new Bundle(); ready.putString("qa", "READY"); sendStatus(1, ready);
                try (LocalSocket socket = server.accept()) {
                    socket.setSoTimeout(30000);
                    DataInputStream stream = new DataInputStream(socket.getInputStream());
                    int length = stream.readInt(); check(length > 0 && length <= 1024 * 1024);
                    byte[] payload = new byte[length]; stream.readFully(payload);
                    input = new JSONObject(new String(payload, StandardCharsets.UTF_8));
                }
            }
            String origin = BuildConfig.SYNC_API_ORIGIN, token = input.getString("token");
            stage = "anonymous-health";
            CloudTransfer anonymous = new CloudTransfer(new JSONObject().put("origin", origin).put("token", "0".repeat(64)));
            anonymous.get("/health");
            stage = "unauthenticated-me";
            boolean rejected = false;
            try { anonymous.get("/auth/me"); } catch (CloudTransfer.Failure failure) { rejected = failure.status == 401; }
            check(rejected);
            check(!CloudPolicy.permits(origin, origin + "/api/v1/unknown", "GET"));
            check(!CloudPolicy.permits(origin, "https://example.invalid/api/v1/health", "GET"));
            check(!CloudPolicy.permits(origin, origin.replace("https:", "http:") + "/api/v1/health", "GET"));
            stage = "keystore";
            CloudCredentials credentials = new CloudCredentials(context); credentials.save(origin, token);
            check(credentials.load().getString("token").equals(token));
            byte[] envelope;
            try (InputStream in = new FileInputStream(new File(context.getNoBackupFilesDir(), "cloud-credentials"))) {
                ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] chunk = new byte[4096]; int n;
                while ((n = in.read(chunk)) >= 0) out.write(chunk, 0, n); envelope = out.toByteArray();
            }
            check(!new String(envelope, StandardCharsets.ISO_8859_1).contains(token));
            stage = "authenticated-me";
            CloudTransfer transfer = new CloudTransfer(credentials.load()); transfer.get("/auth/me");
            JSONObject job = input.getJSONObject("job"); byte[] bytes = Base64.decode(input.getString("zip"), Base64.NO_WRAP);
            check(CloudFiles.hex(MessageDigest.getInstance("SHA-256").digest(bytes)).equals(job.getString("sha256")));
            File upload = CloudFiles.file(context, "release-qa.zip"), download = CloudFiles.file(context, "release-qa-download.zip");
            try (FileOutputStream out = new FileOutputStream(upload)) { out.write(bytes); out.getFD().sync(); }
            stage = "upload";
            JSONObject receipt = transfer.upload(job, upload);
            check(receipt.getString("sha256").equals(job.getString("sha256")));
            stage = "download";
            transfer.download(receipt, download);
            check(download.length() == bytes.length);
            check(transfer.get("/packs").getJSONArray("packs").length() > 0);
            upload.delete(); download.delete();
            context.startActivity(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            JSONObject publicResult = new JSONObject().put("status", "PASS").put("applicationId", context.getPackageName())
                    .put("debuggable", false).put("buildConfigDebug", BuildConfig.DEBUG)
                    .put("health", 200).put("unauthenticatedMe", 401).put("authenticatedMe", 200)
                    .put("packId", receipt.getString("packId")).put("revision", receipt.getLong("revision"))
                    .put("bytes", bytes.length).put("sha256", receipt.getString("sha256"))
                    .put("keystoreRoundTrip", true).put("credentialPlaintextAbsent", true).put("nativeDownloadShaVerified", true);
            result.putString("qaResult", publicResult.toString()); finish(Activity.RESULT_OK, result);
        } catch (Exception failure) {
            result.putString("qaResult", "{\"status\":\"FAIL\",\"exception\":\"" + failure.getClass().getSimpleName() + "\",\"stage\":\"" + stage + "\",\"httpStatus\":" + (failure instanceof CloudTransfer.Failure ? ((CloudTransfer.Failure) failure).status : 0) + "}");
            finish(Activity.RESULT_CANCELED, result);
        }
    }
}

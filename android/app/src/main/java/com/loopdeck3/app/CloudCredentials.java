package com.loopdeck3.app;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;

final class CloudCredentials {
    private static final String ALIAS = "loopdeck-cloud-token-v1";
    private final AtomicFile file;
    CloudCredentials(Context context) { file = new AtomicFile(new File(context.getNoBackupFilesDir(), "cloud-credentials")); }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(ALIAS, null);
    }
    synchronized void save(String origin, String token) throws Exception {
        if (!CloudPolicy.permits(BuildConfig.SYNC_API_ORIGIN, origin.replaceAll("/$", "") + "/api/v1/auth/me", "GET")
                || !token.matches("[a-f0-9]{64}")) throw new SecurityException("Invalid cloud credentials");
        JSONObject value = new JSONObject().put("origin", origin.replaceAll("/$", "")).put("token", token);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] encrypted = cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8)), iv = cipher.getIV();
        FileOutputStream output = file.startWrite();
        try { output.write(ByteBuffer.allocate(1 + iv.length + encrypted.length).put((byte) iv.length).put(iv).put(encrypted).array()); file.finishWrite(output); }
        catch (Exception failure) { file.failWrite(output); throw failure; }
    }
    synchronized JSONObject load() throws Exception {
        if (!file.getBaseFile().exists()) return null;
        ByteBuffer value = ByteBuffer.wrap(file.readFully()); int size = value.get() & 255;
        if (size != 12 || value.remaining() <= size) throw new SecurityException("Invalid credentials envelope");
        byte[] iv = new byte[size]; value.get(iv); byte[] bytes = new byte[value.remaining()]; value.get(bytes);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
        JSONObject decoded = new JSONObject(new String(cipher.doFinal(bytes), StandardCharsets.UTF_8));
        if (!CloudPolicy.permits(BuildConfig.SYNC_API_ORIGIN, decoded.getString("origin") + "/api/v1/auth/me", "GET")) throw new SecurityException("Origin changed");
        return decoded;
    }
    synchronized void clear() { file.delete(); }
}

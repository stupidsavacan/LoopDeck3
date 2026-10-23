package com.loopdeck3.app;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Runs normal WebView handlers through same-signed instrumentation, never CDP. */
final class ReleaseUiHarness {
    private final Instrumentation instrumentation;
    private WebView web;
    private String stage = "initialize";
    private ReleaseUiHarness(Instrumentation instrumentation) { this.instrumentation = instrumentation; }
    private static void check(boolean value) throws Exception { if (!value) throw new Exception("UI QA check failed"); }
    private static WebView findWeb(View view) {
        if (view instanceof WebView) return (WebView) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int n = 0; n < group.getChildCount(); n++) { WebView found = findWeb(group.getChildAt(n)); if (found != null) return found; }
        }
        return null;
    }
    private String evaluate(String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1); String[] value = new String[1];
        instrumentation.runOnMainSync(() -> web.evaluateJavascript(script, result -> { value[0] = result; done.countDown(); }));
        check(done.await(15, TimeUnit.SECONDS)); return value[0];
    }
    private void waitFor(String predicate) throws Exception {
        long end = System.currentTimeMillis() + 180000;
        while (System.currentTimeMillis() < end) { if ("true".equals(evaluate("Boolean(" + predicate + ")"))) return; Thread.sleep(300); }
        throw new Exception("UI condition timed out");
    }
    private String asset(String name) throws Exception {
        try (InputStream in = instrumentation.getContext().getAssets().open(name)) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] chunk = new byte[4096]; int n;
            while ((n = in.read(chunk)) >= 0) bytes.write(chunk, 0, n);
            return bytes.toString("UTF-8");
        }
    }
    private JSONObject snapshot() throws Exception {
        evaluate("window.__releaseQaSnapshot=null;"); evaluate(asset("release-ui-snapshot.js"));
        waitFor("window.__releaseQaSnapshot !== null");
        JSONObject value = new JSONObject((String) new JSONTokener(evaluate("JSON.stringify(window.__releaseQaSnapshot)")).nextValue());
        check(!value.optBoolean("qaError")); return value;
    }
    private void click(String text) throws Exception {
        String match = "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===" + JSONObject.quote(text) + "&&!b.disabled)";
        waitFor(match); evaluate("(" + match + ").click()");
    }
    static void run(Instrumentation instrumentation, String socketName) {
        ReleaseUiHarness harness = new ReleaseUiHarness(instrumentation); Bundle result = new Bundle();
        try { result.putString("qaResult", harness.run(socketName).toString()); instrumentation.finish(Activity.RESULT_OK, result); }
        catch (Exception failure) {
            result.putString("qaResult", "{\"status\":\"FAIL\",\"stage\":\"" + harness.stage + "\",\"exception\":\"" + failure.getClass().getSimpleName() + "\"}");
            instrumentation.finish(Activity.RESULT_CANCELED, result);
        }
    }
    private JSONObject run(String socketName) throws Exception {
        check(instrumentation.getTargetContext().getPackageName().equals("com.loopdeck3.app.syncpreview.release"));
        check(!BuildConfig.DEBUG && (instrumentation.getTargetContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0);
        check(socketName != null && socketName.matches("loopdeck-release-qa-[a-f0-9-]{36}"));
        JSONObject input;
        stage = "private-socket";
        try (LocalServerSocket server = new LocalServerSocket(socketName)) {
            Bundle ready = new Bundle(); ready.putString("qa", "READY"); instrumentation.sendStatus(1, ready);
            try (LocalSocket socket = server.accept()) {
                socket.setSoTimeout(30000); DataInputStream stream = new DataInputStream(socket.getInputStream());
                int length = stream.readInt(); check(length > 0 && length <= 1024 * 1024);
                byte[] bytes = new byte[length]; stream.readFully(bytes); input = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            }
        }
        stage = "launch";
        Activity activity = instrumentation.startActivitySync(new Intent(instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        instrumentation.runOnMainSync(() -> web = findWeb(activity.getWindow().getDecorView())); check(web != null);
        waitFor("document.querySelector('.home-screen') && document.querySelector('.cloud-sync-icon')");
        evaluate("(()=>{const original=window.fetch,records=[];window.__releaseQaHttp=records;window.__releaseQaOriginalFetch=original;window.fetch=function(...args){return Reflect.apply(original,this,args).then(response=>{const request=args[0];if(records.length<128)records.push({path:new URL(typeof request==='string'?request:request.url).pathname,method:args[1]?.method??request.method??'GET',status:response.status});return response;});};})()");
        String id = input.getString("packId"); evaluate("window.__releaseQaTarget=" + JSONObject.quote(id));
        JSONObject before = snapshot(); boolean upload = "upload".equals(input.getString("phase"));
        if (upload) {
            stage = "login-form"; evaluate("document.querySelector('.cloud-sync-icon').click()");
            waitFor("document.querySelector('input[type=password]')");
            evaluate("document.querySelector('input[type=password]').value=" + JSONObject.quote(input.getString("phrase")) + ";document.querySelector('input[aria-label=\"端末名\"]').value='Release UI QA';");
            stage = "login-http"; click("ログイン");
            waitFor("Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='この設定で自動同期を開始')");
            check("true".equals(evaluate("!document.querySelector('input[type=password]')")));
            stage = "first-setup";
            check("true".equals(evaluate("(()=>{let builtin=0;for(const label of document.querySelectorAll('.cloud-sync-dialog label')){const c=label.querySelector('input[type=checkbox]');if(c&&label.textContent.startsWith('この端末への取り込みを除外:')){const keep=label.textContent.includes('LoopDeck内蔵教材');c.checked=!keep;if(keep)builtin++;}}return builtin===1;})()")));
            click("この設定で自動同期を開始");
            waitFor("document.querySelector('.cloud-sync-icon')?.dataset.status==='ready'");
            JSONObject imported = snapshot(); check(imported.getInt("builtinQuestions") == 1112); check(imported.getInt("builtinImages") == 4);
            stage = "normal-import"; evaluate("document.querySelector('.cloud-sync-dialog').close();location.hash='import'");
            waitFor("document.querySelector('.import-screen input[type=file]')");
            String pack = input.getJSONObject("pack").toString();
            evaluate("(()=>{const input=document.querySelector('.import-screen input[type=file]');const dt=new DataTransfer();dt.items.add(new File([" + JSONObject.quote(pack) + "],'release-ui-dummy.loopdeck.json',{type:'application/json'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()");
            click("この教材を取り込む"); waitFor("document.querySelector('.home-screen')");
        }
        stage = upload ? "automatic-upload" : "automatic-startup-receive";
        JSONObject after = null; long end = System.currentTimeMillis() + 180000;
        while (System.currentTimeMillis() < end) {
            after = snapshot(); JSONObject target = null;
            JSONArray states = after.getJSONArray("states");
            for (int n = 0; n < states.length(); n++) if (id.equals(states.getJSONObject(n).getString("packId"))) target = states.getJSONObject(n);
            boolean revision = target != null && target.optLong("remoteRevision") >= input.optLong("revision", 1) && !target.optBoolean("dirty");
            if (after.optBoolean("targetPresent") && revision && input.getString("answer").equals(after.optString("targetAnswer")) && after.getInt("outboxCount") == 0 && "ready".equals(after.optString("status"))) break;
            after = null; Thread.sleep(700);
        }
        check(after != null && after.getBoolean("nativeTokenReference"));
        check(before.getJSONObject("learning").toString().equals(after.getJSONObject("learning").toString()));
        for (java.util.Iterator<String> keys = before.getJSONObject("packs").keys(); keys.hasNext();) {
            String key = keys.next(); if (!key.equals(id)) check(before.getJSONObject("packs").getString(key).equals(after.getJSONObject("packs").optString(key)));
        }
        stage = "native-auth-confirmation";
        JSONObject credentials = new CloudCredentials(instrumentation.getTargetContext()).load(); check(credentials != null);
        new CloudTransfer(credentials).get("/auth/me");
        JSONArray http = new JSONArray((String) new JSONTokener(evaluate("JSON.stringify(window.__releaseQaHttp)")).nextValue());
        evaluate("window.fetch=window.__releaseQaOriginalFetch;delete window.__releaseQaOriginalFetch;delete window.__releaseQaHttp;delete window.__releaseQaSnapshot;delete window.__releaseQaTarget;document.querySelector('.cloud-sync-dialog')?.close();location.hash='home'");
        return new JSONObject().put("status", "PASS").put("phase", input.getString("phase")).put("snapshot", after)
                .put("learningUnchanged", true).put("http", http).put("authenticatedMe", 200)
                .put("debuggable", false).put("usedCdp", false).put("usedNormalUiHandlers", true);
    }
}

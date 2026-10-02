package app.prevodilac;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Hosts the Prevodilac web app (bundled in assets/www) in a full-screen WebView.
 * Pages are served from https://appassets.androidplatform.net so localStorage
 * behaves like on a normal https site.
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/assets/www/index.html";

    /** How long a downloaded page gets to report it started before the bundled page is used again. */
    private static final long PAGE_START_TIMEOUT = 15000;
    /** A page update downloaded in the background is applied when returning after this long. */
    private static final long RELOAD_AFTER_AWAY = 10 * 60 * 1000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView webView;
    private WebUpdater web;
    private TextToSpeech tts;
    private boolean ttsReady;
    private boolean pageReady;
    private boolean pageUpdatePending;
    private boolean installAfterPermission;
    private long pausedAt;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebUpdater(this);
        // A downloaded page (see WebUpdater) is served at the same URL as the bundled one.
        final WebViewAssetLoader.AssetsPathHandler assets = new WebViewAssetLoader.AssetsPathHandler(this);
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", path -> {
                    WebResourceResponse page = web.intercept(path);
                    return page != null ? page : assets.handle(path);
                })
                .build();

        webView = new WebView(this);
        webView.setBackgroundColor(getColor(R.color.bg));
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        webView.addJavascriptInterface(new Bridge(), "PrevodilacAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (HOST.equals(url.getHost())) return false;
                // Anything outside the app opens in the browser.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (ActivityNotFoundException ignored) {
                }
                return true;
            }
        });

        // Norwegian speech: WebView has no Web Speech API, so the page calls speak() instead.
        tts = new TextToSpeech(this, status -> {
            if (status != TextToSpeech.SUCCESS) return;
            int r = tts.setLanguage(new Locale("nb", "NO"));
            if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
                r = tts.setLanguage(new Locale("no", "NO"));
            }
            ttsReady = r != TextToSpeech.LANG_MISSING_DATA && r != TextToSpeech.LANG_NOT_SUPPORTED;
        });

        if (savedInstanceState != null) webView.restoreState(savedInstanceState);
        else webView.loadUrl(START_URL);
        watchPageStart();

        ApkInstaller.handleStatus(this, getIntent(), this::toast);
        if (savedInstanceState == null) checkForUpdate(false);
    }

    @Override
    protected void onDestroy() {
        if (tts != null) tts.shutdown();
        super.onDestroy();
    }

    /** If a downloaded page never reports that it started, fall back to the bundled page. */
    private void watchPageStart() {
        pageReady = false;
        handler.removeCallbacks(pageStartCheck);
        if (web.isActive()) handler.postDelayed(pageStartCheck, PAGE_START_TIMEOUT);
    }

    private final Runnable pageStartCheck = () -> {
        if (pageReady || !web.isActive()) return;
        web.rollBack();
        webView.loadUrl(START_URL);
        pageReady = false;
    };

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        ApkInstaller.handleStatus(this, intent, this::toast);
    }

    @Override
    protected void onPause() {
        super.onPause();
        pausedAt = System.currentTimeMillis();
        if (tts != null) tts.stop();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (installAfterPermission && getPackageManager().canRequestPackageInstalls()) {
            installAfterPermission = false;
            startApkInstall();
        } else if (pageUpdatePending && pausedAt > 0
                && System.currentTimeMillis() - pausedAt > RELOAD_AFTER_AWAY) {
            pageUpdatePending = false;
            webView.loadUrl(START_URL);
            watchPageStart();
        }
    }

    /* ---------- update check ---------- */

    private static final long UPDATE_CHECK_INTERVAL = 12 * 60 * 60 * 1000L;

    /**
     * Two kinds of updates:
     * 1. The web page (WebUpdater): downloaded silently and used from the next start.
     * 2. The APK: the latest GitHub Release (tagged v1.0.<versionCode>); offered in a dialog
     *    and installed from inside the app (ApkInstaller).
     * On launch the page is checked every time and the APK at most every 12 hours, silently;
     * the "Провери ажурирања" button checks both right away and reports the result.
     */
    private void checkForUpdate(final boolean manual) {
        final SharedPreferences prefs = getSharedPreferences("update", MODE_PRIVATE);
        long now = System.currentTimeMillis();
        final boolean checkApk = manual || now - prefs.getLong("lastCheck", 0) >= UPDATE_CHECK_INTERVAL;
        if (checkApk) prefs.edit().putLong("lastCheck", now).apply();
        if (manual) toast("Проверавам ажурирања…");

        new Thread(() -> {
            boolean newPage = false, pageChecked = false;
            try {
                newPage = web.check();
                pageChecked = true;
            } catch (Exception ignored) {
                // Offline or GitHub unreachable: keep the current page.
            }
            final boolean pageUpdated = newPage;
            if (pageUpdated && !manual) runOnUiThread(() -> pageUpdatePending = true);
            if (!checkApk) return;
            try {
                URL api = new URL("https://api.github.com/repos/" + BuildConfig.UPDATE_REPO + "/releases/latest");
                HttpURLConnection c = (HttpURLConnection) api.openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                c.setRequestProperty("Accept", "application/vnd.github+json");
                if (c.getResponseCode() != 200) throw new IllegalStateException("HTTP " + c.getResponseCode());
                String body;
                try (InputStream in = c.getInputStream()) {
                    ByteArrayOutputStream buf = new ByteArrayOutputStream();
                    byte[] b = new byte[8192];
                    for (int n; (n = in.read(b)) > 0; ) buf.write(b, 0, n);
                    body = buf.toString("UTF-8");
                }
                String tag = new JSONObject(body).optString("tag_name", "");
                final long latest = Long.parseLong(tag.substring(tag.lastIndexOf('.') + 1));
                final String name = tag.startsWith("v") ? tag.substring(1) : tag;
                // A newer release with the same Android part as this app only has web changes, which
                // WebUpdater already brings in quietly; only offer the APK when android/ changed.
                Matcher nat = Pattern.compile("native: ([0-9a-f]{12})").matcher(new JSONObject(body).optString("body", ""));
                boolean sameNative = nat.find() && nat.group(1).equals(BuildConfig.NATIVE_HASH);
                if (latest > installedVersionCode() && !sameNative) runOnUiThread(() -> showUpdateDialog(name));
                else if (manual && pageUpdated) runOnUiThread(this::showPageUpdatedDialog);
                else if (manual) toast("Имаш најновију верзију");
            } catch (Exception e) {
                // No network, rate limit or unexpected response: the automatic check tries again later.
                if (manual && pageUpdated) runOnUiThread(this::showPageUpdatedDialog);
                else if (manual && pageChecked) toast("Имаш најновију верзију");
                else if (manual) toast("Провера није успела. Јеси ли на интернету?");
            }
        }).start();
    }

    private void showPageUpdatedDialog() {
        if (isFinishing()) return;
        new AlertDialog.Builder(this)
                .setTitle("Ажурирање је преузето")
                .setMessage("Нова верзија Преводиоца је спремна. Покренути је сада? Историја и подешавања остају.")
                .setPositiveButton("Покрени", (d, w) -> {
                    pageUpdatePending = false;
                    webView.loadUrl(START_URL);
                    watchPageStart();
                })
                .setNegativeButton("Касније", (d, w) -> pageUpdatePending = true)
                .show();
    }

    private void startApkInstall() {
        if (!ApkInstaller.ensureAllowed(this)) {
            installAfterPermission = true;
            Toast.makeText(this, "Дозволи Преводиоцу да инсталира ажурирања, па се врати", Toast.LENGTH_LONG).show();
            return;
        }
        toast("Преузимам ажурирање…");
        new Thread(() -> ApkInstaller.downloadAndInstall(this, this::toast)).start();
    }

    private void toast(final String msg) {
        runOnUiThread(() -> Toast.makeText(this, msg, Toast.LENGTH_SHORT).show());
    }

    private long installedVersionCode() throws Exception {
        PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    private void showUpdateDialog(String version) {
        if (isFinishing()) return;
        new AlertDialog.Builder(this)
                .setTitle("Ново ажурирање")
                .setMessage("Преводилац " + version + " је спреман. Инсталирати сада? Историја и подешавања остају.")
                .setPositiveButton("Ажурирај", (d, w) -> startApkInstall())
                .setNegativeButton("Касније", null)
                .show();
    }

    /** Methods index.html can call as window.PrevodilacAndroid.*. */
    private class Bridge {
        @JavascriptInterface
        public String getVersion() {
            String page = web.activeId();
            return page.isEmpty() ? BuildConfig.VERSION_NAME : BuildConfig.VERSION_NAME + " · страница " + page;
        }

        /** Called by index.html once it has rendered; proves a downloaded page works. */
        @JavascriptInterface
        public void ready() {
            runOnUiThread(() -> pageReady = true);
        }

        @JavascriptInterface
        public void checkForUpdate() {
            runOnUiThread(() -> MainActivity.this.checkForUpdate(true));
        }

        /** Speaks Norwegian text with the phone's speech engine. */
        @JavascriptInterface
        public void speak(final String text) {
            runOnUiThread(() -> {
                if (tts == null || !ttsReady) {
                    Toast.makeText(MainActivity.this,
                            "Норвешки глас није инсталиран. Додај га у подешавањима телефона (претварање текста у говор).",
                            Toast.LENGTH_LONG).show();
                    return;
                }
                tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "prevodilac");
            });
        }
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }
}

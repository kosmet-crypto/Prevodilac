# Prevodilac: notes for Claude

Prevodilac is a free Serbian ⇄ Norwegian (bokmål) translator and learning app. One web page
(`index.html`, vanilla JS, data in `localStorage`) is shipped three ways: GitHub Pages (web),
PWA (`manifest.json`, `sw.js`), and an Android app (`android/`, a WebView wrapper whose APK
GitHub Actions builds on every push and publishes as a Release on pushes to `main`).

The owner talks in Serbian (Cyrillic); answer in Serbian. UI text is Serbian Cyrillic.
Code, comments and commit messages are in English (existing page comments are Serbian; keep the
style of the surrounding code).

## Hard requirements from the owner
- No Claude/AI API and nothing that costs money. Translation uses the free MyMemory API
  (`https://api.mymemory.translated.net/get`, no key). Idioms, phrases and the quiz are built in.
- Credit line is exactly: `Аутор: Ivan S. · Epicurus001 · Srbija / Norge` (footer and README).
  Nothing else in the way of credits.

## Privacy (important)
- The owner's real name and email must never appear in this repo. Commit as
  `Claude <noreply@anthropic.com>`, never with a name or email taken from git config or the session.

## Content rules
- `IDIOMS` (in `index.html`): `dir` "sr" or "no", `re` is matched against normalised text
  (Serbian: Latin, lower case, no diacritics, đ → dj; Norwegian: lower case). `has: false` means
  there is no real equivalent and `equivalent` is the most natural description.
- `PHRASES` / `PHRASE_CATS`: everyday phrases by situation, Serbian in Cyrillic, Norwegian bokmål.
- `WORDS` / `WORD_TOPICS`: vocabulary as `[no, forms, sr, level, topic, note]`. Nouns with
  en/ei/et and forms "definite sg, indefinite pl, definite pl"; verbs with "å" and forms
  "present, preterite, har + perfect"; adjectives "neuter, plural". All listed forms are indexed so
  "Речи из текста" can find inflected words in translations.
- Every entry has a CEFR `level` (checked, not copied blindly); the Изрази/Фразе/Речи tabs and the
  quiz filter by it. The owner may paste batches generated in another Claude chat: verify the
  Norwegian, drop duplicates, fix levels and report which levels were changed.
- Only add Norwegian you are confident is correct, natural bokmål.

## Rules that keep updates working
- **Page changes (`index.html`)**
  - Bump `VERSION` in `sw.js` so PWA caches refresh.
  - The Android app downloads `index.html` from `main` on start (`WebUpdater`). It must stay a
    single self-contained file, larger than 20 000 characters, and keep `id="tab-translate"`.
  - If the page starts calling a new `PrevodilacAndroid` bridge method, raise
    `<meta name="prevodilac-native-api">` in `index.html` and `WebUpdater.NATIVE_API` together.
  - Keep `PrevodilacAndroid.ready()` being called after the first render. Without it the app rolls
    a downloaded page back to the bundled one.
  - Bridge methods: `ready()`, `getVersion()`, `checkForUpdate()`, `speak(text)` (Android
    TextToSpeech, because WebView has no Web Speech API).
- **Version numbers:** `versionCode` = Actions `run_number + 0` (`android/app/build.gradle`), and
  the release tag is `v1.0.<run_number + BUILD_OFFSET>` (`.github/workflows/android.yml`). Keep both in sync.
- **APK offers:** CI fingerprints `android/` into `BuildConfig.NATIVE_HASH` and the release notes
  (`native: <hash>`). The app only offers an APK when that fingerprint changes.
- **Signing:** `android/app/prevodilac.keystore` must never change, or installed apps cannot update.

## Workflow
- Before pushing, test the page in headless Chromium (Playwright is preinstalled): load
  `index.html`, exercise the change, and check for page errors. MyMemory is usually not reachable
  from the dev container; mock it with `page.route`.
- The Android SDK is not reachable from the dev container; CI is the Gradle build. Java can be
  compile-checked with `javac --release 17` against Robolectric's `android-all` jar from Maven
  Central plus a small stub for `androidx.webkit.WebViewAssetLoader`, `BuildConfig` and `R`.
- Keep replies short: what was done and what the owner should try.

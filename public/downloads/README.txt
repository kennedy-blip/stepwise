STEPWISE — ANDROID APK DROP LOCATION
====================================

This directory is the download target for the in-game
"Download Android APK (One-Tap)" button.

The button points at:
    /downloads/stepwise.apk
which is configured in:
    src/game/config.ts  ->  APK_DOWNLOAD_URL

HOW TO SHIP A REAL APK
----------------------

1. Build the web bundle:
       npm run build
   This emits the static site into ./dist

2. Wrap it for Android. Two supported routes:

   a) Bubblewrap (Trusted Web Activity) — simplest:
        npm install -g @bubblewrap/cli
        bubblewrap init --manifest https://your-domain.com/.well-known/assetlinks.json
        bubblewrap build
      The resulting .aab / .apk is signed with a local debug key by default.

   b) Capacitor — full native shell with haptic plugins:
        npm install @capacitor/core @capacitor/cli @capacitor/android
        npx cap init "Stepwise" "ai.arena.stepwise" --web-dir=dist
        npx cap add android
        npx cap sync android
        npx cap open android      # then build a release APK in Android Studio
      For release signing, configure a keystore and run:
        cd android && ./gradlew assembleRelease

3. Copy the resulting binary here, named exactly:
        public/downloads/stepwise.apk

4. Rebuild and redeploy:
        npm run build
        vercel --prod

Until a signed binary is provided, this README is what ships in the folder and
the download button will gracefully serve this notice instead of a broken
binary. The game itself is fully playable in the browser with no install.

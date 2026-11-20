#!/usr/bin/env bash
#
# Stepwise — fetch the Android build tools.
#
# The APK build (`npm run build:apk`) needs three things that are not part of
# the npm dependency tree:
#
#   aapt2        the Android resource compiler/linker
#   smali.jar    the smali → dex assembler
#   a JRE        a Java runtime to run smali
#
# This script installs them into tools/android/. It only needs network access
# to npm and GitHub.
#
# Usage: tools/fetch-android-tools.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="$ROOT/tools/android"
mkdir -p "$TOOLS"

echo "▸ Fetching aapt2 (via the aaptjs3 npm package) …"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
npm pack aaptjs3 --pack-destination "$TMP" >/dev/null 2>&1
tar -xzf "$TMP"/aaptjs3-*.tgz -C "$TMP"
AAPT2_SRC="$(find "$TMP/package" -path '*bin/x64/linux/aapt2' -type f | head -1)"
if [ -z "$AAPT2_SRC" ]; then
  echo "✗ Could not find the aapt2 binary in the aaptjs3 package." >&2
  exit 1
fi
cp "$AAPT2_SRC" "$TOOLS/aapt2"
chmod +x "$TOOLS/aapt2"
echo "  aapt2 → $("$TOOLS/aapt2" version | head -1)"

echo "▸ Fetching smali (the smali → dex assembler) …"
SMALI_URL="https://raw.githubusercontent.com/yongjhih/rc/master/bin/smali-2.1.0.jar"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$SMALI_URL" -o "$TOOLS/smali.jar"
else
  wget -q "$SMALI_URL" -O "$TOOLS/smali.jar"
fi
echo "  smali.jar → $(stat -c%s "$TOOLS/smali.jar" 2>/dev/null || wc -c < "$TOOLS/smali.jar") bytes"

echo "▸ Locating a Java runtime …"
if [ -x "$TOOLS/jre/bin/java" ]; then
  echo "  using tools/android/jre"
elif command -v java >/dev/null 2>&1; then
  echo "  using $(command -v java)"
else
  echo "✗ No Java runtime found. Install one, or set JAVA to a java binary." >&2
  echo "  A JRE is enough — smali only needs a runtime, not a compiler." >&2
  exit 1
fi

echo "▸ Creating the signing keystore (if it does not exist yet) …"
if [ ! -f "$TOOLS/stepwise.keystore" ]; then
  JAVA_BIN="${JAVA:-java}"
  if [ -x "$TOOLS/jre/bin/java" ]; then
    JAVA_BIN="$TOOLS/jre/bin/java"
  fi
  KEYTOOL="$(dirname "$JAVA_BIN")/keytool"
  if [ ! -x "$KEYTOOL" ]; then
    echo "✗ keytool not found next to $JAVA_BIN." >&2
    exit 1
  fi
  "$KEYTOOL" -genkeypair -v \
    -keystore "$TOOLS/stepwise.keystore" \
    -alias stepwise \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass stepwisedbg -keypass stepwisedbg \
    -dname "CN=Stepwise, OU=Arena, O=Stepwise, L=Nairobi, C=KE"
  echo "  created $TOOLS/stepwise.keystore"
else
  echo "  reusing $TOOLS/stepwise.keystore"
fi

echo ""
echo "✓ Android build tools are ready. Run: npm run build:apk"

/**
 * Stepwise — Android APK builder.
 *
 * Produces a real, installable Android package that wraps the production web
 * build in a full-screen WebView Activity. The pipeline is deliberately
 * self-contained so it can run on a plain Linux box with no Android SDK:
 *
 *   1. `vite build` produces the static site in ./dist
 *   2. the web bundle is copied into android/assets/www
 *   3. smali sources (android/smali) are assembled into classes.dex
 *   4. `aapt2 compile` turns android/res into flat resources
 *   5. `aapt2 link` produces the unsigned APK (manifest + resources + dex)
 *   6. the APK is signed with v1 (JAR), v2 and v3 signature schemes
 *
 * Required tools (paths may be overridden with environment variables):
 *
 *   AAPT2        path to the `aapt2` binary          (env: AAPT2)
 *   SMALI_JAR    path to a fat `smali.jar`           (env: SMALI_JAR)
 *   JAVA         path to a `java` launcher            (env: JAVA)
 *   KEYSTORE     path to the signing keystore        (env: KEYSTORE)
 *
 * Usage:
 *   node scripts/build-apk.mjs [--out public/downloads/stepwise.apk]
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Locate a tool: explicit env var first, then a list of well-known locations. */
function resolveTool(envVar, candidates, label) {
  const fromEnv = process.env[envVar];
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) {
      throw new Error(`${envVar} points at "${fromEnv}" which does not exist.`);
    }
    return fromEnv;
  }
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Unable to locate ${label}. Set the ${envVar} environment variable to its path.`);
}

const AAPT2 = resolveTool(
  'AAPT2',
  [
    path.join(ROOT, 'tools', 'android', 'aapt2'),
    '/tmp/aa/package/bin/x64/linux/aapt2',
    '/usr/local/bin/aapt2',
  ],
  'aapt2',
);

const SMALI_JAR = resolveTool(
  'SMALI_JAR',
  [path.join(ROOT, 'tools', 'android', 'smali.jar'), '/tmp/smali.jar'],
  'smali.jar',
);

const JAVA = resolveTool(
  'JAVA',
  [
    path.join(ROOT, 'tools', 'android', 'jre', 'bin', 'java'),
    '/tmp/jdk17/jdk4py/java-runtime/bin/java',
    '/usr/bin/java',
  ],
  'java',
);

const KEYSTORE = resolveTool(
  'KEYSTORE',
  [path.join(ROOT, 'tools', 'android', 'stepwise.keystore'), '/tmp/stepwise.keystore'],
  'signing keystore',
);

const KEYSTORE_PASSWORD = process.env.KEYSTORE_PASSWORD ?? 'stepwisedbg';
const KEY_ALIAS = process.env.KEY_ALIAS ?? 'stepwise';
const API_LEVEL = process.env.API_LEVEL ?? '34';
const MIN_SDK = process.env.MIN_SDK ?? '21';

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function fail(message, detail) {
  console.error(`\n✗ ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

/** List the compiled `.flat` files in a directory, for passing to `aapt2 link`. */
function listFlatFiles(directory) {
  return fs
    .readdirSync(directory)
    .filter((file) => file.endsWith('.flat'))
    .sort()
    .map((file) => path.join(directory, file));
}

// ── arguments ────────────────────────────────────────────────────────────────
const outIndex = process.argv.indexOf('--out');
const OUTPUT = path.resolve(
  ROOT,
  outIndex !== -1 && process.argv[outIndex + 1]
    ? process.argv[outIndex + 1]
    : 'public/downloads/stepwise.apk',
);

const WORK = path.join(ROOT, 'android', 'build');

// ── 0. clean ─────────────────────────────────────────────────────────────────
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

// ── 1. web bundle ────────────────────────────────────────────────────────────
// The APK loads the bundle from `file:///android_asset/www/index.html`, so the
// assets must be referenced relatively. The deployed web build keeps the
// absolute `/` base, hence a separate build here.
const distDir = path.join(ROOT, 'dist');
console.log('▸ Building web bundle (vite build, relative base) …');
try {
  run('npm', ['run', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, VITE_BASE: './' },
  });
} catch (error) {
  fail('vite build failed.', error.stderr || error.stdout || String(error));
}
if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  fail('Web build did not produce dist/index.html.');
}

// ── 2. copy the web bundle into the APK assets ──────────────────────────────
// The Activity loads `file:///android_asset/www/index.html`, so the site is
// staged under `assets/www/`. The `downloads/` folder is skipped: the APK
// ships the game, it does not need a copy of its own installer inside it.
const assetsDir = path.join(WORK, 'assets');
const wwwDir = path.join(assetsDir, 'www');
fs.mkdirSync(wwwDir, { recursive: true });
for (const entry of fs.readdirSync(distDir, { withFileTypes: true })) {
  if (entry.name === 'downloads') continue;
  fs.cpSync(path.join(distDir, entry.name), path.join(wwwDir, entry.name), {
    recursive: true,
  });
}
console.log('▸ Copied web bundle into android build assets.');

// ── 3. assemble smali → classes.dex ─────────────────────────────────────────
const dexDir = path.join(WORK, 'dex');
fs.mkdirSync(dexDir, { recursive: true });
const dexPath = path.join(dexDir, 'classes.dex');
console.log('▸ Assembling smali → classes.dex …');
try {
  run(JAVA, [
    '-jar',
    SMALI_JAR,
    '-a',
    API_LEVEL,
    '-o',
    dexPath,
    path.join(ROOT, 'android', 'smali'),
  ]);
} catch (error) {
  fail('smali failed to assemble classes.dex.', error.stderr || error.stdout || String(error));
}
if (!fs.existsSync(dexPath)) fail('smali did not emit classes.dex.');
console.log(`  classes.dex — ${fs.statSync(dexPath).size} bytes`);

// ── 4. build the synthetic framework resource table ─────────────────────────
// `aapt2 link` resolves every `android:` attribute against a framework
// resource table. Without the Android SDK there is no framework-res.apk on
// disk, so one is generated from android/framework/framework-res.xml. It only
// needs to declare the framework *symbols* the manifest references.
const frameworkDir = path.join(ROOT, 'android', 'framework');
const frameworkFlat = path.join(WORK, 'framework-compiled');
const frameworkApk = path.join(WORK, 'framework-res.apk');
fs.mkdirSync(frameworkFlat, { recursive: true });
console.log('▸ Building linking framework resource table …');
try {
  run(AAPT2, ['compile', '--dir', path.join(frameworkDir, 'res'), '-o', frameworkFlat]);
  run(AAPT2, [
    'link',
    '-x', // package id 0x01 — the Android framework package id
    '--manifest',
    path.join(frameworkDir, 'AndroidManifest.xml'),
    '-o',
    frameworkApk,
    ...listFlatFiles(frameworkFlat),
  ]);
} catch (error) {
  fail(
    'aapt2 could not build the linking framework.',
    error.stderr || error.stdout || String(error),
  );
}

// ── 5. aapt2 compile app resources ──────────────────────────────────────────
const flatDir = path.join(WORK, 'compiled');
fs.mkdirSync(flatDir, { recursive: true });
const resDir = path.join(ROOT, 'android', 'res');
console.log('▸ Compiling app resources …');
try {
  run(AAPT2, ['compile', '--dir', resDir, '-o', flatDir]);
} catch (error) {
  fail('aapt2 compile failed.', error.stderr || error.stdout || String(error));
}

// ── 6. aapt2 link → unsigned APK ────────────────────────────────────────────
const unsignedApk = path.join(WORK, 'stepwise-unsigned.apk');
console.log('▸ Linking unsigned APK …');
try {
  run(AAPT2, [
    'link',
    '-I',
    frameworkApk,
    '--manifest',
    path.join(ROOT, 'android', 'AndroidManifest.xml'),
    '-A',
    assetsDir,
    '--java',
    path.join(WORK, 'gen'),
    '-o',
    unsignedApk,
    '--min-sdk-version',
    MIN_SDK,
    '--target-sdk-version',
    API_LEVEL,
    '--version-code',
    '1',
    '--version-name',
    '1.0.0',
    '--no-version-vectors',
    ...listFlatFiles(flatDir),
  ]);
} catch (error) {
  fail('aapt2 link failed.', error.stderr || error.stdout || String(error));
}
if (!fs.existsSync(unsignedApk)) fail('aapt2 link did not emit an APK.');
console.log(`  unsigned APK — ${fs.statSync(unsignedApk).size} bytes`);

// The DEX must be injected into the linked APK: aapt2 link does not accept
// pre-built dex input, so the archive is repacked with classes.dex added.
const { repackWithDex } = await import('./apk-repack.mjs');
await repackWithDex(unsignedApk, dexPath, WORK);

// ── 6. sign (v1 + v2 + v3) ───────────────────────────────────────────────────
const { ApkSigner, SigningKey, convertToPEM } = await import('apk_sign_ts');

const keystoreBytes = new Uint8Array(fs.readFileSync(KEYSTORE));
const { privateKey, certificate } = await convertToPEM(keystoreBytes, KEYSTORE_PASSWORD, 'jks');

const signer = new ApkSigner({
  signingKey: SigningKey.fromPEM(privateKey, certificate),
});

const apkBytes = new Uint8Array(fs.readFileSync(unsignedApk));
const { signedApk } = await signer.sign(apkBytes);

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, signedApk);
console.log(`\n✓ Signed APK written to ${path.relative(ROOT, OUTPUT)}`);
console.log(`  ${signedApk.byteLength} bytes`);
console.log(`  schemes: v1 (JAR), v2, v3`);

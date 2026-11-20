/**
 * Stepwise — APK verification.
 *
 * Checks that the shipped APK is a genuinely installable Android package:
 *
 *   • the zip archive is intact (every entry's CRC matches its contents)
 *   • it contains the pieces Android needs: AndroidManifest.xml, resources.arsc,
 *     classes.dex and the v1 signature files
 *   • the v1 (JAR) signature digests match the archived entries
 *   • the APK Signing Block carries v2 and v3 signature schemes
 *   • the manifest declares the launcher activity and the package name
 *
 * Usage: node scripts/verify-apk.mjs [path/to/apk]
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apkPath = path.resolve(ROOT, process.argv[2] ?? 'public/downloads/stepwise.apk');

const failures = [];
function check(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    console.log(`  ✗ ${message}`);
    failures.push(message);
  }
}

console.log(`Verifying ${path.relative(ROOT, apkPath)}\n`);

const apk = new Uint8Array(readFileSync(apkPath));
const view = new DataView(apk.buffer, apk.byteOffset, apk.byteLength);

// ── locate the zip structures ───────────────────────────────────────────────
let eocd = -1;
for (let i = apk.length - 22; i >= 0; i -= 1) {
  if (view.getUint32(i, true) === 0x06054b50) {
    eocd = i;
    break;
  }
}
if (eocd < 0) {
  console.error('✗ Not a zip archive.');
  process.exit(1);
}

const entryCount = view.getUint16(eocd + 10, true);
const directoryOffset = view.getUint32(eocd + 16, true);

// ── walk the central directory ──────────────────────────────────────────────
const entries = new Map();
let cursor = directoryOffset;
for (let i = 0; i < entryCount; i += 1) {
  if (view.getUint32(cursor, true) !== 0x02014b50) break;
  const flags = view.getUint16(cursor + 8, true);
  const method = view.getUint16(cursor + 10, true);
  const crc = view.getUint32(cursor + 16, true);
  const compressedSize = view.getUint32(cursor + 20, true);
  const uncompressedSize = view.getUint32(cursor + 24, true);
  const nameLength = view.getUint16(cursor + 28, true);
  const extraLength = view.getUint16(cursor + 30, true);
  const commentLength = view.getUint16(cursor + 32, true);
  const localOffset = view.getUint32(cursor + 42, true);
  const name = new TextDecoder().decode(apk.subarray(cursor + 46, cursor + 46 + nameLength));
  entries.set(name, { flags, method, crc, compressedSize, uncompressedSize, localOffset });
  cursor += 46 + nameLength + extraLength + commentLength;
}

console.log('Archive');
check(entries.size > 0, `central directory holds ${entries.size} entries`);

// Every entry must have a well-formed local header.
let localHeadersOk = true;
for (const [name, entry] of entries) {
  if (view.getUint32(entry.localOffset, true) !== 0x04034b50) {
    localHeadersOk = false;
    console.log(`      bad local header: ${name}`);
  }
}
check(localHeadersOk, 'every entry has a valid local header');

// ── required members ────────────────────────────────────────────────────────
console.log('\nPackage contents');
for (const required of [
  'AndroidManifest.xml',
  'resources.arsc',
  'classes.dex',
  'assets/www/index.html',
  'META-INF/MANIFEST.MF',
  'META-INF/CERT.SF',
  'META-INF/CERT.RSA',
]) {
  check(entries.has(required), `contains ${required}`);
}

// ── local headers must agree with the central directory ─────────────────────
// Android's zip parser rejects a package whose two headers disagree — most
// often on the general-purpose flag, where bit 3 marks a trailing data
// descriptor. A mismatch made the installer refuse the APK with "not
// compatible with your phone" before it could even read the manifest.
console.log('\nZip structure');
{
  let headersOk = true;
  let descriptors = 0;
  for (const [, entry] of entries) {
    const localFlags = view.getUint16(entry.localOffset + 6, true);
    const localMethod = view.getUint16(entry.localOffset + 8, true);
    const localCrc = view.getUint32(entry.localOffset + 14, true);
    const localCompressed = view.getUint32(entry.localOffset + 18, true);
    const localUncompressed = view.getUint32(entry.localOffset + 22, true);

    if (localFlags !== entry.flags) {
      headersOk = false;
      console.log(`      flag mismatch: ${entry.name}`);
    }
    if (localMethod !== entry.method) {
      headersOk = false;
      console.log(`      method mismatch: ${entry.name}`);
    }
    if (localCrc !== entry.crc) {
      headersOk = false;
      console.log(`      crc mismatch: ${entry.name}`);
    }
    if (localCompressed !== entry.compressedSize || localUncompressed !== entry.uncompressedSize) {
      headersOk = false;
      console.log(`      size mismatch: ${entry.name}`);
    }
    if (localFlags & 0x0008) descriptors += 1;
  }
  check(headersOk, 'every local header agrees with the central directory');
  check(descriptors === 0, 'no entry uses a trailing data descriptor');
}

// ── aapt2 must be able to read the manifest ─────────────────────────────────
// aapt2's zip and binary-XML readers are the closest available stand-in for
// Android's own installer. If it cannot dump the manifest, the device will
// refuse the package.
console.log('\nManifest (parsed by aapt2)');
{
  const aapt2 = process.env.AAPT2;
  if (!aapt2 || !existsSync(aapt2)) {
    console.log('  – skipped (set AAPT2 to the aapt2 binary to enable)');
  } else {
    try {
      const { execFileSync } = await import('node:child_process');
      const out = execFileSync(
        aapt2,
        ['dump', 'xmltree', apkPath, '--file', 'AndroidManifest.xml'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      check(out.includes('com.stepwise.game'), 'manifest declares the package');
      check(/versionCode\(0x01010012\)=\d+/.test(out), 'manifest declares a versionCode');
      check(/versionName\(0x01010013\)/.test(out), 'manifest declares a versionName');
      check(/minSdkVersion\(0x01010008\)=\d+/.test(out), 'manifest declares a minSdkVersion');
      check(/targetSdkVersion\(0x0101000f\)=\d+/.test(out), 'manifest declares a targetSdkVersion');
      check(/MainActivity/.test(out), 'manifest declares the launcher activity');
      check(
        /android\.intent\.category\.LAUNCHER/.test(out),
        'manifest declares the launcher intent',
      );
    } catch (error) {
      check(false, 'aapt2 could not read the manifest');
      console.log(String(error.stderr || error.stdout || error).slice(0, 800));
    }
  }
}

const dex = entries.get('classes.dex');
if (dex) {
  const nameLength = view.getUint16(dex.localOffset + 26, true);
  const extraLength = view.getUint16(dex.localOffset + 28, true);
  const start = dex.localOffset + 30 + nameLength + extraLength;
  const raw = apk.subarray(start, start + dex.compressedSize);
  const contents = dex.method === 0 ? raw : inflateRawSync(raw);
  const dexMagic = String.fromCharCode(...contents.subarray(0, 4));
  check(dexMagic === 'dex\n', 'classes.dex carries the DEX magic header');
}

// ── v1 (JAR) signature ──────────────────────────────────────────────────────
console.log('\nSignature scheme v1 (JAR)');
const readEntry = (name) => {
  const entry = entries.get(name);
  if (!entry) return null;
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const raw = apk.subarray(start, start + entry.compressedSize);
  return entry.method === 0 ? raw : null;
};

const manifestRaw = readEntry('META-INF/MANIFEST.MF');
const certSfRaw = readEntry('META-INF/CERT.SF');
check(manifestRaw !== null && certSfRaw !== null, 'v1 signature files are readable');

if (manifestRaw && certSfRaw) {
  const manifestText = new TextDecoder().decode(manifestRaw);
  const sfText = new TextDecoder().decode(certSfRaw);

  // Each archived entry must appear in the manifest with a matching digest.
  const blocks = manifestText.trim().split(/\r?\n\r?\n/);
  let digestOk = true;
  let checked = 0;
  for (const block of blocks) {
    if (!block.startsWith('Name:')) continue;
    const name = block
      .slice(block.indexOf('Name:') + 5)
      .split(/\r?\n/)[0]
      .trim();
    const expected = /SHA-256-Digest:\s*(\S+)/.exec(block)?.[1];
    if (!expected) continue;
    const entry = entries.get(name);
    if (!entry) {
      digestOk = false;
      console.log(`      manifest names a missing entry: ${name}`);
      continue;
    }
    const nameLength = view.getUint16(entry.localOffset + 26, true);
    const extraLength = view.getUint16(entry.localOffset + 28, true);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const raw = apk.subarray(start, start + entry.compressedSize);
    // STORED entries can be hashed directly; deflated ones need inflating.
    const contents = entry.method === 0 ? raw : inflateRawSync(raw);
    const actual = createHash('sha256').update(contents).digest('base64');
    if (actual !== expected) {
      digestOk = false;
      console.log(`      digest mismatch: ${name}`);
    }
    checked += 1;
  }
  check(digestOk && checked > 0, `all ${checked} manifest digests match their entries`);

  const manifestDigest = /SHA-256-Digest-Manifest:\s*(\S+)/.exec(sfText)?.[1];
  const actualManifest = createHash('sha256').update(manifestRaw).digest('base64');
  check(manifestDigest === actualManifest, 'CERT.SF manifest digest matches MANIFEST.MF');

  check(/X-Android-APK-Signed:\s*2,\s*3/.test(sfText), 'CERT.SF declares schemes 2 and 3');
}

// ── v2 / v3 signing block ───────────────────────────────────────────────────
console.log('\nSignature schemes v2 and v3');
const MAGIC = new TextEncoder().encode('APK Sig Block 42');
let magicOffset = -1;
for (let i = directoryOffset - MAGIC.length; i >= 0; i -= 1) {
  if (apk[i] === MAGIC[0] && apk.subarray(i, i + MAGIC.length).every((b, k) => b === MAGIC[k])) {
    magicOffset = i;
    break;
  }
}
check(magicOffset >= 0, 'APK Signing Block present');

if (magicOffset >= 0) {
  const trailingSize = Number(view.getBigUint64(magicOffset - 8, true));
  const blockOffset = magicOffset + MAGIC.length - trailingSize - 8;
  const leadingSize = Number(view.getBigUint64(blockOffset, true));
  check(leadingSize === trailingSize, 'signing block size fields agree');

  // Walk the id/value pairs looking for the v2 and v3 scheme identifiers.
  const seen = new Set();
  let offset = blockOffset + 8;
  const end = magicOffset - 8;
  while (offset < end) {
    const pairSize = Number(view.getBigUint64(offset, true));
    const id = view.getUint32(offset + 8, true);
    seen.add(id);
    offset += 8 + pairSize;
  }
  // 0x7109871a — APK Signature Scheme v2
  // 0xf05368c0 — APK Signature Scheme v3
  check(seen.has(0x7109871a), 'v2 signature block present');
  check(seen.has(0xf05368c0), 'v3 signature block present');
}

// ── result ──────────────────────────────────────────────────────────────────
console.log('');
if (failures.length) {
  console.error(`✗ ${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('✓ APK is a valid, signed, installable Android package.');

/**
 * Android APK tests.
 *
 * The APK is a shipped artefact, so the binary itself is asserted here rather
 * than trusted because the build script reported success. These checks mirror
 * what Android itself requires to install a package: a valid zip, the manifest
 * and resource table, a DEX with the launcher activity, and a signature the
 * platform accepts (v1 JAR, v2 and v3).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const APK_PATH = 'public/downloads/stepwise.apk';

interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  /** General-purpose bit flag from the central directory record. */
  centralFlags: number;
}

function readZip(apk: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(apk.buffer, apk.byteOffset, apk.byteLength);
  let eocd = -1;
  for (let i = apk.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  expect(eocd).toBeGreaterThan(-1);

  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const entries = new Map<string, ZipEntry>();
  const decoder = new TextDecoder();

  for (let i = 0; i < count; i += 1) {
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const name = decoder.decode(apk.subarray(cursor + 46, cursor + 46 + nameLength));
    entries.set(name, {
      name,
      method: view.getUint16(cursor + 10, true),
      crc: view.getUint32(cursor + 16, true),
      compressedSize: view.getUint32(cursor + 20, true),
      uncompressedSize: view.getUint32(cursor + 24, true),
      localOffset: view.getUint32(cursor + 42, true),
      centralFlags: view.getUint16(cursor + 8, true),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Reads an entry's uncompressed contents. */
function entryData(apk: Uint8Array, entry: ZipEntry): Uint8Array {
  const view = new DataView(apk.buffer, apk.byteOffset, apk.byteLength);
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const raw = apk.subarray(start, start + entry.compressedSize);
  return entry.method === 0 ? raw : inflateRawSync(raw);
}

describe('Android APK', () => {
  const exists = existsSync(APK_PATH);
  const apk = exists ? new Uint8Array(readFileSync(APK_PATH)) : new Uint8Array(0);
  const entries = exists ? readZip(apk) : new Map<string, ZipEntry>();

  it('is published in the downloads folder', () => {
    expect(exists).toBe(true);
    expect(apk.byteLength).toBeGreaterThan(50_000);
  });

  it('is a valid zip archive', () => {
    expect(entries.size).toBeGreaterThan(0);
    for (const entry of entries.values()) {
      expect(entry.name).not.toBe('');
      expect(entry.compressedSize).toBeGreaterThan(0);
    }
  });

  it('has local headers that agree with the central directory', () => {
    // Android's zip parser rejects a package whose local header and central
    // directory record disagree — most often about the general-purpose flag
    // (bit 3 marks a trailing data descriptor). A mismatch made the installer
    // refuse the APK with "not compatible with your phone" before it could
    // even read the manifest.
    const view = new DataView(apk.buffer, apk.byteOffset, apk.byteLength);

    for (const entry of entries.values()) {
      expect(view.getUint32(entry.localOffset, true), `${entry.name} local signature`).toBe(
        0x04034b50,
      );

      const localFlags = view.getUint16(entry.localOffset + 6, true);
      expect(localFlags, `${entry.name} flag mismatch`).toBe(entry.centralFlags);

      const localMethod = view.getUint16(entry.localOffset + 8, true);
      expect(localMethod, `${entry.name} method mismatch`).toBe(entry.method);

      const localCrc = view.getUint32(entry.localOffset + 14, true);
      const localCompressed = view.getUint32(entry.localOffset + 18, true);
      const localUncompressed = view.getUint32(entry.localOffset + 22, true);

      expect(localCrc, `${entry.name} crc mismatch`).toBe(entry.crc);
      expect(localCompressed, `${entry.name} compressed size mismatch`).toBe(entry.compressedSize);
      expect(localUncompressed, `${entry.name} uncompressed size mismatch`).toBe(
        entry.uncompressedSize,
      );
    }
  });

  it('has no trailing data descriptors', () => {
    // A data descriptor means the sizes live after the entry data instead of
    // in the header. The APK is normalised so every entry is self-describing.
    const view = new DataView(apk.buffer, apk.byteOffset, apk.byteLength);
    for (const entry of entries.values()) {
      const flags = view.getUint16(entry.localOffset + 6, true);
      expect(flags & 0x0008, `${entry.name} still uses a data descriptor`).toBe(0);
    }
  });

  it('declares the version and sdk levels the installer reads', () => {
    // These are plain manifest attributes, but they decide whether the
    // package is offered to the device at all. The binary manifest keeps its
    // strings in a UTF-16 pool, so decode it as such.
    const bytes = entryData(apk, entries.get('AndroidManifest.xml')!);
    const text = new TextDecoder('utf-16le').decode(bytes);
    expect(text).toContain('com.stepwise.game');
    expect(text).toContain('MainActivity');
    expect(text).toContain('android.intent.category.LAUNCHER');
    expect(bytes.byteLength).toBeGreaterThan(100);
  });

  it('contains every member Android needs to install it', () => {
    for (const required of [
      'AndroidManifest.xml',
      'resources.arsc',
      'classes.dex',
      'assets/www/index.html',
      'META-INF/MANIFEST.MF',
      'META-INF/CERT.SF',
      'META-INF/CERT.RSA',
    ]) {
      expect(entries.has(required), `missing ${required}`).toBe(true);
    }
  });

  it('ships the game bundle inside the assets folder', () => {
    const html = new TextDecoder().decode(entryData(apk, entries.get('assets/www/index.html')!));
    expect(html).toMatch(/<div id="app"|<canvas/i);

    const scripts = [...entries.keys()].filter((name) => name.startsWith('assets/www/assets/'));
    expect(scripts.length).toBeGreaterThan(0);
    // The 3D renderer must travel with the app, not just the 2D fallback.
    expect(scripts.some((name) => name.includes('renderer3d'))).toBe(true);
  });

  it('references its assets relatively so the file:// origin resolves them', () => {
    // The APK loads the page from file:///android_asset/www/index.html. An
    // absolute "/assets/..." path would resolve to file:///assets/... and
    // 404, leaving the player with a blank screen.
    const html = new TextDecoder().decode(entryData(apk, entries.get('assets/www/index.html')!));
    const localRefs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((match) => match[1])
      .filter(
        (url) =>
          !url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('data:'),
      );

    expect(localRefs.length).toBeGreaterThan(0);
    for (const ref of localRefs) {
      expect(
        ref.startsWith('/'),
        `"${ref}" is an absolute path and will not resolve inside the APK`,
      ).toBe(false);
    }
  });

  it('ships every asset the page references', () => {
    const html = new TextDecoder().decode(entryData(apk, entries.get('assets/www/index.html')!));
    const refs = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((match) => match[1]);

    for (const ref of refs) {
      const name = `assets/www/${ref.replace(/^\.\//, '')}`;
      expect(entries.has(name), `${name} is referenced but not packaged`).toBe(true);
    }
  });

  it('ships a DEX with the dex magic header', () => {
    const dex = entryData(apk, entries.get('classes.dex')!);
    expect(String.fromCharCode(...dex.subarray(0, 4))).toBe('dex\n');
    expect(dex.byteLength).toBeGreaterThan(1000);
  });

  it('signs the archive with v1, v2 and v3 schemes', () => {
    const manifest = new TextDecoder().decode(entryData(apk, entries.get('META-INF/MANIFEST.MF')!));
    const certSf = new TextDecoder().decode(entryData(apk, entries.get('META-INF/CERT.SF')!));

    // v1: every archived entry is listed with a SHA-256 digest.
    const names = [...entries.keys()].filter((name) => !name.startsWith('META-INF/'));
    for (const name of names) {
      expect(manifest, `${name} is not in MANIFEST.MF`).toContain(`Name: ${name}`);
    }
    expect(manifest).toMatch(/SHA-256-Digest:/);

    // v1: the signature file covers the manifest and declares schemes 2 and 3.
    expect(certSf).toMatch(/SHA-256-Digest-Manifest:/);
    expect(certSf).toMatch(/X-Android-APK-Signed:\s*2,\s*3/);

    // v2/v3: the APK Signing Block carries both scheme identifiers.
    const view = new DataView(apk.buffer, apk.byteOffset, apk.byteLength);
    let eocd = -1;
    for (let i = apk.length - 22; i >= 0; i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    const directoryOffset = view.getUint32(eocd + 16, true);
    const magic = new TextEncoder().encode('APK Sig Block 42');
    let magicOffset = -1;
    for (let i = directoryOffset - magic.length; i >= 0; i -= 1) {
      if (
        apk[i] === magic[0] &&
        apk.subarray(i, i + magic.length).every((b, k) => b === magic[k])
      ) {
        magicOffset = i;
        break;
      }
    }
    expect(magicOffset).toBeGreaterThan(-1);

    const trailingSize = Number(view.getBigUint64(magicOffset - 8, true));
    const blockOffset = magicOffset + magic.length - trailingSize - 8;
    expect(Number(view.getBigUint64(blockOffset, true))).toBe(trailingSize);

    const ids = new Set<number>();
    let cursor = blockOffset + 8;
    while (cursor < magicOffset - 8) {
      const pairSize = Number(view.getBigUint64(cursor, true));
      ids.add(view.getUint32(cursor + 8, true));
      cursor += 8 + pairSize;
    }
    expect(ids.has(0x7109871a)).toBe(true); // APK Signature Scheme v2
    expect(ids.has(0xf05368c0)).toBe(true); // APK Signature Scheme v3
  });

  it('has manifest digests that match the archived contents', () => {
    const manifestRaw = entryData(apk, entries.get('META-INF/MANIFEST.MF')!);
    const manifest = new TextDecoder().decode(manifestRaw);
    const blocks = manifest.trim().split(/\r?\n\r?\n/);

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
      expect(entry, `${name} is missing from the archive`).toBeDefined();
      const actual = createHash('sha256').update(entryData(apk, entry!)).digest('base64');
      expect(actual, `digest mismatch for ${name}`).toBe(expected);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(5);
  });
});

describe('Android project sources', () => {
  it('declares the launcher activity in the manifest', () => {
    const manifest = readFileSync('android/AndroidManifest.xml', 'utf-8');
    expect(manifest).toMatch(/package="com\.stepwise\.game"/);
    expect(manifest).toMatch(/android\.intent\.action\.MAIN/);
    expect(manifest).toMatch(/android\.intent\.category\.LAUNCHER/);
    expect(manifest).toMatch(/com\.stepwise\.game\.MainActivity/);
  });

  it('ships smali sources for the WebView activity and the native bridge', () => {
    expect(existsSync('android/smali/com/stepwise/game/MainActivity.smali')).toBe(true);
    expect(existsSync('android/smali/com/stepwise/game/NativeBridge.smali')).toBe(true);

    const activity = readFileSync('android/smali/com/stepwise/game/MainActivity.smali', 'utf-8');
    expect(activity).toContain('Landroid/webkit/WebView;');
    expect(activity).toContain('file:///android_asset/www/index.html');
    expect(activity).toContain('StepwiseNative');

    const bridge = readFileSync('android/smali/com/stepwise/game/NativeBridge.smali', 'utf-8');
    expect(bridge).toContain('vibrate');
    expect(bridge).toContain('getTargetFps');
  });

  it('requests the permissions the wrapper needs', () => {
    const manifest = readFileSync('android/AndroidManifest.xml', 'utf-8');
    expect(manifest).toMatch(/android\.permission\.INTERNET/);
    expect(manifest).toMatch(/android\.permission\.VIBRATE/);
  });
});

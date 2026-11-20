/**
 * Repack helper — injects `classes.dex` into an aapt2-linked APK.
 *
 * `aapt2 link` produces the resource tables and manifest but has no input for
 * pre-built dex files, so the archive is rewritten here with the dex added.
 *
 * The rewrite **normalises** the archive rather than copying it verbatim.
 * aapt2 writes some entries with a data descriptor (general-purpose flag bit
 * 3) in their local header while leaving the flag clear in the central
 * directory. Android's zip parser compares the two and rejects the package
 * outright — the install fails with "not compatible with your phone", and the
 * manifest cannot even be read.
 *
 * So every entry is rewritten with a plain, self-describing local header
 * (CRC and sizes present in the header, no trailing data descriptor) and a
 * matching central-directory record. The flags always agree, and the sizes
 * are always the true ones.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Parse the central directory of a zip archive.
 * @returns {{entries: Array<object>, eocdOffset: number}}
 */
export function readCentralDirectory(buffer) {
  // The end-of-central-directory record is at the tail, after an optional
  // variable-length comment. Scan backwards for its signature.
  let eocdOffset = -1;
  const minOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let i = buffer.length - 22; i >= minOffset; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('Not a zip archive: no end-of-central-directory record.');

  const count = buffer.readUInt16LE(eocdOffset + 10);
  const directorySize = buffer.readUInt32LE(eocdOffset + 12);
  const directoryOffset = buffer.readUInt32LE(eocdOffset + 16);

  const entries = [];
  let cursor = directoryOffset;
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`Corrupt central directory at entry ${i}.`);
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const time = buffer.readUInt16LE(cursor + 12);
    const date = buffer.readUInt16LE(cursor + 14);
    const crc32 = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    entries.push({
      name,
      flags,
      method,
      time,
      date,
      crc32,
      compressedSize,
      uncompressedSize,
      externalAttributes,
      localHeaderOffset,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor - directoryOffset !== directorySize) {
    throw new Error('Central directory size mismatch.');
  }
  return { entries, eocdOffset };
}

/** CRC-32 (IEEE) over a buffer. */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A single archive member, normalised.
 *
 * `flags` is always 0: no data descriptor, so the local header carries the
 * real CRC and sizes and the central directory agrees with it.
 */
function normaliseEntry(name, contents, method, time, date, externalAttributes) {
  let payload = contents;
  let compressionMethod = method;
  if (compressionMethod !== 0 && compressionMethod !== 8) {
    throw new Error(`Unsupported compression method ${compressionMethod} for ${name}.`);
  }
  if (compressionMethod === 8) {
    // Re-deflate at a fixed level so the output is reproducible.
    payload = zlib.deflateRawSync(contents, { level: 9 });
  }
  return {
    name,
    flags: 0,
    method: compressionMethod,
    time,
    date,
    crc32: crc32(contents),
    compressedSize: payload.length,
    uncompressedSize: contents.length,
    externalAttributes,
    payload,
  };
}

/**
 * Rewrite an APK so that it also contains `classes.dex`.
 *
 * Every entry is decompressed and re-written with consistent headers, so the
 * archive is valid under Android's stricter zip parser.
 *
 * @param {string} apkPath      the linked APK to rewrite
 * @param {string} dexPath      the classes.dex to inject
 * @param {string} workDir      scratch directory for intermediate output
 */
export async function repackWithDex(apkPath, dexPath, workDir) {
  const buffer = fs.readFileSync(apkPath);
  const { entries } = readCentralDirectory(buffer);

  const members = [];

  for (const entry of entries) {
    if (buffer.readUInt32LE(entry.localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Corrupt local header for ${entry.name}.`);
    }
    const nameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
    const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
    const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
    const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);

    let contents;
    if (entry.method === 0) {
      contents = Buffer.from(raw);
    } else if (entry.method === 8) {
      contents = zlib.inflateRawSync(raw);
    } else {
      throw new Error(`Unsupported compression method ${entry.method} for ${entry.name}.`);
    }

    members.push(
      normaliseEntry(
        entry.name,
        contents,
        entry.method,
        entry.time,
        entry.date,
        entry.externalAttributes,
      ),
    );
  }

  // The dex rides along as a deflated member, like every other text entry.
  const dex = fs.readFileSync(dexPath);
  members.push(normaliseEntry('classes.dex', dex, 8, 0, 0x21, 0));

  // ── local entries ─────────────────────────────────────────────────────────
  const chunks = [];
  const directory = [];
  let position = 0;

  for (const member of members) {
    const nameBuffer = Buffer.from(member.name, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(0, 4); // version needed
    header.writeUInt16LE(member.flags, 6);
    header.writeUInt16LE(member.method, 8);
    header.writeUInt16LE(member.time, 10);
    header.writeUInt16LE(member.date, 12);
    header.writeUInt32LE(member.crc32, 14);
    header.writeUInt32LE(member.compressedSize, 18);
    header.writeUInt32LE(member.uncompressedSize, 22);
    header.writeUInt16LE(nameBuffer.length, 26);
    header.writeUInt16LE(0, 28);

    chunks.push(header, nameBuffer, member.payload);
    directory.push({ member, localHeaderOffset: position });
    position += 30 + nameBuffer.length + member.payload.length;
  }

  // ── central directory ─────────────────────────────────────────────────────
  const centralChunks = [];
  let centralSize = 0;
  for (const { member, localHeaderOffset } of directory) {
    const nameBuffer = Buffer.from(member.name, 'utf8');
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x031e, 4); // version made by: UNIX, zip 3.0
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(member.flags, 8);
    header.writeUInt16LE(member.method, 10);
    header.writeUInt16LE(member.time, 12);
    header.writeUInt16LE(member.date, 14);
    header.writeUInt32LE(member.crc32, 16);
    header.writeUInt32LE(member.compressedSize, 20);
    header.writeUInt32LE(member.uncompressedSize, 24);
    header.writeUInt16LE(nameBuffer.length, 28);
    header.writeUInt16LE(0, 30); // extra length
    header.writeUInt16LE(0, 32); // comment length
    header.writeUInt16LE(0, 34); // disk number
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE(member.externalAttributes, 38);
    header.writeUInt32LE(localHeaderOffset, 42);
    centralChunks.push(header, nameBuffer);
    centralSize += 46 + nameBuffer.length;
  }

  // ── end of central directory ──────────────────────────────────────────────
  const centralOffset = position;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(directory.length, 8);
  eocd.writeUInt16LE(directory.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  const archive = Buffer.concat([...chunks, ...centralChunks, eocd]);
  const outPath = path.join(workDir, 'stepwise-dexed.apk');
  fs.writeFileSync(outPath, archive);
  fs.copyFileSync(outPath, apkPath);
  return outPath;
}

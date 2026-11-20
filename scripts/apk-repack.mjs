/**
 * Repack helper — injects `classes.dex` into an aapt2-linked APK.
 *
 * `aapt2 link` produces the resource tables and manifest but has no input
 * for pre-built dex files, so the archive is rewritten here with the dex
 * added. The rewrite preserves every existing entry byte-for-byte (including
 * the STORED entries aapt2 emits for resources.arsc) and only rebuilds the
 * zip directory, so the APK stays byte-stable across rebuilds.
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
function crc32(buffer) {
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
 * Rewrite an APK so that it also contains `classes.dex`.
 *
 * @param {string} apkPath      the linked APK to rewrite
 * @param {string} dexPath      the classes.dex to inject
 * @param {string} workDir      scratch directory for intermediate output
 */
export async function repackWithDex(apkPath, dexPath, workDir) {
  const buffer = fs.readFileSync(apkPath);
  const { entries, eocdOffset } = readCentralDirectory(buffer);

  const dex = fs.readFileSync(dexPath);

  // Read the raw (still compressed) bytes of every existing local entry.
  const localChunks = [];
  for (const entry of entries) {
    const header = buffer.readUInt32LE(entry.localHeaderOffset);
    if (header !== 0x04034b50) {
      throw new Error(`Corrupt local header for ${entry.name}.`);
    }
    const nameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
    const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
    const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
    const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);

    // aapt2 emits entries with a data descriptor (general-purpose flag bit 3).
    // The descriptor follows the compressed data and must travel with it,
    // otherwise every following entry's offset shifts and the archive
    // stops being readable.
    let descriptor = Buffer.alloc(0);
    if (entry.flags & 0x0008) {
      const descriptorStart = dataStart + entry.compressedSize;
      const signature = buffer.readUInt32LE(descriptorStart);
      if (signature === 0x08074b50) {
        // Optional signature, then crc32 + compressed + uncompressed sizes.
        descriptor = buffer.subarray(descriptorStart, descriptorStart + 16);
      } else {
        descriptor = buffer.subarray(descriptorStart, descriptorStart + 12);
      }
    }

    localChunks.push({ entry, data, descriptor });
  }

  // Build the new archive from scratch: keep every entry's original local
  // header, data and data descriptor verbatim, then append the dex entry.
  const chunks = [];
  let position = 0;
  const directory = [];

  for (const { entry, data, descriptor } of localChunks) {
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(entry.flags, 4);
    localHeader.writeUInt16LE(entry.method, 6);
    localHeader.writeUInt16LE(entry.time, 8);
    localHeader.writeUInt16LE(entry.date, 10);
    localHeader.writeUInt32LE(entry.crc32, 14);
    localHeader.writeUInt32LE(entry.compressedSize, 18);
    localHeader.writeUInt32LE(entry.uncompressedSize, 22);
    localHeader.writeUInt16LE(Buffer.byteLength(entry.name), 26);
    localHeader.writeUInt16LE(0, 28);
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    chunks.push(localHeader, nameBuffer, data);
    if (descriptor.length) chunks.push(descriptor);

    directory.push({
      entry,
      localHeaderOffset: position,
    });
    position += 30 + nameBuffer.length + data.length + descriptor.length;
  }

  // classes.dex — deflate it like every other modern APK entry.
  const deflated = zlib.deflateRawSync(dex, { level: 9 });
  const dexEntry = {
    name: 'classes.dex',
    flags: 0,
    method: 8,
    time: 0,
    date: 0x21, // 1980-01-01, the conventional "no timestamp" value
    crc32: crc32(dex),
    compressedSize: deflated.length,
    uncompressedSize: dex.length,
    externalAttributes: 0,
  };
  const dexName = Buffer.from(dexEntry.name, 'utf8');
  const dexLocalHeader = Buffer.alloc(30);
  dexLocalHeader.writeUInt32LE(0x04034b50, 0);
  dexLocalHeader.writeUInt16LE(dexEntry.flags, 4);
  dexLocalHeader.writeUInt16LE(dexEntry.method, 6);
  dexLocalHeader.writeUInt16LE(dexEntry.time, 8);
  dexLocalHeader.writeUInt16LE(dexEntry.date, 10);
  dexLocalHeader.writeUInt32LE(dexEntry.crc32, 14);
  dexLocalHeader.writeUInt32LE(dexEntry.compressedSize, 18);
  dexLocalHeader.writeUInt32LE(dexEntry.uncompressedSize, 22);
  dexLocalHeader.writeUInt16LE(dexName.length, 26);
  dexLocalHeader.writeUInt16LE(0, 28);

  chunks.push(dexLocalHeader, dexName, deflated);
  directory.push({ entry: dexEntry, localHeaderOffset: position });
  position += 30 + dexName.length + deflated.length;

  // Central directory.
  const centralChunks = [];
  let centralSize = 0;
  for (const { entry, localHeaderOffset } of directory) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x031e, 4); // version made by: UNIX, zip 3.0
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(entry.flags, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(entry.time, 12);
    header.writeUInt16LE(entry.date, 14);
    header.writeUInt32LE(entry.crc32, 16);
    header.writeUInt32LE(entry.compressedSize, 20);
    header.writeUInt32LE(entry.uncompressedSize, 24);
    header.writeUInt16LE(Buffer.byteLength(entry.name), 28);
    header.writeUInt16LE(0, 30); // extra length
    header.writeUInt16LE(0, 32); // comment length
    header.writeUInt16LE(0, 34); // disk number
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE(entry.externalAttributes, 38);
    header.writeUInt32LE(localHeaderOffset, 42);
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    centralChunks.push(header, nameBuffer);
    centralSize += 46 + nameBuffer.length;
  }

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

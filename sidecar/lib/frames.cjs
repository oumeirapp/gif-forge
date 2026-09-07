'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveExecutable, run } = require('./tools.cjs');

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function zipStore(entries) {
  const records = [];
  let offset = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || entry.name.startsWith('/') || entry.name.includes('..')) {
      throw new Error('ZIP entries must use safe relative names.');
    }
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const local = Buffer.alloc(30);
    const checksum = crc32(data);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    records.push({ name, data, checksum, offset, local });
    offset += local.length + name.length + data.length;
  }

  const central = records.map((record) => {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt32LE(record.checksum, 16);
    header.writeUInt32LE(record.data.length, 20);
    header.writeUInt32LE(record.data.length, 24);
    header.writeUInt16LE(record.name.length, 28);
    header.writeUInt32LE(record.offset, 42);
    return Buffer.concat([header, record.name]);
  });
  const centralSize = central.reduce((total, item) => total + item.length, 0);
  const ending = Buffer.alloc(22);
  ending.writeUInt32LE(0x06054b50, 0);
  ending.writeUInt16LE(records.length, 8);
  ending.writeUInt16LE(records.length, 10);
  ending.writeUInt32LE(centralSize, 12);
  ending.writeUInt32LE(offset, 16);
  return Buffer.concat([...records.flatMap((record) => [record.local, record.name, record.data]), ...central, ending]);
}

function frameExportFormats(frameExport) {
  if (frameExport === 'png') return ['png'];
  if (frameExport === 'jpeg') return ['jpeg'];
  if (frameExport === 'both') return ['png', 'jpeg'];
  return [];
}

function normalizeHexColor(value) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error('jpegBackground must be a six-digit hexadecimal color such as #ffffff.');
  }
  return `0x${value.slice(1).toUpperCase()}`;
}

function roundMilliseconds(value) {
  return Math.round(value * 1_000) / 1_000;
}

function buildFrameManifest({ format, frameCount, frameDurationMs, width, height, effectiveCaptureFps, jpegQuality, jpegBackground }) {
  const extension = format === 'jpeg' ? 'jpg' : 'png';
  return {
    schemaVersion: 1,
    format,
    width,
    height,
    frameCount,
    frameDurationMs: roundMilliseconds(frameDurationMs),
    effectiveCaptureFps,
    jpeg: format === 'jpeg' ? { quality: jpegQuality, background: jpegBackground } : undefined,
    frames: Array.from({ length: frameCount }, (_, index) => ({
      index: index + 1,
      file: `frame-${String(index + 1).padStart(6, '0')}.${extension}`,
      timestampMs: roundMilliseconds(index * frameDurationMs),
      durationMs: roundMilliseconds(frameDurationMs),
    })),
  };
}

function jpegQScale(quality) {
  return String(Math.max(2, Math.min(31, Math.round(31 - ((quality / 100) * 29)))));
}

async function encodeJpegFrames({ frames, width, height, jpegQuality, jpegBackground }) {
  const tempDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'banner-forge-frames-'));
  try {
    for (let index = 0; index < frames.length; index += 1) {
      await fsp.writeFile(path.join(tempDirectory, `frame-${String(index + 1).padStart(6, '0')}.png`), frames[index]);
    }
    const outputDirectory = path.join(tempDirectory, 'jpeg');
    await fsp.mkdir(outputDirectory);
    const filter = `color=c=${normalizeHexColor(jpegBackground)}:s=${width}x${height}[bg];[0:v]format=rgba[fg];[bg][fg]overlay=format=auto,format=yuvj420p[out]`;
    const ffmpeg = resolveExecutable('ffmpeg', ['BANNER_FORGE_FFMPEG', 'FFMPEG_PATH']);
    await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-start_number', '1', '-i', path.join(tempDirectory, 'frame-%06d.png'),
      '-filter_complex', filter,
      '-map', '[out]', '-frames:v', String(frames.length), '-q:v', jpegQScale(jpegQuality),
      path.join(outputDirectory, 'frame-%06d.jpg'),
    ]);
    return Promise.all(Array.from({ length: frames.length }, (_, index) => (
      fsp.readFile(path.join(outputDirectory, `frame-${String(index + 1).padStart(6, '0')}.jpg`))
    )));
  } finally {
    await fsp.rm(tempDirectory, { recursive: true, force: true });
  }
}

async function exportFrameArchive({ frames, format, frameDurationMs, width, height, effectiveCaptureFps, jpegQuality, jpegBackground }) {
  const imageFrames = format === 'jpeg'
    ? await encodeJpegFrames({ frames, width, height, jpegQuality, jpegBackground })
    : frames;
  const manifest = buildFrameManifest({
    format,
    frameCount: imageFrames.length,
    frameDurationMs,
    width,
    height,
    effectiveCaptureFps,
    jpegQuality,
    jpegBackground,
  });
  return {
    archive: zipStore([
      ...manifest.frames.map((frame, index) => ({ name: frame.file, data: imageFrames[index] })),
      { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    ]),
    manifest,
  };
}

module.exports = {
  buildFrameManifest,
  exportFrameArchive,
  frameExportFormats,
  normalizeHexColor,
  zipStore,
};

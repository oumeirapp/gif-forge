'use strict';

const fs = require('node:fs');

function readSubBlocks(buffer, offset) {
  let cursor = offset;
  let bytes = 0;
  while (cursor < buffer.length) {
    const size = buffer[cursor++];
    if (size === 0) return { offset: cursor, bytes };
    if (cursor + size > buffer.length) throw new Error('Truncated GIF data sub-block.');
    bytes += size;
    cursor += size;
  }
  throw new Error('Unterminated GIF data sub-block.');
}

function parseGif(input) {
  const buffer = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  if (buffer.length < 13 || !/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) throw new Error('Output is not a valid GIF87a/GIF89a file.');
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  const packed = buffer[10];
  let offset = 13;
  if (packed & 0x80) offset += 3 * (2 ** ((packed & 0x07) + 1));
  let frames = 0;
  let durationMs = 0;
  let pendingDelay = 0;
  let pendingDelayOffset = null;
  let loopCount = null;
  const frameDelayOffsets = [];

  while (offset < buffer.length) {
    const marker = buffer[offset++];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      if (offset >= buffer.length) throw new Error('Truncated GIF extension.');
      const label = buffer[offset++];
      if (label === 0xf9) {
        const blockSize = buffer[offset++];
        if (blockSize !== 4 || offset + 5 > buffer.length) throw new Error('Invalid GIF graphics control extension.');
        pendingDelayOffset = offset + 1;
        pendingDelay = buffer.readUInt16LE(offset + 1) * 10;
        offset += blockSize;
        if (buffer[offset++] !== 0) throw new Error('Invalid GIF graphics control terminator.');
      } else if (label === 0xff) {
        const blockSize = buffer[offset++];
        const identifier = buffer.subarray(offset, offset + blockSize).toString('ascii');
        offset += blockSize;
        if (identifier.startsWith('NETSCAPE') && buffer[offset] === 3 && buffer[offset + 1] === 1) {
          loopCount = buffer.readUInt16LE(offset + 2);
        }
        offset = readSubBlocks(buffer, offset).offset;
      } else {
        offset = readSubBlocks(buffer, offset).offset;
      }
      continue;
    }
    if (marker === 0x2c) {
      if (offset + 9 > buffer.length) throw new Error('Truncated GIF image descriptor.');
      const imagePacked = buffer[offset + 8];
      offset += 9;
      if (imagePacked & 0x80) offset += 3 * (2 ** ((imagePacked & 0x07) + 1));
      if (offset >= buffer.length) throw new Error('Missing GIF LZW code size.');
      offset += 1;
      offset = readSubBlocks(buffer, offset).offset;
      frames += 1;
      durationMs += pendingDelay;
      frameDelayOffsets.push(pendingDelayOffset);
      pendingDelay = 0;
      pendingDelayOffset = null;
      continue;
    }
    throw new Error(`Unexpected GIF block marker 0x${marker.toString(16)}.`);
  }
  if (!width || !height || !frames) throw new Error('GIF contains no renderable frames.');
  return {
    buffer,
    frameDelayOffsets,
    inspection: { width, height, frames, durationMs, loopCount, bytes: buffer.length },
  };
}

function inspectGif(input) {
  return parseGif(input).inspection;
}

function distributeFrameDelays(frameCount, targetCentiseconds) {
  const baseDelay = Math.floor(targetCentiseconds / frameCount);
  const extraCentiseconds = targetCentiseconds % frameCount;
  const frameDelays = [];
  let accumulatedExtra = 0;

  for (let index = 0; index < frameCount; index += 1) {
    accumulatedExtra += extraCentiseconds;
    let delay = baseDelay;

    if (accumulatedExtra >= frameCount) {
      delay += 1;
      accumulatedExtra -= frameCount;
    }

    frameDelays.push(delay);
  }

  return frameDelays;
}

function normalizeGifDuration(filePath, targetDurationMs) {
  const parsed = parseGif(filePath);
  const hasDelayForEveryFrame = parsed.frameDelayOffsets.every((offset) => Number.isInteger(offset));
  if (!hasDelayForEveryFrame) return parsed.inspection;

  const targetCentiseconds = Math.max(
    parsed.inspection.frames,
    Math.round(targetDurationMs / 10),
  );
  const frameDelays = distributeFrameDelays(parsed.inspection.frames, targetCentiseconds);
  const maximumDelay = Math.max(...frameDelays);

  if (maximumDelay > 65_535) {
    throw new Error('GIF frame delay exceeds the format limit.');
  }

  for (let index = 0; index < parsed.frameDelayOffsets.length; index += 1) {
    parsed.buffer.writeUInt16LE(frameDelays[index], parsed.frameDelayOffsets[index]);
  }

  fs.writeFileSync(filePath, parsed.buffer);
  return inspectGif(parsed.buffer);
}

function validateGif(input, expected) {
  const inspection = inspectGif(input);
  if (expected?.width && inspection.width !== expected.width) throw new Error(`GIF width ${inspection.width} does not match capture width ${expected.width}.`);
  if (expected?.height && inspection.height !== expected.height) throw new Error(`GIF height ${inspection.height} does not match capture height ${expected.height}.`);
  if (expected?.loopMode === 'forever' && inspection.loopCount !== 0) throw new Error('GIF does not contain the expected infinite loop instruction.');
  if (expected?.loopMode === 'once' && inspection.loopCount !== null) throw new Error('GIF unexpectedly contains a loop instruction.');
  if (expected?.durationMs !== undefined) {
    const durationDifference = Math.abs(inspection.durationMs - expected.durationMs);
    const durationToleranceMs = expected.durationToleranceMs ?? 20;
    if (durationDifference > durationToleranceMs) {
      throw new Error(`GIF duration differs from the captured duration by ${durationDifference} ms.`);
    }
  }
  return inspection;
}

module.exports = { distributeFrameDelays, inspectGif, normalizeGifDuration, validateGif };

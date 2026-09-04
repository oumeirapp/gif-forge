'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROTOCOL_VERSION = 4;
const CAPTURE_FPS = 24;
const OUTPUT_FPS_OPTIONS = Object.freeze([4, 12, 15, 24]);
const PALETTE_OPTIONS = Object.freeze([64, 128, 192, 256]);
const DITHERING_OPTIONS = Object.freeze(['adaptive', 'none', 'bayer-5', 'bayer-4', 'gradfun-bayer-5']);

const DEFAULTS = Object.freeze({
  outputFps: 15,
  maxColors: 256,
  dithering: 'adaptive',
  gifskiQuality: 80,
  captureFps: CAPTURE_FPS,
  maxDurationSeconds: 30,
  loopMode: 'auto',
});

function normalizeConfig(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config must be a JSON object.');
  }

  const legacyFields = ['quality', 'preferredBytes', 'maxBytes', 'captureFps', 'compression'];
  const suppliedLegacyFields = legacyFields.filter((field) => Object.hasOwn(config, field));
  if (suppliedLegacyFields.length > 0) {
    throw new Error(`Protocol v4 does not accept legacy preset, size, capture, or compression-mode fields: ${suppliedLegacyFields.join(', ')}.`);
  }

  const outputFps = config.outputFps ?? DEFAULTS.outputFps;
  if (!OUTPUT_FPS_OPTIONS.includes(outputFps)) {
    throw new Error('outputFps must be one of: 4, 12, 15, 24.');
  }

  const maxColors = config.maxColors ?? DEFAULTS.maxColors;
  if (!PALETTE_OPTIONS.includes(maxColors)) {
    throw new Error('maxColors must be one of: 64, 128, 192, 256.');
  }

  const dithering = config.dithering ?? DEFAULTS.dithering;
  if (!DITHERING_OPTIONS.includes(dithering)) {
    throw new Error(`dithering must be one of: ${DITHERING_OPTIONS.join(', ')}.`);
  }

  const gifskiQuality = config.gifskiQuality ?? DEFAULTS.gifskiQuality;
  if (!Number.isInteger(gifskiQuality) || gifskiQuality < 1 || gifskiQuality > 100) {
    throw new Error('gifskiQuality must be an integer from 1 through 100.');
  }

  const maxDurationSeconds = config.maxDurationSeconds ?? DEFAULTS.maxDurationSeconds;
  if (typeof maxDurationSeconds !== 'number'
    || !Number.isFinite(maxDurationSeconds)
    || maxDurationSeconds < 0.1
    || maxDurationSeconds > 60) {
    throw new Error('maxDurationSeconds must be a number from 0.1 through 60.');
  }

  return {
    outputFps,
    maxColors,
    dithering,
    gifskiQuality,
    captureFps: CAPTURE_FPS,
    maxDurationSeconds,
    loopMode: normalizeLoopMode(config.loopMode),
  };
}

function normalizeLoopMode(value) {
  if (value === undefined || value === null || value === '' || value === 'auto') return 'auto';
  if (value === true || value === 'forever' || value === 'infinite') return 'forever';
  if (value === false || value === 'once') return 'once';
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : DEFAULTS.loopMode;
}

function resolveInputPath(inputPath) {
  const resolved = path.resolve(inputPath);
  try {
    if (fs.statSync(resolved).isDirectory()) return path.join(resolved, 'index.html');
  } catch {
    // Conversion emits the more useful missing-input error later.
  }
  return resolved;
}

function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request must be a JSON object.');
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`protocolVersion must be ${PROTOCOL_VERSION}. Legacy requests are not supported.`);
  }
  if (!Array.isArray(value.inputPaths) || value.inputPaths.length === 0) throw new Error('inputPaths must be a non-empty array.');
  if (value.inputPaths.some((item) => typeof item !== 'string' || item.trim() === '')) throw new Error('Every inputPaths item must be a non-empty string.');
  if (typeof value.outputDirectory !== 'string' || value.outputDirectory.trim() === '') throw new Error('outputDirectory must be a non-empty string.');
  return {
    inputPaths: value.inputPaths.map((item) => path.resolve(item)),
    outputDirectory: path.resolve(value.outputDirectory),
    config: normalizeConfig(value.config),
  };
}

function safeStem(inputPath) {
  const stem = path.basename(inputPath, path.extname(inputPath));
  const cleaned = stem.normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'banner';
}

function uniqueOutputPaths(inputPath, outputDirectory) {
  const stem = safeStem(inputPath);
  let suffix = '';
  let index = 1;
  while (true) {
    const gifPath = path.join(outputDirectory, `${stem}${suffix}.gif`);
    const reportPath = path.join(outputDirectory, `${stem}${suffix}.report.json`);
    if (!fs.existsSync(gifPath) && !fs.existsSync(reportPath)) return { gifPath, reportPath };
    suffix = `-${++index}`;
  }
}

function coalesceFrames(frames, frameDurationMs) {
  const coalesced = [];
  for (const frame of frames) {
    const buffer = Buffer.isBuffer(frame) ? frame : frame.buffer;
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const previous = coalesced.at(-1);
    if (previous && previous.hash === hash && previous.buffer.equals(buffer)) {
      previous.durationMs += frameDurationMs;
      previous.sourceFrames += 1;
    } else {
      coalesced.push({ buffer, hash, durationMs: frameDurationMs, sourceFrames: 1 });
    }
  }
  return coalesced;
}

function gifLoopArgument(loopMode) {
  if (loopMode === 'once') return '-1';
  if (loopMode === 'forever') return '0';
  if (loopMode === 'auto') return '-1';
  return String(loopMode);
}

function gifDurationToleranceMs(fps) {
  return Math.max(250, (1000 / fps) + 20);
}

module.exports = {
  PROTOCOL_VERSION,
  CAPTURE_FPS,
  OUTPUT_FPS_OPTIONS,
  PALETTE_OPTIONS,
  DITHERING_OPTIONS,
  DEFAULTS,
  normalizeConfig,
  normalizeLoopMode,
  resolveInputPath,
  validateRequest,
  safeStem,
  uniqueOutputPaths,
  coalesceFrames,
  gifLoopArgument,
  gifDurationToleranceMs,
};

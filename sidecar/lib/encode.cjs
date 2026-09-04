'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { gifLoopArgument, gifDurationToleranceMs } = require('./helpers.cjs');
const { normalizeGifDuration, validateGif } = require('./gif.cjs');
const { resolveExecutable, run, toolAvailable } = require('./tools.cjs');

const CAMBI_WEIGHT = 0.10;
const QUALITY_SCORE_TOLERANCE = 0.25;
const FALLBACK_CANDIDATE_ID = 'bayer-5';

const DITHER_CANDIDATES = Object.freeze([
  Object.freeze({
    id: 'none',
    label: 'No dithering',
    dither: 'none',
    bayerScale: null,
    prefilter: null,
  }),
  Object.freeze({
    id: 'bayer-5',
    label: 'Light Bayer',
    dither: 'bayer',
    bayerScale: 5,
    prefilter: null,
  }),
  Object.freeze({
    id: 'bayer-4',
    label: 'Bayer',
    dither: 'bayer',
    bayerScale: 4,
    prefilter: null,
  }),
  Object.freeze({
    id: 'gradfun-bayer-5',
    label: 'Deband + Light Bayer',
    dither: 'bayer',
    bayerScale: 5,
    prefilter: 'gradfun=strength=1.2:radius=16',
  }),
]);

function concatEscape(filePath) {
  return filePath.replaceAll("'", "'\\''");
}

async function writeFrames(tempDirectory, frames) {
  const concatLines = ['ffconcat version 1.0'];
  for (let index = 0; index < frames.length; index += 1) {
    const framePath = path.join(tempDirectory, `frame-${String(index).padStart(6, '0')}.png`);
    await fsp.writeFile(framePath, frames[index].buffer);
    concatLines.push(`file '${concatEscape(framePath)}'`);
    concatLines.push(`duration ${(frames[index].durationMs / 1000).toFixed(6)}`);
  }
  if (frames.length > 1) {
    const lastPath = path.join(tempDirectory, `frame-${String(frames.length - 1).padStart(6, '0')}.png`);
    concatLines.push(`file '${concatEscape(lastPath)}'`);
  }
  const concatPath = path.join(tempDirectory, 'frames.ffconcat');
  await fsp.writeFile(concatPath, `${concatLines.join('\n')}\n`, 'utf8');
  return concatPath;
}

function paletteUseFilter(candidate) {
  if (candidate.dither === 'none') {
    return 'paletteuse=dither=none:diff_mode=rectangle';
  }

  return `paletteuse=dither=bayer:bayer_scale=${candidate.bayerScale}:diff_mode=rectangle`;
}

function paletteFilter(profile, candidate, options = {}) {
  const transforms = [];
  if (options.includeFrameRate !== false) transforms.push(`fps=${profile.fps}`);
  if (candidate.prefilter) transforms.push(candidate.prefilter);
  const transformPrefix = transforms.length > 0 ? `${transforms.join(',')},` : '';
  const paletteUse = paletteUseFilter(candidate);

  return `[0:v]${transformPrefix}split[pgen][puse];`
    + `[pgen]palettegen=max_colors=${profile.maxColors}:stats_mode=full[palette];`
    + `[puse][palette]${paletteUse}`;
}

function ffmpegInputArguments(concatPath, frameCount) {
  if (frameCount === 1) {
    const stillFramePath = path.join(path.dirname(concatPath), 'frame-000000.png');
    return ['-i', stillFramePath];
  }

  return ['-f', 'concat', '-safe', '0', '-i', concatPath];
}

function candidatesForDithering(dithering) {
  if (dithering === 'adaptive') return DITHER_CANDIDATES;

  const candidate = DITHER_CANDIDATES.find((item) => item.id === dithering);
  if (!candidate) throw new Error(`Unknown dithering mode: ${dithering}`);
  return [candidate];
}

function gifskiLoopCount(loopMode) {
  if (loopMode === 'forever') return 0;
  if (loopMode === 'once' || loopMode === 'auto') return null;
  return Number.isInteger(loopMode) && loopMode >= 0 ? loopMode : null;
}

function gifskiWorkerArguments(sourcePath, outputPath, quality, loopMode) {
  const request = {
    inputPath: sourcePath,
    outputPath,
    quality,
    loopCount: gifskiLoopCount(loopMode),
  };

  return ['encode', JSON.stringify(request)];
}

async function applyGifskiCompression(worker, quality, loopMode, sourcePath, outputPath) {
  const sourceBytes = (await fsp.stat(sourcePath)).size;

  try {
    await run(worker, gifskiWorkerArguments(sourcePath, outputPath, quality, loopMode));
  } catch (error) {
    throw new Error(`Gifski compression failed: ${error.message}`);
  }

  const processedBytes = (await fsp.stat(outputPath)).size;
  return {
    path: outputPath,
    sourceBytes,
    processedBytes,
    applied: true,
    engine: 'gifski',
    quality,
    label: `Gifski ${quality}% quality`,
  };
}

function percentile(values, ratio) {
  if (values.length === 0) return null;
  const sortedValues = [...values].sort((left, right) => left - right);
  const index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * ratio) - 1);
  return sortedValues[Math.max(0, index)];
}

function roundMetric(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function parseQualityMetrics(value) {
  const meanVmaf = Number(value?.pooled_metrics?.vmaf?.mean);
  const cambiValues = (value?.frames ?? [])
    .map((frame) => Number(frame?.metrics?.cambi))
    .filter(Number.isFinite);
  const p95Cambi = percentile(cambiValues, 0.95);

  if (!Number.isFinite(meanVmaf) || !Number.isFinite(p95Cambi)) {
    throw new Error('FFmpeg did not return complete VMAF and CAMBI metrics.');
  }

  const qualityScore = meanVmaf - (CAMBI_WEIGHT * p95Cambi);
  return {
    meanVmaf: roundMetric(meanVmaf),
    p95Cambi: roundMetric(p95Cambi),
    qualityScore: roundMetric(qualityScore),
  };
}

async function measureCandidateQuality({
  ffmpeg,
  candidatePath,
  concatPath,
  fps,
  tempDirectory,
  index,
}) {
  const metricsFileName = `quality-metrics-${index}.json`;
  const metricsPath = path.join(tempDirectory, metricsFileName);
  const filter = `[0:v]fps=${fps},setpts=PTS-STARTPTS,format=yuv420p[dist];`
    + `[1:v]fps=${fps},setpts=PTS-STARTPTS,format=yuv420p[ref];`
    + `[dist][ref]libvmaf=feature=name=cambi:log_fmt=json:log_path=${metricsFileName}:shortest=1[evaluated]`;

  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-i', candidatePath,
    '-f', 'concat', '-safe', '0', '-i', concatPath,
    '-filter_complex', filter,
    '-map', '[evaluated]', '-an', '-f', 'null', '-',
  ], { cwd: tempDirectory });

  const metrics = JSON.parse(await fsp.readFile(metricsPath, 'utf8'));
  return parseQualityMetrics(metrics);
}

function selectCandidate(items) {
  const measuredItems = items.filter((item) => Number.isFinite(item.metrics?.qualityScore));
  if (measuredItems.length !== items.length || measuredItems.length === 0) return null;

  let bestScore = -Infinity;
  for (const item of measuredItems) {
    bestScore = Math.max(bestScore, item.metrics.qualityScore);
  }

  const minimumAcceptedScore = bestScore - QUALITY_SCORE_TOLERANCE;
  const eligibleItems = measuredItems.filter((item) => item.metrics.qualityScore >= minimumAcceptedScore);
  let selected = eligibleItems[0];
  for (const item of eligibleItems.slice(1)) {
    const isSmaller = item.validation.bytes < selected.validation.bytes;
    const isSameSizeAndHigherQuality = item.validation.bytes === selected.validation.bytes
      && item.metrics.qualityScore > selected.metrics.qualityScore;
    if (isSmaller || isSameSizeAndHigherQuality) selected = item;
  }

  return {
    selected,
    bestScore: roundMetric(bestScore),
    minimumAcceptedScore: roundMetric(minimumAcceptedScore),
  };
}

function fallbackCandidate(items) {
  return items.find((item) => item.candidate.id === FALLBACK_CANDIDATE_ID) ?? items[0];
}

async function encodeGif({ frames, width, height, durationMs, config, onProgress = () => {} }) {
  if (!frames.length) throw new Error('No captured frames were available for encoding.');

  const tempDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'banner-forge-'));
  try {
    const concatPath = await writeFrames(tempDirectory, frames);
    const ffmpeg = resolveExecutable('ffmpeg', ['BANNER_FORGE_FFMPEG', 'FFMPEG_PATH']);
    const gifskiWorker = resolveExecutable('gifski-worker', ['BANNER_FORGE_GIFSKI_WORKER']);
    if (!await toolAvailable(gifskiWorker)) {
      throw new Error('The bundled Gifski worker could not be found. Rebuild the application or set BANNER_FORGE_GIFSKI_WORKER.');
    }
    const isStillImage = frames.length === 1;
    const profile = {
      fps: config.outputFps,
      maxColors: config.maxColors,
    };
    const candidateDefinitions = candidatesForDithering(config.dithering);
    const items = [];

    for (let index = 0; index < candidateDefinitions.length; index += 1) {
      const candidateDefinition = candidateDefinitions[index];
      const candidatePath = path.join(tempDirectory, `candidate-${index}.gif`);
      const optimizedPath = path.join(tempDirectory, `candidate-${index}-gifski.gif`);
      const inputArguments = ffmpegInputArguments(concatPath, frames.length);
      const filter = paletteFilter(profile, candidateDefinition, { includeFrameRate: !isStillImage });
      const expectedFrameCount = Math.max(1, Math.round((durationMs / 1_000) * profile.fps));
      const frameLimitArguments = ['-frames:v', String(isStillImage ? 1 : expectedFrameCount)];

      await run(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        ...inputArguments,
        '-filter_complex', filter,
        ...frameLimitArguments,
        '-loop', gifLoopArgument(config.loopMode), '-an', candidatePath,
      ]);

      const compression = await applyGifskiCompression(
        gifskiWorker,
        config.gifskiQuality,
        config.loopMode,
        candidatePath,
        optimizedPath,
      );
      const expectedDurationMs = isStillImage ? undefined : durationMs;
      if (expectedDurationMs !== undefined) {
        normalizeGifDuration(compression.path, expectedDurationMs);
      }
      const validation = validateGif(compression.path, {
        width,
        height,
        loopMode: config.loopMode,
        durationMs: expectedDurationMs,
        durationToleranceMs: gifDurationToleranceMs(profile.fps),
      });
      const item = {
        index,
        path: compression.path,
        candidate: candidateDefinition,
        profile,
        validation,
        compression,
        metrics: null,
      };
      items.push(item);
      onProgress({
        stage: 'encode',
        current: index + 1,
        total: candidateDefinitions.length,
        profile,
        candidate: candidateDefinition.id,
        bytes: validation.bytes,
      });
    }

    const warnings = [];
    let evaluation;
    let chosen;

    if (config.dithering !== 'adaptive') {
      chosen = items[0];
      evaluation = {
        mode: 'manual',
        selectedCandidate: chosen.candidate.id,
      };
    } else if (isStillImage) {
      chosen = fallbackCandidate(items);
      evaluation = {
        mode: 'static-default',
        tolerance: QUALITY_SCORE_TOLERANCE,
        selectedCandidate: chosen.candidate.id,
      };
    } else {
      let metricsAvailable = true;
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        try {
          item.metrics = await measureCandidateQuality({
            ffmpeg,
            candidatePath: item.path,
            concatPath,
            fps: profile.fps,
            tempDirectory,
            index,
          });
          onProgress({ stage: 'analyze', current: index + 1, total: items.length });
        } catch {
          metricsAvailable = false;
          break;
        }
      }

      const selection = metricsAvailable ? selectCandidate(items) : null;
      if (selection) {
        chosen = selection.selected;
        evaluation = {
          mode: 'vmaf-cambi',
          formula: 'meanVmaf - (0.10 * p95Cambi)',
          tolerance: QUALITY_SCORE_TOLERANCE,
          bestScore: selection.bestScore,
          minimumAcceptedScore: selection.minimumAcceptedScore,
          selectedCandidate: chosen.candidate.id,
        };
      } else {
        chosen = fallbackCandidate(items);
        evaluation = {
          mode: 'bayer-fallback',
          tolerance: QUALITY_SCORE_TOLERANCE,
          selectedCandidate: chosen.candidate.id,
        };
        warnings.push('Adaptive VMAF/CAMBI comparison was unavailable; Light Bayer was used.');
      }
    }

    const gifBuffer = await fsp.readFile(chosen.path);
    const attempts = items.map((item) => ({
      index: item.index,
      candidate: item.candidate.id,
      label: item.candidate.label,
      fps: item.profile.fps,
      maxColors: item.profile.maxColors,
      dither: item.candidate.dither,
      bayerScale: item.candidate.bayerScale,
      prefilter: item.candidate.prefilter,
      bytes: item.validation.bytes,
      compression: {
        engine: item.compression.engine,
        label: item.compression.label,
        quality: item.compression.quality,
        applied: item.compression.applied,
        sourceBytes: item.compression.sourceBytes,
        processedBytes: item.compression.processedBytes,
      },
      metrics: item.metrics,
      validation: item.validation,
    }));

    return {
      gifBuffer,
      profile,
      selectedCandidate: chosen.candidate,
      validation: chosen.validation,
      attempts,
      evaluation,
      compression: {
        engine: chosen.compression.engine,
        label: chosen.compression.label,
        quality: chosen.compression.quality,
        applied: chosen.compression.applied,
        sourceBytes: chosen.compression.sourceBytes,
        processedBytes: chosen.compression.processedBytes,
      },
      warnings,
    };
  } finally {
    await fsp.rm(tempDirectory, { recursive: true, force: true });
  }
}

module.exports = {
  CAMBI_WEIGHT,
  QUALITY_SCORE_TOLERANCE,
  DITHER_CANDIDATES,
  concatEscape,
  candidatesForDithering,
  paletteFilter,
  ffmpegInputArguments,
  gifskiLoopCount,
  gifskiWorkerArguments,
  writeFrames,
  applyGifskiCompression,
  parseQualityMetrics,
  selectCandidate,
  encodeGif,
};

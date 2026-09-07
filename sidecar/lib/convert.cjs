'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { startFileServer } = require('./server.cjs');
const { captureFrames } = require('./capture.cjs');
const { coalesceFrames, resolveInputPath, uniqueOutputPaths, gifDurationToleranceMs } = require('./helpers.cjs');
const { deliveryProfiles, encodeGif, selectDeliveryCandidate } = require('./encode.cjs');
const { validateGif } = require('./gif.cjs');

function validateReport(report) {
  if (!report || ![4, 5].includes(report.schemaVersion)) throw new Error('Generated report has an invalid schema version.');
  if (!report.inputPath || !report.outputPath || !report.capture || !report.encoding || !report.validation) {
    throw new Error('Generated report is incomplete.');
  }
  if (report.validation.bytes <= 0 || report.validation.frames <= 0) {
    throw new Error('Generated report contains invalid GIF metrics.');
  }
  return report;
}

function roundFps(value) {
  return Math.round(value * 1_000) / 1_000;
}

function effectiveGifFps(validation) {
  if (validation.frames <= 1 || validation.durationMs <= 0) return null;
  return roundFps(validation.frames / (validation.durationMs / 1_000));
}

function buildWarnings(config, capture, encoded) {
  const warnings = [...encoded.warnings];
  const captureWasReduced = capture.effectiveCaptureFps < config.captureFps - 0.001;
  const outputWasReduced = encoded.profile.fps < config.outputFps - 0.001;

  if (outputWasReduced) {
    warnings.push(
      `Requested ${config.outputFps} FPS, but capture safety limits reduced output to ${roundFps(encoded.profile.fps)} FPS.`,
    );
  } else if (captureWasReduced) {
    warnings.push(
      `Source sampling was reduced from ${config.captureFps} FPS to ${roundFps(capture.effectiveCaptureFps)} FPS; the requested ${config.outputFps} FPS output was preserved.`,
    );
  }

  return warnings;
}

async function convertOne(inputPath, outputDirectory, config, emitProgress) {
  const entryPath = resolveInputPath(inputPath);
  const stat = await fsp.stat(entryPath).catch(() => null);
  if (!stat?.isFile()) throw new Error(`Input is not a readable HTML file or package with index.html: ${inputPath}`);
  if (!['.html', '.htm'].includes(path.extname(entryPath).toLowerCase())) throw new Error(`Input must be an HTML file: ${inputPath}`);

  await fsp.mkdir(outputDirectory, { recursive: true });
  const outputPaths = uniqueOutputPaths(inputPath, outputDirectory, config.maxBytes);
  const server = await startFileServer(entryPath);

  try {
    emitProgress({ stage: 'load', current: 0, total: 1 });
    const capture = await captureFrames(server.url, config, emitProgress);
    const frames = coalesceFrames(capture.frames, capture.frameDurationMs);
    emitProgress({ stage: 'coalesce', current: frames.length, total: capture.frames.length });

    const isStillImage = frames.length === 1;
    const availableOutputFps = Math.min(config.outputFps, capture.effectiveCaptureFps);
    const outputFps = isStillImage ? config.outputFps : roundFps(availableOutputFps);
    const encodingConfig = {
      outputFps,
      maxColors: config.maxColors,
      dithering: config.dithering,
      gifskiQuality: config.gifskiQuality,
      loopMode: capture.outputLoopMode,
    };
    const expectedDurationMs = isStillImage ? undefined : capture.durationSeconds * 1_000;
    const outputs = [];

    async function writeOutput(kind, paths, encoded, targetBytes) {
      await fsp.writeFile(paths.gifPath, encoded.gifBuffer, { flag: 'wx' });
      const gifValidation = validateGif(paths.gifPath, {
        width: capture.width,
        height: capture.height,
        loopMode: capture.outputLoopMode,
        durationMs: expectedDurationMs,
        durationToleranceMs: gifDurationToleranceMs(encoded.profile.fps),
      });
      const validation = { ...gifValidation, effectiveFps: effectiveGifFps(gifValidation) };
      const warnings = buildWarnings({ ...config, outputFps: encoded.profile.fps }, capture, encoded);
      const metTarget = targetBytes === undefined ? undefined : validation.bytes <= targetBytes;
      if (targetBytes !== undefined) {
        warnings.push(`Delivery settings selected: ${encoded.profile.fps} FPS, ${encoded.profile.maxColors} colors, ${encoded.selectedCandidate.label}, Gifski ${encoded.compression.quality}% quality.`);
        warnings.push(metTarget
          ? `Delivery target met: ${validation.bytes} bytes is within the ${targetBytes}-byte limit.`
          : `Delivery target not met: smallest candidate was ${validation.bytes} bytes, above the ${targetBytes}-byte limit.`);
      }
      const report = validateReport({
        schemaVersion: 5,
        createdAt: new Date().toISOString(),
        inputPath,
        entryPath,
        outputPath: paths.gifPath,
        outputType: kind,
        delivery: targetBytes === undefined ? undefined : {
          targetBytes,
          metTarget,
          candidatesTested: encoded.deliveryCandidates ?? 1,
          candidates: encoded.deliveryAttemptSummary,
        },
        settings: {
          outputFps: encoded.profile.fps,
          maxColors: encoded.profile.maxColors,
          dithering: encoded.selectedCandidate.id,
          gifskiQuality: encoded.compression.quality,
          maxDurationSeconds: config.maxDurationSeconds,
          requestedLoopMode: config.loopMode,
        },
        capture: {
          width: capture.width,
          height: capture.height,
          requestedFps: config.captureFps,
          effectiveFps: roundFps(capture.effectiveCaptureFps),
          frameRateLimited: capture.frameRateLimited,
          durationSeconds: capture.durationSeconds,
          sourceFrames: capture.frames.length,
          uniqueRuns: frames.length,
          timing: capture.discovery,
        },
        encoding: {
          requestedFps: encoded.profile.fps,
          appliedFps: isStillImage ? null : encoded.profile.fps,
          maxColors: encoded.profile.maxColors,
          requestedDithering: encoded.selectedCandidate.id,
          requestedGifskiQuality: encoded.compression.quality,
          paletteMode: 'stable-global',
          loopMode: capture.outputLoopMode,
          selectedCandidate: {
            id: encoded.selectedCandidate.id,
            label: encoded.selectedCandidate.label,
            dither: encoded.selectedCandidate.dither,
            bayerScale: encoded.selectedCandidate.bayerScale,
            prefilter: encoded.selectedCandidate.prefilter,
          },
          evaluation: encoded.evaluation,
          attempts: encoded.attempts,
          compression: encoded.compression,
        },
        validation,
        warnings,
      });

      await fsp.writeFile(paths.reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
      validateReport(JSON.parse(await fsp.readFile(paths.reportPath, 'utf8')));
      emitProgress({ stage: 'validate', current: outputs.length + 1, total: config.outputMode === 'both' ? 2 : 1, bytes: validation.bytes, outputType: kind });
      outputs.push({ ...paths, report });
    }

    if (config.outputMode !== 'size-limited') {
      const encoded = await encodeGif({ frames, width: capture.width, height: capture.height, durationMs: expectedDurationMs ?? 0, config: encodingConfig, onProgress: emitProgress });
      await writeOutput('forge', outputPaths.forge, encoded);
    }

    if (config.outputMode !== 'forge') {
      const candidates = [];
      const profiles = deliveryProfiles(encodingConfig);
      for (let index = 0; index < profiles.length; index += 1) {
        const encoded = await encodeGif({
          frames,
          width: capture.width,
          height: capture.height,
          durationMs: expectedDurationMs ?? 0,
          config: profiles[index],
          onProgress: (progress) => emitProgress({ ...progress, stage: 'optimize', current: index + 1, total: profiles.length }),
        });
        candidates.push(encoded);
      }
      const selected = selectDeliveryCandidate(candidates, config.maxBytes);
      selected.deliveryCandidates = candidates.length;
      selected.deliveryAttemptSummary = candidates.map((candidate) => ({
        bytes: candidate.validation.bytes,
        outputFps: candidate.profile.fps,
        maxColors: candidate.profile.maxColors,
        dithering: candidate.selectedCandidate.id,
        gifskiQuality: candidate.compression.quality,
      }));
      await writeOutput('delivery', outputPaths.delivery, selected, config.maxBytes);
    }

    return { outputs };
  } catch (error) {
    for (const group of [outputPaths.forge, outputPaths.delivery]) {
      for (const outputPath of [group.gifPath, group.reportPath]) {
        try {
          if (fs.existsSync(outputPath)) await fsp.unlink(outputPath);
        } catch {
          // Preserve the conversion error that caused cleanup.
        }
      }
    }
    throw error;
  } finally {
    await server.close();
  }
}

module.exports = {
  validateReport,
  effectiveGifFps,
  buildWarnings,
  convertOne,
};

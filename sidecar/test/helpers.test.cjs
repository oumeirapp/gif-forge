'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const {
  PROTOCOL_VERSION,
  CAPTURE_FPS,
  OUTPUT_FPS_OPTIONS,
  PALETTE_OPTIONS,
  DITHERING_OPTIONS: CONFIG_DITHERING_OPTIONS,
  OUTPUT_MODES,
  normalizeConfig,
  validateRequest,
  resolveInputPath,
  safeStem,
  uniqueOutputPaths,
  coalesceFrames,
  gifLoopArgument,
  gifDurationToleranceMs,
} = require('../lib/helpers.cjs');
const { distributeFrameDelays, inspectGif, validateGif } = require('../lib/gif.cjs');
const { isWithin } = require('../lib/server.cjs');
const {
  DITHER_CANDIDATES,
  candidatesForDithering,
  concatEscape,
  paletteFilter,
  ffmpegInputArguments,
  gifskiLoopCount,
  gifskiWorkerArguments,
  parseQualityMetrics,
  selectCandidate,
  deliveryProfiles,
  selectDeliveryCandidate,
  encodeGif,
} = require('../lib/encode.cjs');
const {
  MAX_CAPTURE_FRAMES,
  MAX_CAPTURE_PIXEL_SAMPLES,
  DISCOVER_SCRIPT,
  timelineDurationMilliseconds,
  seekTimeline,
  chooseDuration,
  resolveOutputLoopMode,
  createCapturePlan,
  captureTimestampMilliseconds,
} = require('../lib/capture.cjs');
const { resolveExecutable, toolAvailable } = require('../lib/tools.cjs');
const { validateReport, effectiveGifFps, buildWarnings } = require('../lib/convert.cjs');

function evaluateDiscovery(animations, windowValue = {}) {
  const documentElement = { scrollWidth: 300, scrollHeight: 250 };
  const document = {
    body: { children: { length: 0 } },
    documentElement,
    getAnimations: () => animations,
    querySelector: (selector) => selector.startsWith('meta[')
      ? { content: 'width=300,height=250' }
      : null,
  };

  return vm.runInNewContext(DISCOVER_SCRIPT, {
    document,
    window: windowValue,
    getComputedStyle: () => ({ width: '300px', height: '250px' }),
  });
}

test('configuration defaults are explicit and every dropdown value is accepted', () => {
  assert.deepEqual(normalizeConfig({}), {
    outputFps: 15,
    maxColors: 256,
    dithering: 'adaptive',
    gifskiQuality: 80,
    captureFps: 24,
    maxDurationSeconds: 30,
    loopMode: 'auto',
    outputMode: 'forge',
    maxBytes: 150_000,
  });
  assert.equal(CAPTURE_FPS, 24);
  assert.deepEqual(OUTPUT_FPS_OPTIONS, [4, 12, 15, 24]);
  assert.deepEqual(PALETTE_OPTIONS, [64, 128, 192, 256]);
  assert.deepEqual(CONFIG_DITHERING_OPTIONS, ['adaptive', 'none', 'bayer-5', 'bayer-4', 'gradfun-bayer-5']);
  assert.deepEqual(normalizeConfig({
    outputFps: 24,
    maxColors: 64,
    dithering: 'none',
    gifskiQuality: 75,
    maxDurationSeconds: 30,
    loopMode: false,
  }), {
    outputFps: 24,
    maxColors: 64,
    dithering: 'none',
    gifskiQuality: 75,
    captureFps: 24,
    maxDurationSeconds: 30,
    loopMode: 'once',
    outputMode: 'forge',
    maxBytes: 150_000,
  });
  assert.throws(() => normalizeConfig({ outputFps: 8 }), /outputFps/);
  assert.throws(() => normalizeConfig({ maxColors: 48 }), /maxColors/);
  assert.throws(() => normalizeConfig({ dithering: 'sierra' }), /dithering/);
  assert.throws(() => normalizeConfig({ gifskiQuality: 0 }), /gifskiQuality/);
  assert.throws(() => normalizeConfig({ gifskiQuality: 101 }), /gifskiQuality/);
  assert.throws(() => normalizeConfig({ gifskiQuality: 80.5 }), /gifskiQuality/);
  assert.throws(() => normalizeConfig({ compression: 'none' }), /legacy/);
  assert.throws(() => normalizeConfig({ maxDurationSeconds: 0 }), /maxDurationSeconds/);
  assert.throws(() => normalizeConfig({ quality: 'high' }), /legacy/);
  assert.throws(() => normalizeConfig({ preferredBytes: 90_000 }), /legacy/);
  assert.deepEqual(OUTPUT_MODES, ['forge', 'size-limited', 'both']);
  assert.deepEqual(normalizeConfig({ outputMode: 'both', maxBytes: 90_000 }).outputMode, 'both');
  assert.equal(normalizeConfig({ outputMode: 'both', maxBytes: 90_000 }).maxBytes, 90_000);
  assert.throws(() => normalizeConfig({ outputMode: 'archive' }), /outputMode/);
  assert.throws(() => normalizeConfig({ maxBytes: 0 }), /maxBytes/);
  assert.throws(() => normalizeConfig({ maxBytes: 150_000.5 }), /maxBytes/);
});

test('protocol v4 request validation resolves paths and rejects legacy requests', () => {
  const request = validateRequest({
    protocolVersion: PROTOCOL_VERSION,
    inputPaths: ['./banner.html'],
    outputDirectory: './out',
    config: { outputFps: 4, maxColors: 128, dithering: 'bayer-5', gifskiQuality: 90, loopMode: 2 },
  });
  assert.equal(request.inputPaths.length, 1);
  assert.equal(request.config.loopMode, 2);
  assert.equal(request.config.outputFps, 4);
  assert.equal(request.config.outputMode, 'forge');
  assert.throws(() => validateRequest({ inputPaths: [], outputDirectory: 'out' }), /protocolVersion/);
  assert.throws(() => validateRequest({ protocolVersion: 2, inputPaths: [], outputDirectory: 'out' }), /protocolVersion/);
  assert.throws(() => validateRequest({ protocolVersion: 4, inputPaths: [], outputDirectory: 'out' }), /non-empty/);
  assert.throws(() => validateRequest({
    protocolVersion: 4,
    inputPaths: ['./banner.html'],
    outputDirectory: './out',
    config: { captureFps: 12 },
  }), /legacy/);
});

test('package directories resolve to their index.html entry point', () => {
  const packageDirectory = path.join(__dirname, 'fixtures', 'package');
  assert.equal(resolveInputPath(packageDirectory), path.join(packageDirectory, 'index.html'));
});

test('legacy GSAP timeline helpers read and seek TimelineMax-style objects', () => {
  const calls = [];
  const timeline = {
    totalDuration: () => 1.25,
    pause: () => calls.push('pause'),
    time: (seconds, suppressEvents) => calls.push(['time', seconds, suppressEvents]),
  };
  assert.equal(timelineDurationMilliseconds(timeline), 1250);
  assert.equal(seekTimeline(timeline, 0.75), true);
  assert.deepEqual(calls, ['pause', ['time', 0.75, false]]);
  assert.equal(chooseDuration({ legacyTimelineMilliseconds: 1250 }, 1), 1);
  assert.equal(resolveOutputLoopMode('auto', false), 'once');
  assert.equal(resolveOutputLoopMode('auto', true), 'forever');
  assert.equal(resolveOutputLoopMode('once', true), 'once');
});

test('infinite CSS and GSAP animations use one complete cycle', () => {
  const cssAnimation = {
    effect: {
      getComputedTiming: () => ({ endTime: Infinity, iterations: Infinity, duration: 750 }),
      getTiming: () => ({ delay: 100, duration: 750 }),
    },
  };
  const cssDiscovery = evaluateDiscovery([cssAnimation]);
  assert.equal(cssDiscovery.cssMilliseconds, 850);
  assert.equal(cssDiscovery.loopsInfinitely, true);
  assert.equal(chooseDuration(cssDiscovery, 30), 0.85);

  const repeatingChild = {
    repeat: () => -1,
    duration: () => 1.2,
    repeatDelay: () => 0.3,
    startTime: () => 99,
    globalTime: () => 2,
  };
  const gsap = {
    globalTimeline: {
      getChildren: () => [repeatingChild],
      duration: () => 1_000_000,
    },
  };
  const gsapDiscovery = evaluateDiscovery([], { gsap });
  assert.equal(gsapDiscovery.gsapMilliseconds, 3500);
  assert.equal(gsapDiscovery.loopsInfinitely, true);
  assert.equal(chooseDuration(gsapDiscovery, 30), 3.5);
});

test('finite GSAP narrative wins over an infinite decorative yoyo in auto mode', () => {
  const narrative = {
    repeat: () => 0,
    duration: () => 7.1,
    totalDuration: () => 7.1,
    startTime: () => 0,
    globalTime: (localTime) => localTime,
  };
  const decorativeYoyo = {
    repeat: () => -1,
    duration: () => 0.8,
    repeatDelay: () => 0.1,
    yoyo: () => true,
    startTime: () => 0,
    globalTime: () => 0,
  };
  const gsap = {
    globalTimeline: {
      getChildren: () => [narrative, decorativeYoyo],
      duration: () => 1_000_000,
    },
  };

  const discovery = evaluateDiscovery([], { gsap });
  assert.equal(discovery.gsapFiniteMilliseconds, 7100);
  assert.equal(discovery.gsapInfiniteMilliseconds, 1800);
  assert.equal(discovery.finiteAnimationMilliseconds, 7100);
  assert.equal(discovery.hasFiniteNarrative, true);
  assert.equal(discovery.hasInfiniteAnimation, true);
  assert.equal(discovery.loopsInfinitely, false);
  assert.equal(chooseDuration(discovery, 30), 7.1);
  assert.equal(resolveOutputLoopMode('auto', discovery.loopsInfinitely), 'once');
  assert.equal(resolveOutputLoopMode('forever', discovery.loopsInfinitely), 'forever');
});

test('capture plans cap frame count and total sampled pixels', () => {
  const plan = createCapturePlan(4096, 4096, 60, 60);
  assert.equal(plan.frameRateLimited, true);
  assert.ok(plan.frameCount <= MAX_CAPTURE_FRAMES);
  assert.ok(plan.pixelSamples <= MAX_CAPTURE_PIXEL_SAMPLES);
  assert.equal(captureTimestampMilliseconds(0, plan.frameCount, 60), 0);
  assert.ok(captureTimestampMilliseconds(plan.frameCount - 1, plan.frameCount, 60) < 60_000);

  const singleFramePlan = createCapturePlan(120, 60, 0.1, 4);
  assert.equal(singleFramePlan.frameCount, 1);
  assert.equal(singleFramePlan.frameDurationMs, 100);
  assert.equal(captureTimestampMilliseconds(0, 1, 0.1), 0);
});

test('safe output stems cannot inject directories', () => {
  assert.equal(safeStem('/tmp/My banner!.html'), 'My-banner');
  assert.equal(safeStem('/tmp/🔥.html'), 'banner');
});

test('output paths reserve Forge and delivery names without overwriting existing files', () => {
  const outputPaths = uniqueOutputPaths('/tmp/My banner!.html', '/tmp/output', 150_000);
  assert.deepEqual(outputPaths, {
    forge: {
      gifPath: '/tmp/output/My-banner.gif',
      reportPath: '/tmp/output/My-banner.report.json',
    },
    delivery: {
      gifPath: '/tmp/output/My-banner-150kb.gif',
      reportPath: '/tmp/output/My-banner-150kb.report.json',
    },
  });
});

test('identical adjacent PNGs are coalesced with exact byte comparison', () => {
  const a = Buffer.from('a');
  const b = Buffer.from('b');
  const result = coalesceFrames([a, Buffer.from('a'), b, Buffer.from('a')], 50);
  assert.deepEqual(result.map(({ durationMs, sourceFrames }) => ({ durationMs, sourceFrames })), [
    { durationMs: 100, sourceFrames: 2 },
    { durationMs: 50, sourceFrames: 1 },
    { durationMs: 50, sourceFrames: 1 },
  ]);
});

test('encoding candidates keep FPS and color quality fixed', () => {
  assert.deepEqual(DITHER_CANDIDATES.map((candidate) => candidate.id), [
    'none',
    'bayer-5',
    'bayer-4',
    'gradfun-bayer-5',
  ]);
  assert.equal(DITHER_CANDIDATES.some((candidate) => candidate.dither.includes('sierra')), false);
  assert.equal(gifLoopArgument('forever'), '0');
  assert.equal(gifLoopArgument('once'), '-1');
  assert.equal(gifDurationToleranceMs(20), 250);
  assert.equal(normalizeConfig({ loopMode: 'auto' }).loopMode, 'auto');
  assert.equal(normalizeConfig({ loopMode: 'infinite' }).loopMode, 'forever');
  assert.equal(candidatesForDithering('adaptive').length, 4);
  assert.deepEqual(candidatesForDithering('none').map((candidate) => candidate.id), ['none']);
  assert.deepEqual(candidatesForDithering('bayer-5').map((candidate) => candidate.id), ['bayer-5']);
  assert.equal(gifskiLoopCount('once'), null);
  assert.equal(gifskiLoopCount('forever'), 0);
  assert.equal(gifskiLoopCount(3), 3);
  const workerArguments = gifskiWorkerArguments(
    '/tmp/input.gif',
    '/tmp/output.gif',
    80,
    'forever',
  );
  assert.equal(workerArguments[0], 'encode');
  assert.deepEqual(
    JSON.parse(workerArguments[1]),
    {
      inputPath: '/tmp/input.gif',
      outputPath: '/tmp/output.gif',
      quality: 80,
      loopCount: 0,
    },
  );
});

test('delivery profiles lower compression cost while preserving dimensions and selected settings first', () => {
  const profiles = deliveryProfiles({
    outputFps: 24,
    maxColors: 256,
    dithering: 'adaptive',
    gifskiQuality: 90,
    loopMode: 'once',
  });

  assert.deepEqual(profiles[0], {
    outputFps: 24,
    maxColors: 256,
    dithering: 'adaptive',
    gifskiQuality: 90,
    loopMode: 'once',
  });
  assert.ok(profiles.some((profile) => profile.gifskiQuality < 90));
  assert.ok(profiles.some((profile) => profile.maxColors < 256));
  assert.ok(profiles.some((profile) => profile.dithering === 'none'));
  assert.ok(profiles.some((profile) => profile.outputFps < 24));
  assert.equal(new Set(profiles.map((profile) => JSON.stringify(profile))).size, profiles.length);
});

test('delivery candidate selection prefers the earliest in-budget candidate and otherwise the smallest output', () => {
  const candidates = [
    { profile: { outputFps: 24 }, validation: { bytes: 210_000 } },
    { profile: { outputFps: 15 }, validation: { bytes: 149_000 } },
    { profile: { outputFps: 12 }, validation: { bytes: 120_000 } },
  ];

  assert.equal(selectDeliveryCandidate(candidates, 150_000), candidates[1]);
  assert.equal(selectDeliveryCandidate(candidates, 100_000), candidates[2]);
});

test('adaptive quality metrics select the smallest visually equivalent candidate', () => {
  const parsed = parseQualityMetrics({
    pooled_metrics: { vmaf: { mean: 95.4 } },
    frames: [
      { metrics: { cambi: 0.1 } },
      { metrics: { cambi: 0.2 } },
      { metrics: { cambi: 0.3 } },
    ],
  });
  assert.deepEqual(parsed, {
    meanVmaf: 95.4,
    p95Cambi: 0.3,
    qualityScore: 95.37,
  });

  const selection = selectCandidate([
    { candidate: { id: 'best' }, validation: { bytes: 2_000 }, metrics: { qualityScore: 95.5 } },
    { candidate: { id: 'small-near-best' }, validation: { bytes: 1_000 }, metrics: { qualityScore: 95.3 } },
    { candidate: { id: 'too-far' }, validation: { bytes: 500 }, metrics: { qualityScore: 95.2 } },
  ]);
  assert.equal(selection.selected.candidate.id, 'small-near-best');
  assert.equal(selection.minimumAcceptedScore, 95.25);
  assert.equal(selectCandidate([{ validation: { bytes: 1 }, metrics: null }]), null);
});

test('GIF parser validates dimensions and frame count', () => {
  const singlePixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  assert.deepEqual(inspectGif(singlePixel), { width: 1, height: 1, frames: 1, durationMs: 0, loopCount: null, bytes: singlePixel.length });
  assert.equal(validateGif(singlePixel, { width: 1, height: 1 }).frames, 1);
  assert.equal(validateGif(singlePixel, { width: 1, height: 1, loopMode: 'once' }).loopCount, null);
  assert.equal(validateGif(singlePixel, { durationMs: 10, durationToleranceMs: 10 }).durationMs, 0);
  assert.throws(() => validateGif(singlePixel, { width: 2, height: 1 }), /width/);
  assert.throws(() => validateGif(singlePixel, { width: 1, height: 1, loopMode: 'forever' }), /infinite loop/);
  assert.throws(() => validateGif(singlePixel, { durationMs: 30, durationToleranceMs: 10 }), /duration/);
});

test('GIF timing distributes centisecond rounding across the animation', () => {
  const delays = distributeFrameDelays(15, 100);

  assert.equal(delays.length, 15);
  assert.equal(delays.reduce((total, delay) => total + delay, 0), 100);
  assert.equal(delays.filter((delay) => delay === 7).length, 10);
  assert.equal(delays.filter((delay) => delay === 6).length, 5);
  assert.equal(delays.some((delay, index) => index > 0 && delay !== delays[index - 1]), true);
  assert.notDeepEqual(delays, [...Array(10).fill(7), ...Array(5).fill(6)]);
});

test('server containment and ffconcat escaping are conservative', () => {
  assert.equal(isWithin('/tmp/root', '/tmp/root/assets/a.png'), true);
  assert.equal(isWithin('/tmp/root', '/tmp/root-other/a.png'), false);
  assert.equal(concatEscape("/tmp/it's.png"), "/tmp/it'\\''s.png");
  assert.match(
    paletteFilter({ fps: 12, maxColors: 192 }, DITHER_CANDIDATES[1]),
    /fps=12.*max_colors=192:stats_mode=full.*dither=bayer:bayer_scale=5/,
  );
  assert.doesNotMatch(
    paletteFilter({ fps: 4, maxColors: 192 }, DITHER_CANDIDATES[0], { includeFrameRate: false }),
    /fps=/,
  );
  assert.match(
    paletteFilter({ fps: 15, maxColors: 256 }, DITHER_CANDIDATES[3]),
    /gradfun=strength=1.2:radius=16.*max_colors=256/,
  );
  assert.deepEqual(ffmpegInputArguments('/tmp/frames.ffconcat', 1), ['-i', '/tmp/frame-000000.png']);
});

test('result warnings report safety adjustments without changing selected controls', () => {
  const config = { outputFps: 15, captureFps: 24 };
  assert.deepEqual(buildWarnings(config, { effectiveCaptureFps: 24 }, { warnings: [], profile: { fps: 15 } }), []);
  assert.match(
    buildWarnings(config, { effectiveCaptureFps: 12.5 }, { warnings: [], profile: { fps: 12.5 } })[0],
    /Requested 15 FPS.*12.5 FPS/,
  );
  assert.match(
    buildWarnings(
      { outputFps: 4, captureFps: 24 },
      { effectiveCaptureFps: 20 },
      { warnings: [], profile: { fps: 4 } },
    )[0],
    /sampling was reduced.*requested 4 FPS output was preserved/,
  );
  assert.equal(effectiveGifFps({ frames: 56, durationMs: 9_300 }), 6.022);
  assert.equal(effectiveGifFps({ frames: 1, durationMs: 0 }), null);
});

test('reports accept the current schema and retain v4 validation compatibility', () => {
  const report = {
    schemaVersion: 4,
    inputPath: '/tmp/input.html',
    outputPath: '/tmp/output.gif',
    capture: {},
    encoding: {},
    validation: { bytes: 1, frames: 1 },
  };

  assert.equal(validateReport(report), report);
  const v5Report = { ...report, schemaVersion: 5 };
  assert.equal(validateReport(v5Report), v5Report);
  assert.throws(() => validateReport({ ...report, schemaVersion: 2 }), /schema version/);
});

test('a single captured frame honors explicit palette, dithering, and Gifski quality', async (context) => {
  const ffmpeg = resolveExecutable('ffmpeg', ['BANNER_FORGE_FFMPEG', 'FFMPEG_PATH']);
  if (!await toolAvailable(ffmpeg)) {
    context.skip('FFmpeg is not installed.');
    return;
  }

  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const encoded = await encodeGif({
    frames: [{ buffer: onePixelPng, durationMs: 100, sourceFrames: 1 }],
    width: 1,
    height: 1,
    durationMs: 100,
    config: {
      outputFps: 4,
      maxColors: 64,
      dithering: 'none',
      gifskiQuality: 80,
      loopMode: 'once',
    },
  });

  const inspection = inspectGif(encoded.gifBuffer);
  assert.equal(inspection.width, 1);
  assert.equal(inspection.height, 1);
  assert.equal(inspection.frames, 1);
  assert.equal(inspection.loopCount, null);
  assert.ok(inspection.bytes > 0);
  assert.equal(encoded.profile.fps, 4);
  assert.equal(encoded.profile.maxColors, 64);
  assert.equal(encoded.selectedCandidate.id, 'none');
  assert.equal(encoded.attempts.length, 1);
  assert.equal(encoded.compression.engine, 'gifski');
  assert.equal(encoded.compression.quality, 80);
});

test('a short animation keeps its captured duration after GIF frame-rate rounding', async (context) => {
  const ffmpeg = resolveExecutable('ffmpeg', ['BANNER_FORGE_FFMPEG', 'FFMPEG_PATH']);
  if (!await toolAvailable(ffmpeg)) {
    context.skip('FFmpeg is not installed.');
    return;
  }

  const firstFrame = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP8wwACLGCSAQANBAECv1AVswAAAABJRU5ErkJggg==',
    'base64',
  );
  const secondFrame = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEklEQVR4nGNkYPjLwMDAwgAGAAsXAQPfmWhAAAAAAElFTkSuQmCC',
    'base64',
  );
  const encoded = await encodeGif({
    frames: [
      { buffer: firstFrame, durationMs: 200, sourceFrames: 1 },
      { buffer: secondFrame, durationMs: 200, sourceFrames: 1 },
    ],
    width: 2,
    height: 2,
    durationMs: 400,
    config: {
      outputFps: 4,
      maxColors: 192,
      dithering: 'adaptive',
      gifskiQuality: 80,
      loopMode: 'once',
    },
  });

  const inspection = inspectGif(encoded.gifBuffer);
  assert.equal(inspection.frames, 2);
  assert.equal(inspection.durationMs, 400);
  assert.equal(encoded.attempts.length, 4);
  assert.equal(encoded.attempts.every((attempt) => attempt.fps === 4), true);
  assert.equal(encoded.attempts.every((attempt) => attempt.maxColors === 192), true);
});

test('Gifski quality defaults to 80 and never changes FPS or palette settings', () => {
  const config = normalizeConfig({ outputFps: 24, maxColors: 256 });

  assert.equal(config.gifskiQuality, 80);
  assert.equal(config.outputFps, 24);
  assert.equal(config.maxColors, 256);
});

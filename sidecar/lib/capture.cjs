'use strict';

if (process.pkg) {
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function loadWithPackagedInspectorFallback(request, parent, isMain) {
    if (request === 'inspector' || request === 'node:inspector') {
      return { url: () => undefined, Session: class UnavailableInspectorSession {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}

const { chromium } = require('playwright-core');
const { resolveChromiumExecutable } = require('./tools.cjs');

const MAX_CAPTURE_FRAMES = 600;
const MAX_CAPTURE_PIXEL_SAMPLES = 100_000_000;

function timelineDurationMilliseconds(timeline) {
  if (!timeline) return 0;
  try {
    let value = 0;
    if (typeof timeline.totalDuration === 'function') {
      value = timeline.totalDuration();
    } else if (typeof timeline.duration === 'function') {
      value = timeline.duration();
    }
    return Number.isFinite(value) && value > 0 ? value * 1000 : 0;
  } catch {
    return 0;
  }
}

function seekTimeline(timeline, seconds) {
  if (!timeline) return false;
  try {
    timeline.pause?.();
    if (typeof timeline.time === 'function') timeline.time(seconds, false);
    else if (typeof timeline.seek === 'function') timeline.seek(seconds, false);
    else return false;
    return true;
  } catch {
    return false;
  }
}

const DISCOVER_SCRIPT = String.raw`(() => {
  const number = (value) => Number.parseFloat(value) || 0;
  const meta = document.querySelector('meta[name="ad.size" i]')?.content || '';
  const metaWidth = number(meta.match(/width\s*=\s*(\d+)/i)?.[1]);
  const metaHeight = number(meta.match(/height\s*=\s*(\d+)/i)?.[1]);
  const candidates = [
    document.querySelector('[data-banner]'),
    document.querySelector('#banner'),
    document.querySelector('.banner'),
    document.querySelector('main'),
    document.body.children.length === 1 ? document.body.firstElementChild : null,
  ].filter(Boolean);
  const bounds = candidates.map((element) => element.getBoundingClientRect())
    .find((rect) => rect.width >= 16 && rect.height >= 16);
  const styleWidth = number(getComputedStyle(document.documentElement).width);
  const styleHeight = number(getComputedStyle(document.documentElement).height);
  const width = metaWidth || Math.ceil(bounds?.width || Math.min(document.documentElement.scrollWidth, styleWidth || 1920));
  const height = metaHeight || Math.ceil(bounds?.height || Math.min(document.documentElement.scrollHeight, styleHeight || 1080));

  let cssFiniteMilliseconds = 0;
  let cssInfiniteMilliseconds = 0;
  let cssLoopsInfinitely = false;
  for (const animation of document.getAnimations()) {
    const timing = animation.effect?.getComputedTiming?.();
    const configuredTiming = animation.effect?.getTiming?.();
    const end = Number(timing?.endTime);
    const loopsInfinitely = timing?.iterations === Infinity;
    if (loopsInfinitely) {
      const delay = Math.max(0, Number(configuredTiming?.delay ?? timing?.delay) || 0);
      const iterationDuration = Number(timing?.duration ?? configuredTiming?.duration) || 0;
      const direction = configuredTiming?.direction ?? timing?.direction;
      const alternates = direction === 'alternate' || direction === 'alternate-reverse';
      const cycleDuration = alternates ? iterationDuration * 2 : iterationDuration;
      cssInfiniteMilliseconds = Math.max(cssInfiniteMilliseconds, delay + cycleDuration);
    } else if (Number.isFinite(end)) {
      cssFiniteMilliseconds = Math.max(cssFiniteMilliseconds, end);
    }
    if (loopsInfinitely) cssLoopsInfinitely = true;
  }
  let gsapFiniteMilliseconds = 0;
  let gsapInfiniteMilliseconds = 0;
  let gsapLoopsInfinitely = false;
  const hasModernGsap = Boolean(window.gsap?.globalTimeline);
  try {
    const globalTimeline = window.gsap?.globalTimeline;
    const children = globalTimeline?.getChildren?.(true, true, false) || [];
    for (const child of children) {
      const repeat = child?.repeat?.();
      const duration = Math.max(0, Number(child?.duration?.()) || 0);
      let globalStart = Math.max(0, Number(child?.startTime?.()) || 0);
      if (typeof child?.globalTime === 'function') {
        const measuredStart = Number(child.globalTime(0));
        if (Number.isFinite(measuredStart)) globalStart = Math.max(0, measuredStart);
      }
      if (repeat === -1 || repeat === Infinity) {
        gsapLoopsInfinitely = true;
        const repeatDelay = Math.max(0, Number(child?.repeatDelay?.()) || 0);
        const yoyoMultiplier = child?.yoyo?.() ? 2 : 1;
        const cycleDuration = (duration + repeatDelay) * yoyoMultiplier;
        const cycleEnd = globalStart + cycleDuration;
        if (cycleEnd > 0) {
          gsapInfiniteMilliseconds = Math.max(gsapInfiniteMilliseconds, cycleEnd * 1000);
        }
        continue;
      }

      const totalDuration = Number(child?.totalDuration?.());
      const localEnd = Number.isFinite(totalDuration) && totalDuration > 0
        ? totalDuration
        : duration;
      let globalEnd = globalStart + localEnd;
      if (typeof child?.globalTime === 'function') {
        const measuredEnd = Number(child.globalTime(localEnd));
        if (Number.isFinite(measuredEnd)) globalEnd = measuredEnd;
      }
      if (Number.isFinite(globalEnd) && globalEnd > 0) {
        gsapFiniteMilliseconds = Math.max(gsapFiniteMilliseconds, globalEnd * 1000);
      }
    }
    if (children.length === 0) {
      const duration = globalTimeline?.duration?.();
      if (Number.isFinite(duration)) gsapFiniteMilliseconds = duration * 1000;
    }
  } catch {}
  let legacyFiniteMilliseconds = 0;
  let legacyInfiniteMilliseconds = 0;
  try {
    if (!hasModernGsap && window.tl) {
      const repeat = window.tl?.repeat?.();
      const hasInfiniteRepeat = repeat === -1 || repeat === Infinity;
      if (hasInfiniteRepeat) {
        const duration = Math.max(0, Number(window.tl?.duration?.()) || 0);
        const repeatDelay = Math.max(0, Number(window.tl?.repeatDelay?.()) || 0);
        const delay = Math.max(0, Number(window.tl?.delay?.()) || 0);
        const yoyoMultiplier = window.tl?.yoyo?.() ? 2 : 1;
        legacyInfiniteMilliseconds = (delay + ((duration + repeatDelay) * yoyoMultiplier)) * 1000;
        gsapLoopsInfinitely = true;
      } else {
        const legacyDuration = typeof window.tl?.totalDuration === 'function'
          ? window.tl.totalDuration()
          : window.tl?.duration?.();
        if (Number.isFinite(legacyDuration)) legacyFiniteMilliseconds = legacyDuration * 1000;
      }
    }
  } catch {}
  const finiteAnimationMilliseconds = Math.max(
    cssFiniteMilliseconds,
    gsapFiniteMilliseconds,
    legacyFiniteMilliseconds,
  );
  const infiniteCycleMilliseconds = Math.max(
    cssInfiniteMilliseconds,
    gsapInfiniteMilliseconds,
    legacyInfiniteMilliseconds,
  );
  const hasInfiniteAnimation = cssLoopsInfinitely || gsapLoopsInfinitely;
  const hasFiniteNarrative = finiteAnimationMilliseconds > 0;
  return {
    width: Math.max(1, Math.min(4096, width || 300)),
    height: Math.max(1, Math.min(4096, height || 250)),
    cssMilliseconds: cssFiniteMilliseconds || cssInfiniteMilliseconds,
    gsapMilliseconds: gsapFiniteMilliseconds || gsapInfiniteMilliseconds,
    legacyTimelineMilliseconds: legacyFiniteMilliseconds || legacyInfiniteMilliseconds,
    cssFiniteMilliseconds,
    cssInfiniteMilliseconds,
    gsapFiniteMilliseconds,
    gsapInfiniteMilliseconds,
    legacyFiniteMilliseconds,
    legacyInfiniteMilliseconds,
    finiteAnimationMilliseconds,
    infiniteCycleMilliseconds,
    animationCount: document.getAnimations().length,
    hasGsap: hasModernGsap,
    hasLegacyTimeline: Boolean(window.tl),
    hasFiniteNarrative,
    hasInfiniteAnimation,
    loopsInfinitely: hasInfiniteAnimation && !hasFiniteNarrative,
  };
})()`;

const WAIT_FOR_ASSETS_SCRIPT = `(() => {
  const timeout = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const ready = [];
  if (document.fonts?.ready) ready.push(document.fonts.ready.catch(() => {}));
  for (const image of document.images) {
    if (!image.complete) ready.push(new Promise((resolve) => {
      image.addEventListener('load', resolve, { once: true });
      image.addEventListener('error', resolve, { once: true });
    }));
  }
  for (const media of document.querySelectorAll('video')) {
    if (media.readyState < 1) ready.push(new Promise((resolve) => {
      media.addEventListener('loadedmetadata', resolve, { once: true });
      media.addEventListener('error', resolve, { once: true });
    }));
  }
  return Promise.race([Promise.allSettled(ready), timeout(5000)]);
})()`;

async function waitForAssets(page) {
  await page.evaluate(WAIT_FOR_ASSETS_SCRIPT);
}

async function freezeAt(page, milliseconds) {
  const time = JSON.stringify(milliseconds);
  await page.evaluate(`(() => {
    for (const animation of document.getAnimations()) {
      try {
        animation.pause();
        animation.currentTime = ${time};
      } catch {}
    }
    try {
      const timeline = window.gsap?.globalTimeline;
      if (timeline) {
        timeline.pause();
        timeline.time(Math.max(0, ${time} / 1000), false);
      }
    } catch {}
    try {
      const timeline = window.tl;
      if (timeline && timeline !== window.gsap?.globalTimeline) {
        timeline.pause?.();
        if (typeof timeline.time === 'function') timeline.time(Math.max(0, ${time} / 1000), false);
        else timeline.seek?.(Math.max(0, ${time} / 1000), false);
      }
    } catch {}
    for (const video of document.querySelectorAll('video')) {
      try {
        video.pause();
        if (Number.isFinite(video.duration)) video.currentTime = Math.min(video.duration, ${time} / 1000);
      } catch {}
    }
  })()`);
}

function chooseDuration(discovery, maximumSeconds) {
  const finiteNarrative = Number(discovery.finiteAnimationMilliseconds) || 0;
  if (finiteNarrative > 0) {
    return Math.min(maximumSeconds, Math.max(0.1, finiteNarrative / 1000));
  }

  const infiniteCycle = Number(discovery.infiniteCycleMilliseconds) || 0;
  if (infiniteCycle > 0) {
    return Math.min(maximumSeconds, Math.max(0.1, infiniteCycle / 1000));
  }

  const detected = Math.max(discovery.cssMilliseconds || 0, discovery.gsapMilliseconds || 0, discovery.legacyTimelineMilliseconds || 0) / 1000;
  if (detected > 0) return Math.min(maximumSeconds, Math.max(0.1, detected));
  const hasAnimation = discovery.animationCount || discovery.hasGsap || discovery.hasLegacyTimeline;
  const fallbackDuration = hasAnimation ? 3 : 0.1;
  return Math.min(maximumSeconds, fallbackDuration);
}

function resolveOutputLoopMode(requestedLoopMode, loopsInfinitely) {
  if (requestedLoopMode !== 'auto') return requestedLoopMode;
  return loopsInfinitely ? 'forever' : 'once';
}

function createCapturePlan(width, height, durationSeconds, requestedFps) {
  const canvasPixels = Math.max(1, Math.ceil(width) * Math.ceil(height));
  const requestedFrameCount = Math.max(1, Math.ceil(durationSeconds * requestedFps));
  const frameCountFromPixelLimit = Math.max(1, Math.floor(MAX_CAPTURE_PIXEL_SAMPLES / canvasPixels));
  const frameCount = Math.min(requestedFrameCount, MAX_CAPTURE_FRAMES, frameCountFromPixelLimit);
  const frameRateLimited = frameCount < requestedFrameCount;
  const effectiveCaptureFps = frameRateLimited ? frameCount / durationSeconds : requestedFps;
  const frameDurationMs = (durationSeconds * 1000) / frameCount;

  return {
    frameCount,
    frameDurationMs,
    effectiveCaptureFps,
    frameRateLimited,
    pixelSamples: frameCount * canvasPixels,
  };
}

function captureTimestampMilliseconds(index, frameCount, durationSeconds) {
  if (frameCount <= 1) return 0;
  return (index / frameCount) * durationSeconds * 1000;
}

async function captureFrames(url, config, onProgress = () => {}) {
  const executablePath = resolveChromiumExecutable();
  const launchOptions = {
    headless: true,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--hide-scrollbars'],
  };
  if (executablePath) launchOptions.executablePath = executablePath;
  let browser;
  try {
    browser = await chromium.launch(launchOptions);
  } catch (error) {
    throw new Error(`Chromium could not be launched. Set BANNER_FORGE_CHROMIUM to a Chromium executable. ${error.message}`);
  }
  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      colorScheme: 'light',
      reducedMotion: 'no-preference',
      locale: 'en-US',
      timezoneId: 'UTC',
    });
    const page = await context.newPage();
    await page.addInitScript({ content: 'Math.random = (() => { let seed = 0x12345678; return () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296); })();' });
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await waitForAssets(page);
    const discovery = await page.evaluate(DISCOVER_SCRIPT);
    await page.setViewportSize({ width: discovery.width, height: discovery.height });
    await page.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const durationSeconds = chooseDuration(discovery, config.maxDurationSeconds);
    const outputLoopMode = resolveOutputLoopMode(config.loopMode, discovery.loopsInfinitely);
    const capturePlan = createCapturePlan(
      discovery.width,
      discovery.height,
      durationSeconds,
      config.captureFps,
    );
    const {
      frameCount,
      frameDurationMs,
      effectiveCaptureFps,
      frameRateLimited,
    } = capturePlan;
    const frames = [];
    for (let index = 0; index < frameCount; index += 1) {
      const timestampMs = captureTimestampMilliseconds(index, frameCount, durationSeconds);
      await freezeAt(page, timestampMs);
      await page.evaluate('new Promise((resolve) => requestAnimationFrame(resolve))');
      frames.push(await page.screenshot({ type: 'png' }));
      if (index === 0 || index === frameCount - 1 || index % Math.max(1, Math.round(frameCount / 10)) === 0) {
        onProgress({ stage: 'capture', current: index + 1, total: frameCount });
      }
    }
    await context.close();
    return {
      frames,
      frameDurationMs,
      width: discovery.width,
      height: discovery.height,
      durationSeconds,
      effectiveCaptureFps,
      frameRateLimited,
      outputLoopMode,
      discovery,
    };
  } finally {
    await browser.close();
  }
}

module.exports = {
  MAX_CAPTURE_FRAMES,
  MAX_CAPTURE_PIXEL_SAMPLES,
  DISCOVER_SCRIPT,
  timelineDurationMilliseconds,
  seekTimeline,
  chooseDuration,
  resolveOutputLoopMode,
  createCapturePlan,
  captureTimestampMilliseconds,
  captureFrames,
};

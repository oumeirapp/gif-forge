'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROTOCOL_VERSION = 4;
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const STDERR_TAIL_BYTES = 4096;

function isTerminal(job) {
  return TERMINAL_STATUSES.has(job.status);
}

function killProcessGroup(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    // The engine runs detached in its own process group, so this also stops Chromium, FFmpeg and gifski.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

class JobManager {
  constructor({
    workRoot,
    sidecarBin,
    storage,
    maxConcurrentJobs = 2,
    jobTimeoutMs = 15 * 60 * 1000,
    jobTtlMs = 24 * 60 * 60 * 1000,
    cwd = process.cwd(),
    logger = console,
  }) {
    this.workRoot = workRoot;
    this.sidecarBin = sidecarBin;
    this.storage = storage;
    this.maxConcurrentJobs = maxConcurrentJobs;
    this.jobTimeoutMs = jobTimeoutMs;
    this.jobTtlMs = jobTtlMs;
    this.cwd = cwd;
    this.logger = logger;
    this.jobs = new Map();
    this.queue = [];
    this.running = new Set();
  }

  static newJobId() {
    return crypto.randomUUID();
  }

  jobDirectories(jobId) {
    const workDirectory = path.join(this.workRoot, jobId);
    return {
      workDirectory,
      inputDirectory: path.join(workDirectory, 'input'),
      outputDirectory: path.join(workDirectory, 'output'),
    };
  }

  // banners: [{ inputPath, displayName }] produced by UploadAssembler.
  create({ jobId = JobManager.newJobId(), owner, banners, config }) {
    const job = {
      id: jobId,
      owner,
      status: 'queued',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      config,
      banners,
      displayNames: new Map(banners.map((banner) => [banner.inputPath, banner.displayName])),
      ...this.jobDirectories(jobId),
      events: [],
      results: [],
      files: new Map(),
      listeners: new Set(),
      child: null,
      sawComplete: false,
      timedOut: false,
      cancelRequested: false,
      stderrTail: '',
      eventChain: Promise.resolve(),
      done: null,
    };
    job.done = new Promise((resolve) => { job.resolveDone = resolve; });
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.pump();
    return job;
  }

  get(jobId, owner) {
    const job = this.jobs.get(jobId);
    if (!job || job.owner !== owner) return undefined;
    return job;
  }

  snapshot(job) {
    return {
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      banners: job.banners.map((banner) => banner.displayName),
      events: job.events.map((entry) => entry.event),
      lastEventId: job.events.length,
      results: job.results,
    };
  }

  subscribe(job, listener) {
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  emit(job, event) {
    const entry = { id: job.events.length + 1, event };
    job.events.push(entry);
    if (event.type === 'result') job.results.push(event);
    for (const listener of job.listeners) listener(entry);
  }

  pump() {
    while (this.running.size < this.maxConcurrentJobs && this.queue.length > 0) {
      const job = this.queue.shift();
      this.start(job);
    }
  }

  sanitizeMessage(job, message) {
    if (typeof message !== 'string') return message;
    return message.split(job.workDirectory + path.sep).join('').split(job.workDirectory).join('');
  }

  displayName(job, inputPath) {
    if (!inputPath) return inputPath;
    return job.displayNames.get(inputPath) ?? path.basename(inputPath);
  }

  async rewriteEvent(job, event) {
    const rewritten = { ...event };
    if (rewritten.inputPath) rewritten.inputPath = this.displayName(job, rewritten.inputPath);
    if (rewritten.file) rewritten.file = this.displayName(job, rewritten.file);
    if (rewritten.message) rewritten.message = this.sanitizeMessage(job, rewritten.message);
    if (Array.isArray(rewritten.warnings)) rewritten.warnings = rewritten.warnings.map((warning) => this.sanitizeMessage(job, warning));

    if (event.type === 'result') {
      delete rewritten.outputPath;
      delete rewritten.reportPath;
      if (event.outputPath) {
        const saved = await this.registerFile(job, event.outputPath);
        rewritten.fileName = saved.fileName;
        rewritten.downloadUrl = this.downloadUrl(job, saved.fileName);
      }
      if (event.reportPath) {
        const saved = await this.registerFile(job, event.reportPath);
        rewritten.reportFileName = saved.fileName;
        rewritten.reportUrl = this.downloadUrl(job, saved.fileName);
      }
    }
    if (event.type === 'complete') job.sawComplete = true;
    return rewritten;
  }

  downloadUrl(job, fileName) {
    return `/api/jobs/${job.id}/files/${encodeURIComponent(fileName)}`;
  }

  async registerFile(job, filePath) {
    const resolved = path.resolve(filePath);
    if (path.dirname(resolved) !== job.outputDirectory) {
      throw new Error('The engine wrote an output outside the job output directory.');
    }
    const saved = await this.storage.save({ owner: job.owner, jobId: job.id, filePath: resolved });
    job.files.set(saved.fileName, saved);
    return saved;
  }

  handleEngineEvent(job, event) {
    job.eventChain = job.eventChain.then(async () => {
      if (job.cancelRequested) return;
      try {
        this.emit(job, await this.rewriteEvent(job, event));
      } catch (error) {
        this.emit(job, {
          type: 'error',
          inputPath: this.displayName(job, event.inputPath),
          message: `Could not store output: ${this.sanitizeMessage(job, error.message)}`,
        });
      }
    });
  }

  start(job) {
    job.status = 'running';
    this.running.add(job);
    const child = spawn(process.execPath, [this.sidecarBin, 'convert'], {
      cwd: this.cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    job.child = child;

    let buffer = '';
    const parseLines = (chunk, flush = false) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      const remainder = lines.pop() ?? '';
      buffer = flush ? '' : remainder;
      if (flush && remainder.trim()) lines.push(remainder);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event && typeof event.type === 'string') this.handleEngineEvent(job, event);
        } catch {
          this.logger.warn?.(`[job ${job.id}] non-JSON engine output: ${line.slice(0, 200)}`);
        }
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => parseLines(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      job.stderrTail = (job.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      job.spawnError = error;
    });

    job.timeout = setTimeout(() => {
      job.timedOut = true;
      killProcessGroup(child);
    }, this.jobTimeoutMs);
    job.timeout.unref?.();

    child.on('close', (code, signal) => {
      parseLines('', true);
      job.eventChain = job.eventChain.then(() => this.finish(job, code, signal));
    });

    child.stdin.end(`${JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      inputPaths: job.banners.map((banner) => banner.inputPath),
      outputDirectory: job.outputDirectory,
      config: job.config,
    })}\n`);
  }

  summaryFromResults(job, failedOverride) {
    const total = job.banners.length;
    const succeededInputs = new Set(job.results.map((result) => result.inputPath));
    const succeeded = succeededInputs.size;
    return { total, succeeded, failed: failedOverride ?? total - succeeded };
  }

  async finish(job, code, signal) {
    clearTimeout(job.timeout);
    job.child = null;
    this.running.delete(job);

    if (job.cancelRequested) {
      job.status = 'cancelled';
    } else if (job.timedOut) {
      this.emit(job, { type: 'error', message: `Job timed out after ${Math.round(this.jobTimeoutMs / 1000)} s and was stopped.` });
      this.emit(job, { type: 'complete', ...this.summaryFromResults(job) });
      job.status = 'failed';
    } else if (!job.sawComplete) {
      const detail = job.spawnError?.message || this.sanitizeMessage(job, job.stderrTail.trim()) || `exit ${code ?? signal}`;
      this.emit(job, { type: 'error', message: `Conversion engine stopped unexpectedly: ${detail}` });
      this.emit(job, { type: 'complete', ...this.summaryFromResults(job) });
      job.status = 'failed';
    } else {
      const complete = job.events.findLast((entry) => entry.event.type === 'complete').event;
      job.status = (complete.failed ?? 0) > 0 ? 'failed' : 'succeeded';
    }

    await this.endJob(job);
    this.pump();
  }

  async endJob(job) {
    job.finishedAt = new Date().toISOString();
    for (const listener of job.listeners) listener(null);
    job.listeners.clear();
    await fsp.rm(job.inputDirectory, { recursive: true, force: true }).catch(() => {});
    job.ttlTimer = setTimeout(() => this.forget(job), this.jobTtlMs);
    job.ttlTimer.unref?.();
    job.resolveDone();
  }

  async forget(job) {
    clearTimeout(job.ttlTimer);
    this.jobs.delete(job.id);
    await fsp.rm(job.workDirectory, { recursive: true, force: true }).catch(() => {});
  }

  // Returns false when the job has already finished.
  async cancel(job) {
    if (isTerminal(job) || job.cancelRequested) return !isTerminal(job);
    job.cancelRequested = true;
    this.emit(job, { type: 'error', message: 'Batch cancelled' });
    this.emit(job, { type: 'complete', ...this.summaryFromResults(job), cancelled: true });
    const queuedIndex = this.queue.indexOf(job);
    if (queuedIndex !== -1) {
      this.queue.splice(queuedIndex, 1);
      job.status = 'cancelled';
      await this.endJob(job);
      return true;
    }
    killProcessGroup(job.child);
    return true;
  }

  async shutdown() {
    for (const job of [...this.queue, ...this.running]) await this.cancel(job);
    await Promise.all([...this.jobs.values()].map((job) => job.done));
    for (const job of this.jobs.values()) clearTimeout(job.ttlTimer);
  }
}

module.exports = { JobManager, isTerminal, killProcessGroup };

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JobManager } = require('../jobs.cjs');
const { createLocalStorage } = require('../storage.cjs');
const { FAKE_ENGINE, isAlive, tempDirectory, waitFor } = require('./helpers.cjs');

const quietLogger = { warn() {}, info() {}, error() {} };

function manager(options = {}) {
  return new JobManager({
    workRoot: tempDirectory(),
    sidecarBin: FAKE_ENGINE,
    storage: createLocalStorage(),
    logger: quietLogger,
    ...options,
  });
}

function createJob(jobs, owner = 'local', names = ['banner']) {
  const jobId = JobManager.newJobId();
  const { inputDirectory, outputDirectory } = jobs.jobDirectories(jobId);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const banners = names.map((name) => {
    const inputPath = path.join(inputDirectory, name);
    fs.mkdirSync(inputPath, { recursive: true });
    fs.writeFileSync(path.join(inputPath, 'index.html'), '<html></html>');
    return { inputPath, displayName: name };
  });
  return jobs.create({ jobId, owner, banners, config: {} });
}

test.afterEach(() => {
  delete process.env.FAKE_ENGINE_MODE;
  delete process.env.FAKE_ENGINE_DELAY_MS;
  delete process.env.FAKE_ENGINE_PID_FILE;
});

test('results replace server paths with download URLs and display names', async () => {
  const jobs = manager();
  const job = createJob(jobs, 'local', ['leaderboard']);
  await job.done;
  assert.equal(job.status, 'succeeded');
  const [result] = job.results;
  assert.equal(result.inputPath, 'leaderboard');
  assert.equal(result.fileName, 'leaderboard.gif');
  assert.equal(result.downloadUrl, `/api/jobs/${job.id}/files/leaderboard.gif`);
  assert.equal(result.reportUrl, `/api/jobs/${job.id}/files/leaderboard.report.json`);
  assert.equal(result.outputPath, undefined);
  assert.equal(result.reportPath, undefined);
  assert.equal(JSON.stringify(job.events).includes(job.workDirectory), false);
  assert.equal(fs.existsSync(job.inputDirectory), false, 'input directory is removed when the job ends');
  assert.equal(fs.existsSync(path.join(job.outputDirectory, 'leaderboard.gif')), true);
});

test('the queue never runs more than MAX_CONCURRENT_JOBS engines', async () => {
  process.env.FAKE_ENGINE_DELAY_MS = '150';
  const jobs = manager({ maxConcurrentJobs: 2 });
  let peak = 0;
  const created = [createJob(jobs), createJob(jobs), createJob(jobs), createJob(jobs)];
  const sampler = setInterval(() => { peak = Math.max(peak, jobs.running.size); }, 5);
  assert.deepEqual(created.map((job) => job.status), ['running', 'running', 'queued', 'queued']);
  await Promise.all(created.map((job) => job.done));
  clearInterval(sampler);
  assert.equal(peak, 2);
  assert.ok(created.every((job) => job.status === 'succeeded'));
});

test('cancel kills the engine and its child processes', async () => {
  const pidFile = path.join(tempDirectory(), 'pids.json');
  process.env.FAKE_ENGINE_MODE = 'hang';
  process.env.FAKE_ENGINE_PID_FILE = pidFile;
  const jobs = manager();
  const job = createJob(jobs);
  await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0);
  const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(isAlive(pids.engine) && isAlive(pids.grandchild));

  await jobs.cancel(job);
  await job.done;
  await waitFor(() => !isAlive(pids.engine) && !isAlive(pids.grandchild));
  assert.equal(job.status, 'cancelled');
  assert.equal(job.events.at(-1).event.type, 'complete');
});

test('cancelling a queued job removes it without starting the engine', async () => {
  process.env.FAKE_ENGINE_DELAY_MS = '100';
  const jobs = manager({ maxConcurrentJobs: 1 });
  const first = createJob(jobs);
  const second = createJob(jobs);
  await jobs.cancel(second);
  assert.equal(second.status, 'cancelled');
  await first.done;
  assert.equal(second.child, null);
});

test('jobs that exceed JOB_TIMEOUT_MS are killed and reported', async () => {
  const pidFile = path.join(tempDirectory(), 'pids.json');
  process.env.FAKE_ENGINE_MODE = 'hang';
  process.env.FAKE_ENGINE_PID_FILE = pidFile;
  const jobs = manager({ jobTimeoutMs: 300 });
  const job = createJob(jobs);
  await job.done;
  assert.equal(job.status, 'failed');
  assert.match(job.events.find((entry) => entry.event.type === 'error').event.message, /timed out/);
  const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  await waitFor(() => !isAlive(pids.grandchild));
});

test('an engine crash produces an error and a complete event without leaking paths', async () => {
  process.env.FAKE_ENGINE_MODE = 'crash';
  const jobs = manager();
  const job = createJob(jobs);
  await job.done;
  assert.equal(job.status, 'failed');
  const types = job.events.map((entry) => entry.event.type);
  assert.deepEqual(types.slice(-2), ['error', 'complete']);
  assert.equal(JSON.stringify(job.events).includes(job.workDirectory), false);
});

test('jobs are only visible to their owner and are forgotten after JOB_TTL_MS', async () => {
  const jobs = manager({ jobTtlMs: 50 });
  const job = createJob(jobs, 'alice');
  assert.equal(jobs.get(job.id, 'bob'), undefined);
  assert.equal(jobs.get(job.id, 'alice'), job);
  await job.done;
  await waitFor(() => !jobs.jobs.has(job.id));
  await waitFor(() => !fs.existsSync(job.workDirectory));
});

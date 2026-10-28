'use strict';

const path = require('node:path');

const PROJECT_DIRECTORY = path.resolve(__dirname, '..');

function readInteger(env, name, fallback, minimum = 1) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}.`);
  }
  return value;
}

function readConfig(env = process.env) {
  const storage = env.STORAGE || 'local';
  if (!['local', 'blob'].includes(storage)) throw new Error('STORAGE must be "local" or "blob".');

  return {
    port: readInteger(env, 'PORT', 8080, 0),
    host: env.HOST || '0.0.0.0',
    workRoot: path.resolve(env.WORK_ROOT || '/tmp/forge'),
    maxConcurrentJobs: readInteger(env, 'MAX_CONCURRENT_JOBS', 2),
    jobTimeoutMs: readInteger(env, 'JOB_TIMEOUT_MS', 15 * 60 * 1000),
    jobTtlMs: readInteger(env, 'JOB_TTL_MS', 24 * 60 * 60 * 1000),
    limits: {
      maxUploadBytes: readInteger(env, 'MAX_UPLOAD_BYTES', 100 * 1024 * 1024),
      maxUnzippedBytes: readInteger(env, 'MAX_UNZIPPED_BYTES', 300 * 1024 * 1024),
      maxFiles: readInteger(env, 'MAX_FILES', 5000),
      maxBannersPerJob: readInteger(env, 'MAX_BANNERS_PER_JOB', 25),
    },
    requireAuth: env.REQUIRE_AUTH === '1',
    storage,
    azure: {
      connectionString: env.AZURE_STORAGE_CONNECTION_STRING || '',
      account: env.AZURE_STORAGE_ACCOUNT || '',
      container: env.AZURE_STORAGE_CONTAINER || 'outputs',
    },
    distDirectory: path.join(PROJECT_DIRECTORY, 'dist'),
    sidecarBin: path.join(PROJECT_DIRECTORY, 'sidecar', 'bin', 'banner-forge-sidecar.cjs'),
    projectDirectory: PROJECT_DIRECTORY,
  };
}

module.exports = { readConfig };

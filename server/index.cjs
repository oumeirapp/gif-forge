'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const Fastify = require('fastify');
const { normalizeConfig } = require('../sidecar/lib/helpers.cjs');
const {
  isExecutable,
  findExecutableOnPath,
  resolveChromiumExecutable,
  resolveExecutable,
  toolAvailable,
} = require('../sidecar/lib/tools.cjs');
const {
  LoginRateLimiter,
  SESSION_COOKIE,
  createPasswordAuth,
  parseCookies,
  resolveOwner,
} = require('./auth.cjs');
const { readConfig } = require('./config.cjs');
const { JobManager, isTerminal } = require('./jobs.cjs');
const { createStorage } = require('./storage.cjs');
const { UploadAssembler, UploadError } = require('./uploads.cjs');

const SSE_PING_MS = 20_000;
const FAILED_LOGIN_DELAY_MS = 500;
const HEALTH_CACHE_MS = 30_000;
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data: blob: https://*.blob.core.windows.net",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SIDECAR_BIN_DIRECTORY = path.resolve(__dirname, '..', 'sidecar', 'bin');

function locate(executable, extraCandidates = []) {
  if (isExecutable(executable)) return executable;
  return extraCandidates.find(isExecutable) || findExecutableOnPath([executable]);
}

async function checkTools() {
  const ffmpeg = locate(resolveExecutable('ffmpeg', ['BANNER_FORGE_FFMPEG', 'FFMPEG_PATH']));
  // The engine runs from sidecar/bin, where build-gifski-worker installs the worker by default.
  const gifskiWorker = locate(resolveExecutable('gifski-worker', ['BANNER_FORGE_GIFSKI_WORKER']), [
    path.join(SIDECAR_BIN_DIRECTORY, 'gifski-worker'),
  ]);
  const chromium = resolveChromiumExecutable();
  const [ffmpegOk, gifskiOk] = await Promise.all([
    ffmpeg ? toolAvailable(ffmpeg) : false,
    gifskiWorker ? toolAvailable(gifskiWorker) : false,
  ]);
  const tools = {
    ffmpeg: ffmpegOk,
    chromium: Boolean(chromium && isExecutable(chromium)),
    gifskiWorker: gifskiOk,
  };
  return { ok: Object.values(tools).every(Boolean), tools };
}

async function readUpload(request, config, workDirectory) {
  const assembler = new UploadAssembler(path.join(workDirectory, 'input'), config.limits);
  let conversionConfig;
  let pendingPath = null;

  for await (const part of request.parts()) {
    if (part.type === 'field') {
      if (part.fieldname === 'config') {
        let raw;
        try {
          raw = JSON.parse(part.value);
        } catch {
          throw new UploadError('config must be a JSON string.');
        }
        try {
          // Validate here so bad settings fail fast; the engine receives the original object
          // because it rejects the derived fields normalizeConfig adds (e.g. captureFps).
          normalizeConfig(raw);
        } catch (error) {
          throw new UploadError(error.message);
        }
        conversionConfig = raw;
      } else if (part.fieldname === 'paths' || part.fieldname === 'paths[]') {
        pendingPath = part.value;
      }
      continue;
    }
    const relativePath = pendingPath || part.filename;
    pendingPath = null;
    await assembler.addFile(relativePath, part.file);
    if (part.file.truncated) {
      throw new UploadError(`Uploads may total at most ${config.limits.maxUploadBytes} bytes.`, 413);
    }
  }

  if (!conversionConfig) throw new UploadError('The config field is required.');
  const banners = await assembler.finish();
  return { banners, conversionConfig };
}

// App Service's X-Forwarded-For can carry "ip:port"; drop the port so retries share one key.
function clientKey(request) {
  return String(request.ip || '').replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/, '$1');
}

function pathOf(request) {
  return request.url.split('?')[0];
}

function uploadErrorStatus(error) {
  if (error instanceof UploadError) return error.statusCode;
  if (['FST_REQ_FILE_TOO_LARGE', 'FST_FILES_LIMIT', 'FST_PARTS_LIMIT', 'FST_FIELDS_LIMIT'].includes(error.code)) return 413;
  if (error.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') return 415;
  return null;
}

function buildServer(config = readConfig(), overrides = {}) {
  const app = Fastify({
    logger: overrides.logger ?? { level: process.env.LOG_LEVEL || 'info' },
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });
  const storage = overrides.storage ?? createStorage(config);
  const jobs = overrides.jobs ?? new JobManager({
    workRoot: config.workRoot,
    sidecarBin: config.sidecarBin,
    storage,
    maxConcurrentJobs: config.maxConcurrentJobs,
    jobTimeoutMs: config.jobTimeoutMs,
    jobTtlMs: config.jobTtlMs,
    cwd: config.projectDirectory,
    logger: app.log,
  });
  const healthCheck = overrides.checkTools ?? checkTools;
  let cachedHealth = null;
  const passwordAuth = config.authMode === 'password'
    ? createPasswordAuth({ password: config.accessPassword, sessionSecret: config.sessionSecret, sessionTtlMs: config.sessionTtlMs })
    : null;
  const loginLimiter = overrides.loginLimiter ?? new LoginRateLimiter();
  const failedLoginDelayMs = overrides.failedLoginDelayMs ?? FAILED_LOGIN_DELAY_MS;
  if (passwordAuth && !config.sessionSecret) {
    app.log.warn('SESSION_SECRET is not set; sessions will not survive a restart.');
  }

  function passwordSession(request) {
    return passwordAuth.verifySession(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
  }

  app.decorate('jobs', jobs);

  app.register(require('@fastify/multipart'), {
    limits: {
      fileSize: config.limits.maxUploadBytes,
      files: config.limits.maxFiles + 1,
      fields: config.limits.maxFiles + 10,
      fieldSize: 1024 * 1024,
      parts: config.limits.maxFiles * 2 + 10,
    },
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/') || pathOf(request) === '/api/session') return;
    if (passwordAuth) {
      // The Easy Auth header is ignored here: without Easy Auth in front, anyone could send it.
      const session = passwordSession(request);
      if (!session) return reply.code(401).send({ error: 'Sign-in required.' });
      request.owner = `session:${session.sid}`;
      return;
    }
    const owner = resolveOwner(request.headers, { requireAuth: config.requireAuth });
    if (!owner) return reply.code(401).send({ error: 'Sign-in required.' });
    request.owner = owner;
  });

  app.get('/api/session', async (request) => {
    if (passwordAuth) return { mode: 'password', authenticated: Boolean(passwordSession(request)) };
    const owner = resolveOwner(request.headers, { requireAuth: config.requireAuth });
    return { mode: config.authMode, authenticated: Boolean(owner) };
  });

  app.post('/api/session', async (request, reply) => {
    if (!passwordAuth) return reply.code(404).send({ error: 'Password sign-in is not enabled.' });
    const key = clientKey(request);
    const retryAfter = loginLimiter.retryAfterSeconds(key);
    if (retryAfter) {
      return reply.code(429).header('Retry-After', retryAfter)
        .send({ error: `Too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} min.` });
    }
    if (!passwordAuth.checkPassword(request.body?.password)) {
      loginLimiter.recordFailure(key);
      await new Promise((resolve) => setTimeout(resolve, failedLoginDelayMs));
      return reply.code(401).send({ error: 'Incorrect password.' });
    }
    loginLimiter.reset(key);
    const { token, session } = passwordAuth.issueSession();
    reply.header('Set-Cookie', passwordAuth.sessionCookie(token, { secure: request.protocol === 'https' }));
    return { mode: 'password', authenticated: true, expiresAt: new Date(session.exp).toISOString() };
  });

  app.delete('/api/session', async (request, reply) => {
    if (passwordAuth) reply.header('Set-Cookie', passwordAuth.clearedCookie({ secure: request.protocol === 'https' }));
    return { mode: config.authMode, authenticated: false };
  });

  function findJob(request, reply) {
    const job = jobs.get(request.params.id, request.owner);
    if (!job) reply.code(404).send({ error: 'Job not found.' });
    return job;
  }

  app.post('/api/jobs', async (request, reply) => {
    const declaredLength = Number(request.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > config.limits.maxUploadBytes + 1024 * 1024) {
      return reply.code(413).send({ error: `Uploads may total at most ${config.limits.maxUploadBytes} bytes.` });
    }
    if (!request.isMultipart()) return reply.code(415).send({ error: 'Send multipart/form-data.' });

    const jobId = JobManager.newJobId();
    const { workDirectory, outputDirectory } = jobs.jobDirectories(jobId);
    await fsp.mkdir(outputDirectory, { recursive: true });
    try {
      const { banners, conversionConfig } = await readUpload(request, config, workDirectory);
      jobs.create({ jobId, owner: request.owner, banners, config: conversionConfig });
      return reply.code(202).send({ jobId, banners: banners.map((banner) => banner.displayName) });
    } catch (error) {
      await fsp.rm(workDirectory, { recursive: true, force: true }).catch(() => {});
      const status = uploadErrorStatus(error);
      if (status) return reply.code(status).send({ error: error.message });
      throw error;
    }
  });

  app.get('/api/jobs/:id', async (request, reply) => {
    const job = findJob(request, reply);
    if (!job) return reply;
    return jobs.snapshot(job);
  });

  app.delete('/api/jobs/:id', async (request, reply) => {
    const job = findJob(request, reply);
    if (!job) return reply;
    await jobs.cancel(job);
    return jobs.snapshot(job);
  });

  app.get('/api/jobs/:id/files/:name', async (request, reply) => {
    const job = findJob(request, reply);
    if (!job) return reply;
    const entry = job.files.get(request.params.name);
    if (!entry) return reply.code(404).send({ error: 'File not found.' });
    return storage.send(reply, entry);
  });

  app.get('/api/jobs/:id/events', (request, reply) => {
    const job = findJob(request, reply);
    if (!job) return reply;
    const lastEventId = Number(request.headers['last-event-id'] ?? request.query.lastEventId ?? 0) || 0;

    // Nothing left to send for a finished job: 204 tells EventSource to stop reconnecting.
    if (isTerminal(job) && lastEventId >= job.events.length) return reply.code(204).send();

    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    response.write('retry: 3000\n\n');

    const write = (entry) => response.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.event)}\n\n`);
    let unsubscribe = () => {};
    let ping = null;
    const close = () => {
      unsubscribe();
      clearInterval(ping);
      if (!response.writableEnded) response.end();
    };

    for (const entry of job.events) if (entry.id > lastEventId) write(entry);
    if (isTerminal(job)) {
      close();
      return;
    }
    unsubscribe = jobs.subscribe(job, (entry) => (entry ? write(entry) : close()));
    ping = setInterval(() => response.write(': ping\n\n'), SSE_PING_MS);
    ping.unref?.();
    request.raw.on('close', close);
  });

  app.get('/healthz', async (_request, reply) => {
    if (!cachedHealth || Date.now() - cachedHealth.at > HEALTH_CACHE_MS) {
      cachedHealth = { at: Date.now(), result: await healthCheck() };
    }
    return reply.code(cachedHealth.result.ok ? 200 : 503).send(cachedHealth.result);
  });

  if (fs.existsSync(path.join(config.distDirectory, 'index.html'))) {
    app.register(require('@fastify/static'), { root: config.distDirectory, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== 'GET' || request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found.' });
      }
      return reply.sendFile('index.html');
    });
  }

  app.addHook('onClose', async () => {
    await jobs.shutdown();
  });

  return app;
}

async function main() {
  const config = readConfig();
  await fsp.mkdir(config.workRoot, { recursive: true });
  const app = buildServer(config);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      app.log.info(`${signal} received, stopping jobs`);
      app.close().then(() => process.exit(0), () => process.exit(1));
    });
  }
  await app.listen({ port: config.port, host: config.host });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { buildServer, checkTools };

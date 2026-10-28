'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { LoginRateLimiter, createPasswordAuth } = require('../auth.cjs');
const { buildServer } = require('../index.cjs');
const { readConfig } = require('../config.cjs');
const { FAKE_ENGINE, buildMultipart, tempDirectory } = require('./helpers.cjs');

const PASSWORD = 'test-shared-password';

function server(env = {}, overrides = {}) {
  const config = readConfig({ WORK_ROOT: tempDirectory(), ACCESS_PASSWORD: PASSWORD, SESSION_SECRET: 'test-secret', ...env });
  config.sidecarBin = FAKE_ENGINE;
  config.distDirectory = path.join(tempDirectory(), 'no-dist');
  return buildServer(config, {
    logger: false,
    checkTools: async () => ({ ok: true, tools: {} }),
    failedLoginDelayMs: 0,
    ...overrides,
  });
}

async function signIn(app, password = PASSWORD) {
  return app.inject({ method: 'POST', url: '/api/session', payload: { password } });
}

function cookieOf(response) {
  return response.headers['set-cookie'].split(';')[0];
}

function htmlUpload() {
  return buildMultipart([
    { name: 'config', value: '{}' },
    { name: 'files', filename: 'promo.html', data: '<html></html>' },
  ]);
}

async function submit(app, cookie) {
  const body = htmlUpload();
  const response = await app.inject({ method: 'POST', url: '/api/jobs', payload: body.payload, headers: { ...body.headers, cookie } });
  assert.equal(response.statusCode, 202, response.body);
  return response.json().jobId;
}

test('readConfig picks password mode and rejects short passwords', () => {
  assert.equal(readConfig({ ACCESS_PASSWORD: PASSWORD, REQUIRE_AUTH: '1' }).authMode, 'password');
  assert.equal(readConfig({ REQUIRE_AUTH: '1' }).authMode, 'easyauth');
  assert.equal(readConfig({}).authMode, 'none');
  assert.throws(() => readConfig({ ACCESS_PASSWORD: 'short' }), /at least 8/);
});

test('session tokens reject tampering and expiry', () => {
  let now = 1_000;
  const auth = createPasswordAuth({ password: PASSWORD, sessionSecret: 's', sessionTtlMs: 100, now: () => now });
  const { token, session } = auth.issueSession();
  assert.equal(auth.verifySession(token).sid, session.sid);

  const [payload, signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sid: 'attacker', exp: now + 10_000 })).toString('base64url');
  assert.equal(auth.verifySession(`${forged}.${signature}`), null);
  assert.equal(auth.verifySession(`${payload}.${signature.slice(0, -2)}xx`), null);
  assert.equal(createPasswordAuth({ password: PASSWORD, sessionSecret: 'other', sessionTtlMs: 100 }).verifySession(token), null);

  now += 101;
  assert.equal(auth.verifySession(token), null);
});

test('password checks are exact', () => {
  const auth = createPasswordAuth({ password: PASSWORD, sessionSecret: 's', sessionTtlMs: 100 });
  assert.equal(auth.checkPassword(PASSWORD), true);
  for (const wrong of ['', `${PASSWORD} `, PASSWORD.toUpperCase(), undefined, 42]) assert.equal(auth.checkPassword(wrong), false);
});

test('the rate limiter locks a client out after repeated failures until the window passes', () => {
  let now = 0;
  const limiter = new LoginRateLimiter({ maxFailures: 3, windowMs: 1000, now: () => now });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(limiter.retryAfterSeconds('a'), 0);
    limiter.recordFailure('a');
  }
  assert.equal(limiter.retryAfterSeconds('a'), 1);
  assert.equal(limiter.retryAfterSeconds('b'), 0);
  now = 1001;
  assert.equal(limiter.retryAfterSeconds('a'), 0);
});

test('API routes need a session; the right password issues a hardened cookie', async (t) => {
  const app = server();
  t.after(() => app.close());

  assert.equal((await app.inject({ url: '/api/jobs/abc' })).statusCode, 401);
  assert.deepEqual((await app.inject({ url: '/api/session' })).json(), { mode: 'password', authenticated: false });

  const wrong = await signIn(app, 'nope-nope-nope');
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.headers['set-cookie'], undefined);

  const ok = await signIn(app);
  assert.equal(ok.statusCode, 200);
  const setCookie = ok.headers['set-cookie'];
  assert.match(setCookie, /^forge_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/);
  const httpsLogin = await app.inject({ method: 'POST', url: '/api/session', payload: { password: PASSWORD }, headers: { 'x-forwarded-proto': 'https' } });
  assert.match(httpsLogin.headers['set-cookie'], /; Secure$/);

  const cookie = cookieOf(ok);
  assert.deepEqual((await app.inject({ url: '/api/session', headers: { cookie } })).json(), { mode: 'password', authenticated: true });
  const jobId = await submit(app, cookie);
  await app.jobs.jobs.get(jobId).done;
  assert.equal((await app.inject({ url: `/api/jobs/${jobId}`, headers: { cookie } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/healthz' })).statusCode, 200, 'health check stays public');

  const signOut = await app.inject({ method: 'DELETE', url: '/api/session', headers: { cookie } });
  assert.match(signOut.headers['set-cookie'], /^forge_session=; .*Max-Age=0/);
});

test('the Easy Auth header is ignored in password mode', async (t) => {
  const app = server();
  t.after(() => app.close());
  const response = await app.inject({ url: '/api/jobs/abc', headers: { 'x-ms-client-principal-id': 'someone' } });
  assert.equal(response.statusCode, 401);
});

test('each sign-in is its own owner, so people sharing the password cannot see each other\'s jobs', async (t) => {
  const app = server();
  t.after(() => app.close());
  const alice = cookieOf(await signIn(app));
  const bob = cookieOf(await signIn(app));
  const jobId = await submit(app, alice);
  await app.jobs.jobs.get(jobId).done;
  assert.equal((await app.inject({ url: `/api/jobs/${jobId}`, headers: { cookie: alice } })).statusCode, 200);
  for (const url of [`/api/jobs/${jobId}`, `/api/jobs/${jobId}/events`, `/api/jobs/${jobId}/files/promo.gif`]) {
    assert.equal((await app.inject({ url, headers: { cookie: bob } })).statusCode, 404, url);
  }
});

test('repeated wrong passwords from one client are throttled with 429', async (t) => {
  const app = server({}, { loginLimiter: new LoginRateLimiter({ maxFailures: 2, windowMs: 60_000 }) });
  t.after(() => app.close());
  assert.equal((await signIn(app, 'wrong-password-1')).statusCode, 401);
  assert.equal((await signIn(app, 'wrong-password-2')).statusCode, 401);
  const blocked = await signIn(app);
  assert.equal(blocked.statusCode, 429, 'even the right password waits out the lockout');
  assert.ok(Number(blocked.headers['retry-after']) > 0);
});

test('POST /api/session is disabled when no password is configured', async (t) => {
  const config = readConfig({ WORK_ROOT: tempDirectory() });
  config.distDirectory = path.join(tempDirectory(), 'no-dist');
  const app = buildServer(config, { logger: false, checkTools: async () => ({ ok: true, tools: {} }) });
  t.after(() => app.close());
  assert.equal((await signIn(app)).statusCode, 404);
  assert.deepEqual((await app.inject({ url: '/api/session' })).json(), { mode: 'none', authenticated: true });
});

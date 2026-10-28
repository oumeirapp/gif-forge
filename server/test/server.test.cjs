'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { buildServer } = require('../index.cjs');
const { readConfig } = require('../config.cjs');
const { FAKE_ENGINE, buildMultipart, buildZip, parseSse, tempDirectory } = require('./helpers.cjs');

function server(env = {}) {
  const config = readConfig({ WORK_ROOT: tempDirectory(), ...env });
  config.sidecarBin = FAKE_ENGINE;
  config.distDirectory = path.join(tempDirectory(), 'no-dist');
  return buildServer(config, {
    logger: false,
    checkTools: async () => ({ ok: true, tools: {} }),
  });
}

function zipUpload(extraParts = []) {
  return buildMultipart([
    { name: 'config', value: JSON.stringify({ outputFps: 15 }) },
    { name: 'paths', value: 'campaign.zip' },
    {
      name: 'files',
      filename: 'campaign.zip',
      data: buildZip([
        { name: 'leaderboard/index.html', data: '<html></html>' },
        { name: 'mpu/index.html', data: '<html></html>' },
      ]),
    },
    ...extraParts,
  ]);
}

async function submit(app, headers = {}) {
  const body = zipUpload();
  const response = await app.inject({ method: 'POST', url: '/api/jobs', payload: body.payload, headers: { ...body.headers, ...headers } });
  assert.equal(response.statusCode, 202, response.body);
  const { jobId } = response.json();
  await app.jobs.jobs.get(jobId).done;
  return jobId;
}

test('POST /api/jobs runs a ZIP upload and serves downloads', async (t) => {
  const app = server();
  t.after(() => app.close());
  const jobId = await submit(app);

  const snapshot = (await app.inject({ url: `/api/jobs/${jobId}` })).json();
  assert.equal(snapshot.status, 'succeeded');
  assert.deepEqual(snapshot.banners, ['campaign/leaderboard', 'campaign/mpu']);
  assert.equal(snapshot.results.length, 2);

  const download = await app.inject({ url: snapshot.results[0].downloadUrl });
  assert.equal(download.statusCode, 200);
  assert.equal(download.headers['content-type'], 'image/gif');
  assert.match(download.headers['content-disposition'], /^attachment; filename="leaderboard.gif"/);
  assert.equal(download.body, 'GIF89a');
  assert.equal(download.headers['x-content-type-options'], 'nosniff');

  const missing = await app.inject({ url: `/api/jobs/${jobId}/files/..%2Fsecret` });
  assert.equal(missing.statusCode, 404);
});

test('POST /api/jobs rejects invalid config and ZIP-slip archives', async (t) => {
  const app = server();
  t.after(() => app.close());

  const badConfig = buildMultipart([{ name: 'config', value: JSON.stringify({ outputFps: 7 }) }]);
  const configResponse = await app.inject({ method: 'POST', url: '/api/jobs', payload: badConfig.payload, headers: badConfig.headers });
  assert.equal(configResponse.statusCode, 400);
  assert.match(configResponse.json().error, /outputFps/);

  const slip = buildMultipart([
    { name: 'config', value: '{}' },
    { name: 'files', filename: 'evil.zip', data: buildZip([{ name: '../../evil.html', data: 'x' }]) },
  ]);
  const slipResponse = await app.inject({ method: 'POST', url: '/api/jobs', payload: slip.payload, headers: slip.headers });
  assert.equal(slipResponse.statusCode, 400);
});

test('POST /api/jobs enforces MAX_UPLOAD_BYTES', async (t) => {
  const app = server({ MAX_UPLOAD_BYTES: '50' });
  t.after(() => app.close());
  const body = buildMultipart([
    { name: 'config', value: '{}' },
    { name: 'files', filename: 'big.html', data: 'x'.repeat(200) },
  ]);
  const response = await app.inject({ method: 'POST', url: '/api/jobs', payload: body.payload, headers: body.headers });
  assert.equal(response.statusCode, 413);
});

test('SSE replays buffered events after Last-Event-ID', async (t) => {
  const app = server();
  t.after(() => app.close());
  const jobId = await submit(app);

  const full = await app.inject({ url: `/api/jobs/${jobId}/events` });
  assert.equal(full.headers['content-type'], 'text/event-stream; charset=utf-8');
  const all = parseSse(full.body);
  assert.deepEqual(all.map((event) => event.id), all.map((_event, index) => index + 1));
  assert.equal(all.at(-1).data.type, 'complete');

  const resumed = parseSse((await app.inject({ url: `/api/jobs/${jobId}/events`, headers: { 'last-event-id': '2' } })).body);
  assert.deepEqual(resumed.map((event) => event.id), all.slice(2).map((event) => event.id));

  const finished = await app.inject({ url: `/api/jobs/${jobId}/events`, headers: { 'last-event-id': String(all.length) } });
  assert.equal(finished.statusCode, 204);
});

test('jobs are isolated by Easy Auth principal and REQUIRE_AUTH rejects anonymous requests', async (t) => {
  const app = server({ REQUIRE_AUTH: '1' });
  t.after(() => app.close());

  const anonymous = zipUpload();
  const rejected = await app.inject({ method: 'POST', url: '/api/jobs', payload: anonymous.payload, headers: anonymous.headers });
  assert.equal(rejected.statusCode, 401);

  const jobId = await submit(app, { 'x-ms-client-principal-id': 'alice' });
  const alice = { 'x-ms-client-principal-id': 'alice' };
  const bob = { 'x-ms-client-principal-id': 'bob' };
  assert.equal((await app.inject({ url: `/api/jobs/${jobId}`, headers: alice })).statusCode, 200);
  for (const url of [`/api/jobs/${jobId}`, `/api/jobs/${jobId}/events`, `/api/jobs/${jobId}/files/leaderboard.gif`]) {
    assert.equal((await app.inject({ url, headers: bob })).statusCode, 404, url);
  }
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/jobs/${jobId}`, headers: bob })).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/jobs/${jobId}` })).statusCode, 401);
});

test('responses carry the CSP and /healthz reports tool status', async (t) => {
  const app = server();
  t.after(() => app.close());
  const response = await app.inject({ url: '/healthz' });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { UploadAssembler, safeSegments } = require('../uploads.cjs');
const { buildZip, tempDirectory } = require('./helpers.cjs');

const LIMITS = {
  maxUploadBytes: 1024 * 1024,
  maxUnzippedBytes: 1024 * 1024,
  maxFiles: 100,
  maxBannersPerJob: 10,
};

function assembler(limits = {}) {
  const root = tempDirectory();
  return { root, upload: new UploadAssembler(path.join(root, 'input'), { ...LIMITS, ...limits }) };
}

function streamOf(data) {
  return Readable.from([Buffer.from(data)]);
}

test('safeSegments rejects absolute paths and traversal', () => {
  assert.throws(() => safeSegments('/etc/passwd'), /Absolute/);
  assert.throws(() => safeSegments('C:\\Windows\\win.ini'), /Absolute/);
  assert.throws(() => safeSegments('banner/../../escape.html'), /traversal/);
  assert.throws(() => safeSegments('..\\escape.html'), /traversal/);
  assert.deepEqual(safeSegments('banner/./img/a.png'), ['banner', 'img', 'a.png']);
});

test('ZIP-slip entries are rejected and nothing is written outside the job', async () => {
  const { root, upload } = assembler();
  const zip = buildZip([
    { name: 'index.html', data: '<html></html>' },
    { name: '../../escaped.txt', data: 'owned' },
  ]);
  await assert.rejects(upload.addFile('evil.zip', streamOf(zip)), (error) => error.statusCode === 400);
  assert.equal(fs.existsSync(path.join(root, 'escaped.txt')), false);
  assert.equal(fs.existsSync(path.join(root, '..', 'escaped.txt')), false);
});

test('ZIP entries with absolute paths are rejected', async () => {
  const { upload } = assembler();
  const zip = buildZip([{ name: '/tmp/forge-absolute.txt', data: 'x' }]);
  await assert.rejects(upload.addFile('abs.zip', streamOf(zip)), (error) => error.statusCode === 400);
  assert.equal(fs.existsSync('/tmp/forge-absolute.txt'), false);
});

test('folder paths with traversal are rejected', async () => {
  const { upload } = assembler();
  await assert.rejects(upload.addFile('banner/../../x.html', streamOf('x')), /traversal/);
});

test('ZIP symlinks, __MACOSX and .DS_Store are skipped', async () => {
  const { upload } = assembler();
  const zip = buildZip([
    { name: 'index.html', data: '<html></html>' },
    { name: 'link', data: '/etc/passwd', mode: 0o120777 },
    { name: '__MACOSX/._index.html', data: 'junk' },
    { name: 'img/.DS_Store', data: 'junk' },
  ]);
  await upload.addFile('banner.zip', streamOf(zip));
  const [banner] = await upload.finish();
  assert.equal(fs.existsSync(path.join(banner.inputPath, 'link')), false);
  assert.equal(fs.existsSync(path.join(banner.inputPath, '__MACOSX')), false);
  assert.equal(fs.existsSync(path.join(banner.inputPath, 'img', '.DS_Store')), false);
  assert.equal(fs.existsSync(path.join(banner.inputPath, 'index.html')), true);
});

test('a ZIP with index.html at its root is one banner named after the ZIP', async () => {
  const { upload } = assembler();
  await upload.addFile('Summer Sale.zip', streamOf(buildZip([
    { name: 'index.html', data: '<html></html>' },
    { name: 'img/a.png', data: 'png' },
  ])));
  const banners = await upload.finish();
  assert.equal(banners.length, 1);
  assert.equal(banners[0].displayName, 'Summer Sale');
  assert.equal(path.basename(banners[0].inputPath), 'Summer Sale');
});

test('a ZIP without a root index.html yields one banner per top-level folder with index.html', async () => {
  const { upload } = assembler();
  await upload.addFile('campaign.zip', streamOf(buildZip([
    { name: 'leaderboard/index.html', data: '<html></html>' },
    { name: 'mpu/index.html', data: '<html></html>' },
    { name: 'assets/logo.png', data: 'png' },
  ])));
  const banners = await upload.finish();
  assert.deepEqual(banners.map((banner) => banner.displayName), ['campaign/leaderboard', 'campaign/mpu']);
});

test('folder uploads become one banner per top-level folder', async () => {
  const { upload } = assembler();
  await upload.addFile('leaderboard/index.html', streamOf('<html></html>'));
  await upload.addFile('leaderboard/img/a.png', streamOf('png'));
  await upload.addFile('mpu/index.html', streamOf('<html></html>'));
  await upload.addFile('mpu/.DS_Store', streamOf('junk'));
  const banners = await upload.finish();
  assert.deepEqual(banners.map((banner) => banner.displayName).sort(), ['leaderboard', 'mpu']);
  for (const banner of banners) assert.equal(fs.existsSync(path.join(banner.inputPath, 'index.html')), true);
});

test('direct HTML files are banners', async () => {
  const { upload } = assembler();
  await upload.addFile('promo.html', streamOf('<html></html>'));
  const [banner] = await upload.finish();
  assert.equal(banner.displayName, 'promo.html');
  assert.equal(path.basename(banner.inputPath), 'promo.html');
});

test('uploads with no banner entry point are rejected', async () => {
  const { upload } = assembler();
  await upload.addFile('assets.zip', streamOf(buildZip([{ name: 'img/a.png', data: 'png' }])));
  await assert.rejects(upload.finish(), /No banners/);
});

test('unsupported single files are rejected', async () => {
  const { upload } = assembler();
  await assert.rejects(upload.addFile('notes.txt', streamOf('hi')), /Unsupported/);
});

test('MAX_UPLOAD_BYTES is enforced', async () => {
  const { upload } = assembler({ maxUploadBytes: 10 });
  await assert.rejects(upload.addFile('big.html', streamOf('x'.repeat(11))), (error) => error.statusCode === 413);
});

test('MAX_UNZIPPED_BYTES is enforced', async () => {
  const { upload } = assembler({ maxUnzippedBytes: 100 });
  const zip = buildZip([{ name: 'index.html', data: 'x'.repeat(101) }]);
  await assert.rejects(upload.addFile('big.zip', streamOf(zip)), (error) => error.statusCode === 413);
});

test('MAX_FILES is enforced for folders and ZIP entries', async () => {
  const folder = assembler({ maxFiles: 2 });
  await folder.upload.addFile('a/index.html', streamOf('x'));
  await folder.upload.addFile('a/1.png', streamOf('x'));
  await assert.rejects(folder.upload.addFile('a/2.png', streamOf('x')), (error) => error.statusCode === 413);

  const zipped = assembler({ maxFiles: 2 });
  const zip = buildZip([{ name: 'index.html' }, { name: '1.png' }, { name: '2.png' }]);
  await assert.rejects(zipped.upload.addFile('a.zip', streamOf(zip)), (error) => error.statusCode === 413);
});

test('MAX_BANNERS_PER_JOB is enforced', async () => {
  const { upload } = assembler({ maxBannersPerJob: 1 });
  await upload.addFile('a.html', streamOf('x'));
  await upload.addFile('b.html', streamOf('x'));
  await assert.rejects(upload.finish(), (error) => error.statusCode === 413);
});

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
const { isWithin } = require('../sidecar/lib/server.cjs');

const HTML_EXTENSIONS = new Set(['.html', '.htm']);
const ENTRY_FILE = 'index.html';
const SYMLINK_MODE = 0o120000;
const FILE_TYPE_MASK = 0o170000;

class UploadError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'UploadError';
    this.statusCode = statusCode;
  }
}

function isIgnoredPath(segments) {
  return segments[0] === '__MACOSX' || segments[segments.length - 1] === '.DS_Store';
}

// Returns the path split into safe segments, or throws for absolute and traversing paths.
function safeSegments(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') throw new UploadError('A file path is empty.');
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.includes('\0')) {
    throw new UploadError(`Absolute paths are not allowed: ${relativePath}`);
  }
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) throw new UploadError(`A file path is empty: ${relativePath}`);
  if (segments.includes('..')) throw new UploadError(`Path traversal is not allowed: ${relativePath}`);
  return segments;
}

function resolveInside(root, segments) {
  const candidate = path.resolve(root, ...segments);
  if (!isWithin(root, candidate) || candidate === root) {
    throw new UploadError(`Path escapes the upload directory: ${segments.join('/')}`);
  }
  return candidate;
}

function safeName(name, fallback) {
  const cleaned = name.normalize('NFKD').replace(/[^a-zA-Z0-9._ -]+/g, '-').replace(/^[-. ]+|[-. ]+$/g, '');
  return cleaned || fallback;
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

// A directory with index.html at its root is one banner; otherwise each direct child
// directory that has index.html is one banner.
async function discoverBanners(root, displayPrefix) {
  if (isFile(path.join(root, ENTRY_FILE))) return [{ inputPath: root, displayName: displayPrefix }];
  const entries = await fsp.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && isFile(path.join(root, entry.name, ENTRY_FILE)))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({ inputPath: path.join(root, entry.name), displayName: `${displayPrefix}/${entry.name}` }));
}

class UploadAssembler {
  constructor(inputDirectory, limits) {
    this.inputDirectory = path.resolve(inputDirectory);
    this.limits = limits;
    this.uploadedBytes = 0;
    this.unzippedBytes = 0;
    this.fileCount = 0;
    this.itemCount = 0;
    this.folderRoots = new Map();
    this.banners = [];
  }

  countFile() {
    this.fileCount += 1;
    if (this.fileCount > this.limits.maxFiles) {
      throw new UploadError(`Uploads may contain at most ${this.limits.maxFiles} files.`, 413);
    }
  }

  uploadCounter() {
    return new Transform({
      transform: (chunk, _encoding, callback) => {
        this.uploadedBytes += chunk.length;
        if (this.uploadedBytes > this.limits.maxUploadBytes) {
          callback(new UploadError(`Uploads may total at most ${this.limits.maxUploadBytes} bytes.`, 413));
          return;
        }
        callback(null, chunk);
      },
    });
  }

  unzippedCounter() {
    return new Transform({
      transform: (chunk, _encoding, callback) => {
        this.unzippedBytes += chunk.length;
        if (this.unzippedBytes > this.limits.maxUnzippedBytes) {
          callback(new UploadError(`Extracted files may total at most ${this.limits.maxUnzippedBytes} bytes.`, 413));
          return;
        }
        callback(null, chunk);
      },
    });
  }

  async writeStream(stream, destination, counters) {
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    try {
      await pipeline(stream, ...counters, fs.createWriteStream(destination, { flags: 'wx' }));
    } catch (error) {
      if (error.code === 'EEXIST') throw new UploadError(`Duplicate file in upload: ${path.relative(this.inputDirectory, destination)}`);
      throw error;
    }
  }

  // relativePath is the folder-relative path (webkitRelativePath) for folder uploads,
  // or just the file name for ZIP and HTML uploads.
  async addFile(relativePath, stream) {
    let segments;
    try {
      segments = safeSegments(relativePath);
    } catch (error) {
      stream.resume();
      throw error;
    }
    if (isIgnoredPath(segments)) {
      await pipeline(stream, this.uploadCounter(), new Transform({ transform: (_chunk, _encoding, callback) => callback() }));
      return;
    }

    if (segments.length > 1) {
      this.countFile();
      const [topLevel] = segments;
      let root = this.folderRoots.get(topLevel);
      if (!root) {
        this.itemCount += 1;
        root = path.join(this.inputDirectory, `f${this.itemCount}`, safeName(topLevel, 'folder'));
        this.folderRoots.set(topLevel, root);
      }
      await this.writeStream(stream, resolveInside(root, segments.slice(1)), [this.uploadCounter()]);
      return;
    }

    const [fileName] = segments;
    const extension = path.extname(fileName).toLowerCase();
    if (extension === '.zip') {
      this.itemCount += 1;
      const itemDirectory = path.join(this.inputDirectory, `z${this.itemCount}`);
      const archivePath = path.join(itemDirectory, 'upload.zip');
      await this.writeStream(stream, archivePath, [this.uploadCounter()]);
      const stem = path.basename(fileName, path.extname(fileName));
      const root = path.join(itemDirectory, safeName(stem, 'banner'));
      await this.extractZip(archivePath, root);
      await fsp.rm(archivePath, { force: true });
      this.banners.push(...await discoverBanners(root, stem));
      return;
    }
    if (HTML_EXTENSIONS.has(extension)) {
      this.countFile();
      this.itemCount += 1;
      const destination = path.join(this.inputDirectory, `h${this.itemCount}`, safeName(fileName, 'banner.html'));
      await this.writeStream(stream, destination, [this.uploadCounter()]);
      this.banners.push({ inputPath: destination, displayName: fileName });
      return;
    }

    stream.resume();
    throw new UploadError(`Unsupported file "${fileName}". Upload ZIP files, HTML files, or folders.`);
  }

  extractZip(archivePath, root) {
    return new Promise((resolve, reject) => {
      yauzl.open(archivePath, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (openError, zipFile) => {
        if (openError) {
          reject(new UploadError(`Invalid ZIP file: ${openError.message}`));
          return;
        }
        let settled = false;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          zipFile.close();
          reject(error instanceof UploadError ? error : new UploadError(`Invalid ZIP file: ${error.message}`));
        };
        zipFile.on('error', fail);
        zipFile.on('end', () => {
          if (settled) return;
          settled = true;
          resolve();
        });
        zipFile.on('entry', (entry) => {
          this.extractEntry(zipFile, entry, root).then(() => zipFile.readEntry(), fail);
        });
        zipFile.readEntry();
      });
    });
  }

  async extractEntry(zipFile, entry, root) {
    const segments = safeSegments(entry.fileName);
    if (entry.fileName.endsWith('/') || isIgnoredPath(segments)) return;
    const mode = (entry.externalFileAttributes >>> 16) & FILE_TYPE_MASK;
    if (mode === SYMLINK_MODE) return;
    this.countFile();
    if (this.unzippedBytes + entry.uncompressedSize > this.limits.maxUnzippedBytes) {
      throw new UploadError(`Extracted files may total at most ${this.limits.maxUnzippedBytes} bytes.`, 413);
    }
    const destination = resolveInside(root, segments);
    const stream = await new Promise((resolve, reject) => {
      zipFile.openReadStream(entry, (error, readStream) => (error ? reject(error) : resolve(readStream)));
    });
    await this.writeStream(stream, destination, [this.unzippedCounter()]);
  }

  async finish() {
    for (const [topLevel, root] of this.folderRoots) {
      this.banners.push(...await discoverBanners(root, topLevel));
    }
    if (this.banners.length === 0) {
      throw new UploadError('No banners were found. Each banner needs an index.html, or upload an .html file directly.');
    }
    if (this.banners.length > this.limits.maxBannersPerJob) {
      throw new UploadError(`A job may contain at most ${this.limits.maxBannersPerJob} banners (found ${this.banners.length}).`, 413);
    }
    return this.banners;
  }
}

module.exports = { UploadAssembler, UploadError, discoverBanners, safeSegments };

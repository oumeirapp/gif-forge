'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function startFileServer(inputPath) {
  const root = path.dirname(path.resolve(inputPath));
  const server = http.createServer((request, response) => {
    try {
      const requestPath = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const candidate = path.resolve(root, `.${requestPath}`);
      if (!isWithin(root, candidate)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) {
        response.writeHead(404).end('Not found');
        return;
      }
      response.setHeader('Content-Type', CONTENT_TYPES[path.extname(candidate).toLowerCase()] || 'application/octet-stream');
      response.setHeader('Cache-Control', 'no-store');
      fs.createReadStream(candidate).pipe(response);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const filename = encodeURIComponent(path.basename(inputPath));
      resolve({
        url: `http://127.0.0.1:${address.port}/${filename}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = { isWithin, startFileServer };

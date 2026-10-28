'use strict';

const crypto = require('node:crypto');

const LOCAL_OWNER = 'local';
const SESSION_COOKIE = 'forge_session';

// App Service Easy Auth strips any client-supplied X-MS-CLIENT-PRINCIPAL-* headers and sets
// them for signed-in users, so the header can be trusted when the app runs behind Easy Auth.
function resolveOwner(headers, { requireAuth }) {
  const principalId = headers['x-ms-client-principal-id'];
  if (typeof principalId === 'string' && principalId.trim()) return principalId.trim();
  return requireAuth ? null : LOCAL_OWNER;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string') return cookies;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    const name = pair.slice(0, index).trim();
    if (name) cookies[name] = pair.slice(index + 1).trim();
  }
  return cookies;
}

// Counts failed sign-ins per client; once a client reaches the limit it is locked out until
// the window since its first failure has passed.
class LoginRateLimiter {
  constructor({ maxFailures = 10, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.now = now;
    this.failures = new Map();
  }

  entry(key) {
    const entry = this.failures.get(key);
    if (entry && this.now() - entry.firstAt > this.windowMs) {
      this.failures.delete(key);
      return null;
    }
    return entry ?? null;
  }

  retryAfterSeconds(key) {
    const entry = this.entry(key);
    if (!entry || entry.count < this.maxFailures) return 0;
    return Math.max(1, Math.ceil((entry.firstAt + this.windowMs - this.now()) / 1000));
  }

  recordFailure(key) {
    const entry = this.entry(key) ?? { count: 0, firstAt: this.now() };
    entry.count += 1;
    this.failures.set(key, entry);
  }

  reset(key) {
    this.failures.delete(key);
  }
}

// Temporary shared-password sign-in. Each successful sign-in gets its own random session id,
// which becomes the job owner, so people sharing the password still can't see each other's jobs.
function createPasswordAuth({ password, sessionSecret, sessionTtlMs, now = Date.now }) {
  const passwordDigest = sha256(password);
  const key = sessionSecret ? sha256(`forge-session:${sessionSecret}`) : crypto.randomBytes(32);

  function sign(payload) {
    return crypto.createHmac('sha256', key).update(payload).digest('base64url');
  }

  return {
    checkPassword(candidate) {
      if (typeof candidate !== 'string' || candidate === '') return false;
      return crypto.timingSafeEqual(sha256(candidate), passwordDigest);
    },

    issueSession() {
      const session = { sid: base64url(crypto.randomBytes(16)), exp: now() + sessionTtlMs };
      const payload = base64url(JSON.stringify(session));
      return { token: `${payload}.${sign(payload)}`, session };
    },

    verifySession(token) {
      if (typeof token !== 'string') return null;
      const [payload, signature, extra] = token.split('.');
      if (!payload || !signature || extra !== undefined) return null;
      const expected = Buffer.from(sign(payload));
      const actual = Buffer.from(signature);
      if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
      try {
        const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (typeof session.sid !== 'string' || !Number.isFinite(session.exp) || session.exp <= now()) return null;
        return session;
      } catch {
        return null;
      }
    },

    sessionCookie(token, { secure, maxAgeSeconds = Math.floor(sessionTtlMs / 1000) }) {
      return [
        `${SESSION_COOKIE}=${token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${maxAgeSeconds}`,
        ...(secure ? ['Secure'] : []),
      ].join('; ');
    },

    clearedCookie({ secure }) {
      return this.sessionCookie('', { secure, maxAgeSeconds: 0 });
    },
  };
}

module.exports = {
  LOCAL_OWNER,
  SESSION_COOKIE,
  LoginRateLimiter,
  createPasswordAuth,
  parseCookies,
  resolveOwner,
};

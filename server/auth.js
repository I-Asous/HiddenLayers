// Accounts and sessions: password hashing, session cookies, request checks and
// rate limits. Nothing here touches the database; app.js does that.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

// ---------- Passwords ----------

// scrypt with OWASP's recommended cost (N=2^15, r=8, p=3: 32 MiB, ~100 ms).
// The parameters are stored with each hash, so they can be raised later
// without breaking existing passwords.
const SCRYPT = { N: 2 ** 15, r: 8, p: 3, keylen: 64 };
const maxmem = (N, r) => 256 * N * r; // twice what scrypt needs

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

// The most used passwords that would otherwise pass the rules below.
const COMMON = new Set([
  'password1', 'password12', 'password123', 'passw0rd', 'p4ssw0rd', 'qwerty123', 'qwerty1234', 'abc12345',
  'abcd1234', 'iloveyou1', 'letmein1', 'welcome1', 'welcome123', 'monkey123', 'dragon123', 'football1',
  'baseball1', 'superman1', 'trustno1', 'sunshine1', 'princess1', 'admin123', 'test1234', '1q2w3e4r',
  '1qaz2wsx', 'zaq12wsx', 'a1b2c3d4', 'q1w2e3r4', 'asdf1234', 'zxcv1234', 'wanderling1', 'password1!',
]);

// Same characters typed on any keyboard give the same password.
const normalize = (password) => String(password).normalize('NFKC');

/** Why a new password can't be used, or null if it's fine. */
export function passwordProblem(password, confirmPassword, username) {
  if (typeof password !== 'string' || !password) return 'Choose a password';
  const p = normalize(password);
  if (p.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (p.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters`;
  if (!/\p{L}/u.test(p) || !/\p{N}/u.test(p)) return 'Password needs at least one letter and one number';
  if (p.toLowerCase() === String(username ?? '').toLowerCase()) return 'Password can\'t be your username';
  if (COMMON.has(p.toLowerCase())) return 'That password is too common. Pick something harder to guess';
  if (password !== confirmPassword) return 'Passwords don\'t match';
  return null;
}

// Each hash takes 32 MiB and ~100 ms of CPU, so only a few run at once and the
// rest wait their turn: a flood of sign-ins can't exhaust the server's memory.
const MAX_HASHING = 4;
let hashing = 0;
const waiting = [];
async function oneAtATime(fn) {
  if (hashing < MAX_HASHING) hashing++;
  else await new Promise((resolve) => waiting.push(resolve)); // the finished hash hands over its slot
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else hashing--;
  }
}

export async function hashPassword(password) {
  const { N, r, p, keylen } = SCRYPT;
  const salt = randomBytes(16);
  const hash = await oneAtATime(() => scrypt(normalize(password), salt, keylen, { N, r, p, maxmem: maxmem(N, r) }));
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored ?? '').split('$');
  if (scheme !== 'scrypt' || typeof password !== 'string' || password.length > PASSWORD_MAX * 4) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await oneAtATime(() => scrypt(normalize(password), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: maxmem(Number(N), Number(r)),
  }));
  return timingSafeEqual(actual, expected);
}

// Checked against when the username doesn't exist, so a wrong name takes as
// long as a wrong password and can't be told apart by timing.
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword('not-a-real-password-1');
  await verifyPassword(String(password ?? ''), dummyHash);
}

// ---------- Sessions ----------

export const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

// The browser holds a random token; the database only ever sees its SHA-256,
// so a leaked database can't be used to sign in.
export const newSessionToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

// Behind Railway (or any TLS proxy) the app itself is reached over plain HTTP.
export const isHttps = (req) => Boolean(req.socket.encrypted)
  || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';

// Over HTTPS the cookie gets the __Host- prefix, which browsers only accept
// when it is Secure, host-only and for the whole site. Plain-HTTP local
// development can't set Secure cookies everywhere, so it uses a plain name.
const cookieName = (req) => (isHttps(req) ? '__Host-wl_session' : 'wl_session');

export function sessionCookie(req, token) {
  const parts = [
    `${cookieName(req)}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${token ? SESSION_TTL_MS / 1000 : 0}`,
  ];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

export function readSessionToken(req) {
  const name = cookieName(req);
  for (const pair of String(req.headers.cookie ?? '').split(';')) {
    const at = pair.indexOf('=');
    if (at > 0 && pair.slice(0, at).trim() === name) return pair.slice(at + 1).trim() || null;
  }
  return null;
}

// ---------- Forged requests ----------

// Every request that changes something must come from this site's own page:
//  - it carries a custom header, which a form or link on another site can't
//    send, and which cross-site scripts can't send without a CORS preflight
//    that this server never approves;
//  - the browser's own Origin / Sec-Fetch-Site headers, when present, must
//    say the request came from this site.
// The SameSite=Strict cookie is a third, independent layer.
export const CSRF_HEADER = 'x-wanderling';

export function checkSameOrigin(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  if (req.headers[CSRF_HEADER] !== '1') return 'Missing request header';
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return 'Cross-site request';
  const origin = req.headers.origin;
  if (origin && !allowedOrigins(req).includes(origin)) return 'Cross-site request';
  return null;
}

// This site's own address as the browser sees it. Behind a proxy the Host
// header may be rewritten, so the forwarded host counts too, and APP_ORIGIN
// (e.g. https://wanderling.up.railway.app) can name it outright.
function allowedOrigins(req) {
  const scheme = isHttps(req) ? 'https' : 'http';
  const hosts = [req.headers.host, String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim()].filter(Boolean);
  const configured = String(process.env.APP_ORIGIN ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  return [...hosts.map((host) => `${scheme}://${host}`), ...configured];
}

// ---------- Rate limits ----------

/** Allows `limit` hits per `windowMs` for each key. */
export function rateLimiter(limit, windowMs) {
  const hits = new Map();
  return {
    /** Counts a hit; false once the key is over its limit. */
    hit(key) {
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(key, entry);
      }
      entry.count++;
      // Forget stale keys now and then so the map can't grow forever.
      if (hits.size > 10_000) for (const [k, e] of hits) if (e.resetAt <= now) hits.delete(k);
      return entry.count <= limit;
    },
    isBlocked(key) {
      const entry = hits.get(key);
      return Boolean(entry && entry.resetAt > Date.now() && entry.count >= limit);
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

// Railway's proxy puts the real client address in X-Real-IP; anywhere else
// the socket address is the client.
export const clientIp = (req) => String(req.headers['x-real-ip'] ?? '').trim() || req.socket.remoteAddress || 'unknown';

// ---------- Response headers ----------

// Where the page may load things from: its own files, Google Fonts, three.js
// from jsDelivr, and Google Maps (which needs eval, blob: workers and inline
// styles). Inline scripts are allowed only by hash: the import map in index.html.
export function securityHeaders(req, { importMapHash }) {
  const csp = [
    "default-src 'self'",
    `script-src 'self' '${importMapHash}' 'unsafe-eval' https://cdn.jsdelivr.net https://*.googleapis.com https://*.gstatic.com https://*.google.com`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.googleusercontent.com",
    "connect-src 'self' data: blob: https://cdn.jsdelivr.net https://*.googleapis.com https://*.gstatic.com https://*.google.com",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "frame-src https://*.google.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), payment=(), usb=(), geolocation=(self), accelerometer=(self), gyroscope=(self)',
    ...(isHttps(req) ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

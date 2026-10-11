import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VOICES, waitForSpeech } from './ai.js';
import { createAdminRoutes } from './admin.js';
import {
  SESSION_TTL_MS, checkSameOrigin, clientIp, hashToken, newSessionToken, rateLimiter, readSessionToken,
  securityHeaders, sessionCookie,
} from './auth.js';
import { createContext } from './context.js';
import { openDb } from './db.js';
import { HttpError } from './http-error.js';
import { loadRules } from './rules.js';
import { createAuthRoutes } from './routes/auth.js';
import { createBattleRoutes } from './routes/battles.js';
import { createBuddyRoutes } from './routes/buddy.js';
import { createSocialRoutes } from './routes/social.js';
import { createStoreRoutes } from './routes/store.js';
import { createWalkRoutes } from './routes/walk.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
// The admin dashboard is its own small site, kept apart from the game.
const ADMIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'admin');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.glb': 'model/gltf-binary',
};

// The import map is the page's one inline script. The Content-Security-Policy
// allows exactly it, by hash, and no other inline script.
const IMPORT_MAP_HASH = (() => {
  const html = readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const map = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1] ?? '';
  return `sha256-${createHash('sha256').update(map).digest('base64')}`;
})();

// Routes anyone may call. Everything else needs a signed-in session.
const PUBLIC_ROUTES = new Set([
  'POST /api/signup', 'POST /api/login', 'POST /api/claim', 'POST /api/logout',
  'GET /api/personalities', 'GET /api/username',
]);
const AUTH_ROUTES = new Set(['POST /api/signup', 'POST /api/login', 'POST /api/claim']);

export async function createApp({ dbFile, dataDir, authAttemptsPerIp = 30, adminFailuresPerIp = 20 }) {
  const db = await openDb(dbFile);
  // Prices, the battle bonus and rest times: defaults unless an admin changed them.
  const rules = await loadRules(db);
  const ttsDir = path.join(dataDir, 'tts');

  // A personality whose voice was removed from VOICES gets regenerated on next talk.
  for (const { user_id, personality } of await db.all('SELECT user_id, personality FROM buddies WHERE personality IS NOT NULL')) {
    if (!(JSON.parse(personality).voice in VOICES)) {
      await db.run('UPDATE buddies SET personality = NULL WHERE user_id = ?', [user_id]);
      await db.run('DELETE FROM ready_lines WHERE user_id = ?', [user_id]);
      await db.run('DELETE FROM buddy_memory WHERE user_id = ?', [user_id]);
    }
  }

  const ctx = createContext({ db, rules, ttsDir });
  const { liveBattles, lastSeen, markSeen, validUsername } = ctx;

  // Every player route, by area; see routes/.
  const routes = {
    ...createAuthRoutes(ctx),
    ...createBuddyRoutes(ctx),
    ...createWalkRoutes(ctx),
    ...createStoreRoutes(ctx),
    ...createSocialRoutes(ctx),
    ...createBattleRoutes(ctx),
  };

  // The dashboard's API (see admin.js). Admin rights don't hang off a player
  // account: every call must carry the ADMIN_KEY from the server's environment.
  // With no key set, the admin API doesn't exist.
  const adminRoutes = createAdminRoutes({
    db, rules, HttpError, validUsername,
    seenAt: (userId) => lastSeen.get(userId)?.at ?? null,
    // A player who was suspended or deleted mid-battle has nothing left to finish.
    forgetPlayer: (userId) => {
      liveBattles.delete(userId);
      lastSeen.delete(userId);
    },
  });

  // Hashing first makes the comparison constant-time whatever the lengths.
  function isAdmin(req) {
    const key = process.env.ADMIN_KEY;
    if (!key) return false;
    const digest = (value) => createHash('sha256').update(String(value)).digest();
    return timingSafeEqual(digest(req.headers['x-admin-key'] ?? ''), digest(key));
  }

  // Wrong admin keys per address, so the key can't be guessed by brute force.
  const adminFailures = rateLimiter(adminFailuresPerIp, 15 * 60_000);

  async function handleAdminApi(req, res, url) {
    if (!process.env.ADMIN_KEY) throw new HttpError(404, 'Not found');
    const ip = clientIp(req);
    if (adminFailures.isBlocked(ip)) throw new HttpError(429, 'Too many wrong keys. Wait 15 minutes and try again');
    if (!isAdmin(req)) {
      adminFailures.hit(ip);
      throw new HttpError(401, 'Wrong admin key');
    }
    const route = adminRoutes[`${req.method} ${url.pathname}`];
    if (!route) throw new HttpError(404, 'Not found');
    const body = req.method === 'GET' ? {} : await readJson(req);
    sendJson(res, 200, await route({ body, query: url.searchParams, tz: timezoneOf(req) }));
  }

  // Brute-force limits: sign-in / sign-up attempts and username lookups per
  // address. Wrong passwords per username are limited in routes/auth.js.
  const authAttempts = rateLimiter(authAttemptsPerIp, 15 * 60_000);
  const usernameLookups = rateLimiter(120, 15 * 60_000);

  // The signed-in user for this request's session cookie, or null.
  async function sessionUser(token) {
    if (!token) return null;
    const session = await db.get(`
      SELECT s.user_id, s.expires_at, u.banned_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?
    `, [hashToken(token)]);
    // A suspended player's sessions are removed, so the banned check is only a backstop.
    if (!session || Number(session.expires_at) <= Date.now() || session.banned_at !== null) return null;
    return session.user_id;
  }

  async function handleApi(req, res, url) {
    const key = `${req.method} ${url.pathname}`;
    const route = routes[key];
    if (!route) throw new HttpError(404, 'Not found');
    const forged = checkSameOrigin(req);
    if (forged) throw new HttpError(403, forged);
    if (AUTH_ROUTES.has(key) && !authAttempts.hit(clientIp(req))) {
      throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again');
    }
    if (key === 'GET /api/username' && !usernameLookups.hit(clientIp(req))) {
      throw new HttpError(429, 'Too many lookups. Wait a few minutes and try again');
    }
    const token = readSessionToken(req);
    const userId = await sessionUser(token);
    if (userId) markSeen(userId);
    if (!userId && !PUBLIC_ROUTES.has(key)) {
      // A stale or expired cookie is cleared so the browser stops sending it.
      if (token) res.setHeader('set-cookie', sessionCookie(req, ''));
      throw new HttpError(401, 'Please sign in');
    }
    const tz = timezoneOf(req);
    const body = req.method === 'GET' ? {} : await readJson(req);
    // A fresh token on every sign-in, so a session can't be planted beforehand.
    const startSession = async (id) => {
      const fresh = newSessionToken();
      const now = Date.now();
      await db.run('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?', [id, now]);
      await db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
        [hashToken(fresh), id, now, now + SESSION_TTL_MS]);
      if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
      res.setHeader('set-cookie', sessionCookie(req, fresh));
    };
    const endSession = () => res.setHeader('set-cookie', sessionCookie(req, ''));
    sendJson(res, 200, await route({ userId, token, tz, body, query: url.searchParams, startSession, endSession }));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    for (const [name, value] of Object.entries(securityHeaders(req, { importMapHash: IMPORT_MAP_HASH }))) {
      res.setHeader(name, value);
    }
    try {
      if (url.pathname.startsWith('/api/tts/')) {
        if (!await sessionUser(readSessionToken(req))) throw new HttpError(401, 'Please sign in');
        return await serveTts(res, ttsDir, url.pathname.slice(9));
      }
      if (url.pathname.startsWith('/api/admin/')) return await handleAdminApi(req, res, url);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (url.pathname === '/admin') {
        res.writeHead(302, { location: '/admin/' });
        return res.end();
      }
      if (url.pathname.startsWith('/admin/')) return serveStatic(req, res, url.pathname.slice(6), ADMIN_DIR);
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      sendJson(res, err.status ?? 500, { error: err.status ? err.message : 'Something went wrong' });
    }
  });
  server.dbLabel = db.label;
  return server;
}

// What Date#getTimezoneOffset() returned in the caller's browser, kept within real offsets.
function timezoneOf(req) {
  const minutes = Number.parseInt(req.headers['x-tz-offset'], 10);
  return Number.isFinite(minutes) ? Math.max(-840, Math.min(840, minutes)) : 0;
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new HttpError(413, 'Request too large');
  }
  if (!raw) return {};
  try {
    const body = JSON.parse(raw);
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {}
  throw new HttpError(400, 'Invalid JSON');
}

async function serveTts(res, ttsDir, name) {
  if (!/^[a-f0-9]{64}\.mp3$/.test(name)) throw new HttpError(404, 'Not found');
  await waitForSpeech(name);
  const file = path.join(ttsDir, name);
  if (!existsSync(file)) throw new HttpError(404, 'Not found');
  res.writeHead(200, { 'content-type': MIME['.mp3'], 'cache-control': 'private, max-age=31536000, immutable' });
  createReadStream(file).pipe(res);
}

function serveStatic(req, res, pathname, dir = PUBLIC_DIR) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'Bad path');
  }
  if (relative.endsWith('/')) relative += 'index.html';
  const file = path.join(dir, relative);
  if (!file.startsWith(dir + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
    throw new HttpError(404, 'Not found');
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

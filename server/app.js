import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buddyLine, isBuddyEvent, speak } from './ai.js';
import { DAY_MS, dayLabel, localDay, openDb, stepsByDay, transaction } from './db.js';
import {
  BATTLE_WIN_BONUS, SLOTS, SPECIES, UPGRADES, pointsEarned, resolveBattle, stageForLevel, upgradeCosts,
} from './game.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
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
const MAX_SESSION_STEPS = 200_000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApp({ dbFile, dataDir }) {
  const db = openDb(dbFile);
  const ttsDir = path.join(dataDir, 'tts');

  const getBuddy = (userId) => db.prepare('SELECT * FROM buddies WHERE user_id = ?').get(userId);
  const getUser = (userId) => db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

  function record(userId) {
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(winner_id = :id), 0) AS wins,
        COALESCE(SUM(winner_id IS NOT NULL AND winner_id != :id), 0) AS losses,
        COALESCE(SUM(winner_id IS NULL), 0) AS draws
      FROM battles WHERE challenger_id = :id OR opponent_id = :id
    `).get({ id: userId });
    return { wins: row.wins, losses: row.losses, draws: row.draws };
  }

  function state(userId, tz) {
    const user = getUser(userId);
    const buddy = getBuddy(userId);
    const today = localDay(Date.now(), tz);
    return {
      user: {
        id: user.id, username: user.username, points: user.points,
        totalSteps: user.total_steps, dailyGoal: user.daily_goal,
      },
      buddy: { ...publicBuddy(buddy), xp: buddy.xp, costs: upgradeCosts(buddy) },
      todaySteps: stepsByDay(db, userId, tz).get(today) ?? 0,
      record: record(userId),
    };
  }

  function addPoints(userId, amount) {
    db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(amount, userId);
  }

  // The balance check and the debit are one statement, so a spend can never
  // take the balance below zero or go through twice on a stale read.
  function spendPoints(userId, cost) {
    const { changes } = db
      .prepare('UPDATE users SET points = points - ? WHERE id = ? AND points >= ?')
      .run(cost, userId, cost);
    if (changes !== 1) throw new HttpError(402, 'Not enough Stride Points');
  }

  const routes = {
    'POST /api/login': ({ body, tz }) => {
      const username = String(body.username ?? '').trim();
      if (!/^[a-zA-Z0-9_]{2,20}$/.test(username)) {
        throw new HttpError(400, 'Username must be 2–20 letters, numbers or underscores');
      }
      const buddyName = String(body.buddyName ?? '').trim().slice(0, 16) || 'Buddy';
      const species = SPECIES.includes(body.species) ? body.species : SPECIES[0];
      const token = randomBytes(24).toString('hex');
      const userId = transaction(db, () => {
        let user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
        if (!user) {
          const { lastInsertRowid } = db
            .prepare('INSERT INTO users (username, created_at) VALUES (?, ?)')
            .run(username, Date.now());
          db.prepare('INSERT INTO buddies (user_id, name, species) VALUES (?, ?, ?)')
            .run(lastInsertRowid, buddyName, species);
          user = { id: Number(lastInsertRowid) };
        }
        db.prepare('INSERT INTO auth_tokens (token, user_id, created_at) VALUES (?, ?, ?)')
          .run(token, user.id, Date.now());
        return user.id;
      });
      return { token, ...state(userId, tz) };
    },

    'POST /api/logout': ({ token }) => {
      db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token);
      return { ok: true };
    },

    'GET /api/me': ({ userId, tz }) => state(userId, tz),

    // The Google Maps JavaScript API runs in the browser, so its key has to be
    // handed to the page. Restrict the key to this site's URL in Google Cloud.
    'GET /api/config': () => ({
      googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || null,
      googleMapsMapId: process.env.GOOGLE_MAPS_MAP_ID || null,
    }),

    'PATCH /api/me': ({ userId, body, tz }) => {
      if (body.dailyGoal !== undefined) {
        const goal = Number(body.dailyGoal);
        if (!Number.isInteger(goal) || goal < 500 || goal > 50_000) {
          throw new HttpError(400, 'Daily goal must be between 500 and 50,000 steps');
        }
        db.prepare('UPDATE users SET daily_goal = ? WHERE id = ?').run(goal, userId);
      }
      if (body.buddyName !== undefined) {
        const name = String(body.buddyName).trim().slice(0, 16);
        if (!name) throw new HttpError(400, 'Your buddy needs a name');
        db.prepare('UPDATE buddies SET name = ? WHERE user_id = ?').run(name, userId);
      }
      return state(userId, tz);
    },

    // The client reports the running total for its walk session; only the part
    // above last_synced_total is new, so retries and repeats add nothing.
    'POST /api/steps/sync': ({ userId, body, tz }) => {
      const sessionId = String(body.sessionId ?? '');
      const total = Number(body.total);
      if (!/^[\w-]{8,64}$/.test(sessionId)) throw new HttpError(400, 'Invalid session id');
      if (!Number.isInteger(total) || total < 0 || total > MAX_SESSION_STEPS) {
        throw new HttpError(400, 'Invalid step total');
      }
      const now = Date.now();
      const result = transaction(db, () => {
        let session = db.prepare('SELECT * FROM walk_sessions WHERE id = ?').get(sessionId);
        if (session && session.user_id !== userId) throw new HttpError(403, 'Not your walk session');
        if (!session) {
          db.prepare('INSERT INTO walk_sessions (id, user_id, started_at) VALUES (?, ?, ?)')
            .run(sessionId, userId, now);
          session = { last_synced_total: 0 };
        }
        const added = Math.max(0, total - session.last_synced_total);
        let earned = 0;
        if (added > 0) {
          const before = getUser(userId).total_steps;
          earned = pointsEarned(before, before + added);
          db.prepare('INSERT INTO step_events (user_id, session_id, timestamp, steps) VALUES (?, ?, ?, ?)')
            .run(userId, sessionId, now, added);
          db.prepare('UPDATE walk_sessions SET last_synced_total = ? WHERE id = ?').run(total, sessionId);
          db.prepare('UPDATE users SET total_steps = total_steps + ?, points = points + ? WHERE id = ?')
            .run(added, earned, userId);
          db.prepare('UPDATE buddies SET xp = xp + ? WHERE user_id = ?').run(earned, userId);
        }
        if (body.ended) {
          db.prepare('UPDATE walk_sessions SET ended_at = COALESCE(ended_at, ?) WHERE id = ?').run(now, sessionId);
        }
        return { added, earned };
      });
      return { ...result, ...state(userId, tz) };
    },

    'POST /api/buddy/upgrade': ({ userId, body, tz }) => {
      const upgrade = Object.hasOwn(UPGRADES, body.type) ? UPGRADES[body.type] : null;
      if (!upgrade) throw new HttpError(400, 'Unknown upgrade');
      const result = transaction(db, () => {
        const buddy = getBuddy(userId);
        const cost = upgrade.cost(buddy);
        spendPoints(userId, cost);
        db.prepare(`UPDATE buddies SET ${upgrade.column} = ${upgrade.column} + 1 WHERE user_id = ?`).run(userId);
        let evolvedTo = null;
        if (body.type === 'level') {
          const stage = stageForLevel(buddy.level + 1);
          if (stage !== buddy.stage) {
            db.prepare('UPDATE buddies SET stage = ? WHERE user_id = ?').run(stage, userId);
            evolvedTo = stage;
          }
        }
        return { cost, evolvedTo, evolvedFrom: evolvedTo ? buddy.stage : null };
      });
      return { ...result, ...state(userId, tz) };
    },

    'POST /api/buddy/equip': ({ userId, body, tz }) => {
      if (!SLOTS.includes(body.slot)) throw new HttpError(400, 'Unknown slot');
      let itemId = null;
      if (body.itemId != null) {
        const item = db.prepare(`
          SELECT c.id, c.slot FROM cosmetics c
          JOIN owned_cosmetics o ON o.cosmetic_id = c.id AND o.user_id = ?
          WHERE c.id = ?
        `).get(userId, String(body.itemId));
        if (!item) throw new HttpError(403, 'You don\'t own that item');
        if (item.slot !== body.slot) throw new HttpError(400, 'That item doesn\'t fit this slot');
        itemId = item.id;
      }
      db.prepare(`UPDATE buddies SET ${body.slot} = ? WHERE user_id = ?`).run(itemId, userId);
      return state(userId, tz);
    },

    'GET /api/store': ({ userId }) => ({ items: storeItems(userId) }),

    'POST /api/store/buy': ({ userId, body, tz }) => {
      transaction(db, () => {
        const item = db.prepare('SELECT * FROM cosmetics WHERE id = ?').get(String(body.itemId ?? ''));
        if (!item) throw new HttpError(404, 'No such item');
        const owned = db
          .prepare('SELECT 1 FROM owned_cosmetics WHERE user_id = ? AND cosmetic_id = ?')
          .get(userId, item.id);
        if (owned) throw new HttpError(409, 'You already own that');
        spendPoints(userId, item.price);
        db.prepare('INSERT INTO owned_cosmetics (user_id, cosmetic_id, bought_at) VALUES (?, ?, ?)')
          .run(userId, item.id, Date.now());
      });
      return { items: storeItems(userId), ...state(userId, tz) };
    },

    'GET /api/opponents': ({ userId }) => ({
      opponents: db.prepare(`
        SELECT b.*, u.username, f.friend_id IS NOT NULL AS is_friend
        FROM buddies b JOIN users u ON u.id = b.user_id
        LEFT JOIN friendships f ON f.user_id = :id AND f.friend_id = b.user_id
        WHERE b.user_id != :id ORDER BY b.level DESC, u.username LIMIT 100
      `).all({ id: userId }).map((row) => ({
        ...publicBuddy(row), userId: row.user_id, username: row.username, isFriend: Boolean(row.is_friend),
      })),
    }),

    'GET /api/friends': ({ userId }) => ({ friends: friendList(userId) }),

    // No requests to approve in this demo: adding someone makes you friends both ways.
    'POST /api/friends': ({ userId, body }) => {
      const username = String(body.username ?? '').trim().replace(/^@/, '');
      const friend = username && db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (!friend) throw new HttpError(404, `No player called "${username.slice(0, 20)}"`);
      if (friend.id === userId) throw new HttpError(400, 'That\'s you!');
      const add = db.prepare('INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)');
      const added = transaction(db, () => {
        const { changes } = add.run(userId, friend.id, Date.now());
        add.run(friend.id, userId, Date.now());
        return changes === 1;
      });
      if (!added) throw new HttpError(409, 'You\'re already friends');
      return { friends: friendList(userId) };
    },

    'POST /api/friends/remove': ({ userId, body }) => {
      const friendId = Number(body.userId);
      db.prepare(`
        DELETE FROM friendships
        WHERE (user_id = :a AND friend_id = :b) OR (user_id = :b AND friend_id = :a)
      `).run({ a: userId, b: friendId });
      return { friends: friendList(userId) };
    },

    // ?board=steps|wins|level  ?scope=friends|all
    'GET /api/leaderboard': ({ userId, tz, query }) => {
      const board = ['steps', 'wins', 'level'].includes(query.get('board')) ? query.get('board') : 'steps';
      const friendsOnly = query.get('scope') !== 'all';
      // "This week" is the last 7 days in the viewer's timezone, today included.
      const weekStart = (localDay(Date.now(), tz) - 6) * DAY_MS + tz * 60_000;
      const rows = db.prepare(`
        SELECT b.*, u.username,
          (SELECT COALESCE(SUM(steps), 0) FROM step_events s
            WHERE s.user_id = u.id AND s.timestamp >= :weekStart) AS steps,
          (SELECT COUNT(*) FROM battles bt WHERE bt.winner_id = u.id) AS wins
        FROM users u JOIN buddies b ON b.user_id = u.id
        WHERE :everyone OR u.id = :id
          OR u.id IN (SELECT friend_id FROM friendships WHERE user_id = :id)
      `).all({ id: userId, weekStart, everyone: friendsOnly ? 0 : 1 });
      const value = (row) => row[board];
      rows.sort((a, b) => value(b) - value(a) || b.xp - a.xp || a.username.localeCompare(b.username));
      const entries = rows.map((row, i) => ({
        rank: i + 1,
        userId: row.user_id,
        username: row.username,
        isMe: row.user_id === userId,
        value: value(row),
        buddy: publicBuddy(row),
      }));
      // Top 50, plus the viewer's own row if they are further down.
      const top = entries.slice(0, 50);
      const mine = entries.find((entry) => entry.isMe);
      if (mine && mine.rank > 50) top.push(mine);
      return { board, scope: friendsOnly ? 'friends' : 'all', entries: top };
    },

    'POST /api/battles': ({ userId, body, tz }) => {
      const opponentId = Number(body.opponentId);
      if (opponentId === userId) throw new HttpError(400, 'You can\'t battle yourself');
      const result = transaction(db, () => {
        const mine = getBuddy(userId);
        const theirs = getBuddy(opponentId);
        if (!theirs) throw new HttpError(404, 'That buddy has wandered off');
        const battle = resolveBattle(mine, theirs);
        const winnerId = battle.winner === 'a' ? userId : battle.winner === 'b' ? opponentId : null;
        if (winnerId) addPoints(winnerId, BATTLE_WIN_BONUS);
        db.prepare('UPDATE buddies SET xp = xp + ? WHERE user_id = ?').run(winnerId === userId ? 10 : 2, userId);
        const { lastInsertRowid } = db.prepare(`
          INSERT INTO battles (challenger_id, opponent_id, winner_id, challenger_damage, opponent_damage, log, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(userId, opponentId, winnerId, battle.totals.a, battle.totals.b, JSON.stringify(battle.log), Date.now());
        return {
          id: Number(lastInsertRowid),
          outcome: battle.winner === 'a' ? 'win' : battle.winner === 'b' ? 'loss' : 'draw',
          bonus: battle.winner === 'a' ? BATTLE_WIN_BONUS : 0,
          log: battle.log,
          totals: battle.totals,
          hpMax: battle.hpMax,
          challenger: publicBuddy(mine),
          opponent: { ...publicBuddy(theirs), username: getUser(opponentId).username },
        };
      });
      return { battle: result, ...state(userId, tz) };
    },

    'GET /api/battles': ({ userId }) => ({
      record: record(userId),
      history: db.prepare(`
        SELECT bt.id, bt.created_at, bt.challenger_id, bt.winner_id,
               bt.challenger_damage, bt.opponent_damage,
               u.username AS other_username, b.name AS other_buddy
        FROM battles bt
        JOIN users u ON u.id = CASE WHEN bt.challenger_id = :id THEN bt.opponent_id ELSE bt.challenger_id END
        JOIN buddies b ON b.user_id = u.id
        WHERE bt.challenger_id = :id OR bt.opponent_id = :id
        ORDER BY bt.created_at DESC, bt.id DESC LIMIT 20
      `).all({ id: userId }).map((row) => {
        const challenged = row.challenger_id === userId;
        return {
          id: row.id,
          at: row.created_at,
          challenged,
          opponent: { username: row.other_username, buddyName: row.other_buddy },
          outcome: row.winner_id === null ? 'draw' : row.winner_id === userId ? 'win' : 'loss',
          myDamage: challenged ? row.challenger_damage : row.opponent_damage,
          theirDamage: challenged ? row.opponent_damage : row.challenger_damage,
        };
      }),
    }),

    'GET /api/stats': ({ userId, tz }) => {
      const user = getUser(userId);
      const byDay = stepsByDay(db, userId, tz);
      const today = localDay(Date.now(), tz);
      const days = [];
      for (let day = today - 29; day <= today; day++) {
        days.push({ date: dayLabel(day), steps: byDay.get(day) ?? 0 });
      }
      // Today only counts toward the streak once the goal is hit; until then
      // yesterday's streak is still alive.
      let streak = 0;
      let day = (byDay.get(today) ?? 0) >= user.daily_goal ? today : today - 1;
      while ((byDay.get(day) ?? 0) >= user.daily_goal) {
        streak++;
        day--;
      }
      let best = null;
      for (const [d, steps] of byDay) {
        if (!best || steps > best.steps) best = { date: dayLabel(d), steps };
      }
      const km = (user.total_steps * 0.762) / 1000;
      return {
        todaySteps: byDay.get(today) ?? 0,
        dailyGoal: user.daily_goal,
        streak,
        bestDay: best,
        totalSteps: user.total_steps,
        distanceKm: km,
        co2SavedKg: km * 0.17,
        days,
      };
    },

    'POST /api/talk': async ({ userId, body, tz }) => {
      const event = body.event ?? 'chat';
      if (!isBuddyEvent(event)) throw new HttpError(400, 'Unknown event');
      const user = getUser(userId);
      const byDay = stepsByDay(db, userId, tz);
      const today = localDay(Date.now(), tz);
      const week = [];
      for (let day = today - 6; day <= today; day++) {
        week.push({ date: dayLabel(day), steps: byDay.get(day) ?? 0 });
      }
      const { text, source } = await buddyLine({
        event, buddy: getBuddy(userId), week, goal: user.daily_goal,
      });
      const audio = await speak(text, ttsDir);
      return { text, source, audioUrl: audio ? `/api/tts/${audio}` : null };
    },
  };

  function friendList(userId) {
    return db.prepare(`
      SELECT b.*, u.username,
        (SELECT COUNT(*) FROM battles bt WHERE bt.winner_id = :id
          AND ((bt.challenger_id = :id AND bt.opponent_id = u.id) OR (bt.challenger_id = u.id AND bt.opponent_id = :id))) AS won,
        (SELECT COUNT(*) FROM battles bt WHERE bt.winner_id = u.id
          AND ((bt.challenger_id = :id AND bt.opponent_id = u.id) OR (bt.challenger_id = u.id AND bt.opponent_id = :id))) AS lost
      FROM friendships f
      JOIN users u ON u.id = f.friend_id
      JOIN buddies b ON b.user_id = u.id
      WHERE f.user_id = :id ORDER BY u.username
    `).all({ id: userId }).map((row) => ({
      ...publicBuddy(row), userId: row.user_id, username: row.username,
      headToHead: { wins: row.won, losses: row.lost },
    }));
  }

  function storeItems(userId) {
    return db.prepare(`
      SELECT c.id, c.slot, c.name, c.price, o.user_id IS NOT NULL AS owned
      FROM cosmetics c
      LEFT JOIN owned_cosmetics o ON o.cosmetic_id = c.id AND o.user_id = ?
      ORDER BY c.sort
    `).all(userId).map((item) => ({ ...item, owned: Boolean(item.owned) }));
  }

  async function handleApi(req, res, url) {
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) throw new HttpError(404, 'Not found');
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    let userId = null;
    if (url.pathname !== '/api/login') {
      const auth = token && db.prepare('SELECT user_id FROM auth_tokens WHERE token = ?').get(token);
      if (!auth) throw new HttpError(401, 'Please sign in');
      userId = auth.user_id;
    }
    const tzHeader = Number.parseInt(req.headers['x-tz-offset'], 10);
    const tz = Number.isFinite(tzHeader) ? Math.max(-840, Math.min(840, tzHeader)) : 0;
    const body = req.method === 'GET' ? {} : await readJson(req);
    sendJson(res, 200, await route({ userId, token, tz, body, query: url.searchParams }));
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/tts/')) return serveTts(res, ttsDir, url.pathname.slice(9));
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      sendJson(res, err.status ?? 500, { error: err.status ? err.message : 'Something went wrong' });
    }
  });
}

function publicBuddy(b) {
  return {
    name: b.name, species: b.species, level: b.level, attack: b.attack, evasion: b.evasion, stage: b.stage,
    equipped: { hat: b.hat, eyewear: b.eyewear, accessory: b.accessory, background: b.background },
  };
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

function serveTts(res, ttsDir, name) {
  if (!/^[a-f0-9]{64}\.mp3$/.test(name)) throw new HttpError(404, 'Not found');
  const file = path.join(ttsDir, name);
  if (!existsSync(file)) throw new HttpError(404, 'Not found');
  res.writeHead(200, { 'content-type': MIME['.mp3'], 'cache-control': 'public, max-age=31536000, immutable' });
  createReadStream(file).pipe(res);
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'Bad path');
  }
  if (relative.endsWith('/')) relative += 'index.html';
  const file = path.join(PUBLIC_DIR, relative);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
    throw new HttpError(404, 'Not found');
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

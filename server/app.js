import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUDDY_EVENTS, MOOD_STYLES, PERSONALITY_PRESETS, VOICES, buddyLine, generatePersonality, isBuddyEvent, situationFor, startSpeech,
  waitForSpeech,
} from './ai.js';
import { DAY_MS, dayLabel, localDay, openDb, stepsByDay, transaction } from './db.js';
import {
  BATTLE_WIN_BONUS, COIN_PACKAGES, COSMETICS, EGGS, MAX_ROUNDS, SLOTS, SPECIES, UPGRADES, UPSET_MS, canUse,
  cosmeticCurrency, elementOf, matchup,
  moodFor, newBattle, opponentMove, pointsEarned, resolveRound, restAfterLoss, stageForLevel, streakFor, upgradeCosts,
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

// Everything that makes a beast itself, and so moves with it when the player
// switches which one they walk with.
const BUDDY_COLUMNS = [
  'name', 'species', 'level', 'attack', 'evasion', 'xp', 'stage', 'hat', 'eyewear', 'accessory', 'background',
  'personality', 'rest_until',
];

// Small enough to fit in a request, and only formats that are plain pictures (no SVG).
const AVATAR_PATTERN = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]{1,8000}={0,2}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function createApp({ dbFile, dataDir }) {
  const db = await openDb(dbFile);
  const ttsDir = path.join(dataDir, 'tts');

  // A personality whose voice was removed from VOICES gets regenerated on next talk.
  for (const { user_id, personality } of await db.all('SELECT user_id, personality FROM buddies WHERE personality IS NOT NULL')) {
    if (!(JSON.parse(personality).voice in VOICES)) {
      await db.run('UPDATE buddies SET personality = NULL WHERE user_id = ?', [user_id]);
      await db.run('DELETE FROM ready_lines WHERE user_id = ?', [user_id]);
      await db.run('DELETE FROM buddy_memory WHERE user_id = ?', [user_id]);
    }
  }

  // Pass tx as q inside a transaction.
  const getBuddy = (userId, q = db) => q.get('SELECT * FROM buddies WHERE user_id = ?', [userId]);
  const getUser = (userId, q = db) => q.get('SELECT * FROM users WHERE id = ?', [userId]);

  // Each buddy's personality is generated once and kept. One generation per
  // user at a time, so a login and a quick tap on Talk share a Gemini call.
  const personalityInFlight = new Map();
  async function ensurePersonality(userId) {
    const buddy = await getBuddy(userId);
    if (buddy.personality) return;
    if (!personalityInFlight.has(userId)) {
      personalityInFlight.set(userId, generatePersonality(buddy).then(async (personality) => {
        await db.run('UPDATE buddies SET personality = ? WHERE user_id = ? AND personality IS NULL',
          [JSON.stringify(personality), userId]);
      }).finally(() => personalityInFlight.delete(userId)));
    }
    return personalityInFlight.get(userId);
  }

  // The last 7 days of steps (oldest first), the goal, and the buddy's mood.
  async function moodContext(userId, tz) {
    const user = await getUser(userId);
    const byDay = await stepsByDay(db, userId, tz);
    const today = localDay(Date.now(), tz);
    const week = [];
    for (let day = today - 6; day <= today; day++) {
      week.push({ date: dayLabel(day), steps: byDay.get(day) ?? 0 });
    }
    const battles = await db.all(`
      SELECT winner_id, created_at FROM battles
      WHERE challenger_id = :id OR opponent_id = :id
      ORDER BY created_at DESC LIMIT 2
    `, { id: userId });
    const mood = moodFor({
      week: week.map((d) => d.steps), goal: user.daily_goal,
      streak: streakFor(byDay, today, user.daily_goal),
      lastBattles: battles.map(({ winner_id }) => (winner_id === null ? 'draw' : winner_id === userId ? 'win' : 'loss')),
      msSinceLastBattle: battles.length ? Date.now() - battles[0].created_at : Infinity,
    });
    // When the mood wears off by itself, so the app can refresh right then.
    const moodUntil = mood === 'upset' ? battles[0].created_at + UPSET_MS : null;
    return { week, goal: user.daily_goal, mood, moodUntil };
  }

  // The buddy remembers its last few exchanges, so it can build on them and
  // doesn't repeat itself.
  const MEMORY_SIZE = 8;
  const recall = async (userId) => (await db
    .all('SELECT situation, reply FROM buddy_memory WHERE user_id = ? ORDER BY id DESC LIMIT ?', [userId, MEMORY_SIZE]))
    .reverse();
  async function remember(userId, situation, reply) {
    await db.run('INSERT INTO buddy_memory (user_id, situation, reply) VALUES (?, ?, ?)', [userId, situation, reply]);
    await db.run(`
      DELETE FROM buddy_memory WHERE user_id = ? AND id NOT IN
        (SELECT id FROM buddy_memory WHERE user_id = ? ORDER BY id DESC LIMIT ?)
    `, [userId, userId, MEMORY_SIZE]);
  }

  // Event lines are written and voiced ahead of time so level-ups and battles
  // answer instantly. They live in the DB so a restart doesn't spend credits again.
  const preparing = new Set();
  function prepareLines(userId, tz) {
    if (!process.env.GEMINI_API_KEY) return; // built-in lines are instant anyway
    for (const event of BUDDY_EVENTS) {
      const key = `${userId}:${event}`;
      if (preparing.has(key)) continue;
      preparing.add(key);
      (async () => {
        if (await db.get('SELECT 1 FROM ready_lines WHERE user_id = ? AND event = ?', [userId, event])) return;
        const buddy = await getBuddy(userId);
        buddy.personality = JSON.parse(buddy.personality);
        const { week, goal, mood } = await moodContext(userId, tz);
        const line = await buddyLine({ event, buddy, week, goal, mood, memory: await recall(userId) });
        if (line.source !== 'gemini') return;
        await db.run(`
          INSERT INTO ready_lines (user_id, event, text, speech, mood) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (user_id, event) DO UPDATE SET text = excluded.text, speech = excluded.speech, mood = excluded.mood
        `, [userId, event, line.text, line.speech, mood]);
        startSpeech(line.speech, ttsDir, buddy.personality.voice, {
          background: true, stability: MOOD_STYLES[mood].stability,
        });
      })().catch((err) => console.error('[ai]', err.message)).finally(() => preparing.delete(key));
    }
  }

  async function record(userId) {
    const row = await db.get(`
      SELECT
        COALESCE(SUM(CASE WHEN winner_id = :id THEN 1 ELSE 0 END), 0) AS wins,
        COALESCE(SUM(CASE WHEN winner_id IS NOT NULL AND winner_id != :id THEN 1 ELSE 0 END), 0) AS losses,
        COALESCE(SUM(CASE WHEN winner_id IS NULL THEN 1 ELSE 0 END), 0) AS draws
      FROM battles WHERE challenger_id = :id OR opponent_id = :id
    `, { id: userId });
    return { wins: row.wins, losses: row.losses, draws: row.draws };
  }

  // When a beast can start a battle again after losing one it started, or null
  // if it is ready now. Each beast rests on its own.
  const restingUntil = (beast) => (Number(beast.rest_until) > Date.now() ? Number(beast.rest_until) : null);

  async function state(userId, tz) {
    const user = await getUser(userId);
    const buddy = await getBuddy(userId);
    const today = localDay(Date.now(), tz);
    const { mood, moodUntil } = await moodContext(userId, tz);
    return {
      user: {
        id: user.id, username: user.username, points: user.points, coins: user.coins,
        totalSteps: user.total_steps, dailyGoal: user.daily_goal, avatar: user.avatar ?? null,
      },
      buddy: {
        ...publicBuddy(buddy), xp: buddy.xp, costs: upgradeCosts(buddy),
        personality: traitsOf(buddy), mood, moodUntil, restingUntil: restingUntil(buddy),
      },
      resting: (await db.all('SELECT * FROM resting_buddies WHERE user_id = ? ORDER BY id', [userId]))
        .map((b) => ({ id: b.id, ...publicBuddy(b), xp: b.xp, personality: traitsOf(b), restingUntil: restingUntil(b) })),
      todaySteps: (await stepsByDay(db, userId, tz)).get(today) ?? 0,
      record: await record(userId),
    };
  }

  // Battles in progress, one per challenger. Kept in memory: a restart simply
  // drops them unrecorded.
  const liveBattles = new Map();

  const battleView = ({ id, battle, challenger, opponent }) => ({
    id, round: battle.round, rounds: MAX_ROUNDS, over: battle.over, hpMax: battle.hpMax, hp: battle.hp,
    energy: battle.energy, totals: battle.totals, challenger, opponent,
    matchup: matchup(challenger.element, opponent.element),
  });

  // Records a finished (or abandoned) battle and pays the winner.
  async function endBattle(userId, { forfeit = false } = {}) {
    const { opponentId, battle, log, sides } = liveBattles.get(userId);
    liveBattles.delete(userId);
    const winner = forfeit ? 'b' : battle.winner;
    const winnerId = winner === 'a' ? userId : winner === 'b' ? opponentId : null;
    await transaction(db, async (tx) => {
      if (winnerId) await addPoints(tx, winnerId, BATTLE_WIN_BONUS);
      await tx.run('UPDATE buddies SET xp = xp + ? WHERE user_id = ?', [winnerId === userId ? 10 : 2, userId]);
      // Only the beast that fought and lost has to rest; being beaten as the opponent costs nothing.
      if (winner === 'b') {
        await tx.run('UPDATE buddies SET rest_until = ? WHERE user_id = ?',
          [Date.now() + restAfterLoss(sides.a.level), userId]);
      }
      await tx.run(`
        INSERT INTO battles (challenger_id, opponent_id, winner_id, challenger_damage, opponent_damage, log, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [userId, opponentId, winnerId, battle.totals.a, battle.totals.b, JSON.stringify(log), Date.now()]);
    });
    return {
      outcome: winner === 'a' ? 'win' : winner === 'b' ? 'loss' : 'draw',
      bonus: winner === 'a' ? BATTLE_WIN_BONUS : 0,
    };
  }

  async function addPoints(tx, userId, amount) {
    await tx.run('UPDATE users SET points = points + ? WHERE id = ?', [amount, userId]);
  }

  // The balance check and the debit are one statement, so a spend can never
  // take the balance below zero or go through twice on a stale read.
  async function spendPoints(tx, userId, cost) {
    const { changes } = await tx.run('UPDATE users SET points = points - ? WHERE id = ? AND points >= ?', [cost, userId, cost]);
    if (changes !== 1) throw new HttpError(402, 'Not enough Stride Points');
  }

  // Diamonds are the coins column.
  async function spendDiamonds(tx, userId, cost) {
    const { changes } = await tx.run('UPDATE users SET coins = coins - ? WHERE id = ? AND coins >= ?', [cost, userId, cost]);
    if (changes !== 1) throw new HttpError(402, 'Not enough diamonds');
  }

  async function storeEggs(userId, q = db) {
    const owned = new Set([
      (await getBuddy(userId, q)).species,
      ...(await q.all('SELECT species FROM resting_buddies WHERE user_id = ?', [userId])).map((b) => b.species),
    ]);
    return EGGS.map((egg) => ({ ...egg, owned: owned.has(egg.species) }));
  }

  function validUsername(value) {
    const username = String(value ?? '').trim();
    if (!/^[a-zA-Z0-9_]{2,20}$/.test(username)) {
      throw new HttpError(400, 'Username must be 2–20 letters, numbers or underscores');
    }
    return username;
  }

  const routes = {
    // Public: sign-up checks the name is free before the player picks a beast.
    'GET /api/username': async ({ query }) => ({
      available: !await db.get('SELECT id FROM users WHERE username = ?', [validUsername(query.get('name'))]),
    }),

    'POST /api/login': async ({ body, tz }) => {
      const username = validUsername(body.username);
      const buddyName = String(body.buddyName ?? '').trim().slice(0, 16) || 'Buddy';
      // Nobody picks their beast: every new player is handed a random egg.
      const species = SPECIES[Math.floor(Math.random() * SPECIES.length)];
      // No preset picked ("Surprise me") leaves it NULL for ensurePersonality to invent.
      const preset = presetById(body.personality);
      const token = randomBytes(24).toString('hex');
      const userId = await transaction(db, async (tx) => {
        let user = await tx.get('SELECT id FROM users WHERE username = ?', [username]);
        // The login screen asks for one or the other, so a typo can't hatch a
        // second buddy and a taken name can't drop a new player into an old account.
        if (body.mode === 'login' && !user) throw new HttpError(404, 'No buddy found for that username');
        if (body.mode === 'signup' && user) throw new HttpError(409, 'That username already has a buddy');
        if (!user) {
          const { id } = await tx.run('INSERT INTO users (username, created_at) VALUES (?, ?) RETURNING id', [username, Date.now()]);
          await tx.run('INSERT INTO buddies (user_id, name, species, personality) VALUES (?, ?, ?, ?)',
            [id, buddyName, species, preset ? JSON.stringify(preset) : null]);
          user = { id };
        }
        await tx.run('INSERT INTO auth_tokens (token, user_id, created_at) VALUES (?, ?, ?)', [token, user.id, Date.now()]);
        return user.id;
      });
      ensurePersonality(userId).then(() => prepareLines(userId, tz)).catch((err) => console.error('[ai]', err.message));
      return { token, ...await state(userId, tz) };
    },

    'POST /api/logout': async ({ token }) => {
      await db.run('DELETE FROM auth_tokens WHERE token = ?', [token]);
      return { ok: true };
    },

    'GET /api/me': ({ userId, tz }) => state(userId, tz),

    // Public: the sign-up screen lists these before there is a session.
    'GET /api/personalities': () => ({
      personalities: PERSONALITY_PRESETS.map(({ id, name, traits, quirk }) => ({ id, name, traits, quirk })),
    }),

    // The Google Maps JavaScript API runs in the browser, so its key has to be
    // handed to the page. Restrict the key to this site's URL in Google Cloud.
    'GET /api/config': () => ({
      googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || null,
      googleMapsMapId: process.env.GOOGLE_MAPS_MAP_ID || null,
    }),

    'PATCH /api/me': async ({ userId, body, tz }) => {
      if (body.dailyGoal !== undefined) {
        const goal = Number(body.dailyGoal);
        if (!Number.isInteger(goal) || goal < 500 || goal > 50_000) {
          throw new HttpError(400, 'Daily goal must be between 500 and 50,000 steps');
        }
        await db.run('UPDATE users SET daily_goal = ? WHERE id = ?', [goal, userId]);
      }
      // A profile picture arrives already shrunk by the app, as a data: URL; null removes it.
      if (body.avatar !== undefined) {
        if (body.avatar !== null && !AVATAR_PATTERN.test(String(body.avatar))) {
          throw new HttpError(400, 'That picture can\'t be used. Try another one');
        }
        await db.run('UPDATE users SET avatar = ? WHERE id = ?', [body.avatar, userId]);
      }
      // The name and personality go to the beast walking with the player, or
      // to one of their resting beasts when beastId names it.
      const resting = body.beastId !== undefined;
      if (resting) {
        const beast = Number.isInteger(body.beastId)
          && await db.get('SELECT 1 FROM resting_buddies WHERE id = ? AND user_id = ?', [body.beastId, userId]);
        if (!beast) throw new HttpError(404, 'You don\'t have that beast');
      }
      const [table, where, key] = resting
        ? ['resting_buddies', 'id = ?', body.beastId]
        : ['buddies', 'user_id = ?', userId];
      if (body.buddyName !== undefined) {
        const name = String(body.buddyName).trim().slice(0, 16);
        if (!name) throw new HttpError(400, 'Your buddy needs a name');
        await db.run(`UPDATE ${table} SET name = ? WHERE ${where}`, [name, key]);
      }
      // A preset id, or 'surprise' for a fresh invented one.
      if (body.personality !== undefined) {
        const preset = presetById(body.personality);
        if (!preset && body.personality !== 'surprise') throw new HttpError(400, 'Unknown personality');
        const { personality: current } = await db.get(`SELECT personality FROM ${table} WHERE ${where}`, [key]);
        if (!preset || JSON.parse(current ?? '{}').id !== preset.id) {
          await db.run(`UPDATE ${table} SET personality = ? WHERE ${where}`, [preset ? JSON.stringify(preset) : null, key]);
          // A resting beast with no personality gets one when it next walks with the player.
          if (!resting) {
            // Lines and memories in the old voice would sound out of character.
            await db.run('DELETE FROM ready_lines WHERE user_id = ?', [userId]);
            await db.run('DELETE FROM buddy_memory WHERE user_id = ?', [userId]);
            await ensurePersonality(userId);
            prepareLines(userId, tz);
          }
        }
      }
      return state(userId, tz);
    },

    // The client reports the running total for its walk session; only the part
    // above last_synced_total is new, so retries and repeats add nothing.
    'POST /api/steps/sync': async ({ userId, body, tz }) => {
      const sessionId = String(body.sessionId ?? '');
      const total = Number(body.total);
      if (!/^[\w-]{8,64}$/.test(sessionId)) throw new HttpError(400, 'Invalid session id');
      if (!Number.isInteger(total) || total < 0 || total > MAX_SESSION_STEPS) {
        throw new HttpError(400, 'Invalid step total');
      }
      const now = Date.now();
      const result = await transaction(db, async (tx) => {
        let session = await tx.get('SELECT * FROM walk_sessions WHERE id = ?', [sessionId]);
        if (session && session.user_id !== userId) throw new HttpError(403, 'Not your walk session');
        if (!session) {
          await tx.run('INSERT INTO walk_sessions (id, user_id, started_at) VALUES (?, ?, ?)', [sessionId, userId, now]);
          session = { last_synced_total: 0 };
        }
        const added = Math.max(0, total - session.last_synced_total);
        let earned = 0;
        if (added > 0) {
          const before = (await getUser(userId, tx)).total_steps;
          earned = pointsEarned(before, before + added);
          await tx.run('INSERT INTO step_events (user_id, session_id, timestamp, steps) VALUES (?, ?, ?, ?)',
            [userId, sessionId, now, added]);
          await tx.run('UPDATE walk_sessions SET last_synced_total = ? WHERE id = ?', [total, sessionId]);
          await tx.run('UPDATE users SET total_steps = total_steps + ?, points = points + ? WHERE id = ?',
            [added, earned, userId]);
          await tx.run('UPDATE buddies SET xp = xp + ? WHERE user_id = ?', [earned, userId]);
        }
        if (body.ended) {
          await tx.run('UPDATE walk_sessions SET ended_at = COALESCE(ended_at, ?) WHERE id = ?', [now, sessionId]);
        }
        return { added, earned };
      });
      return { ...result, ...await state(userId, tz) };
    },

    'POST /api/buddy/upgrade': async ({ userId, body, tz }) => {
      const upgrade = Object.hasOwn(UPGRADES, body.type) ? UPGRADES[body.type] : null;
      if (!upgrade) throw new HttpError(400, 'Unknown upgrade');
      const result = await transaction(db, async (tx) => {
        const buddy = await getBuddy(userId, tx);
        const cost = upgrade.cost(buddy);
        await spendPoints(tx, userId, cost);
        await tx.run(`UPDATE buddies SET ${upgrade.column} = ${upgrade.column} + 1 WHERE user_id = ?`, [userId]);
        let evolvedTo = null;
        if (body.type === 'level') {
          const stage = stageForLevel(buddy.level + 1);
          if (stage !== buddy.stage) {
            await tx.run('UPDATE buddies SET stage = ? WHERE user_id = ?', [stage, userId]);
            evolvedTo = stage;
          }
        }
        return { cost, evolvedTo, evolvedFrom: evolvedTo ? buddy.stage : null };
      });
      return { ...result, ...await state(userId, tz) };
    },

    'POST /api/buddy/equip': async ({ userId, body, tz }) => {
      if (!SLOTS.includes(body.slot)) throw new HttpError(400, 'Unknown slot');
      let itemId = null;
      if (body.itemId != null) {
        const item = await db.get(`
          SELECT c.id, c.slot FROM cosmetics c
          JOIN owned_cosmetics o ON o.cosmetic_id = c.id AND o.user_id = ?
          WHERE c.id = ?
        `, [userId, String(body.itemId)]);
        if (!item) throw new HttpError(403, 'You don\'t own that item');
        if (item.slot !== body.slot) throw new HttpError(400, 'That item doesn\'t fit this slot');
        // There is one of each item: a beast resting at home may be wearing it.
        const wearer = await db.get(`SELECT name FROM resting_buddies WHERE user_id = ? AND ${body.slot} = ?`,
          [userId, item.id]);
        if (wearer) throw new HttpError(409, `${wearer.name} is wearing that. Take it off them first`);
        itemId = item.id;
      }
      await db.run(`UPDATE buddies SET ${body.slot} = ? WHERE user_id = ?`, [itemId, userId]);
      return state(userId, tz);
    },

    // Swaps the buddy the player walks with for one of their resting beasts.
    'POST /api/buddy/switch': async ({ userId, body, tz }) => {
      if (!Number.isInteger(body.id)) throw new HttpError(400, 'Unknown beast');
      // Swapping beasts mid-battle counts as losing it, so the rest lands on the one that fought.
      if (liveBattles.has(userId)) await endBattle(userId, { forfeit: true });
      await transaction(db, async (tx) => {
        const next = await tx.get('SELECT * FROM resting_buddies WHERE id = ? AND user_id = ?', [body.id, userId]);
        if (!next) throw new HttpError(404, 'You don\'t have that beast');
        const active = await getBuddy(userId, tx);
        const assignments = BUDDY_COLUMNS.map((column) => `${column} = ?`).join(', ');
        await tx.run(`UPDATE resting_buddies SET ${assignments} WHERE id = ?`,
          [...BUDDY_COLUMNS.map((column) => active[column]), next.id]);
        await tx.run(`UPDATE buddies SET ${assignments} WHERE user_id = ?`,
          [...BUDDY_COLUMNS.map((column) => next[column]), userId]);
        // Lines and memories belong to the beast that was just put to rest.
        await tx.run('DELETE FROM ready_lines WHERE user_id = ?', [userId]);
        await tx.run('DELETE FROM buddy_memory WHERE user_id = ?', [userId]);
      });
      ensurePersonality(userId).then(() => prepareLines(userId, tz)).catch((err) => console.error('[ai]', err.message));
      return state(userId, tz);
    },

    'GET /api/store': async ({ userId }) => ({
      items: await storeItems(userId),
      eggs: await storeEggs(userId),
      coinPackages: COIN_PACKAGES,
    }),

    'POST /api/store/buy': async ({ userId, body, tz }) => {
      await transaction(db, async (tx) => {
        const item = await tx.get('SELECT * FROM cosmetics WHERE id = ?', [String(body.itemId ?? '')]);
        if (!item) throw new HttpError(404, 'No such item');
        const owned = await tx.get('SELECT 1 FROM owned_cosmetics WHERE user_id = ? AND cosmetic_id = ?', [userId, item.id]);
        if (owned) throw new HttpError(409, 'You already own that');
        await (cosmeticCurrency(item.id) === 'diamonds' ? spendDiamonds : spendPoints)(tx, userId, item.price);
        await tx.run('INSERT INTO owned_cosmetics (user_id, cosmetic_id, bought_at) VALUES (?, ?, ?)',
          [userId, item.id, Date.now()]);
      });
      return { items: await storeItems(userId), ...await state(userId, tz) };
    },

    // A bought egg joins the player's resting beasts until they switch to it.
    'POST /api/store/buy-egg': async ({ userId, body, tz }) => {
      const egg = EGGS.find(({ species }) => species === body.species);
      if (!egg) throw new HttpError(404, 'No such egg');
      await transaction(db, async (tx) => {
        if ((await storeEggs(userId, tx)).find(({ species }) => species === egg.species).owned) {
          throw new HttpError(409, 'You already have that beast');
        }
        await (egg.currency === 'diamonds' ? spendDiamonds : spendPoints)(tx, userId, egg.price);
        const name = egg.species[0].toUpperCase() + egg.species.slice(1);
        await tx.run('INSERT INTO resting_buddies (user_id, name, species) VALUES (?, ?, ?)', [userId, name, egg.species]);
      });
      return { eggs: await storeEggs(userId), ...await state(userId, tz) };
    },

    'POST /api/store/buy-coins': async ({ userId, body, tz }) => {
      const pack = COIN_PACKAGES.find(({ id }) => id === body.packageId);
      if (!pack) throw new HttpError(404, 'No such coin package');
      await transaction(db, async (tx) => {
        await tx.run('UPDATE users SET coins = coins + ? WHERE id = ?', [pack.coins, userId]);
      });
      return { purchased: pack, ...await state(userId, tz) };
    },

    'GET /api/opponents': async ({ userId }) => ({
      opponents: (await db.all(`
        SELECT b.*, u.username, f.friend_id IS NOT NULL AS is_friend
        FROM buddies b JOIN users u ON u.id = b.user_id
        LEFT JOIN friendships f ON f.user_id = :id AND f.friend_id = b.user_id
        WHERE b.user_id != :id ORDER BY b.level DESC, u.username LIMIT 100
      `, { id: userId })).map((row) => ({
        ...publicBuddy(row), userId: row.user_id, username: row.username, isFriend: Boolean(row.is_friend),
      })),
    }),

    'GET /api/friends': async ({ userId }) => ({ friends: await friendList(userId) }),

    // No requests to approve in this demo: adding someone makes you friends both ways.
    'POST /api/friends': async ({ userId, body }) => {
      const username = String(body.username ?? '').trim().replace(/^@/, '');
      const friend = username && await db.get('SELECT id FROM users WHERE username = ?', [username]);
      if (!friend) throw new HttpError(404, `No player called "${username.slice(0, 20)}"`);
      if (friend.id === userId) throw new HttpError(400, 'That\'s you!');
      const add = 'INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING';
      const added = await transaction(db, async (tx) => {
        const { changes } = await tx.run(add, [userId, friend.id, Date.now()]);
        await tx.run(add, [friend.id, userId, Date.now()]);
        return changes === 1;
      });
      if (!added) throw new HttpError(409, 'You\'re already friends');
      return { friends: await friendList(userId) };
    },

    'POST /api/friends/remove': async ({ userId, body }) => {
      const friendId = Number(body.userId);
      await db.run(`
        DELETE FROM friendships
        WHERE (user_id = :a AND friend_id = :b) OR (user_id = :b AND friend_id = :a)
      `, { a: userId, b: friendId });
      return { friends: await friendList(userId) };
    },

    // ?board=steps|wins|level  ?scope=friends|all
    'GET /api/leaderboard': async ({ userId, tz, query }) => {
      const board = ['steps', 'wins', 'level'].includes(query.get('board')) ? query.get('board') : 'steps';
      const friendsOnly = query.get('scope') !== 'all';
      // "This week" is the last 7 days in the viewer's timezone, today included.
      const weekStart = (localDay(Date.now(), tz) - 6) * DAY_MS + tz * 60_000;
      const rows = await db.all(`
        SELECT b.*, u.username,
          (SELECT COALESCE(SUM(steps), 0) FROM step_events s
            WHERE s.user_id = u.id AND s.timestamp >= :weekStart) AS steps,
          (SELECT COUNT(*) FROM battles bt WHERE bt.winner_id = u.id) AS wins
        FROM users u JOIN buddies b ON b.user_id = u.id
        WHERE :everyone = 1 OR u.id = :id
          OR u.id IN (SELECT friend_id FROM friendships WHERE user_id = :id)
      `, { id: userId, weekStart, everyone: friendsOnly ? 0 : 1 });
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

    // Starts a battle. The player then sends one move per round; the opponent's
    // beast picks its own. Nothing is recorded until the battle ends.
    'POST /api/battles': async ({ userId, body }) => {
      const opponentId = Number(body.opponentId);
      if (opponentId === userId) throw new HttpError(400, 'You can\'t battle yourself');
      // Postgres rejects a non-integer id outright where SQLite just finds nobody.
      if (!Number.isInteger(opponentId)) throw new HttpError(404, 'That buddy has wandered off');
      const mine = await getBuddy(userId);
      const theirs = await getBuddy(opponentId);
      if (!theirs) throw new HttpError(404, 'That buddy has wandered off');
      // Walking away from a battle to start another counts as losing it.
      if (liveBattles.has(userId)) await endBattle(userId, { forfeit: true });
      const until = restingUntil(await getBuddy(userId));
      if (until) {
        const seconds = Math.ceil((until - Date.now()) / 1000);
        const left = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
        throw new HttpError(429, `${mine.name} is still resting after that loss. Ready in ${left}`);
      }
      const live = {
        id: randomBytes(8).toString('hex'), opponentId, sides: { a: mine, b: theirs }, battle: newBattle(mine, theirs),
        log: [], challenger: publicBuddy(mine),
        opponent: { ...publicBuddy(theirs), username: (await getUser(opponentId)).username },
      };
      liveBattles.set(userId, live);
      return { battle: battleView(live) };
    },

    'POST /api/battles/move': async ({ userId, body, tz }) => {
      const live = liveBattles.get(userId);
      if (!live || live.id !== body.battleId) throw new HttpError(409, 'That battle is over');
      if (!canUse(live.battle, 'a', body.move)) throw new HttpError(400, 'You can\'t use that move right now');
      const round = live.battle.round;
      const moves = { a: body.move, b: opponentMove(live.battle) };
      const actions = resolveRound(live.battle, live.sides, moves);
      live.log.push({ round, ...actions });
      if (!live.battle.over) return { round: { number: round, ...actions }, battle: battleView(live) };
      const result = await endBattle(userId);
      return { round: { number: round, ...actions }, battle: { ...battleView(live), ...result }, ...await state(userId, tz) };
    },

    'POST /api/battles/forfeit': async ({ userId, body, tz }) => {
      if (liveBattles.get(userId)?.id === body.battleId) await endBattle(userId, { forfeit: true });
      return state(userId, tz);
    },

    'GET /api/battles': async ({ userId }) => ({
      record: await record(userId),
      history: (await db.all(`
        SELECT bt.id, bt.created_at, bt.challenger_id, bt.winner_id,
               bt.challenger_damage, bt.opponent_damage,
               u.username AS other_username, b.name AS other_buddy
        FROM battles bt
        JOIN users u ON u.id = CASE WHEN bt.challenger_id = :id THEN bt.opponent_id ELSE bt.challenger_id END
        JOIN buddies b ON b.user_id = u.id
        WHERE bt.challenger_id = :id OR bt.opponent_id = :id
        ORDER BY bt.created_at DESC, bt.id DESC LIMIT 20
      `, { id: userId })).map((row) => {
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

    'GET /api/stats': async ({ userId, tz }) => {
      const user = await getUser(userId);
      const byDay = await stepsByDay(db, userId, tz);
      const today = localDay(Date.now(), tz);
      const days = [];
      for (let day = today - 29; day <= today; day++) {
        days.push({ date: dayLabel(day), steps: byDay.get(day) ?? 0 });
      }
      const streak = streakFor(byDay, today, user.daily_goal);
      let best = null;
      for (const [d, steps] of byDay) {
        if (!best || steps > best.steps) best = { date: dayLabel(d), steps };
      }
      // The last 12 calendar months, this one included, oldest first.
      const byMonth = new Map();
      for (const [d, steps] of byDay) {
        const month = dayLabel(d).slice(0, 7);
        byMonth.set(month, (byMonth.get(month) ?? 0) + steps);
      }
      const [year, thisMonth] = dayLabel(today).split('-').map(Number);
      const months = [];
      for (let back = 11; back >= 0; back--) {
        const month = new Date(Date.UTC(year, thisMonth - 1 - back, 1)).toISOString().slice(0, 7);
        months.push({ month, steps: byMonth.get(month) ?? 0 });
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
        months,
      };
    },

    'POST /api/talk': async ({ userId, body, tz }) => {
      const event = body.event ?? 'chat';
      if (!isBuddyEvent(event)) throw new HttpError(400, 'Unknown event');
      const { week, goal, mood } = await moodContext(userId, tz);
      await ensurePersonality(userId);
      const buddy = await getBuddy(userId);
      buddy.personality = JSON.parse(buddy.personality);
      // A line written in another mood is stale: drop it and write a fresh one.
      const taken = event !== 'chat' && await db
        .get('DELETE FROM ready_lines WHERE user_id = ? AND event = ? RETURNING text, speech, mood', [userId, event]);
      const ready = taken?.mood === mood && taken;
      const { text, speech, source } = ready
        ? { ...ready, source: 'gemini' }
        : await buddyLine({ event, buddy, week, goal, mood, memory: await recall(userId) });
      if (source === 'gemini') await remember(userId, situationFor(event, week, goal, mood), speech);
      prepareLines(userId, tz);
      // Don't wait for the voice: the text shows now, the audio URL waits for the mp3.
      const audio = startSpeech(speech, ttsDir, buddy.personality.voice, { stability: MOOD_STYLES[mood].stability });
      return { text, source, audioUrl: audio ? `/api/tts/${audio}` : null };
    },
  };

  async function friendList(userId) {
    return (await db.all(`
      SELECT b.*, u.username,
        (SELECT COUNT(*) FROM battles bt WHERE bt.winner_id = :id
          AND ((bt.challenger_id = :id AND bt.opponent_id = u.id) OR (bt.challenger_id = u.id AND bt.opponent_id = :id))) AS won,
        (SELECT COUNT(*) FROM battles bt WHERE bt.winner_id = u.id
          AND ((bt.challenger_id = :id AND bt.opponent_id = u.id) OR (bt.challenger_id = u.id AND bt.opponent_id = :id))) AS lost
      FROM friendships f
      JOIN users u ON u.id = f.friend_id
      JOIN buddies b ON b.user_id = u.id
      WHERE f.user_id = :id ORDER BY u.username
    `, { id: userId })).map((row) => ({
      ...publicBuddy(row), userId: row.user_id, username: row.username,
      headToHead: { wins: row.won, losses: row.lost },
    }));
  }

  async function storeItems(userId) {
    return (await db.all(`
      SELECT c.id, c.slot, c.name, c.price, o.user_id IS NOT NULL AS owned
      FROM cosmetics c
      LEFT JOIN owned_cosmetics o ON o.cosmetic_id = c.id AND o.user_id = ?
      ORDER BY c.sort
    `, [userId])).map((item) => ({
      ...item, owned: Boolean(item.owned), currency: cosmeticCurrency(item.id),
      rarity: COSMETICS.find(({ id }) => id === item.id)?.rarity ?? null,
    }));
  }

  async function handleApi(req, res, url) {
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) throw new HttpError(404, 'Not found');
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    let userId = null;
    if (!['/api/login', '/api/personalities', '/api/username'].includes(url.pathname)) {
      const auth = token && await db.get('SELECT user_id FROM auth_tokens WHERE token = ?', [token]);
      if (!auth) throw new HttpError(401, 'Please sign in');
      userId = auth.user_id;
    }
    const tzHeader = Number.parseInt(req.headers['x-tz-offset'], 10);
    const tz = Number.isFinite(tzHeader) ? Math.max(-840, Math.min(840, tzHeader)) : 0;
    const body = req.method === 'GET' ? {} : await readJson(req);
    sendJson(res, 200, await route({ userId, token, tz, body, query: url.searchParams }));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/tts/')) return await serveTts(res, ttsDir, url.pathname.slice(9));
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      sendJson(res, err.status ?? 500, { error: err.status ? err.message : 'Something went wrong' });
    }
  });
  server.dbLabel = db.label;
  return server;
}

function publicBuddy(b) {
  return {
    name: b.name, species: b.species, element: elementOf(b.species), level: b.level, attack: b.attack,
    evasion: b.evasion, stage: b.stage,
    equipped: { hat: b.hat, eyewear: b.eyewear, accessory: b.accessory, background: b.background },
  };
}

// What the player sees of the personality; the voice and style stay server-side.
function traitsOf(b) {
  if (!b.personality) return null;
  const { id, traits, quirk } = JSON.parse(b.personality);
  return { id: id ?? null, traits, quirk };
}

const presetById = (id) => PERSONALITY_PRESETS.find((p) => p.id === id) ?? null;

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

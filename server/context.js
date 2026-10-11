// What the route groups in routes/ share: looking up a player, the state the
// app is sent after every change, the buddy's voice and memory, battles in
// progress and spending.
import {
  BUDDY_EVENTS, MOOD_STYLES, PERSONALITY_PRESETS, buddyLine, generatePersonality, startSpeech,
} from './ai.js';
import { dayLabel, localDay, stepsByDay, transaction } from './db.js';
import { UPSET_MS, elementOf, moodFor, stageForLevel, streakFor, upgradeCosts } from './game.js';
import { HttpError } from './http-error.js';

export function createContext({ db, rules, ttsDir }) {
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

  // The newest announcement still running, for the app to show each player once.
  async function currentAnnouncement() {
    const row = await db.get(`
      SELECT id, message, created_at FROM announcements
      WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC, id DESC LIMIT 1
    `, [Date.now()]);
    return row ? { id: row.id, message: row.message, at: Number(row.created_at) } : null;
  }

  async function state(userId, tz) {
    const user = await getUser(userId);
    const buddy = await getBuddy(userId);
    const today = localDay(Date.now(), tz);
    const { mood, moodUntil } = await moodContext(userId, tz);
    return {
      user: {
        id: user.id, username: user.username, points: user.points, coins: user.coins,
        totalSteps: user.total_steps, dailyGoal: user.daily_goal, mapVisible: Boolean(user.map_visible),
      },
      buddy: {
        ...publicBuddy(buddy), xp: buddy.xp, costs: upgradeCosts(buddy),
        personality: traitsOf(buddy), mood, moodUntil, restingUntil: restingUntil(buddy),
      },
      resting: (await db.all('SELECT * FROM resting_buddies WHERE user_id = ? ORDER BY id', [userId]))
        .map((b) => ({ id: b.id, ...publicBuddy(b), xp: b.xp, personality: traitsOf(b), restingUntil: restingUntil(b) })),
      todaySteps: (await stepsByDay(db, userId, tz)).get(today) ?? 0,
      record: await record(userId),
      // The demo shortcuts (instant steps, a simulated walk) only exist when the server was started for a demo.
      demo: process.env.DEMO_MODE === '1',
      rules: { battleWinBonus: rules.get('battleWinBonus') },
      announcement: await currentAnnouncement(),
    };
  }

  // Battles in progress, one per challenger. Kept in memory: a restart simply
  // drops them unrecorded.
  const liveBattles = new Map();

  // Records a finished (or abandoned) battle and pays the winner. A forfeit
  // still counts as a loss, but pays nobody: otherwise a second account could
  // start battles and run away to farm points for the first.
  async function endBattle(userId, { forfeit = false } = {}) {
    const { opponentId, battle, log, sides } = liveBattles.get(userId);
    liveBattles.delete(userId);
    const winner = forfeit ? 'b' : battle.winner;
    const winnerId = winner === 'a' ? userId : winner === 'b' ? opponentId : null;
    await transaction(db, async (tx) => {
      if (winnerId && !forfeit) await addPoints(tx, winnerId, rules.get('battleWinBonus'));
      await tx.run('UPDATE buddies SET xp = xp + ? WHERE user_id = ?', [winnerId === userId ? 10 : 2, userId]);
      // Only the beast that fought and lost has to rest; being beaten as the opponent costs nothing.
      if (winner === 'b') {
        await tx.run('UPDATE buddies SET rest_until = ? WHERE user_id = ?',
          [Date.now() + rules.restMs(stageForLevel(sides.a.level), sides.a.level), userId]);
      }
      await tx.run(`
        INSERT INTO battles (challenger_id, opponent_id, winner_id, challenger_damage, opponent_damage, log, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [userId, opponentId, winnerId, battle.totals.a, battle.totals.b, JSON.stringify(log), Date.now()]);
    });
    return {
      outcome: winner === 'a' ? 'win' : winner === 'b' ? 'loss' : 'draw',
      bonus: winner === 'a' ? rules.get('battleWinBonus') : 0,
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

  function validUsername(value) {
    const username = String(value ?? '').trim();
    if (!/^[a-zA-Z0-9_]{2,20}$/.test(username)) {
      throw new HttpError(400, 'Username must be 2–20 letters, numbers or underscores');
    }
    return username;
  }

  // When each player's app last called in. Kept in memory for the dashboard's
  // "online now", and written to the database at most once a minute per
  // player so "last seen" survives a restart without a write on every request.
  const lastSeen = new Map();
  const SEEN_SAVE_MS = 60_000;
  function markSeen(userId) {
    const now = Date.now();
    const saved = lastSeen.get(userId)?.saved ?? 0;
    lastSeen.set(userId, { at: now, saved: now - saved >= SEEN_SAVE_MS ? now : saved });
    if (now - saved >= SEEN_SAVE_MS) {
      db.run('UPDATE users SET last_seen = ? WHERE id = ?', [now, userId]).catch((err) => console.error('[seen]', err.message));
    }
  }

  return {
    db, rules, ttsDir, getBuddy, getUser, ensurePersonality, moodContext, recall, remember, prepareLines, record,
    restingUntil, state, liveBattles, endBattle, addPoints, spendPoints, spendDiamonds, validUsername, lastSeen, markSeen,
  };
}

export function publicBuddy(b) {
  return {
    name: b.name, species: b.species, element: elementOf(b.species), level: b.level, attack: b.attack,
    evasion: b.evasion, stage: b.stage,
    equipped: { hat: b.hat, eyewear: b.eyewear, accessory: b.accessory, background: b.background },
  };
}

// What the player sees of the personality; the voice and style stay server-side.
export function traitsOf(b) {
  if (!b.personality) return null;
  const { id, traits, quirk } = JSON.parse(b.personality);
  return { id: id ?? null, traits, quirk };
}

export const presetById = (id) => PERSONALITY_PRESETS.find((p) => p.id === id) ?? null;

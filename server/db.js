import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { COSMETICS, DEFAULT_DAILY_GOAL, STEPS_PER_POINT, stageForLevel } from './game.js';

export const DAY_MS = 86_400_000;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY,
      username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
      points      INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
      total_steps INTEGER NOT NULL DEFAULT 0,
      daily_goal  INTEGER NOT NULL DEFAULT ${DEFAULT_DAILY_GOAL},
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS buddies (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id),
      name       TEXT NOT NULL,
      species    TEXT NOT NULL DEFAULT 'dragon',
      level      INTEGER NOT NULL DEFAULT 1,
      attack     INTEGER NOT NULL DEFAULT 1,
      evasion    INTEGER NOT NULL DEFAULT 1,
      xp         INTEGER NOT NULL DEFAULT 0,
      stage      TEXT NOT NULL DEFAULT 'egg',
      hat        TEXT REFERENCES cosmetics(id),
      eyewear    TEXT REFERENCES cosmetics(id),
      accessory  TEXT REFERENCES cosmetics(id),
      background TEXT REFERENCES cosmetics(id),
      personality TEXT -- JSON, filled in on first login or talk
    );
    CREATE TABLE IF NOT EXISTS cosmetics (
      id    TEXT PRIMARY KEY,
      slot  TEXT NOT NULL,
      name  TEXT NOT NULL,
      price INTEGER NOT NULL,
      sort  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS owned_cosmetics (
      user_id     INTEGER NOT NULL REFERENCES users(id),
      cosmetic_id TEXT NOT NULL REFERENCES cosmetics(id),
      bought_at   INTEGER NOT NULL,
      PRIMARY KEY (user_id, cosmetic_id)
    );
    -- One row per walk; last_synced_total is what makes syncs idempotent.
    CREATE TABLE IF NOT EXISTS walk_sessions (
      id                TEXT PRIMARY KEY,
      user_id           INTEGER NOT NULL REFERENCES users(id),
      started_at        INTEGER NOT NULL,
      ended_at          INTEGER,
      last_synced_total INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS step_events (
      id         INTEGER PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      session_id TEXT REFERENCES walk_sessions(id),
      timestamp  INTEGER NOT NULL,
      steps      INTEGER NOT NULL CHECK (steps > 0)
    );
    CREATE INDEX IF NOT EXISTS step_events_user_time ON step_events (user_id, timestamp);
    CREATE TABLE IF NOT EXISTS battles (
      id                INTEGER PRIMARY KEY,
      challenger_id     INTEGER NOT NULL REFERENCES users(id),
      opponent_id       INTEGER NOT NULL REFERENCES users(id),
      winner_id         INTEGER REFERENCES users(id),
      challenger_damage INTEGER NOT NULL,
      opponent_damage   INTEGER NOT NULL,
      log               TEXT NOT NULL,
      created_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS battles_challenger ON battles (challenger_id, created_at);
    CREATE INDEX IF NOT EXISTS battles_opponent ON battles (opponent_id, created_at);
    -- Friendship is mutual and stored as one row in each direction.
    CREATE TABLE IF NOT EXISTS friendships (
      user_id    INTEGER NOT NULL REFERENCES users(id),
      friend_id  INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, friend_id),
      CHECK (user_id != friend_id)
    );
    -- The buddy's recent exchanges, sent to Gemini as the conversation so far.
    CREATE TABLE IF NOT EXISTS buddy_memory (
      id        INTEGER PRIMARY KEY,
      user_id   INTEGER NOT NULL REFERENCES users(id),
      situation TEXT NOT NULL,
      reply     TEXT NOT NULL
    );
    -- Event lines (level up, battles…) written ahead of time so they play instantly.
    CREATE TABLE IF NOT EXISTS ready_lines (
      user_id INTEGER NOT NULL REFERENCES users(id),
      event   TEXT NOT NULL,
      text    TEXT NOT NULL,
      speech  TEXT NOT NULL,
      mood    TEXT, -- the mood it was written in; stale once the mood changes
      PRIMARY KEY (user_id, event)
    );
  `);
  // Databases created before beasts existed have no species column.
  if (!db.prepare('PRAGMA table_info(buddies)').all().some((col) => col.name === 'species')) {
    db.exec("ALTER TABLE buddies ADD COLUMN species TEXT NOT NULL DEFAULT 'dragon'");
  }
  if (!db.prepare('PRAGMA table_info(buddies)').all().some((col) => col.name === 'personality')) {
    db.exec('ALTER TABLE buddies ADD COLUMN personality TEXT');
  }
  if (!db.prepare('PRAGMA table_info(ready_lines)').all().some((col) => col.name === 'mood')) {
    db.exec('ALTER TABLE ready_lines ADD COLUMN mood TEXT');
  }
  seedCosmetics(db);
  seedDemoUsers(db);
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function seedCosmetics(db) {
  const upsert = db.prepare(`
    INSERT INTO cosmetics (id, slot, name, price, sort) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET slot = excluded.slot, name = excluded.name,
      price = excluded.price, sort = excluded.sort
  `);
  COSMETICS.forEach((c, i) => upsert.run(c.id, c.slot, c.name, c.price, i));
}

const DEMO_USERS = [
  {
    username: 'mira', buddy: 'Cinder', species: 'phoenix', level: 6, attack: 4, evasion: 6, points: 40,
    equipped: { hat: 'party-hat', accessory: 'scarf', background: 'bg-forest' }, avgSteps: 4200,
  },
  {
    username: 'theo', buddy: 'Inky', species: 'kraken', level: 13, attack: 9, evasion: 12, points: 75,
    equipped: { eyewear: 'sunglasses', accessory: 'bow-tie', background: 'bg-beach' }, avgSteps: 6800,
  },
  {
    username: 'ana', buddy: 'Smolder', species: 'dragon', level: 22, attack: 16, evasion: 18, points: 120,
    equipped: { hat: 'crown', eyewear: 'monocle', accessory: 'cape', background: 'bg-space' }, avgSteps: 9500,
  },
];

function seedDemoUsers(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return;
  const now = Date.now();
  transaction(db, () => {
    for (const demo of DEMO_USERS) {
      const { lastInsertRowid: userId } = db
        .prepare('INSERT INTO users (username, points, created_at) VALUES (?, ?, ?)')
        .run(demo.username, demo.points, now - 30 * DAY_MS);
      const eq = demo.equipped;
      db.prepare(`
        INSERT INTO buddies (user_id, name, species, level, attack, evasion, xp, stage, hat, eyewear, accessory, background)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId, demo.buddy, demo.species, demo.level, demo.attack, demo.evasion, demo.level * 120,
        stageForLevel(demo.level), eq.hat ?? null, eq.eyewear ?? null, eq.accessory ?? null, eq.background ?? null,
      );
      for (const cosmeticId of Object.values(eq)) {
        db.prepare('INSERT INTO owned_cosmetics (user_id, cosmetic_id, bought_at) VALUES (?, ?, ?)')
          .run(userId, cosmeticId, now);
      }
      // A month of walks so the demo accounts have charts worth looking at.
      let total = 0;
      for (let daysAgo = 29; daysAgo >= 1; daysAgo--) {
        const wobble = 0.55 + ((userId * 7 + daysAgo * 13) % 10) / 10;
        const steps = Math.round((demo.avgSteps * wobble) / 100) * 100;
        db.prepare('INSERT INTO step_events (user_id, timestamp, steps) VALUES (?, ?, ?)')
          .run(userId, now - daysAgo * DAY_MS, steps);
        total += steps;
      }
      db.prepare('UPDATE users SET total_steps = ? WHERE id = ?').run(total, userId);
    }
  });
}

// Days are bucketed in the walker's own timezone. offsetMin is what
// Date#getTimezoneOffset() returns in their browser (minutes behind UTC).
export function localDay(timestamp, offsetMin) {
  return Math.floor((timestamp - offsetMin * 60_000) / DAY_MS);
}

export function dayLabel(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function stepsByDay(db, userId, offsetMin) {
  const rows = db.prepare(`
    SELECT CAST((timestamp - ?) / ${DAY_MS} AS INTEGER) AS day, SUM(steps) AS steps
    FROM step_events WHERE user_id = ? GROUP BY day
  `).all(offsetMin * 60_000, userId);
  return new Map(rows.map((r) => [r.day, r.steps]));
}

export { STEPS_PER_POINT };

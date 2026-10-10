import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { COIN_PACKAGES, COSMETICS, DEFAULT_DAILY_GOAL, STEPS_PER_POINT, stageForLevel } from './game.js';

export const DAY_MS = 86_400_000;

// One async interface over both databases:
//   db.get / db.all / db.run (-> { changes, id }) / db.exec, and transaction(db, async (tx) => ...)
// Tiger Data (Postgres) is used when TIGER_DATABASE_URL is set and reachable at
// startup; otherwise SQLite. The choice is made here, once.
export async function openDb(file) {
  const url = process.env.DATABASE_URL || process.env.TIGER_DATABASE_URL;
  const db = (url && await openTiger(url)) || openSqlite(file);
  await seedCosmetics(db);
  await seedDemoUsers(db);
  return db;
}

export function transaction(db, fn) {
  return db.transaction(fn);
}

function openSqlite(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY,
      username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
      points      INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
      coins       INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0),
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
    -- Beasts a player owns but isn't walking with. The one they walk with
    -- lives in buddies; switching swaps the two rows' contents.
    CREATE TABLE IF NOT EXISTS resting_buddies (
      id         INTEGER PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      name       TEXT NOT NULL,
      species    TEXT NOT NULL,
      level      INTEGER NOT NULL DEFAULT 1,
      attack     INTEGER NOT NULL DEFAULT 1,
      evasion    INTEGER NOT NULL DEFAULT 1,
      xp         INTEGER NOT NULL DEFAULT 0,
      stage      TEXT NOT NULL DEFAULT 'egg',
      hat        TEXT REFERENCES cosmetics(id),
      eyewear    TEXT REFERENCES cosmetics(id),
      accessory  TEXT REFERENCES cosmetics(id),
      background TEXT REFERENCES cosmetics(id),
      personality TEXT,
      UNIQUE (user_id, species)
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
    -- A friend request waiting for to_id to accept or decline it.
    CREATE TABLE IF NOT EXISTS friend_requests (
      from_id    INTEGER NOT NULL REFERENCES users(id),
      to_id      INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (from_id, to_id),
      CHECK (from_id != to_id)
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
  if (!db.prepare('PRAGMA table_info(users)').all().some((col) => col.name === 'coins')) {
    db.exec('ALTER TABLE users ADD COLUMN coins INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0)');
  }
  // The player's profile picture: a small image as a data: URL, or NULL for none.
  if (!db.prepare('PRAGMA table_info(users)').all().some((col) => col.name === 'avatar')) {
    db.exec('ALTER TABLE users ADD COLUMN avatar TEXT');
  }
  // When a beast that lost a battle can fight again; it travels with the beast.
  for (const table of ['buddies', 'resting_buddies']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((col) => col.name === 'rest_until')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN rest_until INTEGER`);
    }
  }
  if (!db.prepare('PRAGMA table_info(ready_lines)').all().some((col) => col.name === 'mood')) {
    db.exec('ALTER TABLE ready_lines ADD COLUMN mood TEXT');
  }
  const args = (params = []) => (Array.isArray(params) ? params : [params]);
  const q = {
    get: async (sql, params) => db.prepare(sql).get(...args(params)),
    all: async (sql, params) => db.prepare(sql).all(...args(params)),
    run: async (sql, params) => {
      const { changes, lastInsertRowid } = db.prepare(sql).run(...args(params));
      return { changes, id: Number(lastInsertRowid) };
    },
    exec: async (sql) => db.exec(sql),
  };
  // One connection, so transactions take turns, and queries outside one wait
  // for it to finish instead of landing inside it.
  let queue = Promise.resolve();
  const outside = (method) => async (...a) => {
    await queue;
    return method(...a);
  };
  return {
    label: 'sqlite',
    get: outside(q.get),
    all: outside(q.all),
    run: outside(q.run),
    exec: outside(q.exec),
    async transaction(fn) {
      const prev = queue;
      let release;
      queue = new Promise((resolve) => { release = resolve; });
      await prev;
      try {
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(q);
          db.exec('COMMIT');
          return result;
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      } finally {
        release();
      }
    },
  };
}

const PG_SCHEMA = `
  -- Case-insensitive usernames, like SQLite's COLLATE NOCASE.
  CREATE COLLATION IF NOT EXISTS nocase (provider = icu, locale = 'und-u-ks-level2', deterministic = false);
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    username    TEXT NOT NULL UNIQUE COLLATE nocase,
    points      INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
    coins       INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0),
    total_steps INTEGER NOT NULL DEFAULT 0,
    daily_goal  INTEGER NOT NULL DEFAULT ${DEFAULT_DAILY_GOAL},
    created_at  BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_tokens (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    created_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cosmetics (
    id    TEXT PRIMARY KEY,
    slot  TEXT NOT NULL,
    name  TEXT NOT NULL,
    price INTEGER NOT NULL,
    sort  INTEGER NOT NULL
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
    personality TEXT
  );
  CREATE TABLE IF NOT EXISTS resting_buddies (
    id         INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    name       TEXT NOT NULL,
    species    TEXT NOT NULL,
    level      INTEGER NOT NULL DEFAULT 1,
    attack     INTEGER NOT NULL DEFAULT 1,
    evasion    INTEGER NOT NULL DEFAULT 1,
    xp         INTEGER NOT NULL DEFAULT 0,
    stage      TEXT NOT NULL DEFAULT 'egg',
    hat        TEXT REFERENCES cosmetics(id),
    eyewear    TEXT REFERENCES cosmetics(id),
    accessory  TEXT REFERENCES cosmetics(id),
    background TEXT REFERENCES cosmetics(id),
    personality TEXT,
    UNIQUE (user_id, species)
  );
  CREATE TABLE IF NOT EXISTS owned_cosmetics (
    user_id     INTEGER NOT NULL REFERENCES users(id),
    cosmetic_id TEXT NOT NULL REFERENCES cosmetics(id),
    bought_at   BIGINT NOT NULL,
    PRIMARY KEY (user_id, cosmetic_id)
  );
  CREATE TABLE IF NOT EXISTS walk_sessions (
    id                TEXT PRIMARY KEY,
    user_id           INTEGER NOT NULL REFERENCES users(id),
    started_at        BIGINT NOT NULL,
    ended_at          BIGINT,
    last_synced_total INTEGER NOT NULL DEFAULT 0
  );
  -- timestamp is in the key so the table can be a TimescaleDB hypertable.
  CREATE TABLE IF NOT EXISTS step_events (
    id         INTEGER GENERATED BY DEFAULT AS IDENTITY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    session_id TEXT REFERENCES walk_sessions(id),
    timestamp  BIGINT NOT NULL,
    steps      INTEGER NOT NULL CHECK (steps > 0),
    PRIMARY KEY (id, timestamp)
  );
  CREATE INDEX IF NOT EXISTS step_events_user_time ON step_events (user_id, timestamp);
  CREATE TABLE IF NOT EXISTS battles (
    id                INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    challenger_id     INTEGER NOT NULL REFERENCES users(id),
    opponent_id       INTEGER NOT NULL REFERENCES users(id),
    winner_id         INTEGER REFERENCES users(id),
    challenger_damage INTEGER NOT NULL,
    opponent_damage   INTEGER NOT NULL,
    log               TEXT NOT NULL,
    created_at        BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS battles_challenger ON battles (challenger_id, created_at);
  CREATE INDEX IF NOT EXISTS battles_opponent ON battles (opponent_id, created_at);
  CREATE TABLE IF NOT EXISTS friendships (
    user_id    INTEGER NOT NULL REFERENCES users(id),
    friend_id  INTEGER NOT NULL REFERENCES users(id),
    created_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, friend_id),
    CHECK (user_id != friend_id)
  );
  CREATE TABLE IF NOT EXISTS friend_requests (
    from_id    INTEGER NOT NULL REFERENCES users(id),
    to_id      INTEGER NOT NULL REFERENCES users(id),
    created_at BIGINT NOT NULL,
    PRIMARY KEY (from_id, to_id),
    CHECK (from_id != to_id)
  );
  CREATE TABLE IF NOT EXISTS buddy_memory (
    id        INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id   INTEGER NOT NULL REFERENCES users(id),
    situation TEXT NOT NULL,
    reply     TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ready_lines (
    user_id INTEGER NOT NULL REFERENCES users(id),
    event   TEXT NOT NULL,
    text    TEXT NOT NULL,
    speech  TEXT NOT NULL,
    mood    TEXT,
    PRIMARY KEY (user_id, event)
  );
  ALTER TABLE buddies ADD COLUMN IF NOT EXISTS species TEXT NOT NULL DEFAULT 'dragon';
  ALTER TABLE buddies ADD COLUMN IF NOT EXISTS personality TEXT;
  ALTER TABLE ready_lines ADD COLUMN IF NOT EXISTS mood TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
  ALTER TABLE buddies ADD COLUMN IF NOT EXISTS rest_until BIGINT;
  ALTER TABLE resting_buddies ADD COLUMN IF NOT EXISTS rest_until BIGINT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS coins INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0);
`;

// Any number for pg_advisory_xact_lock; all StepBuddy transactions share it.
const TX_LOCK = 7_833_289;

// Returns null (after one warning) if Tiger Data can't be reached within 5s.
async function openTiger(url) {
  let host = 'unknown host';
  let pool;
  try {
    host = new URL(url).hostname;
    const { default: pg } = await import('pg');
    pg.types.setTypeParser(20, Number); // BIGINT and COUNT(*) come back as strings otherwise
    pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
    pool.on('error', (err) => console.error('[db]', err.message));
    let timer;
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out after 5s')), 5000); }),
    ]).finally(() => clearTimeout(timer));
  } catch (err) {
    console.warn(`db: Tiger Data (${host}) unreachable: ${err.message} — using SQLite instead`);
    pool?.end().catch(() => {});
    return null;
  }
  const wrap = (client) => ({
    get: async (sql, params) => (await client.query(toPg(sql, params))).rows[0],
    all: async (sql, params) => (await client.query(toPg(sql, params))).rows,
    run: async (sql, params) => {
      const result = await client.query(toPg(sql, params));
      return { changes: result.rowCount, id: result.rows[0]?.id };
    },
    exec: async (sql) => { await client.query(sql); },
  });
  const db = {
    ...wrap(pool),
    label: `tiger (${host})`,
    // One client for the whole transaction. The advisory lock makes transactions
    // take turns, as BEGIN IMMEDIATE does in SQLite, so reads inside one
    // (balances, last_synced_total) can't go stale before its writes.
    async transaction(fn) {
      const client = await pool.connect();
      let broken;
      try {
        await client.query('BEGIN');
        try {
          await client.query(`SELECT pg_advisory_xact_lock(${TX_LOCK})`);
          const result = await fn(wrap(client));
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK').catch((e) => { broken = e; });
          throw err;
        }
      } finally {
        client.release(broken);
      }
    },
  };
  await db.exec(PG_SCHEMA);
  if (await db.get("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'")) {
    await db.exec(`SELECT create_hypertable('step_events', 'timestamp', chunk_time_interval => ${7 * DAY_MS},
      if_not_exists => TRUE, migrate_data => TRUE)`);
  }
  return db;
}

// App SQL uses ? and :name placeholders; Postgres wants $1, $2, ...
// String literals are left alone.
function toPg(sql, params = []) {
  const named = !Array.isArray(params);
  const values = [];
  const index = new Map();
  const text = sql.replace(/'(?:[^']|'')*'|\?|(?<!:):([A-Za-z_]\w*)/g, (match, name) => {
    if (match === '?') {
      values.push(params[values.length]);
      return `$${values.length}`;
    }
    if (name && named) {
      if (!index.has(name)) index.set(name, values.push(params[name]));
      return `$${index.get(name)}`;
    }
    return match;
  });
  return { text, values };
}

async function seedCosmetics(db) {
  for (const [i, c] of COSMETICS.entries()) {
    await db.run(`
      INSERT INTO cosmetics (id, slot, name, price, sort) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET slot = excluded.slot, name = excluded.name,
        price = excluded.price, sort = excluded.sort
    `, [c.id, c.slot, c.name, c.price, i]);
  }
}

// Nobody plays the demo accounts, so they accept every friend request themselves.
export const isDemoUser = (username) => DEMO_USERS.some((demo) => demo.username === username);

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

async function seedDemoUsers(db) {
  if ((await db.get('SELECT COUNT(*) AS n FROM users')).n > 0) return;
  const now = Date.now();
  await transaction(db, async (tx) => {
    for (const demo of DEMO_USERS) {
      const { id: userId } = await tx.run(
        'INSERT INTO users (username, points, created_at) VALUES (?, ?, ?) RETURNING id',
        [demo.username, demo.points, now - 30 * DAY_MS],
      );
      const eq = demo.equipped;
      await tx.run(`
        INSERT INTO buddies (user_id, name, species, level, attack, evasion, xp, stage, hat, eyewear, accessory, background)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        userId, demo.buddy, demo.species, demo.level, demo.attack, demo.evasion, demo.level * 120,
        stageForLevel(demo.level), eq.hat ?? null, eq.eyewear ?? null, eq.accessory ?? null, eq.background ?? null,
      ]);
      for (const cosmeticId of Object.values(eq)) {
        await tx.run('INSERT INTO owned_cosmetics (user_id, cosmetic_id, bought_at) VALUES (?, ?, ?)',
          [userId, cosmeticId, now]);
      }
      // A month of walks so the demo accounts have charts worth looking at.
      let total = 0;
      for (let daysAgo = 29; daysAgo >= 1; daysAgo--) {
        const wobble = 0.55 + ((userId * 7 + daysAgo * 13) % 10) / 10;
        const steps = Math.round((demo.avgSteps * wobble) / 100) * 100;
        await tx.run('INSERT INTO step_events (user_id, timestamp, steps) VALUES (?, ?, ?)',
          [userId, now - daysAgo * DAY_MS, steps]);
        total += steps;
      }
      await tx.run('UPDATE users SET total_steps = ? WHERE id = ?', [total, userId]);
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

export async function stepsByDay(db, userId, offsetMin) {
  const rows = await db.all(`
    SELECT CAST((timestamp - ?) / ${DAY_MS} AS INTEGER) AS day, SUM(steps) AS steps
    FROM step_events WHERE user_id = ? GROUP BY day
  `, [offsetMin * 60_000, userId]);
  return new Map(rows.map((r) => [r.day, r.steps]));
}

export { STEPS_PER_POINT };

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { GpsFilter, distanceM, bearingDeg, pathLengthM, pointAlong, stepsFromMeters } from '../public/js/geo.js';
import { SPECIES_IDS, buddyPixels, cosmeticIcon } from '../public/js/buddy.js';
import { ELEMENT_BEATS as CLIENT_ELEMENT_BEATS } from '../public/js/elements.js';
import { StepDetector } from '../public/js/steps.js';
import {
  BUDDY_EVENTS, MOOD_STYLES, PERSONALITY_PRESETS, VOICES, allSpeechDone, buddyLine, cleanLine, stripTags,
} from '../server/ai.js';
import { createApp } from '../server/app.js';
import { hashToken } from '../server/auth.js';
import {
  COIN_PACKAGES, COSMETICS, EGGS, ELEMENT_BEATS, MAX_ROUNDS, MOODS, SPECIES, UPSET_MS, canUse, elementOf, matchup, moodFor, newBattle,
  opponentMove, pointsEarned, resolveRound, restAfterLoss, stageForLevel, streakFor, upgradeCosts,
} from '../server/game.js';

test('evolution stages follow level bands', () => {
  assert.deepEqual([1, 4, 5, 9, 10, 19, 20, 50].map(stageForLevel),
    ['egg', 'egg', 'baby', 'baby', 'teen', 'teen', 'adult', 'adult']);
});

test('the rest after a lost battle grows with level and jumps at each evolution', () => {
  assert.equal(restAfterLoss(1), 35_000);
  assert.equal(restAfterLoss(4), 50_000);
  assert.equal(restAfterLoss(5), 85_000);
  assert.equal(restAfterLoss(10), 170_000);
  assert.equal(restAfterLoss(20), 340_000);
  for (let level = 1; level < 30; level++) assert.ok(restAfterLoss(level + 1) > restAfterLoss(level));
});

test('upgrade costs scale with the current value', () => {
  assert.deepEqual(upgradeCosts({ level: 7, attack: 4, evasion: 9 }), { level: 70, attack: 20, evasion: 45 });
});

test('leftover steps carry over between syncs', () => {
  assert.equal(pointsEarned(0, 99), 0);
  assert.equal(pointsEarned(99, 100), 1);
  assert.equal(pointsEarned(150, 420), 3);
});

test('the walking streak only counts today once the goal is hit', () => {
  const byDay = new Map([[7, 6000], [8, 7000], [9, 6500], [10, 100]]);
  assert.equal(streakFor(byDay, 10, 6000), 3);
  assert.equal(streakFor(new Map([...byDay, [10, 6000]]), 10, 6000), 4);
  assert.equal(streakFor(byDay, 12, 6000), 0);
});

test('mood follows walking and battles, first matching rule wins', () => {
  const mood = (week, { streak = 0, lastBattles = [], msSinceLastBattle = Infinity } = {}) =>
    moodFor({ week, goal: 1000, streak, lastBattles, msSinceLastBattle });
  const walked = [500, 500, 500, 500, 500, 500];
  const twoLosses = { lastBattles: ['loss', 'loss'], streak: 5 };
  assert.equal(mood([...walked, 1200], { ...twoLosses, msSinceLastBattle: 60_000 }), 'upset');
  // Being upset wears off a couple of minutes after the last battle.
  assert.equal(mood([...walked, 1200], { ...twoLosses, msSinceLastBattle: UPSET_MS }), 'proud');
  assert.equal(mood([...walked, 1200], { lastBattles: ['win', 'loss'], streak: 5, msSinceLastBattle: 0 }), 'proud');
  assert.equal(mood([...walked, 1200], { lastBattles: ['loss'], msSinceLastBattle: 0 }), 'happy');
  assert.equal(mood([500, 500, 500, 500, 0, 0, 0]), 'lonely');
  assert.equal(mood([...walked, 0]), 'sleepy');
  assert.equal(mood([...walked, 300]), 'eager');
  assert.deepEqual(Object.keys(MOOD_STYLES).sort(), [...MOODS].sort());
});

// A random() that replays a fixed list of numbers, then repeats the last one.
const sequence = (...values) => () => (values.length > 1 ? values.shift() : values[0]);
const fighter = (attack, species = 'golem', evasion = 0) => ({ attack, evasion, species });

test('battle: an attack does attack + 0..3, a guard halves it, both sides act each round', () => {
  const sides = { a: fighter(10), b: fighter(2) };
  const battle = newBattle(sides.a, sides.b);
  assert.equal(battle.hpMax, 5 * (10 + 3));
  // random: a's dodge roll, a's damage roll (0.99 → +3), b's dodge roll, b's damage roll (0 → +0).
  const first = resolveRound(battle, sides, { a: 'attack', b: 'attack' }, sequence(0.5, 0.99, 0.5, 0));
  assert.deepEqual([first.a.damage, first.b.damage], [13, 2]);
  assert.deepEqual(battle.hp, { a: 65 - 2, b: 65 - 13 });
  assert.deepEqual(battle.energy, { a: 1, b: 1 });
  assert.equal(battle.round, 2);

  const guarded = resolveRound(battle, sides, { a: 'attack', b: 'guard' }, sequence(0.5, 0));
  assert.equal(guarded.a.damage, 5);
  assert.equal(guarded.b.damage, 0);
  assert.deepEqual(battle.energy, { a: 2, b: 3 });
});

test('battle: a special costs 2 energy, hits double, ignores dodging and is stopped by a guard', () => {
  const sides = { a: fighter(10), b: fighter(10, 'golem', 50) };
  const battle = newBattle(sides.a, sides.b);
  assert.equal(canUse(battle, 'a', 'special'), false);
  assert.equal(canUse(battle, 'a', 'dance'), false);
  battle.energy.a = 2;
  assert.equal(canUse(battle, 'a', 'special'), true);
  // random() of 0 would make any attack miss a beast with evasion; a special still lands.
  const hit = resolveRound(battle, sides, { a: 'special', b: 'attack' }, () => 0);
  assert.deepEqual([hit.a.damage, hit.a.dodged, battle.energy.a], [20, false, 0]);

  battle.energy.a = 2;
  const blocked = resolveRound(battle, sides, { a: 'special', b: 'guard' }, () => 0);
  assert.deepEqual([blocked.a.damage, blocked.a.blocked, battle.energy.a], [0, true, 0]);
});

test('battle: elements go water > fire > nature > sky > water', () => {
  assert.deepEqual(ELEMENT_BEATS, CLIENT_ELEMENT_BEATS);
  for (const species of SPECIES) assert.ok(elementOf(species) in ELEMENT_BEATS, species);
  assert.deepEqual(['kraken', 'dragon', 'treant', 'griffin'].map(elementOf), ['water', 'fire', 'nature', 'sky']);
  assert.equal(matchup('water', 'fire'), 'strong');
  assert.equal(matchup('fire', 'water'), 'weak');
  assert.equal(matchup('fire', 'sky'), 'even');
  assert.equal(matchup('fire', 'fire'), 'even');

  // Same stats, same rolls: the kraken's hit is 1.5×, the dragon's 0.75×.
  const sides = { a: fighter(10, 'kraken'), b: fighter(10, 'dragon') };
  const round = resolveRound(newBattle(sides.a, sides.b), sides, { a: 'attack', b: 'attack' }, () => 0.5);
  assert.deepEqual([round.a.damage, round.a.effect, round.b.damage, round.b.effect], [18, 'strong', 9, 'weak']);
});

test('battle: runs until a knockout; only a stalemate hits the round cap', () => {
  const sides = { a: fighter(10), b: fighter(2) };
  const battle = newBattle(sides.a, sides.b);
  while (!battle.over) resolveRound(battle, sides, { a: 'attack', b: opponentMove(battle) });
  assert.equal(battle.winner, 'a');
  assert.equal(battle.hp.b, 0);

  // Both still standing after many rounds: the fight goes on.
  const tough = newBattle(fighter(5), fighter(5));
  tough.hpMax = tough.hp.a = tough.hp.b = 1000;
  for (let i = 0; i < 10; i++) resolveRound(tough, { a: fighter(5), b: fighter(5) }, { a: 'attack', b: 'attack' }, () => 0.99);
  assert.deepEqual([tough.over, tough.round], [false, 11]);

  // Everything misses: nobody is hurt and it is a draw at the cap.
  const dodgers = { a: fighter(5, 'golem', 50), b: fighter(5, 'golem', 50) };
  const quiet = newBattle(dodgers.a, dodgers.b);
  for (let i = 0; i < MAX_ROUNDS; i++) resolveRound(quiet, dodgers, { a: 'attack', b: 'attack' }, () => 0);
  assert.deepEqual([quiet.over, quiet.winner, quiet.round], [true, null, MAX_ROUNDS]);

  const knockout = newBattle(fighter(40), fighter(1));
  knockout.hp.b = 3;
  resolveRound(knockout, { a: fighter(40), b: fighter(1) }, { a: 'attack', b: 'attack' }, () => 0.5);
  assert.deepEqual([knockout.over, knockout.winner, knockout.hp.b, knockout.round], [true, 'a', 0, 1]);
});

test('battle: dodge rate is evasion / (evasion + 50)', () => {
  const sides = { a: fighter(1, 'golem', 50), b: fighter(1, 'golem', 50) };
  let dodged = 0;
  const rounds = 20000;
  for (let i = 0; i < rounds; i++) {
    if (resolveRound(newBattle(sides.a, sides.b), sides, { a: 'attack', b: 'guard' }).a.dodged) dodged++;
  }
  assert.ok(Math.abs(dodged / rounds - 0.5) < 0.02);
});

test('battle: the opponent only uses moves it can afford', () => {
  const sides = { a: fighter(1), b: fighter(1) };
  for (let i = 0; i < 200; i++) {
    const battle = newBattle(sides.a, sides.b);
    battle.hp = { a: 1e6, b: 1e6 };
    while (!battle.over) {
      const move = opponentMove(battle);
      assert.ok(canUse(battle, 'b', move));
      resolveRound(battle, sides, { a: 'attack', b: move });
    }
  }
});

test('step detector counts a walking rhythm and ignores a still phone', () => {
  const walking = new StepDetector();
  let steps = 0;
  // 20 seconds at 60Hz, 2 steps per second, ±3 m/s² around gravity.
  for (let i = 0; i < 1200; i++) {
    const t = (i * 1000) / 60;
    if (walking.push(9.81 + 3 * Math.sin((2 * Math.PI * 2 * t) / 1000), t)) steps++;
  }
  assert.ok(steps >= 37 && steps <= 41, `expected about 40 steps, got ${steps}`);

  const still = new StepDetector();
  let phantom = 0;
  for (let i = 0; i < 1200; i++) {
    if (still.push(9.81 + 0.15 * Math.sin(i), (i * 1000) / 60)) phantom++;
  }
  assert.equal(phantom, 0);
});

test('step detector never counts two steps within 250ms', () => {
  const detector = new StepDetector();
  const times = [];
  // 8Hz shaking: far faster than anyone walks.
  for (let i = 0; i < 600; i++) {
    const t = (i * 1000) / 60;
    if (detector.push(9.81 + 6 * Math.sin((2 * Math.PI * 8 * t) / 1000), t)) times.push(t);
  }
  assert.ok(times.length > 0);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 250);
});

// ---------- GPS ----------

const PARK = { lng: -73.99733, lat: 40.73082 };
// Roughly `meters` north of a point.
const north = (point, meters) => ({ lng: point.lng, lat: point.lat + meters / 111_195 });

test('distance, bearing and the step conversion', () => {
  assert.ok(Math.abs(distanceM(PARK, north(PARK, 100)) - 100) < 0.5);
  assert.ok(Math.abs(bearingDeg(PARK, north(PARK, 100))) < 0.01);
  assert.ok(Math.abs(bearingDeg(PARK, { lng: PARK.lng + 0.001, lat: PARK.lat }) - 90) < 0.01);
  assert.equal(stepsFromMeters(1000), 1300);
  assert.equal(stepsFromMeters(100), 130);
});

test('GPS filter counts real movement and ignores wobble', () => {
  const filter = new GpsFilter();
  assert.deepEqual(filter.push(PARK), { accepted: true, meters: 0, teleport: true });
  assert.equal(filter.push(north(PARK, 2)).meters, 0); // standing still
  assert.equal(filter.push(north(PARK, 3)).meters, 0);
  const step = filter.push(north(PARK, 10));
  assert.ok(Math.abs(step.meters - 10) < 0.1);
  assert.ok(Math.abs(filter.push(north(PARK, 30)).meters - 20) < 0.1);
});

test('GPS filter ignores a jump over 50m, then follows if it was real', () => {
  const filter = new GpsFilter();
  filter.push(PARK);
  // A single stray fix 400m away is dropped and walking continues from where we were.
  assert.equal(filter.push(north(PARK, 400)).accepted, false);
  assert.ok(Math.abs(filter.push(north(PARK, 10)).meters - 10) < 0.1);
  // Two fixes in a row far away: we really are there, but none of that distance counts.
  assert.equal(filter.push(north(PARK, 900)).accepted, false);
  assert.deepEqual(filter.push(north(PARK, 905)), { accepted: true, meters: 0, teleport: true });
  assert.ok(Math.abs(filter.push(north(PARK, 915)).meters - 10) < 0.1);
});

test('walking a path point by point covers its whole length', () => {
  const path = [PARK, north(PARK, 100), { lng: PARK.lng + 0.001, lat: north(PARK, 100).lat }];
  const length = pathLengthM(path);
  assert.ok(Math.abs(distanceM(pointAlong(path, 50), north(PARK, 50))) < 0.01);
  assert.deepEqual(pointAlong(path, length + 500), path.at(-1));
});

test('every beast the server accepts has artwork, and the other way round', () => {
  assert.deepEqual([...SPECIES].sort(), [...SPECIES_IDS].sort());
  assert.equal(SPECIES.length, 23);
  for (const species of SPECIES) {
    for (const stage of ['egg', 'baby', 'teen', 'adult']) {
      const equipped = { hat: 'wizard-hat', eyewear: 'monocle', accessory: 'cape' };
      assert.equal(buddyPixels({ species, stage, equipped }).length, 32);
    }
  }
});

// ---------- API ----------

let server;
let base;
let token;
let dbFile;

// auth is a session token: the value of the session cookie the server set.
async function call(method, route, body, auth = token, headers = {}) {
  const res = await fetch(base + route, {
    method,
    headers: {
      'content-type': 'application/json', 'x-wanderling': '1',
      ...(auth ? { cookie: `wl_session=${auth}` } : {}), ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  // For the tests' convenience: the session the server just started, if any.
  const session = /wl_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
  if (session) data.token = session;
  return { status: res.status, data, cookie: res.headers.get('set-cookie') };
}

const PASSWORD = 'walks-4-days';

// A new account with the standard test password.
const signup = (username, extra = {}) => call('POST', '/signup',
  { username, password: PASSWORD, confirmPassword: PASSWORD, ...extra }, null);

const login = (username, password = PASSWORD) => call('POST', '/login', { username, password }, null);

// Signs in as any account, even one with no password (the demo players), by
// writing a session row directly.
function sessionAs(userId) {
  const db = new DatabaseSync(dbFile);
  const session = `test-${userId}-${Math.random().toString(36).slice(2)}`;
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(session), userId, Date.now(), Date.now() + 60_000);
  db.close();
  return session;
}

// Plays a whole battle with one move, returning the final response.
async function fight(opponentId, auth = token, move = 'attack') {
  rested((await call('GET', '/me', null, auth)).data.user.id);
  const start = await call('POST', '/battles', { opponentId }, auth);
  if (start.status !== 200) return start;
  for (;;) {
    const turn = await call('POST', '/battles/move', { battleId: start.data.battle.id, move }, auth);
    if (turn.status !== 200 || turn.data.battle.over) return turn;
  }
}

before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stepbuddy-'));
  dbFile = path.join(dir, 'test.db');
  // The tests sign in far more often than one person would.
  server = await createApp({ dbFile, dataDir: dir, authAttemptsPerIp: 10_000 });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}/api`;
  const first = await signup('walker', { buddyName: 'Nib', species: 'hamster' });
  // The beast is a random egg, whatever the request asks for.
  assert.ok(SPECIES.includes(first.data.buddy.species));
  assert.equal(first.data.buddy.stage, 'egg');
  token = first.data.token;
});

after(() => server.close());

// Skips the rest the player's beast needs after a lost battle.
function rested(userId) {
  const db = new DatabaseSync(dbFile);
  db.prepare('UPDATE buddies SET rest_until = NULL WHERE user_id = ?').run(userId);
  db.close();
}

test('three demo buddies at different stages are seeded', async () => {
  const { data } = await call('GET', '/opponents');
  assert.deepEqual(data.opponents.map((o) => o.stage).sort(), ['adult', 'baby', 'teen']);
  assert.deepEqual(data.opponents.map((o) => o.species).sort(), ['dragon', 'kraken', 'phoenix']);
});

test('signing in again returns the same account', async () => {
  const again = await login('WALKER');
  assert.equal(again.data.buddy.name, 'Nib');

  const eggs = new Set();
  for (let i = 0; i < 12; i++) {
    eggs.add((await signup(`newbie${i}`, { species: 'dragon' })).data.buddy.species);
  }
  assert.ok(eggs.size > 1);
});

test('sign up needs a free username and a password typed twice', async () => {
  assert.equal((await signup('walker')).status, 409);

  assert.equal((await call('GET', '/username?name=fresh', null, null)).data.available, true);
  assert.equal((await call('GET', '/username?name=Walker', null, null)).data.available, false);
  assert.equal((await call('GET', '/username?name=no%20spaces', null, null)).status, 400);

  const tries = {
    short: ['ab1', 'ab1'], noNumber: ['longenough', 'longenough'], noLetter: ['12345678', '12345678'],
    mismatch: [PASSWORD, `${PASSWORD}x`], common: ['password123', 'password123'], same: ['fresh123', 'fresh123'],
  };
  for (const [password, confirmPassword] of Object.values(tries)) {
    const res = await call('POST', '/signup', { username: 'fresh123', password, confirmPassword }, null);
    assert.equal(res.status, 400, password);
  }
  assert.equal((await call('GET', '/username?name=fresh123', null, null)).data.available, true);

  const created = await signup('fresh', { buddyName: 'Ash' });
  assert.equal(created.data.buddy.name, 'Ash');
  const back = await login('fresh');
  assert.equal(back.data.buddy.name, 'Ash');
});

test('passwords are stored only as salted scrypt hashes', async () => {
  const db = new DatabaseSync(dbFile);
  const rows = db.prepare("SELECT password_hash FROM users WHERE username IN ('walker', 'fresh')").all();
  db.close();
  assert.equal(rows.length, 2);
  for (const { password_hash: hash } of rows) {
    assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.ok(!hash.includes(PASSWORD));
  }
  // Same password, different salt, different hash.
  assert.notEqual(rows[0].password_hash, rows[1].password_hash);
});

test('a wrong password or unknown name gets the same answer', async () => {
  const wrong = await login('walker', 'not-the-password-1');
  const nobody = await login('nobody_here');
  assert.deepEqual([wrong.status, nobody.status], [401, 401]);
  assert.equal(wrong.data.error, nobody.data.error);
  assert.equal(wrong.data.token, undefined);
  // Accounts without a password (the demo players) can't be signed into.
  assert.equal((await call('POST', '/login', { username: 'mira', password: '' }, null)).status, 401);
});

test('sessions are HttpOnly, SameSite=Strict cookies that last a year', async () => {
  const { cookie, data } = await login('walker');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=31536000/);
  // Only a hash of the token is stored.
  const db = new DatabaseSync(dbFile);
  const stored = db.prepare('SELECT token_hash, expires_at FROM sessions WHERE token_hash = ?').get(hashToken(data.token));
  assert.equal(db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(data.token), undefined);
  db.close();
  assert.ok(Math.abs(stored.expires_at - (Date.now() + 365 * 86_400_000)) < 60_000);

  // Over HTTPS (behind a proxy) the cookie is Secure and __Host- prefixed.
  const secure = await call('POST', '/login', { username: 'walker', password: PASSWORD }, null, { 'x-forwarded-proto': 'https' });
  assert.match(secure.cookie, /^__Host-wl_session=/);
  assert.match(secure.cookie, /; Secure/);

  // Signing out ends the session for good.
  const out = await call('POST', '/logout', {}, data.token);
  assert.match(out.cookie, /Max-Age=0/);
  assert.equal((await call('GET', '/me', null, data.token)).status, 401);
});

test('an expired session is refused', async () => {
  const { data } = await login('walker');
  const db = new DatabaseSync(dbFile);
  db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() - 1, hashToken(data.token));
  db.close();
  assert.equal((await call('GET', '/me', null, data.token)).status, 401);
});

test('the game is closed to anyone not signed in', async () => {
  for (const [method, route] of [
    ['GET', '/me'], ['GET', '/config'], ['GET', '/store'], ['GET', '/opponents'], ['GET', '/stats'],
    ['POST', '/steps/sync'], ['POST', '/battles'], ['POST', '/talk'], ['PATCH', '/me'],
  ]) {
    assert.equal((await call(method, route, method === 'GET' ? null : {}, null)).status, 401, `${method} ${route}`);
    assert.equal((await call(method, route, method === 'GET' ? null : {}, 'made-up-session')).status, 401);
  }
  // The old Authorization: Bearer tokens no longer open anything.
  assert.equal((await call('GET', '/me', null, null, { authorization: `Bearer ${token}` })).status, 401);
  const tts = await fetch(`${base}/tts/${'a'.repeat(64)}.mp3`);
  assert.equal(tts.status, 401);
});

test('requests from other sites are refused', async () => {
  // No x-wanderling header: what a form on another site would send.
  const res = await fetch(`${base}/buddy/upgrade`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `wl_session=${token}` },
    body: JSON.stringify({ type: 'attack' }),
  });
  assert.equal(res.status, 403);
  const host = new URL(base).host;
  const evil = await call('POST', '/buddy/upgrade', { type: 'attack' }, token, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  const crossSite = await call('POST', '/buddy/upgrade', { type: 'attack' }, token, { 'sec-fetch-site': 'cross-site' });
  assert.equal(crossSite.status, 403);
  // Login can't be forged either.
  assert.equal((await call('POST', '/login', { username: 'walker', password: PASSWORD }, null,
    { origin: 'https://evil.example' })).status, 403);
  // The app's own page is fine.
  const own = await call('GET', '/me', null, token, { origin: `http://${host}`, 'sec-fetch-site': 'same-origin' });
  assert.equal(own.status, 200);
});

test('pages are served with security headers', async () => {
  const res = await fetch(base.replace('/api', '/'));
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('too many wrong passwords lock that username for a while', async () => {
  await signup('target_1');
  for (let i = 0; i < 10; i++) assert.equal((await login('target_1', `wrong-guess-${i}`)).status, 401);
  // Even the right password is refused now.
  assert.equal((await login('target_1')).status, 429);
});

test('an account from before passwords can set one only from its old device', async () => {
  const db = new DatabaseSync(dbFile);
  const { id } = db.prepare("INSERT INTO users (username, created_at) VALUES ('oldtimer', ?) RETURNING id").get(Date.now());
  db.prepare("INSERT INTO buddies (user_id, name) VALUES (?, 'Rusty')").run(id);
  const legacyToken = 'ab'.repeat(24);
  db.prepare('INSERT INTO auth_tokens (token, user_id, created_at) VALUES (?, ?, ?)').run(legacyToken, id, Date.now());
  db.close();
  // No password yet, so it can't be signed into, and the old token opens nothing.
  assert.equal((await login('oldtimer')).status, 401);
  assert.equal((await call('GET', '/me', null, null, { authorization: `Bearer ${legacyToken}` })).status, 401);

  const claim = (body) => call('POST', '/claim', body, null);
  assert.equal((await claim({ legacyToken: 'cd'.repeat(24), password: PASSWORD, confirmPassword: PASSWORD })).status, 403);
  assert.equal((await claim({ legacyToken, password: PASSWORD, confirmPassword: 'nope' })).status, 400);
  const claimed = await claim({ legacyToken, password: PASSWORD, confirmPassword: PASSWORD });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.data.buddy.name, 'Rusty');
  // The old token is used up, and the password now works.
  assert.equal((await claim({ legacyToken, password: PASSWORD, confirmPassword: PASSWORD })).status, 403);
  assert.equal((await login('oldtimer')).status, 200);
});

test('steps are never counted twice', async () => {
  const first = await call('POST', '/steps/sync', { sessionId: 'session-aaaa', total: 2550 });
  assert.equal(first.data.added, 2550);
  assert.equal(first.data.user.points, 25);

  const repeat = await call('POST', '/steps/sync', { sessionId: 'session-aaaa', total: 2550 });
  assert.equal(repeat.data.added, 0);
  assert.equal(repeat.data.user.points, 25);

  const stale = await call('POST', '/steps/sync', { sessionId: 'session-aaaa', total: 1000 });
  assert.equal(stale.data.added, 0);

  const more = await call('POST', '/steps/sync', { sessionId: 'session-aaaa', total: 2600, ended: true });
  assert.equal(more.data.added, 50);
  assert.equal(more.data.user.points, 26);
  assert.equal(more.data.todaySteps, 2600);
});

test('today\'s steps start again from zero each day', async () => {
  const login = (await signup('nightowl')).data;
  const today = async () => (await call('GET', '/me', null, login.token)).data.todaySteps;
  const db = new DatabaseSync(dbFile);
  try {
    db.prepare('INSERT INTO walk_sessions (id, user_id, started_at) VALUES (?, ?, ?)')
      .run('session-night', login.user.id, Date.now() - 86_400_000);
    db.prepare('INSERT INTO step_events (user_id, session_id, timestamp, steps) VALUES (?, ?, ?, ?)')
      .run(login.user.id, 'session-night', Date.now() - 86_400_000, 900);
    assert.equal(await today(), 0); // yesterday's steps don't count towards today
    await call('POST', '/steps/sync', { sessionId: 'session-morning', total: 300 }, login.token);
    assert.equal(await today(), 300);
  } finally {
    db.close();
  }
});

test('a walk session belongs to one user', async () => {
  const other = (await signup('sneaky')).data.token;
  const res = await call('POST', '/steps/sync', { sessionId: 'session-aaaa', total: 9999 }, other);
  assert.equal(res.status, 403);
});

test('upgrades cost points and are refused when short', async () => {
  const up = await call('POST', '/buddy/upgrade', { type: 'level' });
  assert.equal(up.data.cost, 10);
  assert.equal(up.data.buddy.level, 2);
  assert.equal(up.data.user.points, 16);

  const short = await call('POST', '/buddy/upgrade', { type: 'level' });
  assert.equal(short.status, 402);
  assert.equal((await call('GET', '/me')).data.user.points, 16);
});

test('simultaneous spends cannot overdraw the balance', async () => {
  // 16 points: each +1 attack costs 5, then 10 — only some of 6 requests can succeed.
  const results = await Promise.all(
    Array.from({ length: 6 }, () => call('POST', '/buddy/upgrade', { type: 'attack' })),
  );
  const me = (await call('GET', '/me')).data;
  assert.ok(me.user.points >= 0);
  assert.equal(results.filter((r) => r.status === 200).length, me.buddy.attack - 1);
  assert.equal(me.user.points, 16 - 5 - 10);
});

test('store: buy once, equip only what you own', async () => {
  await call('POST', '/steps/sync', { sessionId: 'session-bbbb', total: 2000, ended: true });
  const before = (await call('GET', '/me')).data.user.points;

  const buy = await call('POST', '/store/buy', { itemId: 'party-hat' });
  assert.equal(buy.data.user.points, before - 5);
  assert.ok(buy.data.items.find((i) => i.id === 'party-hat').owned);

  const twice = await call('POST', '/store/buy', { itemId: 'party-hat' });
  assert.equal(twice.status, 409);
  assert.equal((await call('GET', '/me')).data.user.points, before - 5);

  assert.equal((await call('POST', '/store/buy', { itemId: 'crown' })).status, 402);
  assert.equal((await call('POST', '/buddy/equip', { slot: 'hat', itemId: 'crown' })).status, 403);
  assert.equal((await call('POST', '/buddy/equip', { slot: 'eyewear', itemId: 'party-hat' })).status, 400);

  const worn = await call('POST', '/buddy/equip', { slot: 'hat', itemId: 'party-hat' });
  assert.equal(worn.data.buddy.equipped.hat, 'party-hat');
  const off = await call('POST', '/buddy/equip', { slot: 'hat', itemId: null });
  assert.equal(off.data.buddy.equipped.hat, null);
});

test('store: coin packages credit the wallet without trusting the client amount', async () => {
  const before = (await call('GET', '/me')).data.user.coins;
  const list = await call('GET', '/store');
  assert.deepEqual(list.data.coinPackages.map(({ id }) => id), COIN_PACKAGES.map(({ id }) => id));

  const purchase = await call('POST', '/store/buy-coins', { packageId: COIN_PACKAGES[0].id, coins: 999999 });
  assert.equal(purchase.status, 200);
  assert.equal(purchase.data.purchased.coins, COIN_PACKAGES[0].coins);
  assert.equal(purchase.data.user.coins, before + COIN_PACKAGES[0].coins);
  assert.equal((await call('POST', '/store/buy-coins', { packageId: 'unknown' })).status, 404);
});

test('scenes: every one has artwork, and the rare ones cost diamonds only', async () => {
  const scenes = COSMETICS.filter((item) => item.slot === 'background');
  assert.equal(scenes.length, 14);
  for (const scene of scenes) assert.match(cosmeticIcon(scene), /<rect/);
  assert.equal(scenes.filter((scene) => scene.currency === 'diamonds').length, 4);

  const login = (await signup('decorator')).data;
  const auth = login.token;
  await call('POST', '/steps/sync', { sessionId: 'session-decor', total: 20000, ended: true }, auth);
  const listed = (await call('GET', '/store', null, auth)).data.items.find((item) => item.id === 'bg-aurora');
  assert.deepEqual([listed.currency, listed.rarity, listed.price], ['diamonds', 'legendary', 120]);
  assert.equal((await call('GET', '/store', null, auth)).data.items.find((item) => item.id === 'bg-meadow').currency, 'points');

  // 200 Stride Points don't buy a diamond scene.
  assert.equal((await call('POST', '/store/buy', { itemId: 'bg-aurora' }, auth)).status, 402);
  await call('POST', '/store/buy-coins', { packageId: COIN_PACKAGES.find((pack) => pack.coins >= 120).id }, auth);
  const before = (await call('GET', '/me', null, auth)).data.user;
  const bought = (await call('POST', '/store/buy', { itemId: 'bg-aurora' }, auth)).data;
  assert.deepEqual([bought.user.coins, bought.user.points], [before.coins - 120, before.points]);
  const worn = await call('POST', '/buddy/equip', { slot: 'background', itemId: 'bg-aurora' }, auth);
  assert.equal(worn.data.buddy.equipped.background, 'bg-aurora');
});

test('an item can only be worn by one beast at a time', async () => {
  const login = (await signup('dresser')).data;
  const auth = login.token;
  await call('POST', '/steps/sync', { sessionId: 'session-dress', total: 1000, ended: true }, auth);
  await call('POST', '/store/buy', { itemId: 'party-hat' }, auth);
  const db = new DatabaseSync(dbFile);
  db.prepare("INSERT INTO resting_buddies (user_id, name, species) VALUES (?, 'Spare', ?)")
    .run(login.user.id, SPECIES.find((id) => id !== login.buddy.species));
  db.close();
  const wear = (itemId) => call('POST', '/buddy/equip', { slot: 'hat', itemId }, auth);
  const swap = async () => {
    const { resting } = (await call('GET', '/me', null, auth)).data;
    return (await call('POST', '/buddy/switch', { id: resting[0].id }, auth)).data;
  };

  assert.equal((await wear('party-hat')).data.buddy.equipped.hat, 'party-hat');
  // The hat goes home with the beast wearing it, so the other one can't have it.
  assert.equal((await swap()).resting[0].equipped.hat, 'party-hat');
  const refused = await wear('party-hat');
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /is wearing that/);
  // Once the first beast takes it off, it is free again.
  await swap();
  await wear(null);
  await swap();
  assert.equal((await wear('party-hat')).data.buddy.equipped.hat, 'party-hat');
});

test('eggs: rarity sets the currency, a bought egg rests until switched to', async () => {
  assert.equal(EGGS.length, 20);
  for (const egg of EGGS) {
    assert.ok(SPECIES.includes(egg.species));
    assert.equal(egg.currency, ['rare', 'legendary'].includes(egg.rarity) ? 'diamonds' : 'points');
  }
  const joined = await signup('breeder', { buddyName: 'First' });
  const auth = joined.data.token;
  const first = joined.data.buddy.species;
  const store = (await call('GET', '/store', null, auth)).data;
  assert.equal(store.eggs.length, 20);
  assert.equal(store.eggs.filter((egg) => egg.owned).length, EGGS.some((egg) => egg.species === first) ? 1 : 0);

  const forPoints = EGGS.find((egg) => egg.currency === 'points' && egg.species !== first);
  const forDiamonds = EGGS.find((egg) => egg.currency === 'diamonds' && egg.species !== first);
  assert.equal((await call('POST', '/store/buy-egg', { species: forPoints.species }, auth)).status, 402);
  assert.equal((await call('POST', '/store/buy-egg', { species: forDiamonds.species }, auth)).status, 402);
  assert.equal((await call('POST', '/store/buy-egg', { species: 'dragon' }, auth)).status, 404);

  await call('POST', '/steps/sync', { sessionId: 'breeder-walk', total: forPoints.price * 100 }, auth);
  await call('POST', '/store/buy-coins', { packageId: COIN_PACKAGES.at(-1).id }, auth);
  const before = (await call('GET', '/me', null, auth)).data.user;

  const bought = await call('POST', '/store/buy-egg', { species: forPoints.species }, auth);
  assert.equal(bought.data.user.points, before.points - forPoints.price);
  assert.equal(bought.data.user.coins, before.coins);
  assert.equal(bought.data.eggs.find((egg) => egg.species === forPoints.species).owned, true);
  assert.equal(bought.data.buddy.species, first);
  assert.deepEqual(bought.data.resting.map((b) => [b.species, b.stage, b.level]), [[forPoints.species, 'egg', 1]]);
  assert.equal((await call('POST', '/store/buy-egg', { species: forPoints.species }, auth)).status, 409);

  const gem = await call('POST', '/store/buy-egg', { species: forDiamonds.species }, auth);
  assert.equal(gem.data.user.coins, before.coins - forDiamonds.price);
  assert.equal(gem.data.user.points, bought.data.user.points);
  assert.equal(gem.data.resting.length, 2);

  // Switching swaps the two beasts whole: the first one keeps its name and rests.
  const restingId = gem.data.resting[0].id;
  const swapped = await call('POST', '/buddy/switch', { id: restingId }, auth);
  assert.equal(swapped.data.buddy.species, forPoints.species);
  assert.deepEqual(swapped.data.resting.map((b) => b.name).sort(), ['First', gem.data.resting[1].name].sort());
  const back = await call('POST', '/buddy/switch', { id: restingId }, auth);
  assert.equal(back.data.buddy.name, 'First');
  assert.equal(back.data.buddy.species, first);

  assert.equal((await call('POST', '/buddy/switch', { id: 999999 }, auth)).status, 404);
  assert.equal((await call('POST', '/buddy/switch', { id: restingId }, null)).status, 401);
  // Another player's beast can't be taken.
  assert.equal((await call('POST', '/buddy/switch', { id: restingId })).status, 404);
});

test('levelling across a stage boundary evolves the buddy', async () => {
  await call('POST', '/steps/sync', { sessionId: 'session-cccc', total: 20000, ended: true });
  let last;
  for (let level = 2; level < 5; level++) last = await call('POST', '/buddy/upgrade', { type: 'level' });
  assert.equal(last.data.buddy.level, 5);
  assert.equal(last.data.evolvedFrom, 'egg');
  assert.equal(last.data.evolvedTo, 'baby');
});

test('battles are played a move at a time, then recorded and the winner is paid', async () => {
  const before = (await call('GET', '/me')).data;
  const start = (await call('POST', '/battles', { opponentId: 1 })).data.battle;
  assert.deepEqual([start.round, start.rounds, start.over], [1, MAX_ROUNDS, false]);
  assert.deepEqual(start.hp, { a: start.hpMax, b: start.hpMax });
  assert.equal(start.challenger.element, elementOf(before.buddy.species));
  assert.equal(start.matchup, matchup(start.challenger.element, start.opponent.element));
  // Nothing is recorded or paid until the battle ends.
  assert.deepEqual((await call('GET', '/me')).data.record, before.record);

  assert.equal((await call('POST', '/battles/move', { battleId: start.id, move: 'special' })).status, 400);
  assert.equal((await call('POST', '/battles/move', { battleId: start.id, move: 'dance' })).status, 400);
  assert.equal((await call('POST', '/battles/move', { battleId: 'nope', move: 'attack' })).status, 409);

  const first = (await call('POST', '/battles/move', { battleId: start.id, move: 'guard' })).data;
  assert.deepEqual([first.round.number, first.round.a.move, first.round.a.damage], [1, 'guard', 0]);
  assert.equal(first.battle.energy.a, 2);
  assert.equal(first.battle.hp.b, start.hpMax);

  let last = first;
  let rounds = 1;
  while (!last.battle.over) {
    const move = last.battle.energy.a >= 2 ? 'special' : 'attack';
    last = (await call('POST', '/battles/move', { battleId: start.id, move })).data;
    rounds++;
  }
  assert.ok(rounds <= MAX_ROUNDS);
  assert.ok(last.battle.hp.a === 0 || last.battle.hp.b === 0 || rounds === MAX_ROUNDS);
  const { wins, losses, draws } = last.record;
  assert.equal(wins + losses + draws, 1);
  assert.equal(last.user.points, before.user.points + (last.battle.outcome === 'win' ? 5 : 0));
  const history = (await call('GET', '/battles')).data.history;
  assert.equal(history[0].outcome, last.battle.outcome);
  assert.equal((await call('POST', '/battles/move', { battleId: start.id, move: 'attack' })).status, 409);
  assert.equal((await call('POST', '/battles', { opponentId: before.user.id })).status, 400);
});

test('running away, or starting another battle, loses the one in progress', async () => {
  const runner = (await signup('runner')).data.token;
  const first = (await call('POST', '/battles', { opponentId: 1 }, runner)).data.battle;
  const fled = await call('POST', '/battles/forfeit', { battleId: first.id }, runner);
  assert.deepEqual(fled.data.record, { wins: 0, losses: 1, draws: 0 });
  // Forfeiting again, or a battle that isn't running, changes nothing.
  assert.deepEqual((await call('POST', '/battles/forfeit', { battleId: first.id }, runner)).data.record, fled.data.record);

  rested(fled.data.user.id);
  await call('POST', '/battles', { opponentId: 1 }, runner);
  // The battle walked away from is lost, so the next one has to wait.
  assert.equal((await call('POST', '/battles', { opponentId: 2 }, runner)).status, 429);
  assert.equal((await call('GET', '/me', null, runner)).data.record.losses, 2);
});

test('a beast that loses a battle it started rests, longer when bigger, and only that beast', async () => {
  const login = (await signup('sleepyhead')).data;
  const [auth, userId] = [login.token, login.user.id];
  assert.equal(login.buddy.restingUntil, null);
  const db = new DatabaseSync(dbFile);
  const lose = async () => {
    const { battle } = (await call('POST', '/battles', { opponentId: 1 }, auth)).data;
    return (await call('POST', '/battles/forfeit', { battleId: battle.id }, auth)).data;
  };
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 5000, `${actual} vs ${expected}`);
  try {
    const lost = await lose();
    near(lost.buddy.restingUntil - Date.now(), restAfterLoss(1));
    const refused = await call('POST', '/battles', { opponentId: 1 }, auth);
    assert.equal(refused.status, 429);
    assert.match(refused.data.error, /resting.*0:3\d/);
    assert.equal((await call('GET', '/me', null, auth)).data.record.losses, 1);

    // Another beast is fresh: switching to it gets the player straight back in.
    const species = SPECIES.find((id) => id !== login.buddy.species);
    db.prepare("INSERT INTO resting_buddies (user_id, name, species, level, stage) VALUES (?, 'Spare', ?, 12, 'teen')")
      .run(userId, species);
    const spare = (await call('GET', '/me', null, auth)).data.resting[0];
    assert.equal(spare.restingUntil, null);
    const swapped = (await call('POST', '/buddy/switch', { id: spare.id }, auth)).data;
    assert.equal(swapped.buddy.restingUntil, null);
    near(swapped.resting[0].restingUntil - Date.now(), restAfterLoss(1));

    // An evolved beast needs longer, and swapping away mid-battle loses it.
    const { battle } = (await call('POST', '/battles', { opponentId: 1 }, auth)).data;
    const back = (await call('POST', '/buddy/switch', { id: swapped.resting[0].id }, auth)).data;
    assert.equal(back.record.losses, 2);
    assert.equal((await call('POST', '/battles/move', { battleId: battle.id, move: 'attack' }, auth)).status, 409);
    near(back.resting[0].restingUntil - Date.now(), restAfterLoss(12));
    // The first beast is still resting from its own loss.
    assert.equal((await call('POST', '/battles', { opponentId: 1 }, auth)).status, 429);

    // Once the rest is over the beast can fight again.
    rested(userId);
    assert.equal((await call('GET', '/me', null, auth)).data.buddy.restingUntil, null);
    assert.equal((await call('POST', '/battles', { opponentId: 1 }, auth)).status, 200);
  } finally {
    db.close();
  }
});

test('stats report distance, CO2, a 30-day and a 12-month history', async () => {
  const { data } = await call('GET', '/stats');
  assert.equal(data.days.length, 30);
  assert.equal(data.days.at(-1).steps, data.todaySteps);
  // Twelve calendar months in order, ending with this one, where every step was walked.
  assert.equal(data.months.length, 12);
  assert.equal(data.months.at(-1).month, data.days.at(-1).date.slice(0, 7));
  assert.deepEqual(data.months.map((m) => m.month), data.months.map((m) => m.month).sort());
  assert.equal(new Set(data.months.map((m) => m.month)).size, 12);
  assert.deepEqual(data.months.map((m) => m.steps), [...Array(11).fill(0), 24600]);
  assert.equal(data.totalSteps, 24600);
  assert.ok(Math.abs(data.distanceKm - 24600 * 0.762 / 1000) < 1e-9);
  assert.ok(Math.abs(data.co2SavedKg - data.distanceKm * 0.17) < 1e-9);
  assert.equal(data.streak, 1); // today is over the 6,000 goal
});

test('talking works without API keys', async () => {
  const { data } = await call('POST', '/talk', { event: 'chat' });
  assert.ok(data.text.length > 0);
  assert.equal(data.audioUrl, null);
  assert.ok(MOODS.includes((await call('GET', '/me')).data.buddy.mood));
});

test('a buddy gets one personality and keeps it', async () => {
  await call('POST', '/talk', { event: 'chat' });
  const first = (await call('GET', '/me')).data.buddy.personality;
  assert.equal(first.traits.length, 3);
  assert.ok(PERSONALITY_PRESETS.some((p) => p.quirk === first.quirk));
  await call('POST', '/talk', { event: 'chat' });
  assert.deepEqual((await call('GET', '/me')).data.buddy.personality, first);
});

test('players choose a personality at sign-up and can change it', async () => {
  const list = await call('GET', '/personalities', null, null);
  assert.deepEqual(list.data.personalities.map((p) => p.id), PERSONALITY_PRESETS.map((p) => p.id));
  assert.equal(list.data.personalities[0].voice, undefined); // voice and style stay server-side

  const joined = await signup('chooser', { personality: 'sage' });
  const auth = joined.data.token;
  assert.equal(joined.data.buddy.personality.id, 'sage');
  // Returning players keep theirs.
  await call('POST', '/login', { username: 'chooser', password: PASSWORD, personality: 'diva' }, null);
  assert.equal((await call('GET', '/me', null, auth)).data.buddy.personality.id, 'sage');

  await call('POST', '/talk', { event: 'chat' }, auth);
  const db = new DatabaseSync(dbFile);
  const userId = joined.data.user.id;
  db.prepare('INSERT INTO buddy_memory (user_id, situation, reply) VALUES (?, ?, ?)').run(userId, 'hi', 'old voice');

  const changed = await call('PATCH', '/me', { personality: 'coach' }, auth);
  assert.equal(changed.data.buddy.personality.id, 'coach');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM buddy_memory WHERE user_id = ?').get(userId).n, 0);

  const surprise = await call('PATCH', '/me', { personality: 'surprise' }, auth);
  assert.equal(surprise.data.buddy.personality.traits.length, 3);
  assert.equal((await call('PATCH', '/me', { personality: 'nope' }, auth)).status, 400);
  db.close();
});

test('a resting beast can be renamed and given a personality, but only by its owner', async () => {
  const login = (await signup('keeper')).data;
  const auth = login.token;
  const db = new DatabaseSync(dbFile);
  const species = SPECIES.find((id) => id !== login.buddy.species);
  db.prepare("INSERT INTO resting_buddies (user_id, name, species, xp) VALUES (?, 'Spare', ?, 7)").run(login.user.id, species);
  db.close();
  const spare = (await call('GET', '/me', null, auth)).data.resting[0];
  assert.deepEqual([spare.name, spare.xp, spare.personality], ['Spare', 7, null]);

  const edited = (await call('PATCH', '/me', { beastId: spare.id, buddyName: ' Pip ', personality: 'coach' }, auth)).data;
  assert.equal(edited.resting[0].name, 'Pip');
  assert.equal(edited.resting[0].personality.id, 'coach');
  // The beast walking with the player is left alone.
  assert.equal(edited.buddy.name, login.buddy.name);

  assert.equal((await call('PATCH', '/me', { beastId: spare.id, buddyName: ' ' }, auth)).status, 400);
  assert.equal((await call('PATCH', '/me', { beastId: 999999, buddyName: 'X' }, auth)).status, 404);
  assert.equal((await call('PATCH', '/me', { beastId: 'x', buddyName: 'X' }, auth)).status, 404);
  // Another player's beast can't be renamed.
  assert.equal((await call('PATCH', '/me', { beastId: spare.id, buddyName: 'Mine' })).status, 404);
});

test('buddy lines lose emojis and action text but keep audio tags for speech', () => {
  const speech = cleanLine('*giggles* Hi there! 😄 [laughs] Let\'s go 🚶‍♀️ [whisp');
  assert.equal(speech, 'Hi there! [laughs] Let\'s go');
  assert.equal(stripTags(speech), 'Hi there! Let\'s go');
});

test('a military buddy never giggles, even in a happy mood', async () => {
  const realFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  let system;
  globalThis.fetch = async (_url, opts) => {
    system =JSON.parse(opts.body).system_instruction.parts[0].text;
    return Response.json({ candidates: [{ content: { parts: [{ text: '[GIGGLES] Eyes front, [excited] recruit!' }] } }] });
  };
  Object.assign(process.env, { GEMINI_API_KEY: 'test' });
  try {
    const sergeant = PERSONALITY_PRESETS.find((p) => p.id === 'sergeant');
    const buddy = { name: 'Sarge', species: 'dragon', stage: 'adult', personality: sergeant };
    const week = [{ date: 'today', steps: 9000 }];
    const line = await buddyLine({ event: 'chat', buddy, week, goal: 6000, mood: 'happy' });
    assert.equal(line.speech, 'Eyes front, [excited] recruit!');
    assert.match(system, /Never use \[giggles\]/);
    assert.doesNotMatch(system, /e\.g\.[^.]*\[giggles\]/);
  } finally {
    globalThis.fetch = realFetch;
    process.env = savedEnv;
  }
});

test('every preset voice exists and every voice has a preset', () => {
  for (const preset of PERSONALITY_PRESETS) assert.ok(preset.voice in VOICES, preset.voice);
  for (const key of Object.keys(VOICES)) assert.ok(PERSONALITY_PRESETS.some((p) => p.voice === key), key);
});

test('a personality with a removed voice is cleared on startup', async () => {
  await call('POST', '/talk', { event: 'chat' });
  const db = new DatabaseSync(dbFile);
  const userId = (await call('GET', '/me')).data.user.id;
  db.prepare('UPDATE buddies SET personality = ? WHERE user_id = ?')
    .run(JSON.stringify({ ...PERSONALITY_PRESETS[0], voice: 'removed' }), userId);
  await createApp({ dbFile, dataDir: path.dirname(dbFile) });
  assert.equal(db.prepare('SELECT personality FROM buddies WHERE user_id = ?').get(userId).personality, null);
  db.close();
});

test('event lines work without API keys', async () => {
  const { data } = await call('POST', '/talk', { event: 'levelup' });
  assert.equal(data.source, 'builtin');
  assert.ok(data.text.length > 0);
});

test('with keys, text returns before the voice and event lines are prepared ahead', async () => {
  const realFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  let geminiCalls = 0;
  let ttsActive = 0;
  let ttsMaxActive = 0;
  const situations = [];
  const stabilities = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith(base)) return realFetch(url, opts);
    if (String(url).includes('generativelanguage')) {
      geminiCalls++;
      const wantsJson = JSON.parse(opts.body).generationConfig.responseMimeType;
      if (!wantsJson) situations.push(JSON.parse(opts.body).contents.at(-1).parts[0].text);
      const text = wantsJson ? JSON.stringify(PERSONALITY_PRESETS[0]) : `[giggles] Line ${geminiCalls}!`;
      return Response.json({ candidates: [{ content: { parts: [{ text }] } }] });
    }
    stabilities.push(JSON.parse(opts.body).voice_settings.stability);
    ttsMaxActive = Math.max(ttsMaxActive, ++ttsActive); // ElevenLabs
    await sleep(200);
    ttsActive--;
    return new Response(new Uint8Array([1, 2, 3]));
  };
  Object.assign(process.env, { GEMINI_API_KEY: 'test', ELEVENLABS_API_KEY: 'test' });
  const db = new DatabaseSync(dbFile);
  const until = async (check) => {
    for (let i = 0; i < 200 && !check(); i++) await sleep(10);
    assert.ok(check(), 'timed out');
  };
  try {
    const userId = (await call('GET', '/me')).data.user.id;
    const ready = (event) => db.prepare('SELECT text FROM ready_lines WHERE user_id = ? AND event = ?').get(userId, event);

    // The line comes back while its mp3 is still being made; the audio URL waits for it.
    const { data } = await call('POST', '/talk', { event: 'levelup' });
    assert.match(data.text, /^Line \d+!$/);
    assert.equal(existsSync(path.join(path.dirname(dbFile), 'tts', data.audioUrl.slice(9))), false);
    // Voice clips are only for signed-in players too.
    assert.equal((await realFetch(base.slice(0, -4) + data.audioUrl)).status, 401);
    const audio = await realFetch(base.slice(0, -4) + data.audioUrl, { headers: { cookie: `wl_session=${token}` } });
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get('content-type'), 'audio/mpeg');

    // Every event gets a line ready; using one serves it as is and makes the next.
    await until(() => BUDDY_EVENTS.every(ready));
    const prepared = ready('win').text;
    const win = await call('POST', '/talk', { event: 'win' });
    assert.equal(win.data.text, prepared);
    await until(() => ready('win') && ready('win').text !== prepared);

    // Lines are written and voiced in the buddy's current mood.
    const { mood } = (await call('GET', '/me')).data.buddy;
    assert.ok(situations.every((text) => text.startsWith(`Right now you feel ${MOOD_STYLES[mood].feeling}`)));
    assert.ok(stabilities.every((value) => value === MOOD_STYLES[mood].stability));

    // A line prepared in another mood is stale and isn't used.
    db.prepare('UPDATE ready_lines SET mood = ? WHERE user_id = ? AND event = ?').run('other', userId, 'loss');
    const stale = ready('loss').text;
    assert.notEqual((await call('POST', '/talk', { event: 'loss' })).data.text, stale);

    // Never more ElevenLabs requests at once than the plan allows (5), with room to spare.
    assert.ok(ttsMaxActive > 1 && ttsMaxActive <= 3, `max concurrent TTS: ${ttsMaxActive}`);
  } finally {
    await allSpeechDone(); // queued voice jobs must not reach the real ElevenLabs
    globalThis.fetch = realFetch;
    process.env = savedEnv;
    db.close();
  }
});

test('the buddy remembers its last 8 exchanges and sends them as the conversation', async () => {
  const realFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  let replies = 0;
  let lastChat;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith(base)) return realFetch(url, opts);
    const { contents } = JSON.parse(opts.body);
    if (contents.at(-1).parts[0].text.includes('React to the user')) lastChat = contents;
    return Response.json({ candidates: [{ content: { parts: [{ text: `Reply ${++replies}` }] } }] });
  };
  Object.assign(process.env, { GEMINI_API_KEY: 'test' });
  try {
    const said = [];
    for (let i = 0; i < 10; i++) said.push((await call('POST', '/talk', { event: 'chat' })).data.text);
    // The 10th chat saw the 8 exchanges before it: user/model turns, then the new situation.
    assert.equal(lastChat.length, 17);
    assert.deepEqual(lastChat.filter((turn) => turn.role === 'model').map((turn) => turn.parts[0].text), said.slice(1, 9));
    assert.ok(lastChat.slice(0, -1).every((turn, i) => turn.role === (i % 2 ? 'model' : 'user')));
  } finally {
    globalThis.fetch = realFetch;
    process.env = savedEnv;
  }
});

test('a Gemini reply that is only an action or tag falls back to a built-in line', async () => {
  const realFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  globalThis.fetch = async (url, opts) => (String(url).startsWith(base)
    ? realFetch(url, opts)
    : Response.json({ candidates: [{ content: { parts: [{ text: '*giggles* [laughs]' }] } }] }));
  Object.assign(process.env, { GEMINI_API_KEY: 'test' });
  const logged = console.error;
  console.error = () => {}; // the fallback logs why; expected here
  try {
    const { data } = await call('POST', '/talk', { event: 'chat' });
    assert.equal(data.source, 'builtin');
    assert.ok(data.text.length > 0);
  } finally {
    console.error = logged;
    globalThis.fetch = realFetch;
    process.env = savedEnv;
  }
});

test('friends: add by username, mutual, no duplicates, removable', async () => {
  assert.deepEqual((await call('GET', '/friends')).data.friends, []);
  assert.equal((await call('POST', '/friends', { username: 'nobody_here' })).status, 404);
  assert.equal((await call('POST', '/friends', { username: 'walker' })).status, 400);

  // Nobody plays the demo accounts, so they accept on the spot.
  const added = await call('POST', '/friends', { username: '@Mira' });
  assert.equal(added.data.status, 'accepted');
  assert.deepEqual(added.data.friends.map((f) => f.username), ['mira']);
  assert.equal((await call('POST', '/friends', { username: 'mira' })).status, 409);

  // Mira sees us as a friend too.
  const mira = sessionAs(1);
  assert.deepEqual((await call('GET', '/friends', null, mira)).data.friends.map((f) => f.username), ['walker']);
  assert.ok((await call('GET', '/opponents')).data.opponents.find((o) => o.username === 'mira').isFriend);

  // Head-to-head counts only battles between the two of us.
  const outcome = (await fight(1)).data.battle.outcome;
  const record = (await call('GET', '/friends')).data.friends[0].headToHead;
  assert.ok(record.wins + record.losses >= (outcome === 'draw' ? 0 : 1));

  const removed = await call('POST', '/friends/remove', { userId: 1 });
  assert.deepEqual(removed.data.friends, []);
  assert.deepEqual((await call('GET', '/friends', null, mira)).data.friends, []);
});

test('friend requests: sent, then accepted or declined by the other player', async () => {
  const join = async (username) => {
    const { data } = await signup(username);
    return { auth: data.token, id: data.user.id };
  };
  const [asker, picky, eager] = [await join('asker'), await join('picky'), await join('eager')];
  const friends = async (who) => {
    const { data } = await call('GET', '/friends', null, who.auth);
    return Object.fromEntries(['friends', 'incoming', 'outgoing'].map((list) => [list, data[list].map((f) => f.username)]));
  };
  const statusOf = async (who, username) => (await call('GET', '/opponents', null, who.auth))
    .data.opponents.find((o) => o.username === username).friendStatus;

  // Asking doesn't make anyone friends: it waits with the other player.
  const sent = await call('POST', '/friends', { username: 'picky' }, asker.auth);
  assert.equal(sent.data.status, 'requested');
  assert.deepEqual(await friends(asker), { friends: [], incoming: [], outgoing: ['picky'] });
  assert.deepEqual(await friends(picky), { friends: [], incoming: ['asker'], outgoing: [] });
  assert.deepEqual([await statusOf(asker, 'picky'), await statusOf(picky, 'asker')], ['requested', 'incoming']);
  assert.equal((await call('POST', '/friends', { username: 'picky' }, asker.auth)).status, 409);
  assert.equal((await call('GET', '/leaderboard?scope=friends', null, asker.auth)).data.entries.length, 1);

  // Only the player who was asked can answer, and declining leaves no trace.
  assert.equal((await call('POST', '/friends/respond', { userId: picky.id, accept: true }, asker.auth)).status, 404);
  assert.equal((await call('POST', '/friends/respond', { userId: eager.id, accept: true }, picky.auth)).status, 404);
  const declined = await call('POST', '/friends/respond', { userId: asker.id, accept: false }, picky.auth);
  assert.deepEqual([declined.data.friends, declined.data.incoming], [[], []]);
  assert.deepEqual(await friends(asker), { friends: [], incoming: [], outgoing: [] });
  assert.equal(await statusOf(asker, 'picky'), null);

  // Accepting makes it mutual.
  await call('POST', '/friends', { username: 'eager' }, asker.auth);
  const accepted = await call('POST', '/friends/respond', { userId: asker.id, accept: true }, eager.auth);
  assert.deepEqual(accepted.data.friends.map((f) => f.username), ['asker']);
  assert.deepEqual(await friends(asker), { friends: ['eager'], incoming: [], outgoing: [] });
  assert.equal(await statusOf(asker, 'eager'), 'friend');
  assert.equal((await call('POST', '/friends', { username: 'eager' }, asker.auth)).status, 409);

  // A sent request can be taken back, and asking someone who already asked you accepts theirs.
  await call('POST', '/friends', { username: 'picky' }, asker.auth);
  await call('POST', '/friends/remove', { userId: picky.id }, asker.auth);
  assert.deepEqual((await friends(picky)).incoming, []);
  await call('POST', '/friends', { username: 'asker' }, picky.auth);
  assert.equal((await call('POST', '/friends', { username: 'picky' }, asker.auth)).data.status, 'accepted');
  assert.deepEqual(await friends(picky), { friends: ['asker'], incoming: [], outgoing: [] });
});

test('leaderboard ranks by steps, wins or level, for friends or everyone', async () => {
  await call('POST', '/friends', { username: 'ana' });
  const friends = (await call('GET', '/leaderboard?board=level&scope=friends')).data;
  assert.deepEqual(friends.entries.map((e) => e.username), ['ana', 'walker']);
  assert.deepEqual(friends.entries.map((e) => e.rank), [1, 2]);
  assert.equal(friends.entries[1].isMe, true);
  assert.equal(friends.entries[0].value, 22);

  const everyone = (await call('GET', '/leaderboard?board=steps&scope=all')).data;
  assert.ok(everyone.entries.length >= 5);
  const values = everyone.entries.map((e) => e.value);
  assert.deepEqual(values, [...values].sort((a, b) => b - a));
  assert.equal(everyone.entries.find((e) => e.isMe).value, 24600); // everything walked in these tests was today

  const wins = (await call('GET', '/leaderboard?board=wins&scope=all')).data;
  assert.equal(wins.board, 'wins');
  assert.equal((await call('GET', '/leaderboard?board=nonsense')).data.board, 'steps');
});

test('admin: the dashboard API needs the server\'s key, lists every player and gifts currency', async () => {
  const admin = async (method, route, body, key) => {
    const res = await fetch(base + route, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { 'x-admin-key': key } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  const saved = process.env.ADMIN_KEY;
  try {
    // With no key configured there is no admin API at all.
    delete process.env.ADMIN_KEY;
    assert.equal((await admin('GET', '/admin/players', null, 'anything')).status, 404);

    process.env.ADMIN_KEY = 'test-admin-key';
    assert.equal((await admin('GET', '/admin/players')).status, 401);
    assert.equal((await admin('GET', '/admin/players', null, 'test-admin-ke')).status, 401);
    // A player's own session is not an admin key.
    assert.equal((await call('GET', '/admin/players')).status, 401);
    assert.equal((await admin('POST', '/admin/gift', { userId: 1, points: 5 }, 'wrong')).status, 401);

    const { players } = (await admin('GET', '/admin/players', null, 'test-admin-key')).data;
    const me = (await call('GET', '/me')).data;
    const row = players.find((p) => p.id === me.user.id);
    assert.deepEqual(
      [row.username, row.points, row.diamonds, row.totalSteps, row.buddy.name, row.beasts],
      ['walker', me.user.points, me.user.coins, me.user.totalSteps, me.buddy.name, me.resting.length + 1],
    );
    assert.deepEqual([row.wins, row.losses, row.draws], [me.record.wins, me.record.losses, me.record.draws]);
    assert.equal(row.weekSteps, 24600);
    assert.ok(players.find((p) => p.username === 'mira').demo);
    assert.ok(players.length >= 10);

    const gift = (body) => admin('POST', '/admin/gift', body, 'test-admin-key');
    const given = await gift({ userId: me.user.id, points: 250, diamonds: 40 });
    assert.deepEqual([given.data.points, given.data.diamonds], [me.user.points + 250, me.user.coins + 40]);
    assert.equal((await gift({ userId: me.user.id, diamonds: 10 })).data.diamonds, me.user.coins + 50);
    const after = (await call('GET', '/me')).data.user;
    assert.deepEqual([after.points, after.coins], [me.user.points + 250, me.user.coins + 50]);
    const listed = (await admin('GET', '/admin/players', null, 'test-admin-key')).data.players.find((p) => p.id === me.user.id);
    assert.deepEqual(listed.gifted, { points: 250, diamonds: 50 });

    for (const bad of [
      { userId: me.user.id }, { userId: me.user.id, points: 0, diamonds: 0 },
      { userId: me.user.id, points: 1.5 }, { userId: me.user.id, diamonds: 1_000_001 }, { userId: me.user.id, points: 'lots' },
    ]) {
      assert.equal((await gift(bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await gift({ userId: 999999, points: 5 })).status, 404);
    assert.equal((await gift({ userId: '1 OR 1=1', points: 5 })).status, 404);
    assert.deepEqual((await call('GET', '/me')).data.user.points, me.user.points + 250);

    // A negative amount takes currency back, but never below zero.
    assert.equal((await gift({ userId: me.user.id, points: -50, diamonds: -10 })).data.points, me.user.points + 200);
    assert.equal((await gift({ userId: me.user.id, diamonds: -1_000_000 })).status, 409);
    assert.equal((await call('GET', '/me')).data.user.coins, me.user.coins + 40);

    // The dashboard itself is a separate little site under /admin/.
    const page = await fetch(base.replace('/api', '/admin/'));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Wanderling Admin/);
    assert.equal((await fetch(base.replace('/api', '/admin/admin.js'))).status, 200);
    assert.equal((await fetch(base.replace('/api', '/admin/..%2Fserver%2Fapp.js'))).status, 404);
  } finally {
    if (saved === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = saved;
  }
});

test('admin: fixing accounts, handing things out, tuning the game, and a log of it all', async () => {
  const saved = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = 'test-admin-key';
  const admin = async (method, route, body) => {
    const res = await fetch(base + route, {
      method, headers: { 'content-type': 'application/json', 'x-admin-key': 'test-admin-key' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  const join = async (username) => {
    const { data } = await signup(username);
    return { auth: data.token, id: data.user.id, species: data.buddy.species };
  };
  try {
    const [rule, bystander] = [await join('rulebreaker'), await join('bystander')];
    const detail = async (who = rule) => (await admin('GET', `/admin/player?id=${who.id}`)).data;
    assert.equal((await admin('GET', '/admin/player?id=999999')).status, 404);

    // Handing out an item and a beast, once each.
    const catalog = (await admin('GET', '/admin/catalog')).data;
    assert.equal(catalog.items.length, COSMETICS.length);
    assert.equal((await admin('POST', '/admin/give-item', { userId: rule.id, itemId: 'crown' })).status, 200);
    assert.equal((await admin('POST', '/admin/give-item', { userId: rule.id, itemId: 'crown' })).status, 409);
    assert.equal((await admin('POST', '/admin/give-item', { userId: rule.id, itemId: 'nope' })).status, 404);
    const spare = SPECIES.find((id) => id !== rule.species);
    assert.equal((await admin('POST', '/admin/give-beast', { userId: rule.id, species: spare })).status, 200);
    assert.equal((await admin('POST', '/admin/give-beast', { userId: rule.id, species: spare })).status, 409);
    assert.equal((await admin('POST', '/admin/give-beast', { userId: rule.id, species: rule.species })).status, 409);
    assert.equal((await call('POST', '/buddy/equip', { slot: 'hat', itemId: 'crown' }, rule.auth)).status, 200);

    // Fixing a beast: stats, name, and a rest that should be over.
    const lost = (await call('POST', '/battles', { opponentId: 1 }, rule.auth)).data.battle;
    await call('POST', '/battles/forfeit', { battleId: lost.id }, rule.auth);
    assert.ok((await detail()).beasts[0].restingUntil);
    await admin('POST', '/admin/beast', { userId: rule.id, clearRest: true, level: 12, attack: 9, name: ' Fixed ' });
    const fixed = (await call('GET', '/me', null, rule.auth)).data.buddy;
    assert.deepEqual([fixed.name, fixed.level, fixed.stage, fixed.attack, fixed.restingUntil], ['Fixed', 12, 'teen', 9, null]);
    const restingId = (await detail()).beasts[1].id;
    await admin('POST', '/admin/beast', { userId: rule.id, beastId: restingId, evasion: 7 });
    assert.equal((await detail()).beasts[1].evasion, 7);
    assert.equal((await admin('POST', '/admin/beast', { userId: rule.id, level: 101 })).status, 400);
    assert.equal((await admin('POST', '/admin/beast', { userId: bystander.id, beastId: restingId, level: 2 })).status, 404);
    assert.equal((await admin('POST', '/admin/beast', { userId: rule.id })).status, 400);

    // The detail view gathers it all.
    const seen = await detail();
    assert.deepEqual(seen.items.map((item) => item.id), ['crown']);
    assert.deepEqual([seen.beasts.length, seen.battles[0].outcome, seen.battles[0].other], [2, 'loss', 'mira']);
    assert.ok(seen.log.some((entry) => entry.action === 'beast' && /level 1 to 12/.test(entry.detail)));

    // A walk reported faster than anyone walks is flagged; an honest one isn't.
    await call('POST', '/steps/sync', { sessionId: 'session-honest', total: 80 }, bystander.auth);
    await call('POST', '/steps/sync', { sessionId: 'session-cheat', total: 50 }, rule.auth);
    await call('POST', '/steps/sync', { sessionId: 'session-cheat', total: 90_050 }, rule.auth);
    const { flags } = (await admin('GET', '/admin/suspicious')).data;
    assert.ok(flags.some((flag) => flag.userId === rule.id && flag.steps === 90_000 && flag.points === 900));
    assert.ok(!flags.some((flag) => flag.userId === bystander.id));
    const rows = (await admin('GET', '/admin/players')).data.players;
    assert.ok(rows.find((p) => p.id === rule.id).flags >= 1);
    assert.equal(rows.find((p) => p.id === bystander.id).flags, 0);

    // Renaming: valid, free names only.
    assert.equal((await admin('POST', '/admin/rename', { userId: rule.id, username: 'bystander' })).status, 409);
    assert.equal((await admin('POST', '/admin/rename', { userId: rule.id, username: 'no spaces' })).status, 400);
    assert.equal((await admin('POST', '/admin/rename', { userId: 1, username: 'not_mira' })).status, 409);
    assert.equal((await admin('POST', '/admin/rename', { userId: rule.id, username: 'reformed' })).status, 200);
    assert.equal((await call('GET', '/me', null, rule.auth)).data.user.username, 'reformed');

    // Signing out everywhere ends the session but the account still works.
    assert.equal((await admin('POST', '/admin/signout', { userId: rule.id })).data.sessions, 1);
    assert.equal((await call('GET', '/me', null, rule.auth)).status, 401);
    rule.auth = (await login('reformed')).data.token;

    // Suspending signs them out, keeps them out and hides them from other players.
    const listed = async () => (await call('GET', '/opponents', null, bystander.auth)).data.opponents.some((o) => o.username === 'reformed');
    assert.equal(await listed(), true);
    assert.equal((await admin('POST', '/admin/suspend', { userId: rule.id, suspended: true })).status, 200);
    assert.equal((await call('GET', '/me', null, rule.auth)).status, 401);
    const refused = await login('reformed');
    assert.deepEqual([refused.status, refused.data.error], [403, 'This account is suspended']);
    assert.equal(await listed(), false);
    assert.ok(!(await call('GET', '/leaderboard?scope=all', null, bystander.auth)).data.entries.some((e) => e.username === 'reformed'));
    assert.equal((await admin('POST', '/admin/suspend', { userId: 1, suspended: true })).status, 409);
    await admin('POST', '/admin/suspend', { userId: rule.id, suspended: false });
    rule.auth = (await login('reformed')).data.token;
    assert.equal(await listed(), true);

    // A gift to everyone skips demo accounts unless asked.
    const before = (await admin('GET', '/admin/players')).data.players;
    const all = (await admin('POST', '/admin/gift-all', { points: 7 })).data;
    assert.equal(all.players, before.filter((p) => !p.demo).length);
    const after = (await admin('GET', '/admin/players')).data.players;
    for (const p of before) assert.equal(after.find((a) => a.id === p.id).points, p.points + (p.demo ? 0 : 7), p.username);
    assert.equal((await admin('POST', '/admin/gift-all', { points: -7 })).status, 400);

    // Settings change the game at once and go back to their defaults.
    const settings = (await admin('GET', '/admin/settings')).data.settings;
    assert.ok(settings.every((rule) => rule.value === rule.default && !rule.changed));
    await admin('POST', '/admin/settings', { name: 'price.party-hat', amount: 3 });
    await admin('POST', '/admin/settings', { name: 'battleWinBonus', amount: 12 });
    await admin('POST', '/admin/settings', { name: 'rest.egg', amount: 600 });
    await admin('POST', '/admin/settings', { name: 'egg.kappa', amount: 1 });
    const store = (await call('GET', '/store', null, bystander.auth)).data;
    assert.equal(store.items.find((item) => item.id === 'party-hat').price, 3);
    assert.equal(store.eggs.find((egg) => egg.species === 'kappa').price, 1);
    const wallet = (await call('GET', '/me', null, bystander.auth)).data;
    assert.equal(wallet.rules.battleWinBonus, 12);
    assert.equal((await call('POST', '/store/buy', { itemId: 'party-hat' }, bystander.auth)).data.user.points, wallet.user.points - 3);
    const battle = (await call('POST', '/battles', { opponentId: 1 }, bystander.auth)).data.battle;
    const fled = (await call('POST', '/battles/forfeit', { battleId: battle.id }, bystander.auth)).data;
    assert.ok(Math.abs(fled.buddy.restingUntil - Date.now() - 605_000) < 5000);
    assert.equal((await admin('POST', '/admin/settings', { name: 'battleWinBonus', amount: -1 })).status, 400);
    assert.equal((await admin('POST', '/admin/settings', { name: 'battleWinBonus', amount: 2.5 })).status, 400);
    assert.equal((await admin('POST', '/admin/settings', { name: 'nonsense', amount: 1 })).status, 404);
    assert.equal((await admin('POST', '/admin/settings', { name: 'constructor', amount: 1 })).status, 404);
    for (const name of ['price.party-hat', 'battleWinBonus', 'rest.egg', 'egg.kappa']) {
      assert.equal((await admin('POST', '/admin/settings', { name, amount: null })).data.setting.changed, false);
    }
    assert.equal((await call('GET', '/store', null, bystander.auth)).data.items.find((item) => item.id === 'party-hat').price, 5);

    // Activity and the economy add up.
    const { days } = (await admin('GET', '/admin/activity')).data;
    assert.equal(days.length, 30);
    assert.ok(days.at(-1).signups >= 2 && days.at(-1).steps >= 90_130 && days.at(-1).walkers >= 2 && days.at(-1).battles >= 2);
    const economy = (await admin('GET', '/admin/economy')).data;
    const everyone = (await admin('GET', '/admin/players')).data.players;
    assert.equal(economy.held.points, everyone.reduce((sum, p) => sum + p.points, 0));
    assert.ok(economy.items.find((item) => item.id === 'crown').owned >= 1);
    assert.ok(economy.gifted.points >= 7);

    // Deleting needs the username typed, then removes every trace.
    assert.equal((await admin('POST', '/admin/delete', { userId: rule.id, confirm: 'wrong' })).status, 400);
    assert.equal((await admin('POST', '/admin/delete', { userId: 1, confirm: 'mira' })).status, 409);
    assert.equal((await admin('POST', '/admin/delete', { userId: rule.id, confirm: 'Reformed' })).status, 200);
    assert.equal((await call('GET', '/me', null, rule.auth)).status, 401);
    assert.equal((await admin('GET', `/admin/player?id=${rule.id}`)).status, 404);
    assert.equal(await listed(), false);
    const db = new DatabaseSync(dbFile);
    for (const [table, column] of [['buddies', 'user_id'], ['resting_buddies', 'user_id'], ['step_events', 'user_id'],
      ['battles', 'challenger_id'], ['owned_cosmetics', 'user_id'], ['sessions', 'user_id']]) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(rule.id).n, 0, table);
    }
    db.close();
    // The name is free again, as a brand new player.
    assert.equal((await signup('reformed')).data.user.totalSteps, 0);

    // Everything above was written down.
    const actions = (await admin('GET', '/admin/log')).data.entries.map((entry) => entry.action);
    for (const action of ['give-item', 'give-beast', 'beast', 'rename', 'signout', 'suspend', 'unsuspend', 'gift-all', 'setting', 'delete']) {
      assert.ok(actions.includes(action), action);
    }
    const deleted = (await admin('GET', '/admin/log')).data.entries.find((entry) => entry.action === 'delete');
    assert.equal(deleted.username, 'reformed');
  } finally {
    if (saved === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = saved;
  }
});

test('admin: an announcement reaches every player until it ends or is stopped', async () => {
  const saved = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = 'test-admin-key';
  const admin = async (method, route, body) => {
    const res = await fetch(base + route, {
      method, headers: { 'content-type': 'application/json', 'x-admin-key': 'test-admin-key' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  const seen = async () => (await call('GET', '/me')).data.announcement;
  try {
    assert.equal(await seen(), null);
    assert.equal((await admin('POST', '/admin/announce', { message: '   ' })).status, 400);
    assert.equal((await admin('POST', '/admin/announce', { message: 'x'.repeat(301) })).status, 400);
    assert.equal((await admin('POST', '/admin/announce', { message: 'hi', hours: 0 })).status, 400);
    assert.equal((await call('POST', '/admin/announce', { message: 'I am a player' })).status, 401);

    assert.equal((await admin('POST', '/admin/announce', { message: ' Double points this weekend! ', hours: 24 })).status, 200);
    const first = await seen();
    assert.equal(first.message, 'Double points this weekend!');
    // Every player gets it, in every answer that carries their state.
    const other = (await signup('latecomer')).data;
    assert.equal(other.announcement.id, first.id);

    // A newer one takes its place; stopping that brings the older one back.
    await admin('POST', '/admin/announce', { message: '<b>Maintenance</b> at noon' });
    const second = await seen();
    assert.ok(second.id > first.id);
    assert.equal(second.message, '<b>Maintenance</b> at noon');
    const { announcements } = (await admin('GET', '/admin/announcements')).data;
    assert.deepEqual(announcements.slice(0, 2).map((a) => [a.id, a.active, a.expiresAt === null]),
      [[second.id, true, true], [first.id, true, false]]);
    assert.equal((await admin('POST', '/admin/announce/stop', { id: second.id })).status, 200);
    assert.equal((await seen()).id, first.id);
    assert.equal((await admin('POST', '/admin/announce/stop', { id: 999999 })).status, 404);

    // One that has run its time is no longer shown.
    const db = new DatabaseSync(dbFile);
    db.prepare('UPDATE announcements SET expires_at = ? WHERE id = ?').run(Date.now() - 1, first.id);
    db.close();
    assert.equal(await seen(), null);
    assert.ok((await admin('GET', '/admin/announcements')).data.announcements.every((a) => !a.active));
  } finally {
    if (saved === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = saved;
  }
});

test('admin: players whose app called in recently show as online', async () => {
  const saved = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = 'test-admin-key';
  try {
    const here = (await signup('present')).data;
    await call('GET', '/me', null, here.token);
    const players = (await (await fetch(`${base}/admin/players`, { headers: { 'x-admin-key': 'test-admin-key' } })).json()).players;
    const row = players.find((p) => p.id === here.user.id);
    assert.equal(row.online, true);
    assert.ok(Date.now() - row.lastSeen < 5000);
    // Nobody is playing the demo accounts.
    const theo = players.find((p) => p.username === 'theo');
    assert.deepEqual([theo.online, theo.lastSeen], [false, null]);
    // The time is also written down, so it survives a restart.
    const db = new DatabaseSync(dbFile);
    assert.ok(db.prepare('SELECT last_seen FROM users WHERE id = ?').get(here.user.id).last_seen > 0);
    db.close();
  } finally {
    if (saved === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = saved;
  }
});

test('demo shortcuts are only offered when the server runs in demo mode', async () => {
  const saved = process.env.DEMO_MODE;
  try {
    delete process.env.DEMO_MODE;
    assert.equal((await call('GET', '/me')).data.demo, false);
    process.env.DEMO_MODE = 'yes'; // only exactly 1 turns it on
    assert.equal((await call('GET', '/me')).data.demo, false);
    process.env.DEMO_MODE = '1';
    assert.equal((await call('GET', '/me')).data.demo, true);
  } finally {
    if (saved === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = saved;
  }
});

test('the map key comes from the server environment', async () => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  assert.equal((await call('GET', '/config')).data.googleMapsKey, 'test-key');
  delete process.env.GOOGLE_MAPS_API_KEY;
  assert.equal((await call('GET', '/config')).data.googleMapsKey, null);
  assert.equal((await call('GET', '/config', null, null)).status, 401);
});

test('nearby: friends anywhere who let friends see them, nearest first', async () => {
  const park = { lat: 40.73082, lng: -73.99733 };
  const signUp = async (username) => (await signup(username, { buddyName: 'Pal' })).data;
  const near = await signUp('near_walker');
  const far = await signUp('far_walker');
  const stale = await signUp('stale_walker');
  const stranger = await signUp('stranger');
  // A friend request only counts once they accept it.
  const me = (await call('GET', '/me')).data.user;
  const befriend = async (other) => {
    await call('POST', '/friends', { username: other.user.username });
    await call('POST', '/friends/respond', { userId: me.id, accept: true }, other.token);
  };
  for (const other of [near, far, stale]) await befriend(other);

  assert.equal((await call('POST', '/location', { lat: 91, lng: 0 })).status, 400);
  assert.equal((await call('POST', '/location', { lat: 'x', lng: 0 })).status, 400);
  // Nothing shared yet: you see nobody.
  assert.deepEqual((await call('GET', '/nearby')).data.players, []);

  await call('POST', '/location', park);
  await call('POST', '/location', { lat: park.lat + 0.0027, lng: park.lng }, near.token); // ~300m north
  await call('POST', '/location', { lat: park.lat + 0.045, lng: park.lng }, far.token); // ~5km north
  await call('POST', '/location', { lat: park.lat, lng: park.lng + 0.001 }, stale.token);
  await call('POST', '/location', { lat: park.lat, lng: park.lng + 0.0005 }, stranger.token);
  new DatabaseSync(dbFile).prepare('UPDATE locations SET updated_at = ? WHERE user_id = ?')
    .run(Date.now() - 3 * 60_000, stale.user.id);

  const usernames = async (route = '/nearby') => (await call('GET', route)).data.players.map((p) => p.username).sort();
  const { players } = (await call('GET', '/nearby')).data;
  // Not the stranger, however close; the far friend too, after the near one.
  assert.deepEqual(players.map((p) => p.username), ['near_walker', 'far_walker']);
  assert.ok(Math.abs(players[0].distanceM - 300) < 10);
  assert.ok(Math.abs(players[1].distanceM - 5000) < 50);
  assert.equal(players[0].buddy.name, 'Pal');

  // Becoming friends puts the stranger on the map.
  await befriend(stranger);
  assert.deepEqual(await usernames(), ['far_walker', 'near_walker', 'stranger']);

  // Hidden players vanish at once and stay off friends' maps.
  assert.equal((await call('PATCH', '/me', { mapVisible: 'x' }, stranger.token)).status, 400);
  const hidden = await call('PATCH', '/me', { mapVisible: false }, stranger.token);
  assert.equal(hidden.data.user.mapVisible, false);
  assert.deepEqual(await usernames(), ['far_walker', 'near_walker']);
  await call('POST', '/location', { lat: park.lat, lng: park.lng + 0.0005 }, stranger.token);
  assert.deepEqual(await usernames(), ['far_walker', 'near_walker']);

  // Demo mode adds only the seeded buddies you are friends with.
  await call('POST', '/friends', { username: 'ana' }); // 409 if already friends; either way, friends
  const demoFriends = (await call('GET', '/friends')).data.friends
    .map((f) => f.username).filter((name) => ['mira', 'theo', 'ana'].includes(name));
  assert.ok(demoFriends.includes('ana') && demoFriends.length < 3, `demo friends: ${demoFriends}`);
  const demo = (await call('GET', '/nearby?demo=1')).data.players;
  assert.deepEqual(demo.map((p) => p.username).sort(), [...demoFriends, 'far_walker', 'near_walker'].sort());
  for (const p of demo) assert.equal(Boolean(p.demo), !p.username.endsWith('_walker')); // only seeded buddies pace

  // Friends who stop walking stay on the map while their position is fresh.
  await call('POST', '/steps/sync', { sessionId: 'near-walk-0001', total: 0, ended: true }, near.token);
  assert.deepEqual(await usernames(), ['far_walker', 'near_walker']);
});

test('a player profile shows their buddy and record', async () => {
  const mira = (await call('GET', '/opponents')).data.opponents.find((o) => o.username === 'mira');
  const { status, data } = await call('GET', `/player?id=${mira.userId}`);
  assert.equal(status, 200);
  assert.equal(data.username, 'mira');
  assert.equal(data.buddy.species, 'phoenix');
  assert.deepEqual(Object.keys(data.record).sort(), ['draws', 'losses', 'wins']);
  assert.equal(typeof data.isFriend, 'boolean');
  assert.equal((await call('GET', '/player?id=99999')).status, 404);
  assert.equal((await call('GET', '/player?id=abc')).status, 404);
});

test('requests without a session are rejected', async () => {
  assert.equal((await call('GET', '/me', null, null)).status, 401);
});

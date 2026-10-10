import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { GpsFilter, distanceM, bearingDeg, pathLengthM, pointAlong, stepsFromMeters } from '../public/js/geo.js';
import { StepDetector } from '../public/js/steps.js';
import { createApp } from '../server/app.js';
import { pointsEarned, resolveBattle, stageForLevel, upgradeCosts } from '../server/game.js';

test('evolution stages follow level bands', () => {
  assert.deepEqual([1, 4, 5, 9, 10, 19, 20, 50].map(stageForLevel),
    ['egg', 'egg', 'baby', 'baby', 'teen', 'teen', 'adult', 'adult']);
});

test('upgrade costs scale with the current value', () => {
  assert.deepEqual(upgradeCosts({ level: 7, attack: 4, evasion: 9 }), { level: 70, attack: 20, evasion: 45 });
});

test('leftover steps carry over between syncs', () => {
  assert.equal(pointsEarned(0, 99), 0);
  assert.equal(pointsEarned(99, 100), 1);
  assert.equal(pointsEarned(150, 420), 3);
});

test('battle: 5 rounds, one attack each, damage = attack + 0..3, dodges do nothing', () => {
  const a = { attack: 10, evasion: 0 };
  const b = { attack: 2, evasion: 0 };
  const result = resolveBattle(a, b);
  assert.equal(result.log.length, 10);
  for (const turn of result.log) {
    const attack = turn.attacker === 'a' ? 10 : 2;
    assert.ok(!turn.dodged && turn.damage >= attack && turn.damage <= attack + 3);
  }
  assert.equal(result.winner, 'a');
  assert.equal(result.totals.a, result.log.filter((t) => t.attacker === 'a').reduce((s, t) => s + t.damage, 0));

  // random() always 0 is below any positive dodge chance, so everything misses.
  const allMiss = resolveBattle({ attack: 5, evasion: 50 }, { attack: 5, evasion: 50 }, () => 0);
  assert.ok(allMiss.log.every((t) => t.dodged && t.damage === 0));
  assert.equal(allMiss.winner, null);
});

test('battle: dodge rate is evasion / (evasion + 50)', () => {
  let dodged = 0;
  let turns = 0;
  for (let i = 0; i < 4000; i++) {
    for (const turn of resolveBattle({ attack: 1, evasion: 50 }, { attack: 1, evasion: 50 }).log) {
      turns++;
      if (turn.dodged) dodged++;
    }
  }
  assert.ok(Math.abs(dodged / turns - 0.5) < 0.02);
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

// ---------- API ----------

let server;
let base;
let token;

async function call(method, route, body, auth = token) {
  const res = await fetch(base + route, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stepbuddy-'));
  server = createApp({ dbFile: path.join(dir, 'test.db'), dataDir: dir });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}/api`;
  const login = await call('POST', '/login', { username: 'walker', buddyName: 'Nib', species: 'kraken' }, null);
  assert.equal(login.data.buddy.species, 'kraken');
  token = login.data.token;
});

after(() => server.close());

test('three demo buddies at different stages are seeded', async () => {
  const { data } = await call('GET', '/opponents');
  assert.deepEqual(data.opponents.map((o) => o.stage).sort(), ['adult', 'baby', 'teen']);
  assert.deepEqual(data.opponents.map((o) => o.species).sort(), ['dragon', 'kraken', 'phoenix']);
});

test('signing in again returns the same account', async () => {
  const again = await call('POST', '/login', { username: 'WALKER' }, null);
  assert.equal(again.data.buddy.name, 'Nib');

  const unknown = await call('POST', '/login', { username: 'newbie', species: 'hamster' }, null);
  assert.equal(unknown.data.buddy.species, 'dragon');
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

test('a walk session belongs to one user', async () => {
  const other = (await call('POST', '/login', { username: 'sneaky' }, null)).data.token;
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

test('levelling across a stage boundary evolves the buddy', async () => {
  await call('POST', '/steps/sync', { sessionId: 'session-cccc', total: 20000, ended: true });
  let last;
  for (let level = 2; level < 5; level++) last = await call('POST', '/buddy/upgrade', { type: 'level' });
  assert.equal(last.data.buddy.level, 5);
  assert.equal(last.data.evolvedFrom, 'egg');
  assert.equal(last.data.evolvedTo, 'baby');
});

test('battles are recorded and the winner is paid', async () => {
  const before = (await call('GET', '/me')).data;
  const { data } = await call('POST', '/battles', { opponentId: 1 });
  assert.equal(data.battle.log.length, 10);
  const { wins, losses, draws } = data.record;
  assert.equal(wins + losses + draws, 1);
  assert.equal(data.user.points, before.user.points + (data.battle.outcome === 'win' ? 5 : 0));
  const history = (await call('GET', '/battles')).data.history;
  assert.equal(history[0].outcome, data.battle.outcome);
  assert.equal((await call('POST', '/battles', { opponentId: before.user.id })).status, 400);
});

test('stats report distance, CO2 and a 30-day history', async () => {
  const { data } = await call('GET', '/stats');
  assert.equal(data.days.length, 30);
  assert.equal(data.days.at(-1).steps, data.todaySteps);
  assert.equal(data.totalSteps, 24600);
  assert.ok(Math.abs(data.distanceKm - 24600 * 0.762 / 1000) < 1e-9);
  assert.ok(Math.abs(data.co2SavedKg - data.distanceKm * 0.17) < 1e-9);
  assert.equal(data.streak, 1); // today is over the 6,000 goal
});

test('talking works without API keys', async () => {
  const { data } = await call('POST', '/talk', { event: 'chat' });
  assert.ok(data.text.length > 0);
  assert.equal(data.audioUrl, null);
});

test('friends: add by username, mutual, no duplicates, removable', async () => {
  assert.deepEqual((await call('GET', '/friends')).data.friends, []);
  assert.equal((await call('POST', '/friends', { username: 'nobody_here' })).status, 404);
  assert.equal((await call('POST', '/friends', { username: 'walker' })).status, 400);

  const added = await call('POST', '/friends', { username: '@Mira' });
  assert.deepEqual(added.data.friends.map((f) => f.username), ['mira']);
  assert.equal((await call('POST', '/friends', { username: 'mira' })).status, 409);

  // Mira sees us as a friend too.
  const mira = (await call('POST', '/login', { username: 'mira' }, null)).data.token;
  assert.deepEqual((await call('GET', '/friends', null, mira)).data.friends.map((f) => f.username), ['walker']);
  assert.ok((await call('GET', '/opponents')).data.opponents.find((o) => o.username === 'mira').isFriend);

  // Head-to-head counts only battles between the two of us.
  const fight = (await call('POST', '/battles', { opponentId: 1 })).data.battle.outcome;
  const record = (await call('GET', '/friends')).data.friends[0].headToHead;
  assert.ok(record.wins + record.losses >= (fight === 'draw' ? 0 : 1));

  const removed = await call('POST', '/friends/remove', { userId: 1 });
  assert.deepEqual(removed.data.friends, []);
  assert.deepEqual((await call('GET', '/friends', null, mira)).data.friends, []);
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

test('the map key comes from the server environment', async () => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  assert.equal((await call('GET', '/config')).data.googleMapsKey, 'test-key');
  delete process.env.GOOGLE_MAPS_API_KEY;
  assert.equal((await call('GET', '/config')).data.googleMapsKey, null);
  assert.equal((await call('GET', '/config', null, null)).status, 401);
});

test('requests without a session are rejected', async () => {
  assert.equal((await call('GET', '/me', null, null)).status, 401);
});

// The admin dashboard's API: looking at players, fixing their accounts, handing
// things out and tuning the game. app.js checks the admin key before any of
// these run. Everything that changes something is written to admin_log.
import { DAY_MS, dayLabel, isDemoUser, localDay, transaction } from './db.js';
import { COSMETICS, EGGS, SLOTS, SPECIES, STEPS_PER_POINT, elementOf, stageForLevel } from './game.js';

const MAX_GIFT = 1_000_000;
// An open app calls in at least every two minutes, so anyone heard from within three is online.
const ONLINE_MS = 3 * 60_000;
const MAX_ANNOUNCEMENT = 300;
const MAX_ANNOUNCEMENT_HOURS = 24 * 90;
const MAX_LEVEL = 100;
const MAX_STAT = 999;

// Steps are reported by the phone and taken on trust, so these only point at
// walks worth a look. A sync that adds a lot of steps faster than anyone walks,
// or a walk whose very first report is already huge, gets flagged.
const FAST_STEPS_PER_SECOND = 4;
const FAST_MIN_STEPS = 500;
const BIG_FIRST_SYNC = 3000;

export function createAdminRoutes({ db, rules, HttpError, validUsername, forgetPlayer, seenAt }) {
  const log = (q, action, user, detail = '') => q.run(
    'INSERT INTO admin_log (action, user_id, username, detail, created_at) VALUES (?, ?, ?, ?, ?)',
    [action, user?.id ?? null, user?.username ?? null, detail, Date.now()],
  );

  // Some databases carry a locations table (the map's shared positions) that
  // this code doesn't create but that points at players; a deleted player's
  // row there has to go too. Checked once, outside any transaction.
  let hasLocations;
  const locationsExist = () => (hasLocations ??= db.get('SELECT 1 AS yes FROM locations LIMIT 1').then(() => true, () => false));

  async function playerOr404(userId, q = db) {
    const user = Number.isInteger(userId) && await q.get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) throw new HttpError(404, 'No such player');
    return user;
  }

  const wholeNumber = (value, { min, max, what }) => {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new HttpError(400, `${what} must be a whole number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}`);
    }
    return value;
  };
  const amountOf = (value) => (value === undefined || value === null || value === '' ? 0 : Number(value));
  const currency = (points, diamonds) => [points && `${points} Stride Points`, diamonds && `${diamonds} diamonds`]
    .filter(Boolean).join(' and ');

  // Walk reports from the last 30 days that look faster than walking. Demo
  // accounts are skipped: their history is made up when the database is seeded.
  async function suspiciousWalks(userId = null) {
    const events = await db.all(`
      SELECT s.user_id, u.username, s.session_id, s.timestamp, s.steps, w.started_at
      FROM step_events s
      JOIN walk_sessions w ON w.id = s.session_id
      JOIN users u ON u.id = s.user_id
      WHERE s.timestamp >= :since AND (:userId = 0 OR s.user_id = :userId)
      ORDER BY s.session_id, s.timestamp, s.id
    `, { since: Date.now() - 30 * DAY_MS, userId: userId ?? 0 });
    const flags = [];
    let previous = null;
    for (const event of events) {
      const first = previous?.session_id !== event.session_id;
      const seconds = Math.max(1, (Number(event.timestamp) - Number(first ? event.started_at : previous.timestamp)) / 1000);
      const pace = event.steps / seconds;
      const reason = first && event.steps >= BIG_FIRST_SYNC
        ? `${event.steps.toLocaleString('en-US')} steps in the first report of a walk`
        : !first && event.steps >= FAST_MIN_STEPS && pace > FAST_STEPS_PER_SECOND
          ? `${event.steps.toLocaleString('en-US')} steps in ${Math.round(seconds)}s (${pace.toFixed(1)} a second)`
          : null;
      if (reason && !isDemoUser(event.username)) {
        flags.push({
          userId: event.user_id, username: event.username, at: Number(event.timestamp), steps: event.steps,
          points: Math.floor(event.steps / STEPS_PER_POINT), reason,
        });
      }
      previous = event;
    }
    return flags.sort((a, b) => b.at - a.at);
  }

  const beastView = (b, walking) => ({
    id: walking ? null : b.id, walking, name: b.name, species: b.species, element: elementOf(b.species),
    level: b.level, stage: b.stage, attack: b.attack, evasion: b.evasion, xp: b.xp,
    equipped: SLOTS.map((slot) => b[slot]).filter(Boolean),
    restingUntil: Number(b.rest_until) > Date.now() ? Number(b.rest_until) : null,
  });

  return {
    'GET /api/admin/players': async () => {
      const weekAgo = Date.now() - 7 * DAY_MS;
      const players = await db.all(`
        SELECT u.id, u.username, u.points, u.coins, u.total_steps, u.daily_goal, u.created_at, u.banned_at, u.last_seen,
          b.name AS buddy_name, b.species, b.level, b.stage,
          (SELECT COUNT(*) FROM resting_buddies r WHERE r.user_id = u.id) AS resting,
          (SELECT COUNT(*) FROM friendships f WHERE f.user_id = u.id) AS friends,
          (SELECT COUNT(*) FROM battles bt WHERE bt.winner_id = u.id) AS wins,
          (SELECT COUNT(*) FROM battles bt WHERE (bt.challenger_id = u.id OR bt.opponent_id = u.id)
            AND bt.winner_id IS NOT NULL AND bt.winner_id != u.id) AS losses,
          (SELECT COUNT(*) FROM battles bt WHERE (bt.challenger_id = u.id OR bt.opponent_id = u.id)
            AND bt.winner_id IS NULL) AS draws,
          (SELECT COALESCE(SUM(s.steps), 0) FROM step_events s WHERE s.user_id = u.id AND s.timestamp >= :weekAgo) AS week_steps,
          (SELECT MAX(s.timestamp) FROM step_events s WHERE s.user_id = u.id) AS last_walk,
          (SELECT COALESCE(SUM(g.points), 0) FROM admin_gifts g WHERE g.user_id = u.id) AS gifted_points,
          (SELECT COALESCE(SUM(g.diamonds), 0) FROM admin_gifts g WHERE g.user_id = u.id) AS gifted_diamonds
        FROM users u JOIN buddies b ON b.user_id = u.id
        ORDER BY u.username
      `, { weekAgo });
      const flagCount = new Map();
      for (const flag of await suspiciousWalks()) flagCount.set(flag.userId, (flagCount.get(flag.userId) ?? 0) + 1);
      // What this server has heard since it started, or what was last written down before that.
      const lastSeenOf = (p) => seenAt(p.id) ?? (p.last_seen === null ? null : Number(p.last_seen));
      return {
        players: players.map((p) => ({
          id: p.id, username: p.username, demo: isDemoUser(p.username), suspended: p.banned_at !== null,
          lastSeen: lastSeenOf(p), online: Date.now() - (lastSeenOf(p) ?? 0) < ONLINE_MS,
          joined: Number(p.created_at), points: p.points, diamonds: p.coins, totalSteps: Number(p.total_steps),
          weekSteps: Number(p.week_steps), dailyGoal: p.daily_goal,
          lastWalk: p.last_walk === null ? null : Number(p.last_walk),
          buddy: { name: p.buddy_name, species: p.species, level: p.level, stage: p.stage },
          beasts: Number(p.resting) + 1, friends: Number(p.friends),
          wins: Number(p.wins), losses: Number(p.losses), draws: Number(p.draws),
          gifted: { points: Number(p.gifted_points), diamonds: Number(p.gifted_diamonds) },
          flags: flagCount.get(p.id) ?? 0,
        })),
      };
    },

    // Everything about one player: beasts, items, battles, walks, friends and what admins did to the account.
    'GET /api/admin/player': async ({ query }) => {
      const user = await playerOr404(Number(query.get('id')));
      const id = user.id;
      const active = await db.get('SELECT * FROM buddies WHERE user_id = ?', [id]);
      const resting = await db.all('SELECT * FROM resting_buddies WHERE user_id = ? ORDER BY id', [id]);
      return {
        id, username: user.username, demo: isDemoUser(user.username), suspended: user.banned_at !== null,
        joined: Number(user.created_at), points: user.points, diamonds: user.coins,
        totalSteps: Number(user.total_steps), dailyGoal: user.daily_goal,
        sessions: (await db.get('SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id = ?', [id])).n,
        beasts: [beastView(active, true), ...resting.map((b) => beastView(b, false))],
        items: (await db.all(`
          SELECT c.id, c.name, c.slot, o.bought_at FROM owned_cosmetics o JOIN cosmetics c ON c.id = o.cosmetic_id
          WHERE o.user_id = ? ORDER BY c.sort
        `, [id])).map((item) => ({ ...item, bought_at: undefined, at: Number(item.bought_at) })),
        battles: (await db.all(`
          SELECT bt.created_at, bt.challenger_id, bt.winner_id, u.username AS other
          FROM battles bt
          JOIN users u ON u.id = CASE WHEN bt.challenger_id = :id THEN bt.opponent_id ELSE bt.challenger_id END
          WHERE bt.challenger_id = :id OR bt.opponent_id = :id
          ORDER BY bt.created_at DESC, bt.id DESC LIMIT 20
        `, { id })).map((row) => ({
          at: Number(row.created_at), other: row.other, challenged: row.challenger_id === id,
          outcome: row.winner_id === null ? 'draw' : row.winner_id === id ? 'win' : 'loss',
        })),
        walks: (await db.all(`
          SELECT w.started_at, COALESCE(SUM(s.steps), 0) AS steps, MAX(s.timestamp) AS last_at
          FROM walk_sessions w LEFT JOIN step_events s ON s.session_id = w.id
          WHERE w.user_id = ? GROUP BY w.id, w.started_at ORDER BY w.started_at DESC LIMIT 20
        `, [id])).map((row) => ({
          at: Number(row.started_at), steps: Number(row.steps),
          minutes: row.last_at === null ? 0 : Math.round((Number(row.last_at) - Number(row.started_at)) / 60_000),
        })),
        friends: (await db.all(`
          SELECT u.username FROM friendships f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ? ORDER BY u.username
        `, [id])).map((row) => row.username),
        flags: await suspiciousWalks(id),
        log: (await db.all(`
          SELECT action, detail, created_at FROM admin_log WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50
        `, [id])).map((row) => ({ action: row.action, detail: row.detail, at: Number(row.created_at) })),
      };
    },

    // Adds to one player's wallet, or takes away with a negative amount. A balance never goes below zero.
    'POST /api/admin/gift': async ({ body }) => {
      const [points, diamonds] = [amountOf(body.points), amountOf(body.diamonds)]
        .map((value) => wholeNumber(value, { min: -MAX_GIFT, max: MAX_GIFT, what: 'An amount' }));
      if (points === 0 && diamonds === 0) throw new HttpError(400, 'Nothing to give');
      const player = await transaction(db, async (tx) => {
        const user = await playerOr404(body.userId, tx);
        if (user.points + points < 0 || user.coins + diamonds < 0) {
          throw new HttpError(409, `${user.username} only has ${user.points} Stride Points and ${user.coins} diamonds`);
        }
        await tx.run('UPDATE users SET points = points + ?, coins = coins + ? WHERE id = ?', [points, diamonds, user.id]);
        await tx.run('INSERT INTO admin_gifts (user_id, points, diamonds, created_at) VALUES (?, ?, ?, ?)',
          [user.id, points, diamonds, Date.now()]);
        const given = currency(Math.max(points, 0), Math.max(diamonds, 0));
        const taken = currency(Math.max(-points, 0), Math.max(-diamonds, 0));
        await log(tx, taken && !given ? 'took' : 'gift', user, [given && `gave ${given}`, taken && `took ${taken}`].filter(Boolean).join(', '));
        return playerOr404(user.id, tx);
      });
      return { id: player.id, username: player.username, points: player.points, diamonds: player.coins };
    },

    // The same gift to every player who isn't suspended. Demo accounts are left out unless asked for.
    'POST /api/admin/gift-all': async ({ body }) => {
      const [points, diamonds] = [amountOf(body.points), amountOf(body.diamonds)]
        .map((value) => wholeNumber(value, { min: 0, max: MAX_GIFT, what: 'An amount' }));
      if (points + diamonds === 0) throw new HttpError(400, 'Nothing to give');
      const players = await transaction(db, async (tx) => {
        const everyone = (await tx.all('SELECT id, username FROM users WHERE banned_at IS NULL'))
          .filter((user) => body.includeDemo === true || !isDemoUser(user.username));
        for (const user of everyone) {
          await tx.run('UPDATE users SET points = points + ?, coins = coins + ? WHERE id = ?', [points, diamonds, user.id]);
          await tx.run('INSERT INTO admin_gifts (user_id, points, diamonds, created_at) VALUES (?, ?, ?, ?)',
            [user.id, points, diamonds, Date.now()]);
        }
        await log(tx, 'gift-all', null, `gave ${currency(points, diamonds)} to ${everyone.length} players`);
        return everyone.length;
      });
      return { players };
    },

    'POST /api/admin/give-item': async ({ body }) => {
      const item = COSMETICS.find(({ id }) => id === body.itemId);
      if (!item) throw new HttpError(404, 'No such item');
      await transaction(db, async (tx) => {
        const user = await playerOr404(body.userId, tx);
        const { changes } = await tx.run(`
          INSERT INTO owned_cosmetics (user_id, cosmetic_id, bought_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING
        `, [user.id, item.id, Date.now()]);
        if (!changes) throw new HttpError(409, `${user.username} already has the ${item.name}`);
        await log(tx, 'give-item', user, `gave the ${item.name}`);
      });
      return { ok: true };
    },

    // The beast arrives as an egg resting at home, the same as one bought in the store.
    'POST /api/admin/give-beast': async ({ body }) => {
      if (!SPECIES.includes(body.species)) throw new HttpError(404, 'No such beast');
      await transaction(db, async (tx) => {
        const user = await playerOr404(body.userId, tx);
        const has = (await tx.get('SELECT 1 AS yes FROM buddies WHERE user_id = ? AND species = ?', [user.id, body.species]))
          || (await tx.get('SELECT 1 AS yes FROM resting_buddies WHERE user_id = ? AND species = ?', [user.id, body.species]));
        if (has) throw new HttpError(409, `${user.username} already has a ${body.species}`);
        const name = body.species[0].toUpperCase() + body.species.slice(1);
        await tx.run('INSERT INTO resting_buddies (user_id, name, species) VALUES (?, ?, ?)', [user.id, name, body.species]);
        await log(tx, 'give-beast', user, `gave a ${body.species} egg`);
      });
      return { ok: true };
    },

    'POST /api/admin/rename': async ({ body }) => {
      const username = validUsername(body.username);
      await transaction(db, async (tx) => {
        const user = await playerOr404(body.userId, tx);
        if (isDemoUser(user.username)) throw new HttpError(409, 'Demo accounts keep their names');
        const taken = await tx.get('SELECT id FROM users WHERE username = ?', [username]);
        if (taken && taken.id !== user.id) throw new HttpError(409, 'That username is taken');
        await tx.run('UPDATE users SET username = ? WHERE id = ?', [username, user.id]);
        await log(tx, 'rename', { id: user.id, username }, `renamed from ${user.username}`);
      });
      return { ok: true };
    },

    // Fixes one beast: its name, level and stats, or a rest that should be over.
    // beastId is a resting beast's id, or left out for the one walking with the player.
    'POST /api/admin/beast': async ({ body }) => {
      await transaction(db, async (tx) => {
        const user = await playerOr404(body.userId, tx);
        const resting = body.beastId !== undefined && body.beastId !== null;
        const [table, where, key] = resting
          ? ['resting_buddies', 'id = ? AND user_id = ?', [body.beastId, user.id]]
          : ['buddies', 'user_id = ?', [user.id]];
        const beast = (!resting || Number.isInteger(body.beastId))
          && await tx.get(`SELECT * FROM ${table} WHERE ${where}`, key);
        if (!beast) throw new HttpError(404, 'No such beast');
        const changes = {};
        const notes = [];
        if (body.name !== undefined) {
          changes.name = String(body.name).trim().slice(0, 16);
          if (!changes.name) throw new HttpError(400, 'A beast needs a name');
          if (changes.name !== beast.name) notes.push(`renamed ${beast.name} to ${changes.name}`);
        }
        if (body.level !== undefined) {
          changes.level = wholeNumber(Number(body.level), { min: 1, max: MAX_LEVEL, what: 'Level' });
          changes.stage = stageForLevel(changes.level);
          if (changes.level !== beast.level) notes.push(`level ${beast.level} to ${changes.level}`);
        }
        for (const stat of ['attack', 'evasion']) {
          if (body[stat] === undefined) continue;
          changes[stat] = wholeNumber(Number(body[stat]), { min: 1, max: MAX_STAT, what: stat });
          if (changes[stat] !== beast[stat]) notes.push(`${stat} ${beast[stat]} to ${changes[stat]}`);
        }
        if (body.clearRest === true) {
          changes.rest_until = null;
          if (Number(beast.rest_until) > Date.now()) notes.push('ended its rest');
        }
        const columns = Object.keys(changes);
        if (!columns.length) throw new HttpError(400, 'Nothing to change');
        await tx.run(`UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE ${where}`,
          [...columns.map((column) => changes[column]), ...key]);
        if (notes.length) await log(tx, 'beast', user, `${changes.name ?? beast.name}: ${notes.join(', ')}`);
      });
      return { ok: true };
    },

    // A suspended player is signed out, can't sign back in and drops off the leaderboards.
    'POST /api/admin/suspend': async ({ body }) => {
      const suspended = body.suspended === true;
      await transaction(db, async (tx) => {
        const user = await playerOr404(body.userId, tx);
        if (isDemoUser(user.username)) throw new HttpError(409, 'Demo accounts can\'t be suspended');
        await tx.run('UPDATE users SET banned_at = ? WHERE id = ?', [suspended ? Date.now() : null, user.id]);
        if (suspended) await tx.run('DELETE FROM auth_tokens WHERE user_id = ?', [user.id]);
        await log(tx, suspended ? 'suspend' : 'unsuspend', user);
      });
      if (suspended) forgetPlayer(body.userId);
      return { ok: true };
    },

    // Ends every session, so whoever is using the account has to sign in again.
    'POST /api/admin/signout': async ({ body }) => {
      const sessions = await transaction(db, async (tx) => {
        const user = await playerOr404(body.userId, tx);
        const { changes } = await tx.run('DELETE FROM auth_tokens WHERE user_id = ?', [user.id]);
        await log(tx, 'signout', user, `ended ${changes} sessions`);
        return changes;
      });
      return { sessions };
    },

    // Removes the player and everything of theirs. confirm must be their username, so a slip can't do it.
    'POST /api/admin/delete': async ({ body }) => {
      const extra = await locationsExist() ? [['locations', ['user_id']]] : [];
      await transaction(db, async (tx) => {
        const user = await playerOr404(body.userId, tx);
        if (isDemoUser(user.username)) throw new HttpError(409, 'Demo accounts can\'t be deleted');
        if (String(body.confirm ?? '').toLowerCase() !== user.username.toLowerCase()) {
          throw new HttpError(400, 'Type the player\'s username to confirm');
        }
        const id = user.id;
        for (const [table, columns] of [
          ...extra, ['auth_tokens', ['user_id']], ['ready_lines', ['user_id']], ['buddy_memory', ['user_id']],
          ['friend_requests', ['from_id', 'to_id']], ['friendships', ['user_id', 'friend_id']],
          ['battles', ['challenger_id', 'opponent_id', 'winner_id']], ['step_events', ['user_id']], ['walk_sessions', ['user_id']],
          ['owned_cosmetics', ['user_id']], ['resting_buddies', ['user_id']], ['buddies', ['user_id']],
          ['admin_gifts', ['user_id']], ['users', ['id']],
        ]) {
          await tx.run(`DELETE FROM ${table} WHERE ${columns.map((column) => `${column} = ?`).join(' OR ')}`,
            columns.map(() => id));
        }
        await log(tx, 'delete', user, `deleted the account (${Number(user.total_steps)} steps, ${user.points} points, ${user.coins} diamonds)`);
      });
      forgetPlayer(body.userId);
      return { ok: true };
    },

    'GET /api/admin/suspicious': async () => ({ flags: (await suspiciousWalks()).slice(0, 200) }),

    'GET /api/admin/log': async () => ({
      entries: (await db.all(`
        SELECT action, user_id, username, detail, created_at FROM admin_log ORDER BY created_at DESC, id DESC LIMIT 300
      `)).map((row) => ({
        action: row.action, userId: row.user_id, username: row.username, detail: row.detail, at: Number(row.created_at),
      })),
    }),

    // The last 30 days, one row a day in the admin's own timezone.
    'GET /api/admin/activity': async ({ tz }) => {
      const today = localDay(Date.now(), tz);
      const first = today - 29;
      const since = first * DAY_MS + tz * 60_000;
      const dayOf = (timestamp) => localDay(Number(timestamp), tz);
      const days = new Map();
      for (let day = first; day <= today; day++) {
        days.set(day, { date: dayLabel(day), signups: 0, walkers: new Set(), steps: 0, battles: 0 });
      }
      for (const row of await db.all('SELECT created_at FROM users WHERE created_at >= ?', [since])) {
        days.get(dayOf(row.created_at)).signups++;
      }
      for (const row of await db.all('SELECT user_id, timestamp, steps FROM step_events WHERE timestamp >= ?', [since])) {
        const day = days.get(dayOf(row.timestamp));
        day.walkers.add(row.user_id);
        day.steps += row.steps;
      }
      for (const row of await db.all('SELECT created_at FROM battles WHERE created_at >= ?', [since])) {
        days.get(dayOf(row.created_at)).battles++;
      }
      return { days: [...days.values()].map((day) => ({ ...day, walkers: day.walkers.size })) };
    },

    // Where the currency is and what players have spent it on.
    'GET /api/admin/economy': async () => {
      const totals = await db.get(`
        SELECT COUNT(*) AS players, COALESCE(SUM(points), 0) AS points, COALESCE(SUM(coins), 0) AS diamonds,
          COALESCE(SUM(total_steps), 0) AS steps
        FROM users
      `);
      const gifts = await db.get(`
        SELECT COALESCE(SUM(points), 0) AS points, COALESCE(SUM(diamonds), 0) AS diamonds FROM admin_gifts
      `);
      const walked = await db.all('SELECT total_steps FROM users');
      const wins = (await db.get('SELECT COUNT(*) AS n FROM battles WHERE winner_id IS NOT NULL')).n;
      const sold = new Map((await db.all(`
        SELECT cosmetic_id, COUNT(*) AS n FROM owned_cosmetics GROUP BY cosmetic_id
      `)).map((row) => [row.cosmetic_id, Number(row.n)]));
      const hatched = new Map();
      for (const table of ['buddies', 'resting_buddies']) {
        for (const row of await db.all(`SELECT species, COUNT(*) AS n FROM ${table} GROUP BY species`)) {
          hatched.set(row.species, (hatched.get(row.species) ?? 0) + Number(row.n));
        }
      }
      return {
        players: Number(totals.players), steps: Number(totals.steps),
        held: { points: Number(totals.points), diamonds: Number(totals.diamonds) },
        gifted: { points: Number(gifts.points), diamonds: Number(gifts.diamonds) },
        earned: {
          walking: walked.reduce((sum, row) => sum + Math.floor(Number(row.total_steps) / STEPS_PER_POINT), 0),
          battles: Number(wins) * rules.get('battleWinBonus'),
        },
        items: COSMETICS.map((item) => ({
          id: item.id, name: item.name, slot: item.slot, currency: item.currency ?? 'points',
          price: rules.get(`price.${item.id}`), owned: sold.get(item.id) ?? 0,
        })),
        // Beasts players have, by species. Every player starts with one for free, so this isn't all sales.
        beasts: SPECIES.map((species) => {
          const egg = EGGS.find((e) => e.species === species);
          return {
            species, owned: hatched.get(species) ?? 0, currency: egg?.currency ?? null,
            price: egg ? rules.get(`egg.${species}`) : null,
          };
        }),
      };
    },

    'GET /api/admin/announcements': async () => ({
      announcements: (await db.all(`
        SELECT id, message, created_at, expires_at FROM announcements ORDER BY created_at DESC, id DESC LIMIT 50
      `)).map((row) => ({
        id: row.id, message: row.message, at: Number(row.created_at),
        expiresAt: row.expires_at === null ? null : Number(row.expires_at),
        active: row.expires_at === null || Number(row.expires_at) > Date.now(),
      })),
    }),

    // Players see the newest running announcement once, the next time their app
    // hears from the server. hours is how long it runs; left out, until removed.
    'POST /api/admin/announce': async ({ body }) => {
      const message = String(body.message ?? '').trim();
      if (!message) throw new HttpError(400, 'Write a message first');
      if (message.length > MAX_ANNOUNCEMENT) throw new HttpError(400, `Keep it to ${MAX_ANNOUNCEMENT} characters`);
      const hours = body.hours === undefined || body.hours === null
        ? null : wholeNumber(Number(body.hours), { min: 1, max: MAX_ANNOUNCEMENT_HOURS, what: 'Hours' });
      const now = Date.now();
      await db.run('INSERT INTO announcements (message, created_at, expires_at) VALUES (?, ?, ?)',
        [message, now, hours === null ? null : now + hours * 3_600_000]);
      await log(db, 'announce', null, `${hours === null ? 'until removed' : `for ${hours}h`}: ${message}`);
      return { ok: true };
    },

    // Stops an announcement now. Players who already saw it aren't affected.
    'POST /api/admin/announce/stop': async ({ body }) => {
      const row = Number.isInteger(body.id) && await db.get('SELECT message FROM announcements WHERE id = ?', [body.id]);
      if (!row) throw new HttpError(404, 'No such announcement');
      await db.run('UPDATE announcements SET expires_at = ? WHERE id = ?', [Date.now(), body.id]);
      await log(db, 'announce-stop', null, row.message);
      return { ok: true };
    },

    // What can be handed out.
    'GET /api/admin/catalog': async () => ({
      items: COSMETICS.map(({ id, name, slot }) => ({ id, name, slot })),
      species: SPECIES,
    }),

    'GET /api/admin/settings': async () => ({ settings: rules.list() }),

    // amount: null puts the rule back to its default.
    'POST /api/admin/settings': async ({ body }) => {
      const before = rules.list().find((rule) => rule.name === body.name);
      if (!before) throw new HttpError(404, 'No such setting');
      const amount = body.amount === null ? null : Number(body.amount);
      if (!await rules.set(body.name, amount)) {
        throw new HttpError(400, `${before.label} must be a whole number from 0 to ${before.max.toLocaleString('en-US')}`);
      }
      const after = rules.list().find((rule) => rule.name === body.name);
      if (after.value !== before.value || after.changed !== before.changed) {
        await log(db, 'setting', null, `${before.label}: ${before.value} to ${after.value}${amount === null ? ' (default)' : ''}`);
      }
      return { setting: after };
    },
  };
}

// Other players: opponents, friends, positions on the map and leaderboards.
import { publicBuddy } from '../context.js';
import { DAY_MS, DEMO_USERNAMES, isDemoUser, localDay, transaction } from '../db.js';
import { distanceM } from '../../public/js/geo.js';
import { HttpError } from '../http-error.js';

// Friends show up on each other's maps, wherever they are, while their
// position is this fresh.
const NEARBY_FRESH_MS = 120_000;
// Demo: where the seeded buddies stand around you, in metres [north, east].
const DEMO_OFFSETS_M = [[60, 40], [-90, 70], [30, -120]];

export function createSocialRoutes({ db, record }) {
  // Friendship is one row each way; any request between the two is settled by it.
  async function befriend(tx, a, b) {
    const add = 'INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING';
    await tx.run(add, [a, b, Date.now()]);
    await tx.run(add, [b, a, Date.now()]);
    await tx.run(`
      DELETE FROM friend_requests WHERE (from_id = :a AND to_id = :b) OR (from_id = :b AND to_id = :a)
    `, { a, b });
  }

  // Friends, the requests waiting for this player's answer, and the ones they are waiting on.
  async function friendsView(userId) {
    const requests = async (mine, theirs) => (await db.all(`
      SELECT b.*, u.username FROM friend_requests r
      JOIN users u ON u.id = r.${theirs} JOIN buddies b ON b.user_id = u.id
      WHERE r.${mine} = ? ORDER BY r.created_at DESC
    `, [userId])).map((row) => ({ ...publicBuddy(row), userId: row.user_id, username: row.username }));
    return {
      friends: await friendList(userId),
      incoming: await requests('to_id', 'from_id'),
      outgoing: await requests('from_id', 'to_id'),
    };
  }

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

  return {
    // friendStatus is 'friend', 'requested' (you asked them), 'incoming' (they asked you) or null.
    'GET /api/opponents': async ({ userId }) => ({
      opponents: (await db.all(`
        SELECT b.*, u.username, f.friend_id IS NOT NULL AS is_friend,
          sent.to_id IS NOT NULL AS is_requested, got.from_id IS NOT NULL AS is_incoming
        FROM buddies b JOIN users u ON u.id = b.user_id
        LEFT JOIN friendships f ON f.user_id = :id AND f.friend_id = b.user_id
        LEFT JOIN friend_requests sent ON sent.from_id = :id AND sent.to_id = b.user_id
        LEFT JOIN friend_requests got ON got.to_id = :id AND got.from_id = b.user_id
        WHERE b.user_id != :id AND u.banned_at IS NULL ORDER BY b.level DESC, u.username LIMIT 100
      `, { id: userId })).map((row) => ({
        ...publicBuddy(row), userId: row.user_id, username: row.username, isFriend: Boolean(row.is_friend),
        friendStatus: row.is_friend ? 'friend' : row.is_incoming ? 'incoming' : row.is_requested ? 'requested' : null,
      })),
    }),

    'POST /api/location':async ({ userId, body }) => {
      const lat = Number(body.lat);
      const lng = Number(body.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        throw new HttpError(400, 'Invalid location');
      }
      await db.run(`
        INSERT INTO locations (user_id, lat, lng, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, updated_at = excluded.updated_at
      `, [userId, lat, lng, Date.now()]);
      return { ok: true };
    },

    // Friends who let friends see them and have shared a position lately,
    // nearest first. Only for callers sharing their own position.
    'GET /api/nearby': async ({ userId, query }) => {
      const since = Date.now() - NEARBY_FRESH_MS;
      const me = await db.get('SELECT lat, lng FROM locations WHERE user_id = ? AND updated_at >= ?', [userId, since]);
      if (!me) return { players: [] };
      const toPlayer = (row, at) => ({
        userId: row.user_id, username: row.username, lat: at.lat, lng: at.lng,
        distanceM: Math.round(distanceM(me, at)), buddy: publicBuddy(row),
      });
      const players = (await db.all(`
        SELECT b.*, u.username, l.lat, l.lng
        FROM locations l JOIN users u ON u.id = l.user_id JOIN buddies b ON b.user_id = u.id
        JOIN friendships f ON f.user_id = ? AND f.friend_id = u.id
        WHERE u.map_visible = 1 AND l.updated_at >= ?
      `, [userId, since]))
        .map((row) => toPlayer(row, row));
      if (query.get('demo') === '1') {
        const metresPerDegree = 111_320;
        for (const [i, username] of DEMO_USERNAMES.entries()) {
          const row = await db.get(`
            SELECT b.*, u.username FROM users u JOIN buddies b ON b.user_id = u.id
            JOIN friendships f ON f.user_id = ? AND f.friend_id = u.id
            WHERE u.username = ?
          `, [userId, username]);
          if (!row || players.some((p) => p.userId === row.user_id)) continue;
          const [north, east] = DEMO_OFFSETS_M[i % DEMO_OFFSETS_M.length];
          players.push({
            ...toPlayer(row, {
              lat: me.lat + north / metresPerDegree,
              lng: me.lng + east / (metresPerDegree * Math.cos((me.lat * Math.PI) / 180)),
            }),
            demo: true, // the map walks it around this spot
          });
        }
      }
      players.sort((a, b) => a.distanceM - b.distanceM);
      return { players: players.slice(0, 30) };
    },

    'GET /api/player': async ({ userId, query }) => {
      const id = Number(query.get('id'));
      const row = Number.isInteger(id) && await db.get(`
        SELECT b.*, u.username, u.total_steps, f.friend_id IS NOT NULL AS is_friend
        FROM users u JOIN buddies b ON b.user_id = u.id
        LEFT JOIN friendships f ON f.user_id = ? AND f.friend_id = u.id
        WHERE u.id = ?
      `, [userId, id]);
      if (!row) throw new HttpError(404, 'That buddy has wandered off');
      return {
        userId: row.user_id, username: row.username, buddy: publicBuddy(row), record: await record(id),
        totalSteps: row.total_steps, isFriend: Boolean(row.is_friend),
      };
    },

    'GET /api/friends': async ({ userId }) => friendsView(userId),

    // Asks someone to be friends; they accept or decline. If they had already
    // asked you, this accepts their request instead. status says which happened.
    'POST /api/friends': async ({ userId, body }) => {
      const username = String(body.username ?? '').trim().replace(/^@/, '');
      const friend = username && await db.get('SELECT id, username FROM users WHERE username = ?', [username]);
      if (!friend) throw new HttpError(404, `No player called "${username.slice(0, 20)}"`);
      if (friend.id === userId) throw new HttpError(400, 'That\'s you!');
      const status = await transaction(db, async (tx) => {
        const pair = [userId, friend.id];
        if (await tx.get('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?', pair)) {
          throw new HttpError(409, 'You\'re already friends');
        }
        const theyAsked = await tx.get('SELECT 1 FROM friend_requests WHERE to_id = ? AND from_id = ?', pair);
        if (theyAsked || isDemoUser(friend.username)) {
          await befriend(tx, userId, friend.id);
          return 'accepted';
        }
        const { changes } = await tx.run(`
          INSERT INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING
        `, [...pair, Date.now()]);
        if (!changes) throw new HttpError(409, 'You\'ve already asked them');
        return 'requested';
      });
      return { status, ...await friendsView(userId) };
    },

    // Answers a request from userId: accept makes you friends, otherwise it is just dropped.
    'POST /api/friends/respond': async ({ userId, body }) => {
      const fromId = Number(body.userId);
      await transaction(db, async (tx) => {
        const asked = Number.isInteger(fromId)
          && await tx.get('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?', [fromId, userId]);
        if (!asked) throw new HttpError(404, 'That request is gone');
        if (body.accept === true) await befriend(tx, userId, fromId);
        else await tx.run('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?', [fromId, userId]);
      });
      return friendsView(userId);
    },

    // Ends a friendship, or takes back a request you sent.
    'POST /api/friends/remove': async ({ userId, body }) => {
      const friendId = Number(body.userId);
      await db.run(`
        DELETE FROM friendships
        WHERE (user_id = :a AND friend_id = :b) OR (user_id = :b AND friend_id = :a)
      `, { a: userId, b: friendId });
      await db.run('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?', [userId, friendId]);
      return friendsView(userId);
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
        WHERE u.banned_at IS NULL AND (:everyone = 1 OR u.id = :id
          OR u.id IN (SELECT friend_id FROM friendships WHERE user_id = :id))
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
  };
}

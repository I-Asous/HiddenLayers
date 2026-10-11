// Signing up, signing in and out, and setting a password on an old account.
import {
  burnPasswordCheck, hashPassword, hashToken, passwordProblem, rateLimiter, verifyPassword,
} from '../auth.js';
import { presetById } from '../context.js';
import { transaction } from '../db.js';
import { SPECIES } from '../game.js';
import { HttpError } from '../http-error.js';

export function createAuthRoutes({ db, validUsername, markSeen, ensurePersonality, prepareLines, state }) {
  // Wrong passwords per username.
  const loginFailures = rateLimiter(10, 15 * 60_000);

  return {
    // Public: sign-up checks the name is free before the player picks a beast.
    'GET /api/username': async ({ query }) => ({
      available: !await db.get('SELECT id FROM users WHERE username = ?', [validUsername(query.get('name'))]),
    }),

    // New account: username, password (typed twice) and the buddy to hatch.
    'POST /api/signup': async ({ body, tz, startSession }) => {
      const username = validUsername(body.username);
      const problem = passwordProblem(body.password, body.confirmPassword, username);
      if (problem) throw new HttpError(400, problem);
      const passwordHash = await hashPassword(body.password);
      const buddyName = String(body.buddyName ?? '').trim().slice(0, 16) || 'Buddy';
      // Nobody picks their beast: every new player is handed a random egg.
      const species = SPECIES[Math.floor(Math.random() * SPECIES.length)];
      // No preset picked ("Surprise me") leaves it NULL for ensurePersonality to invent.
      const preset = presetById(body.personality);
      const userId = await transaction(db, async (tx) => {
        if (await tx.get('SELECT id FROM users WHERE username = ?', [username])) {
          throw new HttpError(409, 'That username is taken');
        }
        // Friends only see a new player on their map once the player turns that on.
        const { id } = await tx.run(`
          INSERT INTO users (username, password_hash, map_visible, created_at) VALUES (?, ?, 0, ?) RETURNING id
        `, [username, passwordHash, Date.now()]);
        await tx.run('INSERT INTO buddies (user_id, name, species, personality) VALUES (?, ?, ?, ?)',
          [id, buddyName, species, preset ? JSON.stringify(preset) : null]);
        return id;
      });
      markSeen(userId);
      await startSession(userId);
      ensurePersonality(userId).then(() => prepareLines(userId, tz)).catch((err) => console.error('[ai]', err.message));
      return state(userId, tz);
    },

    // One message for a wrong name and a wrong password, so neither gives
    // away which usernames exist.
    'POST /api/login': async ({ body, tz, startSession }) => {
      const username = String(body.username ?? '').trim();
      const key = username.toLowerCase();
      if (loginFailures.isBlocked(key)) {
        throw new HttpError(429, 'Too many wrong passwords. Wait 15 minutes and try again');
      }
      const user = /^[a-zA-Z0-9_]{2,20}$/.test(username)
        && await db.get('SELECT id, password_hash, banned_at FROM users WHERE username = ?', [username]);
      const ok = user?.password_hash
        ? await verifyPassword(body.password, user.password_hash)
        : (await burnPasswordCheck(body.password), false);
      if (!ok) {
        loginFailures.hit(key);
        throw new HttpError(401, 'Wrong username or password');
      }
      loginFailures.reset(key);
      // Only said to someone who knows the password, so it gives nothing away.
      if (user.banned_at !== null) throw new HttpError(403, 'This account is suspended');
      markSeen(user.id);
      await startSession(user.id);
      ensurePersonality(user.id).then(() => prepareLines(user.id, tz)).catch((err) => console.error('[ai]', err.message));
      return state(user.id, tz);
    },

    // Accounts made before passwords existed: the device that still holds the
    // old sign-in token may use it once to set a password. Nobody else can.
    'POST /api/claim': async ({ body, tz, startSession }) => {
      const legacy = typeof body.legacyToken === 'string' && /^[a-f0-9]{48}$/.test(body.legacyToken)
        && await db.get(`
          SELECT u.id, u.username FROM auth_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.token = ? AND u.password_hash IS NULL
        `, [body.legacyToken]);
      if (!legacy) throw new HttpError(403, 'This device can\'t set a password for that account. Please sign in');
      const problem = passwordProblem(body.password, body.confirmPassword, legacy.username);
      if (problem) throw new HttpError(400, problem);
      const passwordHash = await hashPassword(body.password);
      await transaction(db, async (tx) => {
        await tx.run('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash IS NULL', [passwordHash, legacy.id]);
        await tx.run('DELETE FROM auth_tokens WHERE user_id = ?', [legacy.id]);
      });
      await startSession(legacy.id);
      return { username: legacy.username, ...await state(legacy.id, tz) };
    },

    'POST /api/logout': async ({ token, endSession }) => {
      if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
      endSession();
      return { ok: true };
    },
  };
}

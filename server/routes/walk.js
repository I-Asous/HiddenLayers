// Steps coming in from walks, and the stats they add up to.
import { dayLabel, localDay, stepsByDay, transaction } from '../db.js';
import { pointsEarned, streakFor } from '../game.js';
import { HttpError } from '../http-error.js';

const MAX_SESSION_STEPS = 200_000;

export function createWalkRoutes({ db, getUser, state }) {
  return {
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
  };
}

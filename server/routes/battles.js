// Battles: started by the player, fought a move at a time, recorded at the end.
import { randomBytes } from 'node:crypto';
import { publicBuddy } from '../context.js';
import { MAX_ROUNDS, canUse, matchup, newBattle, opponentMove, resolveRound } from '../game.js';
import { HttpError } from '../http-error.js';

const battleView = ({ id, battle, challenger, opponent }) => ({
  id, round: battle.round, rounds: MAX_ROUNDS, over: battle.over, hpMax: battle.hpMax, hp: battle.hp,
  energy: battle.energy, totals: battle.totals, challenger, opponent,
  matchup: matchup(challenger.element, opponent.element),
});

export function createBattleRoutes({ db, getBuddy, getUser, state, record, restingUntil, liveBattles, endBattle }) {
  return {
    // Starts a battle. The player then sends one move per round; the opponent's
    // beast picks its own. Nothing is recorded until the battle ends.
    'POST /api/battles': async ({ userId, body }) => {
      const opponentId = Number(body.opponentId);
      if (opponentId === userId) throw new HttpError(400, 'You can\'t battle yourself');
      // Postgres rejects a non-integer id outright where SQLite just finds nobody.
      if (!Number.isInteger(opponentId)) throw new HttpError(404, 'That buddy has wandered off');
      const mine = await getBuddy(userId);
      const theirs = await getBuddy(opponentId);
      // Suspended players are off the opponents list, and can't be fought by id either.
      if (!theirs || (await getUser(opponentId)).banned_at !== null) throw new HttpError(404, 'That buddy has wandered off');
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
  };
}

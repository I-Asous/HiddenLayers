// The player's settings and the beast walking with them: upgrades, cosmetics,
// switching beasts and talking.
import {
  MOOD_STYLES, PERSONALITY_PRESETS, buddyLine, isBuddyEvent, situationFor, startSpeech,
} from '../ai.js';
import { rateLimiter } from '../auth.js';
import { presetById } from '../context.js';
import { transaction } from '../db.js';
import { SLOTS, UPGRADES, stageForLevel } from '../game.js';
import { HttpError } from '../http-error.js';

// Everything that makes a beast itself, and so moves with it when the player
// switches which one they walk with.
const BUDDY_COLUMNS = [
  'name', 'species', 'level', 'attack', 'evasion', 'xp', 'stage', 'hat', 'eyewear', 'accessory', 'background',
  'personality', 'rest_until',
];

export function createBuddyRoutes({
  db, ttsDir, getBuddy, state, moodContext, ensurePersonality, prepareLines, recall, remember, spendPoints,
  liveBattles, endBattle,
}) {
  // Talking and new personalities call paid AI APIs, so each player gets a budget.
  const aiCalls = rateLimiter(60, 60 * 60_000);
  const spendAiCall = (userId) => {
    if (!aiCalls.hit(userId)) throw new HttpError(429, 'Your buddy needs a breather. Try again in a bit');
  };

  return {
    'GET /api/me': ({ userId, tz }) => state(userId, tz),

    // Public: the sign-up screen lists these before there is a session.
    'GET /api/personalities': () => ({
      personalities: PERSONALITY_PRESETS.map(({ id, name, traits, quirk }) => ({ id, name, traits, quirk })),
    }),

    // The Google Maps JavaScript API runs in the browser, so its key has to be
    // handed to the page. Restrict the key to this site's URL in Google Cloud.
    'GET /api/config': () => ({
      googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || null,
      googleMapsMapId: process.env.GOOGLE_MAPS_MAP_ID || null,
    }),

    'PATCH /api/me': async ({ userId, body, tz }) => {
      if (body.personality !== undefined) spendAiCall(userId);
      if (body.dailyGoal !== undefined) {
        const goal = Number(body.dailyGoal);
        if (!Number.isInteger(goal) || goal < 500 || goal > 50_000) {
          throw new HttpError(400, 'Daily goal must be between 500 and 50,000 steps');
        }
        await db.run('UPDATE users SET daily_goal = ? WHERE id = ?', [goal, userId]);
      }
      // The name and personality go to the beast walking with the player, or
      // to one of their resting beasts when beastId names it.
      const resting = body.beastId !== undefined;
      if (resting) {
        const beast = Number.isInteger(body.beastId)
          && await db.get('SELECT 1 FROM resting_buddies WHERE id = ? AND user_id = ?', [body.beastId, userId]);
        if (!beast) throw new HttpError(404, 'You don\'t have that beast');
      }
      const [table, where, key] = resting
        ? ['resting_buddies', 'id = ?', body.beastId]
        : ['buddies', 'user_id = ?', userId];
      if (body.buddyName !== undefined) {
        const name = String(body.buddyName).trim().slice(0, 16);
        if (!name) throw new HttpError(400, 'Your buddy needs a name');
        await db.run(`UPDATE ${table} SET name = ? WHERE ${where}`, [name, key]);
      }
      if (body.mapVisible !== undefined) {
        if (typeof body.mapVisible !== 'boolean') throw new HttpError(400, 'mapVisible must be true or false');
        await db.run('UPDATE users SET map_visible = ? WHERE id = ?', [body.mapVisible ? 1 : 0, userId]);
        // Hiding takes you off friends' maps now, not when your last position goes stale.
        if (!body.mapVisible) await db.run('DELETE FROM locations WHERE user_id = ?', [userId]);
      }
      // A preset id, or 'surprise' for a fresh invented one.
      if (body.personality !== undefined) {
        const preset = presetById(body.personality);
        if (!preset && body.personality !== 'surprise') throw new HttpError(400, 'Unknown personality');
        const { personality: current } = await db.get(`SELECT personality FROM ${table} WHERE ${where}`, [key]);
        if (!preset || JSON.parse(current ?? '{}').id !== preset.id) {
          await db.run(`UPDATE ${table} SET personality = ? WHERE ${where}`, [preset ? JSON.stringify(preset) : null, key]);
          // A resting beast with no personality gets one when it next walks with the player.
          if (!resting) {
            // Lines and memories in the old voice would sound out of character.
            await db.run('DELETE FROM ready_lines WHERE user_id = ?', [userId]);
            await db.run('DELETE FROM buddy_memory WHERE user_id = ?', [userId]);
            await ensurePersonality(userId);
            prepareLines(userId, tz);
          }
        }
      }
      return state(userId, tz);
    },

    'POST /api/buddy/upgrade': async ({ userId, body, tz }) => {
      const upgrade = Object.hasOwn(UPGRADES, body.type) ? UPGRADES[body.type] : null;
      if (!upgrade) throw new HttpError(400, 'Unknown upgrade');
      const result = await transaction(db, async (tx) => {
        const buddy = await getBuddy(userId, tx);
        const cost = upgrade.cost(buddy);
        await spendPoints(tx, userId, cost);
        await tx.run(`UPDATE buddies SET ${upgrade.column} = ${upgrade.column} + 1 WHERE user_id = ?`, [userId]);
        let evolvedTo = null;
        if (body.type === 'level') {
          const stage = stageForLevel(buddy.level + 1);
          if (stage !== buddy.stage) {
            await tx.run('UPDATE buddies SET stage = ? WHERE user_id = ?', [stage, userId]);
            evolvedTo = stage;
          }
        }
        return { cost, evolvedTo, evolvedFrom: evolvedTo ? buddy.stage : null };
      });
      return { ...result, ...await state(userId, tz) };
    },

    'POST /api/buddy/equip': async ({ userId, body, tz }) => {
      if (!SLOTS.includes(body.slot)) throw new HttpError(400, 'Unknown slot');
      let itemId = null;
      if (body.itemId != null) {
        const item = await db.get(`
          SELECT c.id, c.slot FROM cosmetics c
          JOIN owned_cosmetics o ON o.cosmetic_id = c.id AND o.user_id = ?
          WHERE c.id = ?
        `, [userId, String(body.itemId)]);
        if (!item) throw new HttpError(403, 'You don\'t own that item');
        if (item.slot !== body.slot) throw new HttpError(400, 'That item doesn\'t fit this slot');
        // There is one of each item: a beast resting at home may be wearing it.
        const wearer = await db.get(`SELECT name FROM resting_buddies WHERE user_id = ? AND ${body.slot} = ?`,
          [userId, item.id]);
        if (wearer) throw new HttpError(409, `${wearer.name} is wearing that. Take it off them first`);
        itemId = item.id;
      }
      await db.run(`UPDATE buddies SET ${body.slot} = ? WHERE user_id = ?`, [itemId, userId]);
      return state(userId, tz);
    },

    // Swaps the buddy the player walks with for one of their resting beasts.
    'POST /api/buddy/switch': async ({ userId, body, tz }) => {
      if (!Number.isInteger(body.id)) throw new HttpError(400, 'Unknown beast');
      // Swapping beasts mid-battle counts as losing it, so the rest lands on the one that fought.
      if (liveBattles.has(userId)) await endBattle(userId, { forfeit: true });
      await transaction(db, async (tx) => {
        const next = await tx.get('SELECT * FROM resting_buddies WHERE id = ? AND user_id = ?', [body.id, userId]);
        if (!next) throw new HttpError(404, 'You don\'t have that beast');
        const active = await getBuddy(userId, tx);
        const assignments = BUDDY_COLUMNS.map((column) => `${column} = ?`).join(', ');
        await tx.run(`UPDATE resting_buddies SET ${assignments} WHERE id = ?`,
          [...BUDDY_COLUMNS.map((column) => active[column]), next.id]);
        await tx.run(`UPDATE buddies SET ${assignments} WHERE user_id = ?`,
          [...BUDDY_COLUMNS.map((column) => next[column]), userId]);
        // Lines and memories belong to the beast that was just put to rest.
        await tx.run('DELETE FROM ready_lines WHERE user_id = ?', [userId]);
        await tx.run('DELETE FROM buddy_memory WHERE user_id = ?', [userId]);
      });
      ensurePersonality(userId).then(() => prepareLines(userId, tz)).catch((err) => console.error('[ai]', err.message));
      return state(userId, tz);
    },

    'POST /api/talk': async ({ userId, body, tz }) => {
      spendAiCall(userId);
      const event = body.event ?? 'chat';
      if (!isBuddyEvent(event)) throw new HttpError(400, 'Unknown event');
      const { week, goal, mood } = await moodContext(userId, tz);
      await ensurePersonality(userId);
      const buddy = await getBuddy(userId);
      buddy.personality = JSON.parse(buddy.personality);
      // A line written in another mood is stale: drop it and write a fresh one.
      const taken = event !== 'chat' && await db
        .get('DELETE FROM ready_lines WHERE user_id = ? AND event = ? RETURNING text, speech, mood', [userId, event]);
      const ready = taken?.mood === mood && taken;
      const { text, speech, source } = ready
        ? { ...ready, source: 'gemini' }
        : await buddyLine({ event, buddy, week, goal, mood, memory: await recall(userId) });
      if (source === 'gemini') await remember(userId, situationFor(event, week, goal, mood), speech);
      prepareLines(userId, tz);
      // Don't wait for the voice: the text shows now, the audio URL waits for the mp3.
      const audio = startSpeech(speech, ttsDir, buddy.personality.voice, { stability: MOOD_STYLES[mood].stability });
      return { text, source, audioUrl: audio ? `/api/tts/${audio}` : null };
    },
  };
}

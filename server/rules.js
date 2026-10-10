// Game numbers an admin can change without a code change: prices, the battle
// win bonus and how long a beaten beast rests. Each has a default from game.js;
// the settings table holds only the ones that were changed.
import { BATTLE_WIN_BONUS, COSMETICS, EGGS, REST_BASE_MS, REST_PER_LEVEL_MS } from './game.js';

const MAX_PRICE = 1_000_000;

// name → { label, group, unit, default, max }. The order here is the order the dashboard shows.
export const RULES = Object.fromEntries([
  ['battleWinBonus', { label: 'Battle win bonus', group: 'Battles', unit: 'Stride Points', default: BATTLE_WIN_BONUS, max: 10_000 }],
  ...Object.entries(REST_BASE_MS).map(([stage, ms]) => [`rest.${stage}`, {
    label: `Rest after a loss: ${stage}`, group: 'Battles', unit: 'seconds', default: ms / 1000, max: 86_400,
  }]),
  ['restPerLevel', { label: 'Extra rest per level', group: 'Battles', unit: 'seconds', default: REST_PER_LEVEL_MS / 1000, max: 3600 }],
  ...COSMETICS.map((item) => [`price.${item.id}`, {
    label: item.name, group: item.slot === 'background' ? 'Scene prices' : 'Accessory prices',
    unit: item.currency === 'diamonds' ? 'diamonds' : 'Stride Points', default: item.price, max: MAX_PRICE,
  }]),
  ...EGGS.map((egg) => [`egg.${egg.species}`, {
    label: `${egg.species[0].toUpperCase()}${egg.species.slice(1)} egg (${egg.rarity})`, group: 'Egg prices',
    unit: egg.currency === 'diamonds' ? 'diamonds' : 'Stride Points', default: egg.price, max: MAX_PRICE,
  }]),
]);

/** Reads the changed values once; get() then answers from memory. */
export async function loadRules(db) {
  const changed = new Map();
  for (const { name, amount } of await db.all('SELECT name, amount FROM settings')) {
    if (name in RULES) changed.set(name, Number(amount));
  }
  return {
    get: (name) => changed.get(name) ?? RULES[name].default,
    /** How long a beast of this stage and level rests after losing, in ms. */
    restMs(stage, level) {
      return (this.get(`rest.${stage}`) + this.get('restPerLevel') * level) * 1000;
    },
    list: () => Object.entries(RULES).map(([name, rule]) => ({
      name, ...rule, value: changed.get(name) ?? rule.default, changed: changed.has(name),
    })),
    /** Sets a rule, or puts it back to its default when amount is null. Returns false for a bad name or amount. */
    async set(name, amount) {
      if (!Object.hasOwn(RULES, name)) return false;
      if (amount === null) {
        await db.run('DELETE FROM settings WHERE name = ?', [name]);
        changed.delete(name);
        return true;
      }
      if (!Number.isInteger(amount) || amount < 0 || amount > RULES[name].max) return false;
      await db.run(`
        INSERT INTO settings (name, amount) VALUES (?, ?)
        ON CONFLICT (name) DO UPDATE SET amount = excluded.amount
      `, [name, amount]);
      changed.set(name, amount);
      return true;
    },
  };
}

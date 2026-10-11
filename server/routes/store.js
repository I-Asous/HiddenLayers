// The store: cosmetics, eggs and diamond packs.
import { transaction } from '../db.js';
import { COIN_PACKAGES, COSMETICS, EGGS, cosmeticCurrency } from '../game.js';
import { HttpError } from '../http-error.js';

export function createStoreRoutes({ db, rules, getBuddy, state, spendPoints, spendDiamonds }) {
  async function storeItems(userId) {
    return (await db.all(`
      SELECT c.id, c.slot, c.name, c.price, o.user_id IS NOT NULL AS owned
      FROM cosmetics c
      LEFT JOIN owned_cosmetics o ON o.cosmetic_id = c.id AND o.user_id = ?
      ORDER BY c.sort
    `, [userId])).map((item) => ({
      ...item, price: rules.get(`price.${item.id}`), owned: Boolean(item.owned), currency: cosmeticCurrency(item.id),
      rarity: COSMETICS.find(({ id }) => id === item.id)?.rarity ?? null,
    }));
  }

  async function storeEggs(userId, q = db) {
    const owned = new Set([
      (await getBuddy(userId, q)).species,
      ...(await q.all('SELECT species FROM resting_buddies WHERE user_id = ?', [userId])).map((b) => b.species),
    ]);
    return EGGS.map((egg) => ({ ...egg, price: rules.get(`egg.${egg.species}`), owned: owned.has(egg.species) }));
  }

  return {
    'GET /api/store': async ({ userId }) => ({
      items: await storeItems(userId),
      eggs: await storeEggs(userId),
      coinPackages: COIN_PACKAGES,
    }),

    'POST /api/store/buy': async ({ userId, body, tz }) => {
      await transaction(db, async (tx) => {
        const item = await tx.get('SELECT * FROM cosmetics WHERE id = ?', [String(body.itemId ?? '')]);
        if (!item) throw new HttpError(404, 'No such item');
        const owned = await tx.get('SELECT 1 FROM owned_cosmetics WHERE user_id = ? AND cosmetic_id = ?', [userId, item.id]);
        if (owned) throw new HttpError(409, 'You already own that');
        await (cosmeticCurrency(item.id) === 'diamonds' ? spendDiamonds : spendPoints)(tx, userId, rules.get(`price.${item.id}`));
        await tx.run('INSERT INTO owned_cosmetics (user_id, cosmetic_id, bought_at) VALUES (?, ?, ?)',
          [userId, item.id, Date.now()]);
      });
      return { items: await storeItems(userId), ...await state(userId, tz) };
    },

    // A bought egg joins the player's resting beasts until they switch to it.
    'POST /api/store/buy-egg': async ({ userId, body, tz }) => {
      const egg = EGGS.find(({ species }) => species === body.species);
      if (!egg) throw new HttpError(404, 'No such egg');
      await transaction(db, async (tx) => {
        const listed = (await storeEggs(userId, tx)).find(({ species }) => species === egg.species);
        if (listed.owned) throw new HttpError(409, 'You already have that beast');
        await (egg.currency === 'diamonds' ? spendDiamonds : spendPoints)(tx, userId, listed.price);
        const name = egg.species[0].toUpperCase() + egg.species.slice(1);
        await tx.run('INSERT INTO resting_buddies (user_id, name, species) VALUES (?, ?, ?)', [userId, name, egg.species]);
      });
      return { eggs: await storeEggs(userId), ...await state(userId, tz) };
    },

    'POST /api/store/buy-coins': async ({ userId, body, tz }) => {
      const pack = COIN_PACKAGES.find(({ id }) => id === body.packageId);
      if (!pack) throw new HttpError(404, 'No such coin package');
      await transaction(db, async (tx) => {
        await tx.run('UPDATE users SET coins = coins + ? WHERE id = ?', [pack.coins, userId]);
      });
      return { purchased: pack, ...await state(userId, tz) };
    },
  };
}

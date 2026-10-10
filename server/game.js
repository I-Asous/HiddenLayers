// Game rules. Everything here is pure so it can be tested without a database.

export const STEPS_PER_POINT = 100;
export const DEFAULT_DAILY_GOAL = 6000;
// HP is sized so the harder hitter needs about this many clean hits to win.
export const HP_HITS = 5;
// Battles run until a knockout. The cap only ends a stalemate (both sides
// guarding or dodging everything); then whoever has more HP left wins.
export const MAX_ROUNDS = 30;
export const BATTLE_WIN_BONUS = 5;
export const SLOTS = ['hat', 'eyewear', 'accessory', 'background'];
// Must match the sprites in public/js/buddy.js; the first is the default.
export const SPECIES = [
  'dragon', 'phoenix', 'kraken', 'unicorn', 'pegasus', 'griffin', 'hydra', 'cerberus', 'yeti', 'kitsune', 'minotaur',
  'cyclops', 'golem', 'sphinx', 'basilisk', 'manticore', 'thunderbird', 'jackalope', 'gargoyle', 'treant', 'djinn',
  'kappa', 'fenrir',
];

export function stageForLevel(level) {
  if (level >= 20) return 'adult';
  if (level >= 10) return 'teen';
  if (level >= 5) return 'baby';
  return 'egg';
}

export const UPGRADES = {
  level: { column: 'level', cost: (buddy) => 10 * buddy.level },
  attack: { column: 'attack', cost: (buddy) => 5 * buddy.attack },
  evasion: { column: 'evasion', cost: (buddy) => 5 * buddy.evasion },
};

export function upgradeCosts(buddy) {
  return {
    level: UPGRADES.level.cost(buddy),
    attack: UPGRADES.attack.cost(buddy),
    evasion: UPGRADES.evasion.cost(buddy),
  };
}

// Points are derived from the lifetime step total so leftover steps carry
// over between syncs instead of being rounded away each time.
export function pointsEarned(totalBefore, totalAfter) {
  return Math.floor(totalAfter / STEPS_PER_POINT) - Math.floor(totalBefore / STEPS_PER_POINT);
}

// Days in a row the goal was hit. Today only counts once the goal is hit;
// until then yesterday's streak is still alive. byDay maps day → steps.
export function streakFor(byDay, today, goal) {
  let streak = 0;
  let day = (byDay.get(today) ?? 0) >= goal ? today : today - 1;
  while ((byDay.get(day) ?? 0) >= goal) {
    streak++;
    day--;
  }
  return streak;
}

export const MOODS = ['upset', 'proud', 'happy', 'lonely', 'sleepy', 'eager'];

// Losing two battles in a row upsets the buddy, but only for a couple of minutes.
export const UPSET_MS = 2 * 60_000;

// The buddy's mood, from how the walking (and battling) is going. week is 7
// step counts, oldest first, today last; lastBattles is the last two outcomes,
// newest first. The first matching rule wins.
export function moodFor({ week, goal, streak, lastBattles, msSinceLastBattle }) {
  const today = week.at(-1);
  if (lastBattles.length === 2 && lastBattles.every((r) => r === 'loss') && msSinceLastBattle < UPSET_MS) {
    return 'upset';
  }
  if (streak >= 3) return 'proud';
  if (today >= goal) return 'happy';
  if (week.slice(-3).every((steps) => steps === 0)) return 'lonely';
  if (today === 0) return 'sleepy';
  return 'eager';
}

// A beast that loses a battle it started has to rest before starting another.
// Bigger beasts take longer to recover: each stage has its own base, and every
// level adds a little on top.
export const REST_BASE_MS = { egg: 30_000, baby: 60_000, teen: 2 * 60_000, adult: 4 * 60_000 };
export const REST_PER_LEVEL_MS = 5_000;

export function restAfterLoss(level) {
  return REST_BASE_MS[stageForLevel(level)] + REST_PER_LEVEL_MS * level;
}

export function dodgeChance(evasion) {
  return evasion / (evasion + 50);
}

export const BATTLE_MOVES = ['attack', 'guard', 'special'];
export const SPECIAL_COST = 2;
export const MAX_ENERGY = 3;

// Each element is strong against the one it points to and weak against the one
// that points to it; the other pairings are even.
export const ELEMENT_BEATS = { water: 'fire', fire: 'nature', nature: 'sky', sky: 'water' };
const ELEMENT_SPECIES = {
  fire: ['dragon', 'phoenix', 'cerberus', 'manticore', 'kitsune', 'djinn'],
  water: ['kraken', 'hydra', 'kappa', 'yeti', 'fenrir'],
  nature: ['treant', 'jackalope', 'unicorn', 'minotaur', 'golem', 'cyclops', 'basilisk'],
  sky: ['pegasus', 'griffin', 'thunderbird', 'sphinx', 'gargoyle'],
};
const ELEMENT_OF = Object.fromEntries(
  Object.entries(ELEMENT_SPECIES).flatMap(([element, species]) => species.map((id) => [id, element])),
);
export const elementOf = (species) => ELEMENT_OF[species] ?? 'nature';

/** How an attack of one element lands on a defender of another: 'strong', 'weak' or 'even'. */
export function matchup(attacker, defender) {
  if (ELEMENT_BEATS[attacker] === defender) return 'strong';
  if (ELEMENT_BEATS[defender] === attacker) return 'weak';
  return 'even';
}
const EFFECT_MULTIPLIER = { strong: 1.5, weak: 0.75, even: 1 };

// a = challenger, b = opponent. Each needs { attack, evasion, species }.
// Both start with one shared HP size, set by the harder hitter.
export function newBattle(a, b) {
  const hpMax = HP_HITS * (Math.max(a.attack, b.attack) + 3);
  return {
    round: 1, hpMax, hp: { a: hpMax, b: hpMax }, energy: { a: 0, b: 0 }, totals: { a: 0, b: 0 }, over: false,
    winner: null,
  };
}

export const canUse = (battle, side, move) =>
  BATTLE_MOVES.includes(move) && (move !== 'special' || battle.energy[side] >= SPECIAL_COST);

// Plays one round in place; both sides act at once. Returns what each side did.
//   attack  — attack + 0..3 damage, can be dodged, halved by a guard. +1 energy.
//   guard   — deals nothing, halves an attack and stops a special. +2 energy.
//   special — costs 2 energy, hits twice as hard and can't be dodged.
// The battle ends when someone runs out of HP. If nobody has by MAX_ROUNDS,
// whoever has more HP left wins.
export function resolveRound(battle, sides, moves, random = Math.random) {
  const actions = {};
  for (const [attacker, defender] of [['a', 'b'], ['b', 'a']]) {
    const move = moves[attacker];
    const action = { move, damage: 0, dodged: false, blocked: false, effect: 'even' };
    if (move !== 'guard') {
      const special = move === 'special';
      const guarded = moves[defender] === 'guard';
      action.effect = matchup(elementOf(sides[attacker].species), elementOf(sides[defender].species));
      action.dodged = !special && random() < dodgeChance(sides[defender].evasion);
      action.blocked = special && guarded;
      const power = (sides[attacker].attack + Math.floor(random() * 4)) * (special ? 2 : 1);
      if (!action.dodged && !action.blocked) {
        action.damage = Math.max(1, Math.round(power * EFFECT_MULTIPLIER[action.effect] * (guarded ? 0.5 : 1)));
      }
    }
    actions[attacker] = action;
  }
  for (const [attacker, defender] of [['a', 'b'], ['b', 'a']]) {
    const { move, damage } = actions[attacker];
    battle.hp[defender] = Math.max(0, battle.hp[defender] - damage);
    battle.totals[attacker] += damage;
    battle.energy[attacker] = move === 'special'
      ? battle.energy[attacker] - SPECIAL_COST
      : Math.min(MAX_ENERGY, battle.energy[attacker] + (move === 'guard' ? 2 : 1));
  }
  if (battle.round >= MAX_ROUNDS || battle.hp.a === 0 || battle.hp.b === 0) {
    battle.over = true;
    battle.winner = battle.hp.a === battle.hp.b ? null : battle.hp.a > battle.hp.b ? 'a' : 'b';
  } else {
    battle.round++;
  }
  return actions;
}

// The opponent isn't at the controls, so their beast picks for itself: it likes
// to use a special once charged, and guards more when the challenger has one ready.
export function opponentMove(battle, random = Math.random) {
  if (battle.energy.b >= SPECIAL_COST && random() < 0.6) return 'special';
  if (battle.energy.a >= SPECIAL_COST && random() < 0.5) return 'guard';
  return random() < 0.2 ? 'guard' : 'attack';
}

export const COSMETICS = [
  { id: 'party-hat', slot: 'hat', name: 'Party Hat', price: 5 },
  { id: 'wizard-hat', slot: 'hat', name: 'Wizard Hat', price: 25 },
  { id: 'crown', slot: 'hat', name: 'Crown', price: 60 },
  { id: 'sunglasses', slot: 'eyewear', name: 'Sunglasses', price: 10 },
  { id: 'monocle', slot: 'eyewear', name: 'Monocle', price: 20 },
  { id: 'scarf', slot: 'accessory', name: 'Scarf', price: 8 },
  { id: 'bow-tie', slot: 'accessory', name: 'Bow Tie', price: 12 },
  { id: 'cape', slot: 'accessory', name: 'Cape', price: 35 },
  { id: 'bg-forest', slot: 'background', name: 'Forest', price: 15 },
  { id: 'bg-beach', slot: 'background', name: 'Beach', price: 20 },
  { id: 'bg-city', slot: 'background', name: 'City', price: 30 },
  { id: 'bg-space', slot: 'background', name: 'Space', price: 50 },
];

// Eggs sold in the store, one per beast added after the first three. Common and
// uncommon eggs cost Stride Points; rare and legendary ones cost diamonds.
const EGG_TIERS = {
  common: { currency: 'points', price: 80, species: ['jackalope', 'kappa', 'golem', 'treant', 'yeti', 'kitsune'] },
  uncommon: { currency: 'points', price: 200, species: ['minotaur', 'cyclops', 'gargoyle', 'pegasus', 'griffin', 'basilisk'] },
  rare: { currency: 'diamonds', price: 80, species: ['unicorn', 'sphinx', 'manticore', 'djinn'] },
  legendary: { currency: 'diamonds', price: 250, species: ['hydra', 'cerberus', 'thunderbird', 'fenrir'] },
};
export const EGGS = Object.entries(EGG_TIERS).flatMap(([rarity, { currency, price, species }]) =>
  species.map((id) => ({ species: id, element: elementOf(id), rarity, currency, price })));

export const COIN_PACKAGES = [
  { id: 'starter', name: 'Starter Stack', coins: 100, priceCents: 99 },
  { id: 'adventurer', name: 'Adventurer Chest', coins: 550, priceCents: 499, popular: true },
  { id: 'legend', name: 'Legend Hoard', coins: 1200, priceCents: 999 },
];

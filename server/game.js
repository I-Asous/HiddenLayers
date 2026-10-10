// Game rules. Everything here is pure so it can be tested without a database.

export const STEPS_PER_POINT = 100;
export const DEFAULT_DAILY_GOAL = 6000;
export const BATTLE_ROUNDS = 5;
export const BATTLE_WIN_BONUS = 5;
export const SLOTS = ['hat', 'eyewear', 'accessory', 'background'];
export const SPECIES = ['dragon', 'phoenix', 'kraken'];

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

export function dodgeChance(evasion) {
  return evasion / (evasion + 50);
}

// a = challenger, b = opponent. Each needs { attack, evasion }.
export function resolveBattle(a, b, random = Math.random) {
  const sides = { a, b };
  const totals = { a: 0, b: 0 };
  const log = [];
  for (let round = 1; round <= BATTLE_ROUNDS; round++) {
    for (const [attacker, defender] of [['a', 'b'], ['b', 'a']]) {
      const dodged = random() < dodgeChance(sides[defender].evasion);
      const damage = dodged ? 0 : sides[attacker].attack + Math.floor(random() * 4);
      totals[attacker] += damage;
      log.push({ round, attacker, dodged, damage });
    }
  }
  const winner = totals.a === totals.b ? null : totals.a > totals.b ? 'a' : 'b';
  // One shared HP pool sized to the hardest possible hitter, so whoever has
  // more HP left on screen is always the winner.
  const hpMax = BATTLE_ROUNDS * (Math.max(a.attack, b.attack) + 3);
  return { log, totals, winner, hpMax };
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

export const COIN_PACKAGES = [
  { id: 'starter', name: 'Starter Stack', coins: 100, priceCents: 99 },
  { id: 'adventurer', name: 'Adventurer Chest', coins: 550, priceCents: 499, popular: true },
  { id: 'legend', name: 'Legend Hoard', coins: 1200, priceCents: 999 },
];

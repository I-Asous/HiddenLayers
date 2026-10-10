// Every beast has an element. Each element is strong against the one it points
// to and weak against the one that points to it. Must match server/game.js.
export const ELEMENT_BEATS = { water: 'fire', fire: 'nature', nature: 'sky', sky: 'water' };
export const ELEMENT_LABELS = { fire: 'Fire', water: 'Water', nature: 'Nature', sky: 'Sky' };

/** How an attack of one element lands on a defender of another: 'strong', 'weak' or 'even'. */
export function matchup(attacker, defender) {
  if (ELEMENT_BEATS[attacker] === defender) return 'strong';
  if (ELEMENT_BEATS[defender] === attacker) return 'weak';
  return 'even';
}

export const weakTo = (element) => Object.keys(ELEMENT_BEATS).find((other) => ELEMENT_BEATS[other] === element);

export const elementTag = (element) =>
  `<span class="element is-${element}">${ELEMENT_LABELS[element] ?? ''}</span>`;

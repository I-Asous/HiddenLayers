// Buddy artwork: pixel-art mythical beasts on a 32×32 canvas.
//
// Sprites are written as the LEFT HALF of the creature and mirrored, so every
// beast is symmetric. Only fills are drawn here — the dark outline is added
// automatically around each layer. Cosmetics are placed from anchors read off
// the sprite (eyes, top of head, neck), so any item fits any beast at any stage.

import { BESTIARY } from './bestiary.js';
import { C } from './palette.js';

const SIZE = 32;
const GROUND = 30; // sprites stand with their last row at y = GROUND - 1
const O = '#1a1c2c';

// Sprite letters: b body, d dark body, l belly, h belly shade, a/c accents,
// p cheek, k eye, w eye white / teeth, m mouth, s egg shell.
const SHARED = { k: O, m: O, w: C.white, s: C.white };

const EGG = {
  rows: [
    '...ss',
    '..sss',
    '.ssss',
    '.sbss',
    'sssss',
    'sssbs',
    'sssks',
    'spsss',
    'ssssm',
    'shsbs',
    '.hsss',
    '..hhh',
  ],
  hat: 0, neck: 9, neckHalf: 4,
};

export const SPECIES = {
  dragon: {
    name: 'Dragon',
    titles: { egg: 'Dragon Egg', baby: 'Whelp', teen: 'Drake', adult: 'Dragon' },
    colors: { b: C.green, d: C.teal, l: C.lime, h: C.green, a: C.yellow, c: C.red, p: C.orange },
    stages: {
      baby: {
        rows: [
          '..a....',
          '..a....',
          '..bbbbb',
          '.bbbbbb',
          '.bbbbbb',
          '.bbkbbb',
          '.bbkbbb',
          '.bpbbbb',
          '..bbbbm',
          'c.bblll',
          'ccbblll',
          '.cbblll',
          '..bbbll',
          '..ddd..',
        ],
        hat: 2, neck: 9, neckHalf: 4,
      },
      teen: {
        rows: [
          '..a......',
          '..aa.....',
          '...abbbbb',
          '..bbbbbbb',
          '.bbbbbbbb',
          '.bbbwkbbb',
          '.bbbkkbbb',
          '.bpbbbbbb',
          '.bbbbbbmm',
          '..bbbbbbb',
          '.ccbbblll',
          'cccbbllll',
          'cccbbllll',
          '.ccbbllll',
          '..cbbllll',
          '...bbblll',
          '...ddd...',
        ],
        hat: 2, neck: 10, neckHalf: 6,
      },
      adult: {
        rows: [
          '...a.......',
          '...aa......',
          'c...aa.....',
          'cc...abbbbb',
          'ccc.bbbbbbb',
          'cccbbbbbbbb',
          'ccccbbbbbbb',
          '.cccbbwkbbb',
          '.cccbbkkbbb',
          '..ccbpbbbbb',
          '..cbbbbbwmw',
          '...bbbbbbmm',
          '...bbbbllll',
          '..bbbblllll',
          '.bbbbblllll',
          '.bb.bbhhhhh',
          '.bb.bblllll',
          '....bbhhhhh',
          '....bbbllll',
          '...bbbbbbbb',
          '...dddd....',
        ],
        hat: 3, neck: 12, neckHalf: 7,
      },
    },
  },
  phoenix: {
    name: 'Phoenix',
    titles: { egg: 'Phoenix Egg', baby: 'Ember Chick', teen: 'Firebird', adult: 'Phoenix' },
    colors: { b: C.orange, d: C.red, l: C.yellow, h: C.orange, a: C.yellow, c: C.yellow, p: C.red },
    stages: {
      baby: {
        rows: [
          '......c',
          '.....cc',
          '...bbbb',
          '..bbbbb',
          '.bbbbbb',
          '.bbkbbb',
          '.bbkbba',
          '.bpbbba',
          'dbbbbll',
          'ddbblll',
          '.dbblll',
          '..bbbll',
          '....aa.',
        ],
        hat: 2, neck: 8, neckHalf: 5,
      },
      teen: {
        rows: [
          '.......cc',
          '......ccc',
          '.....cbbb',
          '...bbbbbb',
          '..bbbbbbb',
          '..bbwkbbb',
          '..bbkkbba',
          '..bpbbbaa',
          'c..bbbbbb',
          'cddbbblll',
          'cddbbllll',
          'cdddbllll',
          '.cddbllll',
          '..cdbblll',
          '....bbbll',
          '.....aa..',
        ],
        hat: 2, neck: 9, neckHalf: 6,
      },
      adult: {
        rows: [
          '.........cc',
          'c.......ccc',
          'cc.....cbbb',
          'ccd...bbbbb',
          'cddd.bbbbbb',
          'cdddbbbwkbb',
          'cddddbbkkbb',
          '.cdddbpbbba',
          '.cddddbbbaa',
          '..cdddbbbbb',
          '..cddbbblll',
          '...cdbbllll',
          '...cdbbllll',
          '....dbbllll',
          '....bbbllll',
          '.....bbblll',
          '.....bbbbll',
          '...c..bbbbb',
          '..cdc.aa.dc',
          '...c.....cc',
        ],
        hat: 2, neck: 10, neckHalf: 6,
      },
    },
  },
  kraken: {
    name: 'Kraken',
    titles: { egg: 'Kraken Egg', baby: 'Squidlet', teen: 'Tidelurker', adult: 'Kraken' },
    colors: { b: C.sky, d: C.blue, l: C.cyan, h: C.sky, a: C.cyan, c: C.blue, p: C.orange },
    stages: {
      baby: {
        rows: [
          '...bbbb',
          '..bbbbb',
          '.bbabbb',
          '.bbbbbb',
          'bbbbbbb',
          'bbbkbbb',
          'bbbkbbb',
          'bbpbbbm',
          'bbbbbbb',
          '.bbbbbb',
          '.b.bb.b',
          '.d.bl.b',
          'dd.dd.d',
        ],
        hat: 0, neck: 9, neckHalf: 6,
      },
      teen: {
        rows: [
          '....bbbbb',
          '...bbbbbb',
          '..bbabbbb',
          '.bbbbbbab',
          '.bbbbbbbb',
          'bbbbbbbbb',
          'bbbbwkbbb',
          'bbbbkkbbb',
          'bbbpbbbbb',
          'bbbbbbbmm',
          '.bbbbbbbb',
          '..bbbbbbb',
          '.bb.bb.bb',
          'bb..bl.bl',
          'b...bb.bb',
          'dd..dd.dd',
        ],
        hat: 0, neck: 11, neckHalf: 7,
      },
      adult: {
        rows: [
          '......bbbbb',
          '....bbbbbbb',
          '...bbbabbbb',
          '..bbbbbbbab',
          'c.bbbbbbbbb',
          'ccbbbbbbbbb',
          'cbbbbbbbbbb',
          '.bbbbddbbbb',
          '.bbbbwkbbbb',
          '.bbbbkkbbbb',
          '.bbbpbbbbbb',
          '.bbbbbbbmwm',
          '..bbbbbbbbb',
          '.bbbbbbbbbb',
          'bbb.bbb.bbb',
          'bb..blb.blb',
          'bb..bbb.bbb',
          'bl...bb..bb',
          'bb...bl..bl',
          'd....dd..dd',
          'dd..dd...d.',
        ],
        hat: 0, neck: 13, neckHalf: 9,
      },
    },
  },
  ...BESTIARY,
};

export const SPECIES_IDS = Object.keys(SPECIES);

const speciesOf = (buddy) => SPECIES[buddy.species] ?? SPECIES.dragon;

/** What this beast is called at its current stage, e.g. "Drake". */
export function stageName(buddy) {
  return speciesOf(buddy).titles[buddy.stage] ?? speciesOf(buddy).titles.egg;
}

const HATS = {
  'party-hat': {
    colors: { y: C.yellow, p: C.red },
    rows: ['..yy..', '..pp..', '.pppp.', '.pyyp.', 'pppppp', 'pyyppp'],
  },
  'wizard-hat': {
    colors: { v: C.blue, V: C.navy, y: C.yellow },
    rows: ['....vv....', '...vvv....', '...vvvv...', '..vvyyvv..', '..vvvvvv..', '.vvvvvvvv.', 'VVVVVVVVVV'],
  },
  crown: {
    colors: { y: C.yellow, r: C.red, g: C.green },
    rows: ['y..yy..y', 'yy.yy.yy', 'yyyyyyyy', 'yryggyry'],
  },
};

const BOW_TIE = { colors: { g: C.lime, y: C.yellow }, rows: ['gg.yy.gg', 'gggyyggg', 'gg.yy.gg'] };

function gridPixels(rows, colors, x0, y0) {
  const pixels = [];
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch !== '.') pixels.push([x0 + x, y0 + y, colors[ch]]);
    });
  });
  return pixels;
}

function rectPixels(x, y, w, h, color) {
  const pixels = [];
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) pixels.push([x + dx, y + dy, color]);
  return pixels;
}

/** Paints a layer into the canvas, with a 1px dark outline around it. */
function blit(canvas, pixels, outline = true) {
  const inside = (x, y) => x >= 0 && y >= 0 && x < SIZE && y < SIZE;
  if (outline) {
    for (const [x, y] of pixels) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (inside(x + dx, y + dy)) canvas[y + dy][x + dx] = O;
      }
    }
  }
  for (const [x, y, color] of pixels) if (inside(x, y)) canvas[y][x] = color;
}

/** Sprite pixels plus the anchor points cosmetics hang from. */
function sprite(buddy) {
  const species = speciesOf(buddy);
  const def = buddy.stage === 'egg' || !species.stages[buddy.stage] ? EGG : species.stages[buddy.stage];
  const colors = def === EGG
    ? { ...SHARED, b: species.colors.b, h: C.silver, p: species.colors.p }
    : { ...SHARED, ...species.colors };
  const half = def.rows[0].length;
  const rows = def.rows.map((row) => row + [...row].reverse().join(''));
  const x0 = SIZE / 2 - half;
  const y0 = GROUND - rows.length;

  // Eyes: the first 'k' in the half-sprite; a 'w' beside it makes a 2px eye.
  const eyeRow = def.rows.findIndex((row) => row.includes('k'));
  const eyeCol = def.rows[eyeRow].indexOf('k');
  const wide = def.rows[eyeRow][eyeCol - 1] === 'w';
  let eyeHeight = 1;
  while (def.rows[eyeRow + eyeHeight]?.[eyeCol] === 'k') eyeHeight++;
  const eyeWidth = wide ? 2 : 1;
  const leftX = x0 + eyeCol - (wide ? 1 : 0);
  const eye = { y: y0 + eyeRow, w: eyeWidth, h: eyeHeight };

  return {
    pixels: gridPixels(rows, colors, x0, y0),
    eyes: [{ ...eye, x: leftX }, { ...eye, x: SIZE - leftX - eyeWidth }],
    hatY: y0 + def.hat,
    neckY: y0 + def.neck,
    neckHalf: def.neckHalf,
  };
}

const COSMETICS = {
  sunglasses(anchor) {
    const [left, right] = anchor.eyes;
    const height = Math.max(2, left.h);
    const lens = (eye) => rectPixels(eye.x - 1, eye.y, eye.w + 2, height, C.dusk);
    const bridge = rectPixels(left.x + left.w + 1, left.y, right.x - left.x - left.w - 2, 1, O);
    const glint = [[left.x - 1, left.y, C.silver], [right.x - 1, right.y, C.silver]];
    return [{ pixels: [...lens(left), ...lens(right), ...bridge, ...glint] }];
  },
  monocle(anchor) {
    const eye = anchor.eyes[1];
    const pixels = [];
    const [x1, y1, x2, y2] = [eye.x - 1, eye.y - 1, eye.x + eye.w, eye.y + Math.max(2, eye.h)];
    for (let x = x1; x <= x2; x++) pixels.push([x, y1, C.yellow], [x, y2, C.yellow]);
    for (let y = y1; y <= y2; y++) pixels.push([x1, y, C.yellow], [x2, y, C.yellow]);
    for (let i = 1; i <= 4; i++) pixels.push([x2 + (i > 2 ? 1 : 0), y2 + i, C.yellow]);
    // No outline: it would fill in the lens.
    return [{ pixels, outline: false }];
  },
  scarf(anchor) {
    const x = SIZE / 2 - anchor.neckHalf;
    return [{
      pixels: [
        ...rectPixels(x, anchor.neckY, anchor.neckHalf * 2, 2, C.red),
        ...rectPixels(SIZE / 2 + 1, anchor.neckY + 2, 2, 3, C.red),
        [x + 1, anchor.neckY, C.white], [SIZE / 2 - 2, anchor.neckY + 1, C.white],
        [SIZE / 2 + 2, anchor.neckY + 3, C.white],
      ],
    }];
  },
  'bow-tie'(anchor) {
    return [{ pixels: gridPixels(BOW_TIE.rows, BOW_TIE.colors, SIZE / 2 - 4, anchor.neckY) }];
  },
  cape(anchor) {
    const back = [];
    for (let y = anchor.neckY; y < GROUND; y++) {
      const half = Math.min(15, anchor.neckHalf + 2 + Math.floor((y - anchor.neckY) / 2));
      back.push(...rectPixels(SIZE / 2 - half, y, half * 2, 1, y === GROUND - 1 ? C.plum : C.red));
    }
    const front = [
      ...rectPixels(SIZE / 2 - anchor.neckHalf, anchor.neckY, anchor.neckHalf * 2, 1, C.red),
      ...rectPixels(SIZE / 2 - 1, anchor.neckY, 2, 2, C.yellow),
    ];
    return [{ pixels: back, behind: true }, { pixels: front }];
  },
};

function hatLayer(id, hatY) {
  const hat = HATS[id];
  const width = hat.rows[0].length;
  // The hat's bottom row overlaps the top row of the head.
  return { pixels: gridPixels(hat.rows, hat.colors, SIZE / 2 - width / 2, hatY - hat.rows.length + 1) };
}

/** The buddy as a 32×32 grid of colours (null = transparent). */
export function buddyPixels(buddy) {
  const canvas = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  const body = sprite(buddy);
  const eq = buddy.equipped ?? {};
  const layers = [
    ...(COSMETICS[eq.accessory]?.(body) ?? []),
    ...(COSMETICS[eq.eyewear]?.(body) ?? []),
    ...(HATS[eq.hat] ? [hatLayer(eq.hat, body.hatY)] : []),
  ];
  for (const layer of layers.filter((l) => l.behind)) blit(canvas, layer.pixels);
  blit(canvas, body.pixels);
  for (const layer of layers.filter((l) => !l.behind)) blit(canvas, layer.pixels, layer.outline !== false);
  return canvas;
}

/** Turns a pixel grid into SVG rects, merging horizontal runs of one colour. */
function rects(canvas) {
  let out = '';
  canvas.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const color = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === color) end++;
      if (color) out += `<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${color}"/>`;
      x = end;
    }
  });
  return out;
}

const r = (x, y, w, h, color) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}"/>`;
const stars = (points, color = C.white) => points.map(([x, y]) => r(x, y, 1, 1, color)).join('');
// A stepped triangle (pine tree, mountain) with its tip at (cx, top).
const steps = (cx, top, rows, color) =>
  Array.from({ length: rows }, (_, i) => r(cx - 1 - i, top + i, 2 + 2 * i, 1, color)).join('');

const BACKGROUNDS = {
  'bg-forest': () => `
    ${r(0, 0, 32, 32, C.sky)}${r(24, 3, 4, 4, C.yellow)}
    ${r(4, 7, 6, 2, C.white)}${r(6, 6, 3, 1, C.white)}
    ${steps(4, 10, 7, C.teal)}${steps(4, 15, 8, C.teal)}${steps(27, 9, 7, C.teal)}${steps(27, 14, 9, C.teal)}
    ${steps(13, 14, 6, C.green)}${steps(20, 15, 6, C.green)}
    ${r(0, 26, 32, 6, C.green)}${r(0, 26, 32, 1, C.lime)}
    ${stars([[3, 29], [9, 28], [15, 30], [22, 28], [28, 30]], C.lime)}`,
  'bg-beach': () => `
    ${r(0, 0, 32, 32, C.cyan)}${r(3, 3, 5, 5, C.yellow)}
    ${r(18, 5, 7, 2, C.white)}${r(20, 4, 3, 1, C.white)}
    ${r(0, 16, 32, 10, C.sky)}${r(0, 16, 32, 1, C.blue)}
    ${stars([[2, 19], [3, 19], [10, 21], [11, 21], [19, 18], [20, 18], [26, 22], [27, 22], [14, 24], [15, 24]])}
    ${r(0, 25, 32, 7, C.yellow)}${r(0, 25, 32, 1, C.white)}
    ${r(27, 12, 1, 14, C.orange)}${r(24, 11, 7, 1, C.green)}${r(23, 12, 3, 1, C.green)}${r(29, 12, 3, 1, C.green)}
    ${r(26, 10, 3, 1, C.green)}${stars([[5, 28], [12, 30], [20, 28]], C.orange)}`,
  'bg-city': () => `
    ${r(0, 0, 32, 10, C.plum)}${r(0, 10, 32, 8, C.red)}${r(0, 18, 32, 8, C.orange)}
    ${r(21, 12, 6, 6, C.yellow)}
    ${r(0, 14, 6, 13, C.navy)}${r(7, 9, 6, 18, C.night)}${r(14, 16, 5, 11, C.navy)}
    ${r(20, 19, 5, 8, C.night)}${r(26, 11, 6, 16, C.navy)}
    ${stars([[1, 16], [3, 19], [4, 22], [8, 11], [11, 14], [9, 18], [11, 22], [15, 18], [17, 22],
      [21, 21], [23, 23], [27, 13], [30, 16], [28, 20], [30, 23]], C.yellow)}
    ${r(0, 27, 32, 5, C.dusk)}${r(0, 27, 32, 1, C.slate)}`,
  'bg-space': () => `
    ${r(0, 0, 32, 32, C.night)}
    ${stars([[2, 3], [7, 8], [12, 2], [17, 6], [29, 4], [1, 14], [30, 15], [5, 20], [27, 21], [15, 11]])}
    ${stars([[9, 5], [22, 10], [3, 24], [29, 9]], C.silver)}
    ${r(22, 3, 5, 5, C.orange)}${r(23, 2, 3, 7, C.orange)}${r(20, 5, 9, 1, C.yellow)}
    ${r(4, 4, 3, 3, C.silver)}
    ${r(0, 27, 32, 5, C.slate)}${r(0, 27, 32, 1, C.silver)}
    ${r(4, 29, 3, 1, C.dusk)}${r(18, 30, 4, 1, C.dusk)}${r(26, 28, 2, 1, C.dusk)}`,
};

const DEFAULT_BG = () => `
  ${r(0, 0, 32, 32, C.navy)}
  ${stars([[3, 4], [11, 2], [27, 5], [20, 9], [6, 12], [29, 14]], C.slate)}
  ${r(0, 27, 32, 5, C.dusk)}${r(0, 27, 32, 1, C.slate)}`;

/**
 * Returns the SVG markup for a buddy.
 * @param {{species?: string, stage: string, equipped?: object}} buddy
 * @param {{background?: boolean, className?: string}} [options]
 */
export function buddySvg(buddy, { background = true, className = '' } = {}) {
  const bg = background ? (BACKGROUNDS[buddy.equipped?.background] ?? DEFAULT_BG)() : '';
  return `
    <svg class="buddy ${className}" viewBox="0 0 ${SIZE} ${SIZE}" shape-rendering="crispEdges" role="img"
      aria-label="${stageName(buddy)}">
      ${bg}
      <g class="buddy-body">${rects(buddyPixels(buddy))}</g>
    </svg>`;
}

// Stand-in anchors for drawing eyewear and accessories on their own.
const ICON_ANCHOR = {
  eyes: [{ x: 11, y: 14, w: 2, h: 2 }, { x: 19, y: 14, w: 2, h: 2 }],
  neckY: 13, neckHalf: 5,
};

/** A cosmetic drawn on its own, for store and wardrobe tiles. */
export function cosmeticIcon(item) {
  if (item.slot === 'background') {
    return `<svg viewBox="0 0 ${SIZE} ${SIZE}" class="cosmetic-icon is-bg" shape-rendering="crispEdges"
      aria-hidden="true">${BACKGROUNDS[item.id]()}</svg>`;
  }
  const canvas = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  const layers = item.slot === 'hat' ? [hatLayer(item.id, 20)] : COSMETICS[item.id](ICON_ANCHOR);
  for (const layer of layers) blit(canvas, layer.pixels, layer.outline !== false);
  // Crop to the drawing, keeping it square so every icon has the same pixel size feel.
  let [x1, y1, x2, y2] = [SIZE, SIZE, 0, 0];
  canvas.forEach((row, y) => row.forEach((color, x) => {
    if (!color) return;
    x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y);
  }));
  const side = Math.max(x2 - x1, y2 - y1) + 3;
  const vx = (x1 + x2 + 1 - side) / 2;
  const vy = (y1 + y2 + 1 - side) / 2;
  return `<svg viewBox="${vx} ${vy} ${side} ${side}" class="cosmetic-icon" shape-rendering="crispEdges"
    aria-hidden="true">${rects(canvas)}</svg>`;
}

// The step-history chart shown in the player's profile: one bar chart, with a
// filter for how far back it looks.
import { fmt } from './fx.js';

const W = 340;
const H = 170;
const PAD = { left: 34, right: 34, top: 12, bottom: 24 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

export const parse = (date) => new Date(`${date}T00:00:00Z`);
const dateFmt = (options) => new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
const weekday = dateFmt({ weekday: 'short' });
export const shortDate = dateFmt({ month: 'short', day: 'numeric' });
const fullDate = dateFmt({ weekday: 'short', month: 'short', day: 'numeric' });
const monthLetter = dateFmt({ month: 'narrow' });
const monthYear = dateFmt({ month: 'long', year: 'numeric' });
const compact = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n));

function niceMax(value) {
  const step = value <= 4000 ? 1000 : value <= 10_000 ? 2000 : value <= 20_000 ? 5000
    : 10 ** Math.floor(Math.log10(value)) / 2;
  return Math.max(step * 2, Math.ceil(value / step) * step);
}

// Each range turns a GET /api/stats answer into bars: { steps, axis, title }.
// axis is the label under the bar ('' for none), title names it in the readout.
// Days are measured against the daily goal; a month's total isn't.
const RANGES = {
  week: {
    label: 'Week',
    total: 'this week',
    goal: true,
    bars: (stats) => stats.days.slice(-7).map((d) => ({
      steps: d.steps, axis: weekday.format(parse(d.date)), title: fullDate.format(parse(d.date)),
    })),
  },
  month: {
    label: 'Month',
    total: 'in the last 30 days',
    goal: true,
    bars: (stats) => stats.days.map((d, i, days) => ({
      steps: d.steps,
      // Too many days to label each: one a week, counting back from today.
      axis: (days.length - 1 - i) % 7 === 0 ? shortDate.format(parse(d.date)) : '',
      title: fullDate.format(parse(d.date)),
    })),
  },
  year: {
    label: 'Year',
    total: 'in the last 12 months',
    goal: false,
    bars: (stats) => stats.months.map((m) => ({
      steps: m.steps, axis: monthLetter.format(parse(`${m.month}-01`)), title: monthYear.format(parse(`${m.month}-01`)),
    })),
  },
};

function barChart(bars, goal, label) {
  const max = niceMax(Math.max(goal ?? 0, ...bars.map((b) => b.steps)));
  const y = (v) => PAD.top + PLOT_H * (1 - v / max);
  const grid = [0, max / 2, max].map((tick) => `
    <line x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(tick)}" y2="${y(tick)}" class="grid-line"/>
    <text x="${PAD.left - 6}" y="${y(tick) + 4}" text-anchor="end" class="axis-text">${compact(tick)}</text>`).join('');
  const goalLine = goal ? `
    <line x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(goal)}" y2="${y(goal)}" class="goal-line"/>
    <text x="${W - PAD.right}" y="${y(goal) - 5}" text-anchor="end" class="axis-text goal-text">Goal</text>` : '';
  const slot = PLOT_W / bars.length;
  const width = slot * 0.6;
  const marks = bars.map((bar, i) => {
    const x = PAD.left + slot * i + (slot - width) / 2;
    const top = y(bar.steps);
    const height = PAD.top + PLOT_H - top;
    // A lighter cap on top of each bar, like a lit pixel edge.
    const mark = height > 0
      ? `<rect class="bar-mark" x="${x}" y="${top}" width="${width}" height="${height}"/>
         <rect class="bar-cap" x="${x}" y="${top}" width="${width}" height="${Math.min(4, height)}"/>`
      : '';
    return `
      <g class="bar-slot ${i === bars.length - 1 ? 'is-today' : ''}" data-index="${i}">
        <rect x="${PAD.left + slot * i}" y="${PAD.top}" width="${slot}" height="${PLOT_H + PAD.bottom}" fill="transparent"/>
        ${mark}
        <text x="${x + width / 2}" y="${H - 6}" text-anchor="middle" class="axis-text">${bar.axis}</text>
      </g>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${label}">${grid}${marks}${goalLine}</svg>`;
}

/**
 * Draws the step history into el from a GET /api/stats answer, and keeps it
 * answering to the range filter and to a tap or hover on a bar.
 */
export function mountStepHistory(el, stats) {
  let range = 'week';
  let bars = [];
  const out = () => el.querySelector('.readout');
  const total = () => `<b>${fmt(bars.reduce((sum, b) => sum + b.steps, 0))}</b> steps ${RANGES[range].total}`;

  function render() {
    bars = RANGES[range].bars(stats);
    el.innerHTML = `
      <section class="chart-card">
        <div class="segmented segmented-sub" role="tablist" aria-label="Time range">${Object.entries(RANGES).map(([id, r]) => `
          <button role="tab" aria-selected="${id === range}" data-range="${id}">${r.label}</button>`).join('')}
        </div>
        <p class="readout">${total()}</p>
        ${barChart(bars, RANGES[range].goal ? stats.dailyGoal : null, `Steps ${RANGES[range].total}`)}
      </section>`;
  }

  // Tap or hover a bar to read its value; leave and the total comes back.
  const pick = (slot) => {
    el.querySelector('.is-active')?.classList.remove('is-active');
    if (!slot) {
      if (out()) out().innerHTML = total();
      return;
    }
    slot.classList.add('is-active');
    const bar = bars[Number(slot.dataset.index)];
    out().innerHTML = `<b>${fmt(bar.steps)}</b> steps · ${bar.title}`;
  };
  el.addEventListener('pointerover', (e) => pick(e.target.closest('.bar-slot')));
  el.addEventListener('pointerdown', (e) => pick(e.target.closest('.bar-slot')));
  el.addEventListener('pointerleave', () => pick(null));
  el.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-range]');
    if (!tab) return;
    range = tab.dataset.range;
    render();
  });
  render();
}

import { api } from '../api.js';
import { fmt, fmtDistance, toast } from '../fx.js';
import { icons } from '../icons.js';

const W = 340;
const H = 170;
const PAD = { left: 34, right: 34, top: 12, bottom: 24 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

const parse = (date) => new Date(`${date}T00:00:00Z`);
const dateFmt = (options) => new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
const weekday = dateFmt({ weekday: 'short' });
const shortDate = dateFmt({ month: 'short', day: 'numeric' });
const fullDate = dateFmt({ weekday: 'short', month: 'short', day: 'numeric' });
const compact = (n) => (n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n));

function niceMax(value) {
  const step = value <= 4000 ? 1000 : value <= 10_000 ? 2000 : 5000;
  return Math.max(step * 2, Math.ceil(value / step) * step);
}

function axes(max, goal) {
  const y = (v) => PAD.top + PLOT_H * (1 - v / max);
  const grid = [0, max / 2, max].map((tick) => `
    <line x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(tick)}" y2="${y(tick)}" class="grid-line"/>
    <text x="${PAD.left - 6}" y="${y(tick) + 4}" text-anchor="end" class="axis-text">${compact(tick)}</text>`).join('');
  const goalLine = `
    <line x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(goal)}" y2="${y(goal)}" class="goal-line"/>
    <text x="${W - PAD.right}" y="${y(goal) - 5}" text-anchor="end" class="axis-text goal-text">Goal</text>`;
  return { y, grid, goalLine };
}

function barChart(days, goal) {
  const max = niceMax(Math.max(goal, ...days.map((d) => d.steps)));
  const { y, grid, goalLine } = axes(max, goal);
  const slot = PLOT_W / days.length;
  const width = slot * 0.6;
  const bars = days.map((day, i) => {
    const x = PAD.left + slot * i + (slot - width) / 2;
    const top = y(day.steps);
    const height = PAD.top + PLOT_H - top;
    // A lighter cap on top of each bar, like a lit pixel edge.
    const bar = height > 0
      ? `<rect class="bar-mark" x="${x}" y="${top}" width="${width}" height="${height}"/>
         <rect class="bar-cap" x="${x}" y="${top}" width="${width}" height="${Math.min(4, height)}"/>`
      : '';
    return `
      <g class="bar-slot ${i === days.length - 1 ? 'is-today' : ''}" data-index="${i}">
        <rect x="${PAD.left + slot * i}" y="${PAD.top}" width="${slot}" height="${PLOT_H + PAD.bottom}" fill="transparent"/>
        ${bar}
        <text x="${x + width / 2}" y="${H - 6}" text-anchor="middle" class="axis-text">${weekday.format(parse(day.date))}</text>
      </g>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Steps per day, last 7 days">
    ${grid}${bars}${goalLine}</svg>`;
}

function lineChart(days, goal) {
  const max = niceMax(Math.max(goal, ...days.map((d) => d.steps)));
  const { y, grid, goalLine } = axes(max, goal);
  const x = (i) => PAD.left + (PLOT_W * i) / (days.length - 1);
  const points = days.map((d, i) => `${x(i).toFixed(1)} ${y(d.steps).toFixed(1)}`);
  const base = PAD.top + PLOT_H;
  const labels = [0, Math.floor((days.length - 1) / 2), days.length - 1].map((i) => `
    <text x="${x(i)}" y="${H - 6}" class="axis-text"
      text-anchor="${i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}">${shortDate.format(parse(days[i].date))}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Steps per day, last 30 days">
    ${grid}
    <path class="line-area" d="M${x(0)} ${base}L${points.join('L')}L${x(days.length - 1)} ${base}z"/>
    <path class="line-mark" d="M${points.join('L')}"/>
    ${goalLine}${labels}
    <g class="crosshair" style="display:none">
      <line y1="${PAD.top}" y2="${base}" class="crosshair-line"/>
      <rect width="8" height="8" class="crosshair-dot"/>
    </g>
    <rect class="hit" x="${PAD.left}" y="${PAD.top}" width="${PLOT_W}" height="${PLOT_H}" fill="transparent"/>
  </svg>`;
}

const readout = (day) => `<b>${fmt(day.steps)}</b> steps · ${fullDate.format(parse(day.date))}`;

export function mount(el) {
  el.innerHTML = '<header class="topbar"><h1>Stats</h1></header><p class="empty">Crunching your steps…</p>';
  let alive = true;

  api('/stats').then((stats) => {
    if (!alive) return;
    const week = stats.days.slice(-7);
    const month = stats.days;
    const weekTotal = week.reduce((sum, d) => sum + d.steps, 0);
    el.innerHTML = `
      <header class="topbar"><h1>Stats</h1></header>

      <div class="tiles">
        <div class="tile tile-wide">
          <small>${icons.boot}Today</small>
          <b>${fmt(stats.todaySteps)}</b>
          <span>${Math.floor((stats.todaySteps / stats.dailyGoal) * 100)}% of your ${fmt(stats.dailyGoal)}-step goal</span>
          <div class="bar"><i style="width:${Math.min(100, (stats.todaySteps / stats.dailyGoal) * 100)}%"></i></div>
        </div>
        <div class="tile"><small>${icons.flame}Current streak</small><b>${stats.streak}</b>
          <span>${stats.streak === 1 ? 'day' : 'days'} hitting your goal</span></div>
        <div class="tile"><small>${icons.trophy}Best day</small><b>${stats.bestDay ? fmt(stats.bestDay.steps) : '–'}</b>
          <span>${stats.bestDay ? shortDate.format(parse(stats.bestDay.date)) : 'No walks yet'}</span></div>
        <div class="tile"><small>${icons.boot}Total distance</small><b>${fmtDistance(stats.distanceKm * 1000, { decimals: 1, small: false })}</b>
          <span>${fmt(stats.totalSteps)} steps all time</span></div>
        <div class="tile"><small>${icons.leaf}CO₂ saved</small><b>${stats.co2SavedKg.toFixed(1)} kg</b>
          <span>vs driving the same distance</span></div>
      </div>

      <section class="chart-card" id="week">
        <h2>Last 7 days</h2>
        <p class="readout" data-default="&lt;b&gt;${fmt(weekTotal)}&lt;/b&gt; steps this week"></p>
        ${barChart(week, stats.dailyGoal)}
      </section>

      <section class="chart-card" id="month">
        <h2>Last 30 days</h2>
        <p class="readout" data-default="Touch the chart to see a day"></p>
        ${lineChart(month, stats.dailyGoal)}
      </section>`;

    for (const out of el.querySelectorAll('.readout')) out.innerHTML = out.dataset.default;

    // Bars: tap or hover a day to read its value.
    const weekEl = el.querySelector('#week');
    const weekOut = weekEl.querySelector('.readout');
    const pickBar = (slot) => {
      weekEl.querySelector('.is-active')?.classList.remove('is-active');
      if (!slot) {
        weekOut.innerHTML = weekOut.dataset.default;
        return;
      }
      slot.classList.add('is-active');
      weekOut.innerHTML = readout(week[Number(slot.dataset.index)]);
    };
    weekEl.addEventListener('pointerover', (e) => pickBar(e.target.closest('.bar-slot')));
    weekEl.addEventListener('pointerdown', (e) => pickBar(e.target.closest('.bar-slot')));
    weekEl.addEventListener('pointerleave', () => pickBar(null));

    // Line: a crosshair that snaps to the nearest day.
    const monthEl = el.querySelector('#month');
    const monthOut = monthEl.querySelector('.readout');
    const svg = monthEl.querySelector('svg');
    const cross = svg.querySelector('.crosshair');
    const max = niceMax(Math.max(stats.dailyGoal, ...month.map((d) => d.steps)));
    const track = (event) => {
      const box = svg.getBoundingClientRect();
      const px = ((event.clientX - box.left) / box.width) * W;
      const i = Math.max(0, Math.min(month.length - 1, Math.round(((px - PAD.left) / PLOT_W) * (month.length - 1))));
      const cx = PAD.left + (PLOT_W * i) / (month.length - 1);
      const cy = PAD.top + PLOT_H * (1 - month[i].steps / max);
      cross.style.display = '';
      cross.querySelector('line').setAttribute('x1', cx);
      cross.querySelector('line').setAttribute('x2', cx);
      cross.querySelector('rect').setAttribute('x', cx - 4);
      cross.querySelector('rect').setAttribute('y', cy - 4);
      monthOut.innerHTML = readout(month[i]);
    };
    svg.addEventListener('pointermove', track);
    svg.addEventListener('pointerdown', track);
    svg.addEventListener('pointerleave', () => {
      cross.style.display = 'none';
      monthOut.innerHTML = monthOut.dataset.default;
    });
  }).catch((err) => toast(err.message, 'warn'));

  // Stats are fetched once per visit; state changes elsewhere don't redraw them.
  return { update() {}, destroy() { alive = false; } };
}

import { api } from '../api.js';
import { mountStepHistory, parse, shortDate } from '../charts.js';
import {
  distanceUnits, escapeHtml, fmt, fmtDistance, musicSettings, setDistanceUnits, setMusic, toast,
} from '../fx.js';
import { markVisibilityChosen } from '../gps.js';
import { app } from '../state.js';
import { walk } from '../steps.js';

const OUTCOME = { win: 'Won', loss: 'Lost', draw: 'Draw' };

// <option>s for a personality <select>: the presets from GET /api/personalities.
export const personalityOptions = (presets) => presets.map((p) => `
  <option value="${p.id}">${escapeHtml(`${p.name}: ${p.traits.join(', ')}`)}</option>`).join('');

// A sheet that slides up over the app; closes on the X or a tap outside it.
export function openSheet(label, html) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(label)}">${html}</div>`;
  document.body.append(overlay);
  const sheet = { overlay, onClose: () => {}, close: () => { overlay.remove(); sheet.onClose(); } };
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target.closest('[data-close]')) sheet.close();
  });
  return sheet;
}

export const stat = (label, value, kind = '') => `<div class="stat ${kind}"><small>${label}</small><b>${value}</b></div>`;

// The player's own numbers. walking is the answer from GET /api/stats, null until it arrives.
function statsHtml(walking) {
  const { user, record } = app.state;
  const w = (value) => (walking ? value(walking) : '…');
  const row = (label, value) => `<li><span>${label}</span><b>${value}</b></li>`;
  return `
    <h3>Battles</h3>
    <div class="record">
      ${stat('Wins', record.wins, 'is-win')}${stat('Losses', record.losses, 'is-loss')}${stat('Draws', record.draws)}
    </div>
    <h3>Walking</h3>
    <div class="bar" role="img" aria-label="${Math.floor((app.todaySteps / user.dailyGoal) * 100)}% of today's goal"><i
      style="width:${Math.min(100, (app.todaySteps / user.dailyGoal) * 100)}%"></i></div>
    <ul class="stat-list">
      ${row('Steps today', `${fmt(app.todaySteps)} of ${fmt(user.dailyGoal)}`)}
      ${row('Goal streak', w((s) => `${s.streak} ${s.streak === 1 ? 'day' : 'days'}`))}
      ${row('Best day', w((s) => (s.bestDay
        ? `${fmt(s.bestDay.steps)} steps · ${shortDate.format(parse(s.bestDay.date))}` : 'No walks yet')))}
      ${row('Total steps', fmt(user.totalSteps))}
      ${row('Distance', w((s) => fmtDistance(s.distanceKm * 1000, { decimals: 1, small: false })))}
      ${row('CO₂ saved vs driving', w((s) => `${s.co2SavedKg.toFixed(1)} kg`))}
    </ul>
    <h3>Wallet</h3>
    <ul class="stat-list">
      ${row('Stride Points', fmt(user.points))}
      ${row('Diamonds', fmt(app.diamonds))}
    </ul>`;
}

export async function openProfile() {
  const { user } = app.state;
  let walking = null;
  const sheet = openSheet('Profile', `<div class="profile">
      <div class="sheet-head">
        <h2>${escapeHtml(user.username)}</h2>
        <button class="icon-btn" data-close aria-label="Close">X</button>
      </div>
      <div class="segmented" role="tablist" aria-label="Profile">
        <button role="tab" aria-selected="true" data-profile-tab="stats">Stats</button>
        <button role="tab" aria-selected="false" data-profile-tab="settings">Settings</button>
      </div>
      <div class="profile-panel" data-panel="stats">
        <div class="sheet-section" id="player-stats">${statsHtml(walking)}</div>
        <h3>Step history</h3>
        <div class="sheet-section" id="charts"><p class="muted">Crunching your steps…</p></div>
        <h3>Recent battles</h3>
        <ul class="history" id="history"><li class="muted">Loading…</li></ul>
      </div>
      <div class="profile-panel" data-panel="settings" hidden>
        <div class="setting">
          <span class="setting-label">Distance units</span>
          <div class="segmented" role="radiogroup" aria-label="Distance units">${[['km', 'Kilometres'], ['mi', 'Miles']].map(([value, label]) => `
            <button type="button" role="radio" aria-checked="${distanceUnits() === value}" aria-selected="${distanceUnits() === value}"
              data-units="${value}">${label}</button>`).join('')}
          </div>
        </div>
        <div class="setting">
          <span class="setting-label">On friends' maps</span>
          <div class="segmented" role="radiogroup" aria-label="On friends' maps">${[['true', 'Visible'], ['false', 'Hidden']].map(([value, label]) => `
            <button type="button" role="radio" aria-checked="${String(user.mapVisible) === value}"
              aria-selected="${String(user.mapVisible) === value}" data-map-visible="${value}">${label}</button>`).join('')}
          </div>
        </div>
        <div class="setting">
          <span class="setting-label">Music</span>
          <div class="segmented" role="radiogroup" aria-label="Music">${[[true, 'On'], [false, 'Off']].map(([value, label]) => `
            <button type="button" role="radio" aria-checked="${musicSettings().on === value}"
              aria-selected="${musicSettings().on === value}" data-music="${value}">${label}</button>`).join('')}
          </div>
          <label class="volume">Volume
            <input type="range" id="music-volume" min="0" max="100" step="5" value="${Math.round(musicSettings().level * 100)}"
              ${musicSettings().on ? '' : 'disabled'}>
          </label>
        </div>
        <form id="profile-form">
          <label>Daily step goal
            <input name="dailyGoal" type="number" inputmode="numeric" min="500" max="50000" step="100" required
              value="${user.dailyGoal}">
          </label>
          <button class="btn btn-primary btn-block">Save</button>
        </form>
        <button class="btn btn-ghost btn-block" id="signout">Sign out</button>
      </div></div>`);
  const { overlay, close } = sheet;

  // A new goal or a change of units shows here straight away.
  const redraw = () => {
    if (app.state) overlay.querySelector('#player-stats').innerHTML = statsHtml(walking);
  };

  app.addEventListener('change', redraw);
  sheet.onClose = () => app.removeEventListener('change', redraw);

  overlay.querySelectorAll('[data-profile-tab]').forEach((tab) => tab.addEventListener('click', () => {
    overlay.querySelectorAll('[data-profile-tab]').forEach((t) => t.setAttribute('aria-selected', t === tab));
    overlay.querySelectorAll('[data-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tab.dataset.profileTab;
    });
  }));

  // Applies straight away, no Save needed: it only changes how distances are shown.
  overlay.querySelectorAll('[data-units]').forEach((button) => button.addEventListener('click', () => {
    setDistanceUnits(button.dataset.units);
    overlay.querySelectorAll('[data-units]').forEach((b) => {
      const on = b === button;
      b.setAttribute('aria-checked', on);
      b.setAttribute('aria-selected', on);
    });
    app.dispatchEvent(new Event('change'));
  }));

  // Saved straight away too; the Map tab asks this the first time it opens.
  overlay.querySelectorAll('[data-map-visible]').forEach((button) => button.addEventListener('click', async () => {
    try {
      app.setState(await api('/me', { method: 'PATCH', body: { mapVisible: button.dataset.mapVisible === 'true' } }));
      markVisibilityChosen();
      overlay.querySelectorAll('[data-map-visible]').forEach((b) => {
        const on = b === button;
        b.setAttribute('aria-checked', on);
        b.setAttribute('aria-selected', on);
      });
    } catch (err) {
      toast(err.message, 'warn');
    }
  }));

  // Music changes are heard straight away and remembered on this device.
  overlay.querySelectorAll('[data-music]').forEach((button) => button.addEventListener('click', () => {
    const on = button.dataset.music === 'true';
    setMusic({ on });
    overlay.querySelectorAll('[data-music]').forEach((b) => {
      b.setAttribute('aria-checked', b === button);
      b.setAttribute('aria-selected', b === button);
    });
    overlay.querySelector('#music-volume').disabled = !on;
  }));
  overlay.querySelector('#music-volume').addEventListener('input', (event) => {
    setMusic({ level: Number(event.target.value) / 100 });
  });

  overlay.querySelector('#profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.target.querySelector('button');
    button.disabled = true;
    try {
      app.setState(await api('/me', {
        method: 'PATCH', body: { dailyGoal: Number(new FormData(event.target).get('dailyGoal')) },
      }));
      toast('Saved!', 'good');
    } catch (err) {
      toast(err.message, 'warn');
    }
    button.disabled = false;
  });

  api('/stats').then((stats) => {
    walking = stats;
    redraw();
    mountStepHistory(overlay.querySelector('#charts'), stats);
  }).catch(() => {
    overlay.querySelector('#charts').innerHTML = '<p class="muted">Couldn\'t load your step history.</p>';
  });

  overlay.querySelector('#signout').addEventListener('click', async () => {
    await walk.stop();
    walk.reset();
    await api('/logout', { method: 'POST' }).catch(() => {});
    close();
    app.clear();
    app.dispatchEvent(new Event('signedout'));
  });

  try {
    const { history } = await api('/battles');
    overlay.querySelector('#history').innerHTML = history.length
      ? history.map((b) => `
          <li>
            <span class="tag is-${b.outcome}">${OUTCOME[b.outcome]}</span>
            <span class="history-who">${b.challenged ? 'vs' : 'challenged by'}
              <b>${escapeHtml(b.opponent.buddyName)}</b> <small>@${escapeHtml(b.opponent.username)}</small></span>
            <span class="history-score">${fmt(b.myDamage)}–${fmt(b.theirDamage)}</span>
          </li>`).join('')
      : '<li class="muted">No battles yet. Pick a fight in the Battle tab!</li>';
  } catch {
    overlay.querySelector('#history').innerHTML = '<li class="muted">Couldn\'t load battles.</li>';
  }
}

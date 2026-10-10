import { api } from '../api.js';
import { mountStepHistory, parse, shortDate } from '../charts.js';
import {
  avatarHtml, distanceUnits, escapeHtml, fmt, fmtDistance, musicSettings, setDistanceUnits, setMusic, toast,
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

// The profile picture with its buttons.
function pictureHtml() {
  const { user } = app.state;
  return `
    ${avatarHtml(user, 'avatar-large')}
    <div class="picture-actions">
      <button type="button" class="btn btn-small" data-picture="choose">${user.avatar ? 'Change picture' : 'Add a picture'}</button>
      ${user.avatar ? '<button type="button" class="btn btn-ghost btn-small" data-picture="remove">Remove</button>' : ''}
    </div>`;
}

// Pictures are cropped square and shrunk on the phone until they fit in a
// request, so a camera photo never has to be uploaded whole.
const PICTURE_MAX_CHARS = 8000;
async function shrinkPicture(file) {
  const image = await createImageBitmap(file);
  const side = Math.min(image.width, image.height);
  for (const size of [96, 64, 48]) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    canvas.getContext('2d')
      .drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, size, size);
    for (const quality of [0.8, 0.6, 0.4]) {
      const url = canvas.toDataURL('image/jpeg', quality);
      if (url.length <= PICTURE_MAX_CHARS) return url;
    }
  }
  throw new Error('That picture is too detailed. Try another one.');
}

export async function openProfile() {
  const { user } = app.state;
  let walking = null;
  const sheet = openSheet('Profile', `<div class="profile">
      <div class="sheet-head">
        <h2>${escapeHtml(user.username)}</h2>
        <button class="icon-btn" data-close aria-label="Close">X</button>
      </div>
      <div class="picture" id="picture">${pictureHtml()}</div>
      <input type="file" id="picture-file" accept="image/*" hidden>
      <div class="sheet-section" id="player-stats">${statsHtml(walking)}</div>
      <h3>Step history</h3>
      <div class="sheet-section" id="charts"><p class="muted">Crunching your steps…</p></div>
      <h3>Settings</h3>
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
      <h3>Recent battles</h3>
      <ul class="history" id="history"><li class="muted">Loading…</li></ul>
      <button class="btn btn-ghost btn-block" id="signout">Sign out</button></div>`);
  const { overlay, close } = sheet;

  // A new goal, picture or change of units shows here straight away.
  const redraw = () => {
    if (!app.state) return;
    overlay.querySelector('#player-stats').innerHTML = statsHtml(walking);
    overlay.querySelector('#picture').innerHTML = pictureHtml();
  };

  const savePicture = async (avatar) => {
    try {
      app.setState(await api('/me', { method: 'PATCH', body: { avatar } }));
    } catch (err) {
      toast(err.message, 'warn');
    }
  };
  const fileInput = overlay.querySelector('#picture-file');
  overlay.querySelector('#picture').addEventListener('click', (event) => {
    const action = event.target.closest('[data-picture]')?.dataset.picture;
    if (action === 'choose') fileInput.click();
    if (action === 'remove') savePicture(null);
  });
  fileInput.addEventListener('change', async () => {
    const [file] = fileInput.files;
    fileInput.value = ''; // so the same photo can be picked again
    if (!file) return;
    try {
      await savePicture(await shrinkPicture(file));
    } catch (err) {
      // createImageBitmap rejects files that aren't pictures it can read.
      toast(err.message.startsWith('That picture') ? err.message : 'That file isn\'t a picture this app can read.', 'warn');
    }
  });
  app.addEventListener('change', redraw);
  sheet.onClose = () => app.removeEventListener('change', redraw);

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

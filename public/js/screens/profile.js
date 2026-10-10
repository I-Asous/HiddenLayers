import { api, setToken } from '../api.js';
import { distanceUnits, escapeHtml, fmt, setDistanceUnits, toast } from '../fx.js';
import { app } from '../state.js';
import { walk } from '../steps.js';

const OUTCOME = { win: 'Won', loss: 'Lost', draw: 'Draw' };

// <option>s for a personality <select>: the presets from GET /api/personalities.
export const personalityOptions = (presets) => presets.map((p) => `
  <option value="${p.id}">${escapeHtml(`${p.name}: ${p.traits.join(', ')}`)}</option>`).join('');

export async function openProfile() {
  const { user, buddy, record } = app.state;
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Profile">
      <div class="sheet-head">
        <h2>${escapeHtml(user.username)}</h2>
        <button class="icon-btn" data-close aria-label="Close">X</button>
      </div>
      <p class="traits">${escapeHtml([
        `Feeling ${buddy.mood}`, ...(buddy.personality ? [...buddy.personality.traits, buddy.personality.quirk] : []),
      ].join(' · '))}</p>
      <div class="record">
        <div class="stat is-win"><small>Wins</small><b>${record.wins}</b></div>
        <div class="stat is-loss"><small>Losses</small><b>${record.losses}</b></div>
        <div class="stat"><small>Draws</small><b>${record.draws}</b></div>
      </div>
      <div class="setting">
        <span class="setting-label">Distance units</span>
        <div class="segmented" role="radiogroup" aria-label="Distance units">${[['km', 'Kilometres'], ['mi', 'Miles']].map(([value, label]) => `
          <button type="button" role="radio" aria-checked="${distanceUnits() === value}" aria-selected="${distanceUnits() === value}"
            data-units="${value}">${label}</button>`).join('')}
        </div>
      </div>
      <form id="profile-form">
        <label>Buddy name
          <input name="buddyName" maxlength="16" required value="${escapeHtml(buddy.name)}" autocomplete="off">
        </label>
        <label>Daily step goal
          <input name="dailyGoal" type="number" inputmode="numeric" min="500" max="50000" step="100" required
            value="${user.dailyGoal}">
        </label>
        <label>Personality
          <select name="personality">
            <option value="" selected>Keep current</option>
            <option value="surprise">Surprise me (new random one)</option>
          </select>
        </label>
        <button class="btn btn-primary btn-block">Save</button>
      </form>
      <h3>Recent battles</h3>
      <ul class="history" id="history"><li class="muted">Loading…</li></ul>
      <button class="btn btn-ghost btn-block" id="signout">Sign out</button>
    </div>`;
  document.body.append(overlay);
  const close = () => overlay.remove();

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target.closest('[data-close]')) close();
  });

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

  api('/personalities').then(({ personalities }) => {
    overlay.querySelector('[name=personality]')
      .insertAdjacentHTML('beforeend', personalityOptions(personalities));
  }).catch(() => {});

  overlay.querySelector('#profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const button = event.target.querySelector('button');
    button.disabled = true; // a new personality can take a moment to invent
    try {
      app.setState(await api('/me', {
        method: 'PATCH',
        body: {
          buddyName: form.get('buddyName'), dailyGoal: Number(form.get('dailyGoal')),
          personality: form.get('personality') || undefined,
        },
      }));
      toast('Saved!', 'good');
      close();
    } catch (err) {
      toast(err.message, 'warn');
      button.disabled = false;
    }
  });

  overlay.querySelector('#signout').addEventListener('click', async () => {
    await walk.stop();
    walk.reset();
    await api('/logout', { method: 'POST' }).catch(() => {});
    setToken(null);
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

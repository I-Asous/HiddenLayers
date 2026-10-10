import { api, setToken } from '../api.js';
import { escapeHtml, fmt, toast } from '../fx.js';
import { app } from '../state.js';
import { walk } from '../steps.js';

const OUTCOME = { win: 'Won', loss: 'Lost', draw: 'Draw' };

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
      <div class="record">
        <div class="stat is-win"><small>Wins</small><b>${record.wins}</b></div>
        <div class="stat is-loss"><small>Losses</small><b>${record.losses}</b></div>
        <div class="stat"><small>Draws</small><b>${record.draws}</b></div>
      </div>
      <form id="profile-form">
        <label>Buddy name
          <input name="buddyName" maxlength="16" required value="${escapeHtml(buddy.name)}" autocomplete="off">
        </label>
        <label>Daily step goal
          <input name="dailyGoal" type="number" inputmode="numeric" min="500" max="50000" step="100" required
            value="${user.dailyGoal}">
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

  overlay.querySelector('#profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      app.setState(await api('/me', {
        method: 'PATCH',
        body: { buddyName: form.get('buddyName'), dailyGoal: Number(form.get('dailyGoal')) },
      }));
      toast('Saved!', 'good');
      close();
    } catch (err) {
      toast(err.message, 'warn');
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

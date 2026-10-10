import { api } from '../api.js';
import { buddySvg, stageName } from '../buddy.js';
import { elementTag } from '../elements.js';
import { escapeHtml, fmt, toast } from '../fx.js';
import { app } from '../state.js';
import { openSheet, personalityOptions, stat } from './profile.js';

/**
 * One beast's card: what it is and how it's doing, with its name and
 * personality to edit. id is a resting beast's id, or null for the one walking
 * with the player.
 */
export function openBeast(id = null) {
  const walking = id === null;
  const beast = walking ? app.state.buddy : app.state.resting.find((b) => b.id === id);
  if (!beast) return;
  const tired = beast.restingUntil > Date.now();
  const status = [
    walking ? 'Walking with you' : 'Waiting at home',
    ...(walking ? [`Feeling ${beast.mood}`] : []),
    ...(tired ? ['Recovering from a lost battle'] : []),
  ];
  const sheet = openSheet(beast.name, `
      <div class="sheet-head">
        <h2>${escapeHtml(beast.name)}</h2>
        <button class="icon-btn" data-close aria-label="Close">X</button>
      </div>
      <div class="beast-card">
        <div class="item-art">${buddySvg(beast, { background: false, className: 'is-idle' })}</div>
        <div>
          <b>${stageName(beast)}</b> ${elementTag(beast.element)}
          <p>${escapeHtml(status.join(' · '))}</p>
          <p class="traits">${beast.personality
            ? escapeHtml([...beast.personality.traits, beast.personality.quirk].join(' · '))
            : 'Its personality will show once it walks and talks with you.'}</p>
        </div>
      </div>
      <div class="record record-4">
        ${stat('Level', beast.level)}${stat('XP', fmt(beast.xp))}${stat('Attack', beast.attack)}${stat('Evasion', beast.evasion)}
      </div>
      <form id="beast-form">
        <label>Name
          <input name="buddyName" maxlength="16" required value="${escapeHtml(beast.name)}" autocomplete="off">
        </label>
        <label>Personality
          <select name="personality">
            <option value="" selected>Keep current</option>
            <option value="surprise">Surprise me (new random one)</option>
          </select>
        </label>
        <button class="btn btn-primary btn-block">Save</button>
      </form>
      ${walking ? '' : '<button class="btn btn-block" id="walk-with">Walk with this beast</button>'}`);
  const { overlay, close } = sheet;

  api('/personalities').then(({ personalities }) => {
    overlay.querySelector('[name=personality]')
      .insertAdjacentHTML('beforeend', personalityOptions(personalities));
  }).catch(() => {});

  overlay.querySelector('#beast-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const button = event.target.querySelector('button');
    button.disabled = true; // a new personality can take a moment to invent
    try {
      app.setState(await api('/me', {
        method: 'PATCH',
        body: {
          ...(walking ? {} : { beastId: id }),
          buddyName: form.get('buddyName'), personality: form.get('personality') || undefined,
        },
      }));
      toast('Saved!', 'good');
      close();
    } catch (err) {
      toast(err.message, 'warn');
      button.disabled = false;
    }
  });

  overlay.querySelector('#walk-with')?.addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      app.setState(await api('/buddy/switch', { method: 'POST', body: { id } }));
      toast(`${app.state.buddy.name} is walking with you now.`, 'good');
      close();
    } catch (err) {
      toast(err.message, 'warn');
      event.target.disabled = false;
    }
  });
}

import { api, handleSignedOut, hasToken, setToken } from './api.js';
import { SPECIES, buddySvg } from './buddy.js';
import { toast } from './fx.js';
import { app } from './state.js';
import { walk } from './steps.js';
import * as battle from './screens/battle.js';
import * as home from './screens/home.js';
import * as map from './screens/map.js';
import { personalityOptions } from './screens/profile.js';
import * as stats from './screens/stats.js';
import * as store from './screens/store.js';
import * as walkScreen from './screens/walk.js';

const SCREENS = { home, walk: walkScreen, map, store, battle, stats };
// Drawn on a 12×12 pixel grid.
const TAB_ICONS = {
  home: '<path d="M5 1h2v1h1v1h1v1h1v1h1v1h-1v5h-3v-3h-2v3h-3v-5h-1v-1h1v-1h1v-1h1v-1h1z"/>',
  walk: '<path d="M4 1h4v6h2v1h1v1h1v2h-8z"/>',
  map: '<path fill-rule="evenodd" d="M4 1h4v1h1v1h1v4h-1v1h-1v1h-1v2h-2v-2h-1v-1h-1v-1h-1v-4h1v-1h1zM5 4v2h2v-2z"/>',
  store: '<path fill-rule="evenodd" d="M4 1h4v2h2v8h-8v-8h2zM5 2v1h2v-1z"/>',
  battle: '<path d="M9 1h2v2h-1v1h-1v1h-1v1h-1v1h1v1h-1v-1h-1v1h-1v1h-1v1h-2v-2h1v-1h1v-1h1v-1h-1v-1h1v1h1v-1h1v-1h1v-1h1v-1h1z"/>',
  stats: '<path d="M1 7h2v4h-2zM5 3h2v8h-2zM9 5h2v6h-2z"/>',
};
const TAB_LABELS = { home: 'Home', walk: 'Walk', map: 'Map', store: 'Store', battle: 'Battle', stats: 'Stats' };

const root = document.getElementById('app');
let current = null; // { name, screen }

function tabFromHash() {
  const name = location.hash.slice(1);
  return name in SCREENS ? name : 'home';
}

function showLogin() {
  current?.screen.destroy();
  current = null;
  root.innerHTML = `
    <main class="login">
      <h1>StepBuddy</h1>
      <p>Hatch a mythical beast and raise it with every step you take.</p>
      <form id="login-form">
        <label>Username
          <input name="username" required minlength="2" maxlength="20" pattern="[A-Za-z0-9_]+"
            autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="e.g. sam_walks">
        </label>
        <fieldset class="species">
          <legend>Choose your beast <small>(new players)</small></legend>
          ${Object.entries(SPECIES).map(([id, species], i) => `
            <label class="species-option">
              <input type="radio" name="species" value="${id}" ${i === 0 ? 'checked' : ''}>
              ${buddySvg({ species: id, stage: 'adult' }, { background: false, className: 'is-idle' })}
              <span>${species.name}</span>
            </label>`).join('')}
        </fieldset>
        <label>Name your buddy <small>(new players)</small>
          <input name="buddyName" maxlength="16" autocomplete="off" placeholder="Buddy">
        </label>
        <label>Personality <small>(new players)</small>
          <select name="personality">
            <option value="" selected>Surprise me</option>
          </select>
        </label>
        <button class="btn btn-primary btn-block btn-xl">Start</button>
        <p class="hint">No password needed. Returning? Just enter your username.</p>
      </form>
    </main>`;
  api('/personalities').then(({ personalities }) => {
    root.querySelector('[name=personality]')?.insertAdjacentHTML('beforeend', personalityOptions(personalities));
  }).catch(() => {});
  root.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const button = event.target.querySelector('button');
    button.disabled = true;
    try {
      const result = await api('/login', {
        method: 'POST',
        body: {
          username: form.get('username').trim(),
          buddyName: form.get('buddyName'),
          species: form.get('species'),
          personality: form.get('personality'),
        },
      });
      setToken(result.token);
      app.setState(result);
      showApp();
    } catch (err) {
      toast(err.message, 'warn');
      button.disabled = false;
    }
  });
}

function showApp() {
  root.innerHTML = `
    <main id="screen" class="screen"></main>
    <nav class="tabbar" aria-label="Main">
      ${Object.keys(SCREENS).map((name) => `
        <a href="#${name}" data-tab="${name}">
          <svg viewBox="0 0 12 12" width="24" height="24" fill="currentColor" shape-rendering="crispEdges"
            aria-hidden="true">${TAB_ICONS[name]}</svg>
          <span>${TAB_LABELS[name]}</span>
        </a>`).join('')}
    </nav>`;
  showTab(tabFromHash());
}

function showTab(name) {
  const screenEl = document.getElementById('screen');
  if (!screenEl) return;
  current?.screen.destroy();
  screenEl.dataset.tab = name;
  screenEl.scrollTop = 0;
  current = { name, screen: SCREENS[name].mount(screenEl) };
  for (const link of root.querySelectorAll('[data-tab]')) {
    if (link.dataset.tab === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

addEventListener('hashchange', () => {
  if (app.state) showTab(tabFromHash());
});
app.addEventListener('change', () => current?.screen.update());
app.addEventListener('signedout', showLogin);
handleSignedOut(() => {
  walk.reset();
  app.clear();
  showLogin();
});

// Save steps when the app is backgrounded: phones may freeze or kill the page
// without another chance to sync.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') walk.sync({ keepalive: true });
  else walk.resume();
});

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (!hasToken()) return showLogin();
  try {
    await app.refresh();
  } catch (err) {
    if (err.status === 401) return; // handleSignedOut already showed the login
    root.innerHTML = `<main class="login"><h1>StepBuddy</h1><p>Can't reach the server. Check your connection.</p>
      <button class="btn btn-primary" onclick="location.reload()">Try again</button></main>`;
    return;
  }
  showApp();
  walk.recover();
}

boot();

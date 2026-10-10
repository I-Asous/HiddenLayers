import { api, clearLegacyToken, handleSignedOut, legacyToken } from './api.js';
import { toast } from './fx.js';
import { app } from './state.js';
import { walk } from './steps.js';
import * as battle from './screens/battle.js';
import * as home from './screens/home.js';
import * as map from './screens/map.js';
import { personalityOptions } from './screens/profile.js';
import * as store from './screens/store.js';
import * as walkScreen from './screens/walk.js';

const SCREENS = { home, walk: walkScreen, map, battle, store };
// Drawn on a 12×12 pixel grid.
const TAB_ICONS = {
  home: '<path d="M5 1h2v1h1v1h1v1h1v1h1v1h-1v5h-3v-3h-2v3h-3v-5h-1v-1h1v-1h1v-1h1v-1h1z"/>',
  walk: '<path d="M4 1h4v6h2v1h1v1h1v2h-8z"/>',
  map: '<path fill-rule="evenodd" d="M4 1h4v1h1v1h1v4h-1v1h-1v1h-1v2h-2v-2h-1v-1h-1v-1h-1v-4h1v-1h1zM5 4v2h2v-2z"/>',
  store: '<path fill-rule="evenodd" d="M4 1h4v2h2v8h-8v-8h2zM5 2v1h2v-1z"/>',
  battle: '<path d="M9 1h2v2h-1v1h-1v1h-1v1h-1v1h1v1h-1v-1h-1v1h-1v1h-1v1h-2v-2h1v-1h1v-1h1v-1h-1v-1h1v1h1v-1h1v-1h1v-1h1v-1h1z"/>',
};
const TAB_LABELS = { home: 'Home', walk: 'Walk', map: 'Map', store: 'Store', battle: 'Battle' };

const root = document.getElementById('app');
let current = null; // { name, screen }

function tabFromHash() {
  const name = location.hash.slice(1);
  return name in SCREENS ? name : 'home';
}

// Remembered so a player who has signed in here before gets the short form.
const USERNAME_KEY = 'stepbuddy.username';

function lastUsername() {
  try {
    return localStorage.getItem(USERNAME_KEY) ?? '';
  } catch {
    return '';
  }
}

const escapeAttr = (value) => value.replace(/[^A-Za-z0-9_]/g, '');

const LOGIN_INTRO = {
  login: 'Welcome back! Your buddy is waiting.',
  signup: 'Hatch a mythical beast and raise it with every step you take.',
  beast: 'A mystery egg is waiting for you. Walk to find out what hatches!',
  claim: 'Accounts now need a password. Set one to keep your buddy safe.',
};

const PASSWORD_RULES = 'At least 8 characters, with a letter and a number.';

// The same rules the server checks (server/auth.js), so most mistakes show
// before anything is sent.
function passwordProblem(password, confirm, username) {
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (password.length > 128) return 'Password must be at most 128 characters';
  if (!/\p{L}/u.test(password) || !/\p{N}/u.test(password)) return 'Password needs at least one letter and one number';
  if (password.toLowerCase() === username.toLowerCase()) return 'Password can\'t be your username';
  if (password !== confirm) return 'Passwords don\'t match';
  return null;
}

const passwordField = (name, label, autocomplete) => `
        <label>${label}
          <input name="${name}" type="password" required minlength="8" maxlength="128" autocomplete="${autocomplete}">
        </label>`;

// "login" asks returning players for their username and password. New players
// get two steps: "signup" picks a free username and a password (typed twice),
// then "beast" names the buddy that will hatch from their random egg. "claim"
// is for accounts made before passwords: the device that still holds the old
// sign-in sets the password once.
function showLogin(mode = legacyToken() ? 'claim' : lastUsername() ? 'login' : 'signup', username = lastUsername()) {
  current?.screen.destroy();
  current = null;
  username = escapeAttr(username);
  const usernameField = `
        <label>${mode === 'signup' ? 'Choose a username' : 'Username'}
          <input name="username" required minlength="2" maxlength="20" pattern="[A-Za-z0-9_]+" value="${username}"
            autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="e.g. sam_walks">
        </label>`;
  const fields = {
    login: usernameField + passwordField('password', 'Password', 'current-password'),
    signup: usernameField
      + passwordField('password', 'Choose a password', 'new-password')
      + passwordField('confirmPassword', 'Type it again', 'new-password')
      + `<p class="hint hint-top">${PASSWORD_RULES}</p>`,
    beast: `
        <p class="hint hint-top">Username: ${username}</p>
        <label>Name your buddy
          <input name="buddyName" maxlength="16" autocomplete="off" placeholder="Buddy">
        </label>
        <label>Personality
          <select name="personality">
            <option value="" selected>Surprise me</option>
          </select>
        </label>`,
    claim: (username ? `<p class="hint hint-top">Username: ${username}</p>` : '')
      + passwordField('password', 'New password', 'new-password')
      + passwordField('confirmPassword', 'Type it again', 'new-password')
      + `<p class="hint hint-top">${PASSWORD_RULES}</p>`,
  }[mode];
  root.innerHTML = `
    <main class="login">
      <h1>Wanderling</h1>
      <p>${LOGIN_INTRO[mode]}</p>
      <form id="login-form">
        ${fields}
        <button class="btn btn-primary btn-block btn-xl">${{ login: 'Log in', signup: 'Next', beast: 'Start', claim: 'Set password' }[mode]}</button>
      </form>
      <button class="btn btn-ghost btn-block" id="login-switch">
        ${{ login: 'New here? Hatch a buddy', signup: 'Already have a buddy? Log in', beast: 'Back', claim: 'Use a different account' }[mode]}
      </button>
    </main>`;
  const form = root.querySelector('#login-form');
  const typedUsername = () => form.elements.username?.value.trim() ?? username;
  if (mode === 'beast') {
    api('/personalities').then(({ personalities }) => {
      root.querySelector('[name=personality]')?.insertAdjacentHTML('beforeend', personalityOptions(personalities));
    }).catch(() => {});
  }
  root.querySelector('#login-switch').addEventListener('click', () => {
    if (mode === 'claim') clearLegacyToken();
    if (mode !== 'beast') pendingPassword = null;
    showLogin({ login: 'signup', signup: 'login', beast: 'signup', claim: 'login' }[mode], typedUsername());
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const button = form.querySelector('button');
    const password = String(data.get('password') ?? '');
    const confirmPassword = String(data.get('confirmPassword') ?? '');
    if (mode === 'signup' || mode === 'claim') {
      const problem = passwordProblem(password, confirmPassword, typedUsername());
      if (problem) return toast(problem, 'warn');
    }
    button.disabled = true;
    try {
      if (mode === 'signup') {
        const { available } = await api(`/username?name=${encodeURIComponent(typedUsername())}`);
        if (available) {
          // Kept in memory only, until the beast step sends it.
          pendingPassword = { password, confirmPassword };
          return showLogin('beast', typedUsername());
        }
        toast('That username is taken. Try another one.', 'warn');
        button.disabled = false;
        return;
      }
      let result;
      if (mode === 'login') {
        result = await api('/login', { method: 'POST', body: { username: typedUsername(), password } });
      } else if (mode === 'claim') {
        result = await api('/claim', { method: 'POST', body: { legacyToken: legacyToken(), password, confirmPassword } });
        clearLegacyToken();
      } else {
        if (!pendingPassword) return showLogin('signup', typedUsername());
        result = await api('/signup', {
          method: 'POST',
          body: {
            username: typedUsername(), ...pendingPassword,
            buddyName: data.get('buddyName'), personality: data.get('personality'),
          },
        });
        pendingPassword = null;
      }
      try {
        localStorage.setItem(USERNAME_KEY, result.username ?? result.user.username);
      } catch {}
      app.setState(result);
      showApp();
    } catch (err) {
      // The old sign-in on this device is gone or already used: sign in normally.
      if (err.status === 403 && mode === 'claim') {
        clearLegacyToken();
        toast(err.message, 'warn');
        return showLogin('login', typedUsername());
      }
      // Someone took the name while this player was choosing their beast.
      if (err.status === 409 && mode === 'beast') {
        toast('That username was just taken. Try another one.', 'warn');
        pendingPassword = null;
        return showLogin('signup', typedUsername());
      }
      toast(err.message, 'warn');
      if (mode === 'login') form.elements.password.value = '';
      button.disabled = false;
    }
  });
}

// The password chosen on the sign-up step, held until the beast step submits.
let pendingPassword = null;

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
  showAnnouncement();
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
app.addEventListener('signedout', () => showLogin());
handleSignedOut(() => {
  walk.reset();
  app.clear();
  showLogin();
});

// Save steps when the app is backgrounded: phones may freeze or kill the page
// without another chance to sync.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') return walk.sync({ keepalive: true });
  walk.resume();
  refreshOnNewDay();
});

// Today's steps start again from zero at midnight. The server counts them by
// the player's own day, so an app left open (or reopened the next morning)
// only has to ask again once the date changes.
let shownDay = new Date().toDateString();
function refreshOnNewDay() {
  const today = new Date().toDateString();
  if (today === shownDay || !app.state) return;
  shownDay = today;
  // On a failure, forget the day so the next check tries again.
  app.refresh().catch(() => { shownDay = null; });
}
setInterval(refreshOnNewDay, 30_000);

// Announcements from the admins arrive with the server state. Each is shown
// once per device, as soon as the app is open on its main screens.
const ANNOUNCEMENT_KEY = 'stepbuddy.announcement-seen';
function showAnnouncement() {
  const announcement = app.state?.announcement;
  if (!announcement || !document.getElementById('screen') || document.querySelector('.overlay')) return;
  let seen = 0;
  try {
    seen = Number(localStorage.getItem(ANNOUNCEMENT_KEY)) || 0;
  } catch {}
  if (announcement.id <= seen) return;
  const overlay = document.createElement('div');
  overlay.className = 'overlay evolution';
  overlay.innerHTML = `
    <div class="evolution-card" role="dialog" aria-modal="true" aria-label="Announcement">
      <p class="eyebrow">Announcement</p>
      <p class="announcement"></p>
      <button class="btn btn-primary btn-block">Got it</button>
    </div>`;
  // As text, never HTML: the message is whatever was typed into the dashboard.
  overlay.querySelector('.announcement').textContent = announcement.message;
  overlay.querySelector('button').addEventListener('click', () => {
    try {
      localStorage.setItem(ANNOUNCEMENT_KEY, String(announcement.id));
    } catch {}
    overlay.remove();
    showAnnouncement(); // a newer one may have arrived while this was open
  });
  document.body.append(overlay);
}
app.addEventListener('change', showAnnouncement);
// A player who leaves the app open still hears about a new one within a couple of minutes.
setInterval(() => {
  if (app.state && document.visibilityState === 'visible') app.refresh().catch(() => {});
}, 120_000);

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  // The session cookie can't be read from here, so ask the server who this is.
  try {
    await app.refresh();
  } catch (err) {
    if (err.status === 401) return; // handleSignedOut already showed the login
    root.innerHTML = `<main class="login"><h1>Wanderling</h1><p>Can't reach the server. Check your connection.</p>
      <button class="btn btn-primary" id="retry">Try again</button></main>`;
    root.querySelector('#retry').addEventListener('click', () => location.reload());
    return;
  }
  showApp();
  walk.recover();
}

boot();

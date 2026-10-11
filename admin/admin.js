// The admin dashboard: every player with their stats, tools to fix an account
// or hand things out, how the game is doing, and the numbers that tune it. It
// talks to /api/admin/*, which only answers to the ADMIN_KEY set in the
// server's environment.

const KEY_STORE = 'stepbuddy.admin-key';
const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const day = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
const moment = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dateOf = (timestamp) => (timestamp ? day.format(new Date(timestamp)) : 'Never');
const timeOf = (timestamp) => moment.format(new Date(timestamp));
// "5 min ago", "3 h ago", then the date.
function ago(timestamp) {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} h ago`;
  return dateOf(timestamp);
}

// The key is kept for this browser tab only, so closing the tab locks the dashboard.
let key = sessionStorage.getItem(KEY_STORE) ?? '';
let players = [];
let catalog = { items: [], species: [] };
let sort = { column: 'username', descending: false };
let tab = 'players';

async function api(path, body) {
  const res = await fetch(`/api/admin${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'x-admin-key': key, 'x-tz-offset': String(new Date().getTimezoneOffset()),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? 'Something went wrong');
    err.status = res.status;
    throw err;
  }
  return data;
}

// Text always goes in as text, never as HTML: names are whatever players typed.
function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

function button(label, onClick, className = '') {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

/** A table from headings and rows of cells; a cell is text, a node, or { text, num }. */
function table(headings, rows, { onRow } = {}) {
  const head = el('tr', '', ...headings.map((h) => el('th', h.num ? 'num' : '', el('span', 'th-text', h.label ?? h))));
  const body = rows.map((cells, i) => {
    const row = el('tr', onRow ? 'clickable' : '', ...cells.map((cell, c) => {
      const numeric = headings[c]?.num;
      return el('td', `${numeric ? 'num' : ''} ${cell?.className ?? ''}`, cell?.node ?? cell);
    }));
    if (onRow) row.addEventListener('click', () => onRow(i));
    return row;
  });
  return el('div', 'table-wrap', el('table', '', el('thead', '', head), el('tbody', '', ...body)));
}

let toastTimer;
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
}

/** Runs an admin action; a failure is shown rather than thrown. Returns whether it worked. */
async function act(action, done) {
  try {
    const result = await action();
    if (done) toast(typeof done === 'function' ? done(result) : done);
    return true;
  } catch (err) {
    if (err.status === 401) showGate('That key was not accepted.');
    else toast(err.message);
    return false;
  }
}

// ---------- Players ----------

// Each column: its heading, the value it sorts by, and how its cell is drawn.
const COLUMNS = [
  {
    id: 'username', label: 'Player', value: (p) => p.username.toLowerCase(),
    // The tags only show when they apply; append() would print a skipped one as "false".
    cell: (p, td) => td.append(...[
      p.online && el('span', 'dot', ''),
      p.username,
      p.demo && el('span', 'tag', 'demo'),
      p.suspended && el('span', 'tag warn', 'suspended'),
      p.flags > 0 && el('span', 'tag warn', `${p.flags} flagged`),
      el('span', 'sub', `Joined ${dateOf(p.joined)}`),
    ].filter(Boolean)),
  },
  {
    id: 'level', label: 'Beast', value: (p) => p.buddy.level,
    cell: (p, td) => td.append(
      `${p.buddy.name} · Lv ${p.buddy.level}`,
      el('span', 'sub', `${p.buddy.stage} ${p.buddy.species}${p.beasts > 1 ? ` · ${p.beasts} beasts` : ''}`),
    ),
  },
  { id: 'points', label: 'Stride Points', numeric: true, value: (p) => p.points, cell: (p, td) => td.append(fmt(p.points)) },
  { id: 'diamonds', label: 'Diamonds', numeric: true, value: (p) => p.diamonds, cell: (p, td) => td.append(fmt(p.diamonds)) },
  { id: 'totalSteps', label: 'Total steps', numeric: true, value: (p) => p.totalSteps, cell: (p, td) => td.append(fmt(p.totalSteps)) },
  {
    id: 'weekSteps', label: 'Last 7 days', numeric: true, value: (p) => p.weekSteps,
    cell: (p, td) => td.append(fmt(p.weekSteps), el('span', 'sub', `goal ${fmt(p.dailyGoal)}/day`)),
  },
  {
    id: 'lastSeen', label: 'Last seen', value: (p) => (p.online ? Infinity : p.lastSeen ?? 0),
    cell: (p, td) => td.append(p.online ? el('span', 'win', 'Online now') : p.lastSeen ? ago(p.lastSeen) : 'Not yet seen'),
  },
  { id: 'lastWalk', label: 'Last walk', value: (p) => p.lastWalk ?? 0, cell: (p, td) => td.append(dateOf(p.lastWalk)) },
  {
    id: 'wins', label: 'Battles', numeric: true, value: (p) => p.wins,
    cell: (p, td) => td.append(el('span', 'win', `${p.wins}W`), ' ', el('span', 'loss', `${p.losses}L`), ` ${p.draws}D`),
  },
  { id: 'friends', label: 'Friends', numeric: true, value: (p) => p.friends, cell: (p, td) => td.append(fmt(p.friends)) },
  {
    id: 'gifted', label: 'Gifted so far', numeric: true, value: (p) => p.gifted.points + p.gifted.diamonds,
    cell: (p, td) => td.append(p.gifted.points || p.gifted.diamonds
      ? `${fmt(p.gifted.points)} pts · ${fmt(p.gifted.diamonds)} dia` : '–'),
  },
];

function renderHead() {
  $('head').replaceChildren(...COLUMNS.map((column) => {
    const th = el('th', column.numeric ? 'num' : '');
    if (sort.column === column.id) th.setAttribute('aria-sort', sort.descending ? 'descending' : 'ascending');
    th.append(button(column.label, () => {
      // A new column starts with its biggest values first, except names.
      sort = sort.column === column.id
        ? { column: column.id, descending: !sort.descending }
        : { column: column.id, descending: column.id !== 'username' };
      renderPlayers();
    }));
    return th;
  }), el('th'));
}

function visiblePlayers() {
  const query = $('search').value.trim().toLowerCase();
  const hideDemo = $('hide-demo').checked;
  const { value } = COLUMNS.find((column) => column.id === sort.column);
  return players
    .filter((p) => !(hideDemo && p.demo))
    .filter((p) => !$('online-only').checked || p.online)
    .filter((p) => !query || `${p.username} ${p.buddy.name} ${p.buddy.species}`.toLowerCase().includes(query))
    .sort((a, b) => {
      const [x, y] = [value(a), value(b)];
      return (x < y ? -1 : x > y ? 1 : 0) * (sort.descending ? -1 : 1);
    });
}

function renderPlayers() {
  renderHead();
  const shown = visiblePlayers();
  $('rows').replaceChildren(...shown.map((player) => {
    const row = el('tr');
    for (const column of COLUMNS) {
      const td = el('td', column.numeric ? 'num' : '');
      column.cell(player, td);
      row.append(td);
    }
    const open = button('Open', () => openPlayer(player.id));
    open.setAttribute('aria-label', `Open ${player.username}`);
    row.append(el('td', '', open));
    return row;
  }));
  $('empty').hidden = shown.length > 0;
  $('count').textContent = `${shown.length} of ${players.length} players`;

  const sum = (pick) => shown.reduce((total, p) => total + pick(p), 0);
  const weekAgo = Date.now() - 7 * 86_400_000;
  $('totals').replaceChildren(...[
    ['Players', shown.length],
    ['Online now', shown.filter((p) => p.online).length],
    ['Walked in the last 7 days', shown.filter((p) => p.lastWalk >= weekAgo).length],
    ['Total steps', sum((p) => p.totalSteps)],
    ['Stride Points held', sum((p) => p.points)],
    ['Diamonds held', sum((p) => p.diamonds)],
  ].map(([label, value]) => el('div', 'total', el('small', '', label), el('b', '', fmt(value)))));
}

async function loadPlayers() {
  ({ players } = await api('/players'));
  renderPlayers();
}

// The rows on screen, as a spreadsheet. Quotes guard commas; a leading ' stops
// a name starting with = + - @ from being run as a formula when it is opened.
function exportCsv() {
  const safe = (value) => {
    const text = String(value ?? '');
    return `"${(/^[=+\-@]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
  };
  const header = ['id', 'username', 'joined', 'online', 'last_seen', 'suspended', 'demo', 'stride_points', 'diamonds', 'total_steps', 'steps_last_7_days',
    'daily_goal', 'last_walk', 'beast', 'species', 'level', 'beasts', 'wins', 'losses', 'draws', 'friends',
    'gifted_points', 'gifted_diamonds', 'flagged_walks'];
  const iso = (timestamp) => (timestamp ? new Date(timestamp).toISOString() : '');
  const lines = visiblePlayers().map((p) => [
    p.id, p.username, iso(p.joined), p.online, iso(p.lastSeen), p.suspended, p.demo, p.points, p.diamonds, p.totalSteps, p.weekSteps, p.dailyGoal,
    iso(p.lastWalk), p.buddy.name, p.buddy.species, p.buddy.level, p.beasts, p.wins, p.losses, p.draws, p.friends,
    p.gifted.points, p.gifted.diamonds, p.flags,
  ].map(safe).join(','));
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([`${header.join(',')}\n${lines.join('\n')}\n`], { type: 'text/csv' }));
  link.download = `wanderling-players-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

// ---------- One player ----------

async function openPlayer(id) {
  let player;
  if (!await act(async () => { player = await api(`/player?id=${id}`); })) return;
  const dialog = $('player');
  // After any change: reload this player and the list behind it.
  const again = async () => {
    await act(loadPlayers);
    openPlayer(id);
  };
  const run = (action, done) => async () => { if (await act(action, done)) again(); };

  const tags = [
    player.demo && el('span', 'tag', 'demo'),
    player.suspended && el('span', 'tag warn', 'suspended'),
  ];
  const head = el('div', 'player-head',
    el('div', '',
      el('h2', '', player.username, ...tags),
      el('p', 'note', `Joined ${dateOf(player.joined)} · ${fmt(player.points)} Stride Points · ${fmt(player.diamonds)} diamonds · `
        + `${fmt(player.totalSteps)} steps · goal ${fmt(player.dailyGoal)}/day · ${player.sessions} signed-in ${player.sessions === 1 ? 'device' : 'devices'}`)),
    button('Close', () => dialog.close(), 'quiet'));

  const actions = el('div', 'actions',
    button('Gift or take currency', () => openGift(player, again)),
    button('Rename', async () => {
      const username = prompt(`New username for ${player.username}:`, player.username);
      if (username && username !== player.username) run(() => api('/rename', { userId: id, username }), 'Renamed.')();
    }, 'quiet'),
    button('Sign out everywhere', run(
      () => api('/signout', { userId: id }),
      (result) => `Ended ${result.sessions} ${result.sessions === 1 ? 'session' : 'sessions'}.`,
    ), 'quiet'),
    player.suspended
      ? button('Lift suspension', run(() => api('/suspend', { userId: id, suspended: false }), 'Suspension lifted.'), 'quiet')
      : button('Suspend', () => {
        if (confirm(`Suspend ${player.username}? They are signed out, can't sign back in, and drop off the leaderboards.`)) {
          run(() => api('/suspend', { userId: id, suspended: true }), 'Suspended.')();
        }
      }, 'danger'),
    button('Delete account', async () => {
      const typed = prompt(`This permanently deletes ${player.username}, their beasts, steps, battles and friends. It can't be undone.\n\nType their username to confirm:`);
      if (typed === null) return;
      if (await act(() => api('/delete', { userId: id, confirm: typed }), `${player.username} was deleted.`)) {
        dialog.close();
        act(loadPlayers);
      }
    }, 'danger'));

  // Things to hand out: whatever they don't have yet.
  const owned = new Set(player.items.map((item) => item.id));
  const species = new Set(player.beasts.map((beast) => beast.species));
  const itemSelect = el('select', '', ...catalog.items.filter((item) => !owned.has(item.id))
    .map((item) => Object.assign(el('option', '', `${item.name} (${item.slot})`), { value: item.id })));
  const beastSelect = el('select', '', ...catalog.species.filter((name) => !species.has(name))
    .map((name) => Object.assign(el('option', '', name), { value: name })));
  const give = el('div', 'give',
    itemSelect, button('Give item', run(() => api('/give-item', { userId: id, itemId: itemSelect.value }), 'Item given.'), 'small'),
    beastSelect, button('Give beast', run(() => api('/give-beast', { userId: id, species: beastSelect.value }), 'Egg given.'), 'small'));

  const beasts = table(
    ['Beast', 'Species', { label: 'Level', num: true }, { label: 'Attack', num: true }, { label: 'Evasion', num: true }, 'Rest', ''],
    player.beasts.map((beast) => {
      const field = (value, className = '') => Object.assign(el('input', `inline-input ${className}`), { value, type: className ? 'text' : 'number' });
      const [name, level, attack, evasion] = [field(beast.name, 'name'), field(beast.level), field(beast.attack), field(beast.evasion)];
      name.maxLength = 16;
      const beastId = beast.id ?? undefined;
      return [
        { node: el('span', '', name, beast.walking && el('span', 'tag', 'walking')) },
        `${beast.stage} ${beast.species}`,
        { node: level }, { node: attack }, { node: evasion },
        { node: beast.restingUntil
          ? button(`End rest (${timeOf(beast.restingUntil)})`, run(() => api('/beast', { userId: id, beastId, clearRest: true }), 'Rest ended.'), 'quiet small')
          : el('span', 'sub', 'ready') },
        { node: button('Save', run(() => api('/beast', {
          userId: id, beastId, name: name.value, level: Number(level.value), attack: Number(attack.value), evasion: Number(evasion.value),
        }), 'Beast saved.'), 'small') },
      ];
    }),
  );

  const list = (title, items, empty) => el('div', '',
    el('h3', '', title),
    items.length ? el('ul', 'plain', ...items.map((item) => el('li', '', ...item))) : el('p', 'note', empty));
  const columns = el('div', 'columns',
    list('Recent walks', player.walks.map((walk) => [`${fmt(walk.steps)} steps`, el('span', 'sub', ` · ${timeOf(walk.at)} · ${walk.minutes} min`)]), 'No walks yet.'),
    list('Recent battles', player.battles.map((battle) => [
      el('span', battle.outcome === 'win' ? 'win' : battle.outcome === 'loss' ? 'loss' : '', battle.outcome),
      ` ${battle.challenged ? 'vs' : 'challenged by'} ${battle.other}`, el('span', 'sub', ` · ${timeOf(battle.at)}`),
    ]), 'No battles yet.'),
    list('Items', player.items.map((item) => [item.name, el('span', 'sub', ` · ${item.slot}`)]), 'Owns no items.'),
    list('Friends', player.friends.map((name) => [name]), 'No friends yet.'),
    list('Flagged walks', player.flags.map((flag) => [flag.reason, el('span', 'sub', ` · ${timeOf(flag.at)} · ${fmt(flag.points)} points`)]), 'Nothing flagged in the last 30 days.'),
    list('Admin history', player.log.map((entry) => [`${entry.action}${entry.detail ? `: ${entry.detail}` : ''}`, el('span', 'sub', ` · ${timeOf(entry.at)}`)]), 'No admin actions yet.'));

  dialog.replaceChildren(head, actions, give, el('h3', '', 'Beasts'), beasts, columns);
  if (!dialog.open) dialog.showModal();
}

// ---------- Gifting ----------

// to is a player, or null to gift everyone. after runs once a gift has gone through.
let gift = { to: null, after: () => {} };

function openGift(to, after) {
  gift = { to, after };
  $('gift-title').textContent = to ? `Gift to ${to.username}` : 'Gift to every player';
  $('gift-balance').textContent = to
    ? `Has ${fmt(to.points)} Stride Points and ${fmt(to.diamonds)} diamonds.`
    : 'Goes to every player who isn\'t suspended.';
  $('gift-take').hidden = !to;
  $('gift-demo-row').hidden = Boolean(to);
  $('gift-demo').checked = false;
  $('gift-points').value = '';
  $('gift-diamonds').value = '';
  $('gift-error').textContent = '';
  $('gift').showModal();
  $('gift-points').focus();
}

async function sendGift(sign) {
  const points = Number($('gift-points').value || 0);
  const diamonds = Number($('gift-diamonds').value || 0);
  if (!Number.isInteger(points) || !Number.isInteger(diamonds) || points < 0 || diamonds < 0) {
    $('gift-error').textContent = 'Enter whole numbers, zero or more.';
    return;
  }
  if (points + diamonds === 0) {
    $('gift-error').textContent = 'Enter an amount.';
    return;
  }
  const parts = [points && `${fmt(points)} Stride Points`, diamonds && `${fmt(diamonds)} diamonds`].filter(Boolean).join(' and ');
  if (!gift.to && !confirm(`Give ${parts} to every player?`)) return;
  for (const id of ['gift-send', 'gift-take']) $(id).disabled = true;
  try {
    if (gift.to) {
      await api('/gift', { userId: gift.to.id, points: sign * points, diamonds: sign * diamonds });
      toast(sign > 0 ? `Gave ${gift.to.username} ${parts}.` : `Took ${parts} from ${gift.to.username}.`);
    } else {
      const { players: count } = await api('/gift-all', { points, diamonds, includeDemo: $('gift-demo').checked });
      toast(`Gave ${parts} to ${count} players.`);
    }
    $('gift').close();
    gift.after();
  } catch (err) {
    if (err.status === 401) {
      $('gift').close();
      showGate('That key was not accepted.');
    } else {
      $('gift-error').textContent = err.message;
    }
  } finally {
    for (const id of ['gift-send', 'gift-take']) $(id).disabled = false;
  }
}

// ---------- The other tabs ----------

const TABS = {
  players: loadPlayers,

  async activity() {
    const { days } = await api('/activity');
    const recent = [...days].reverse();
    const most = (pick) => Math.max(1, ...days.map(pick));
    const bar = (value, max) => ({
      className: 'bar-cell',
      node: el('span', '', Object.assign(el('i'), { style: `width:${(value / max) * 100}%` }), el('span', '', fmt(value))),
    });
    const week = days.slice(-7);
    const sum = (list, pick) => list.reduce((total, d) => total + pick(d), 0);
    $('tab-activity').replaceChildren(
      el('div', 'totals', ...[
        ['New players, last 7 days', sum(week, (d) => d.signups)],
        ['Steps, last 7 days', sum(week, (d) => d.steps)],
        ['Battles, last 7 days', sum(week, (d) => d.battles)],
        ['Walked today', days.at(-1).walkers],
      ].map(([label, value]) => el('div', 'total', el('small', '', label), el('b', '', fmt(value))))),
      el('h3', '', 'Last 30 days'),
      table(
        ['Day', { label: 'New players', num: true }, 'Players who walked', 'Steps', { label: 'Battles', num: true }],
        recent.map((d) => [
          day.format(new Date(`${d.date}T12:00:00`)), fmt(d.signups),
          bar(d.walkers, most((x) => x.walkers)), bar(d.steps, most((x) => x.steps)), fmt(d.battles),
        ]),
      ));
  },

  async economy() {
    const e = await api('/economy');
    const sold = e.items.filter((item) => item.owned > 0).sort((a, b) => b.owned - a.owned);
    $('tab-economy').replaceChildren(
      el('div', 'totals', ...[
        ['Stride Points held', e.held.points], ['Diamonds held', e.held.diamonds],
        ['Points earned by walking', e.earned.walking], ['Points earned in battles', e.earned.battles],
        ['Points gifted (net)', e.gifted.points], ['Diamonds gifted (net)', e.gifted.diamonds],
      ].map(([label, value]) => el('div', 'total', el('small', '', label), el('b', '', fmt(value))))),
      el('p', 'note', 'Earned and gifted are all-time. Diamonds bought in the store are not tracked separately, so they show only in what players hold.'),
      el('h3', '', 'Items players own'),
      sold.length ? table(
        ['Item', 'Slot', { label: 'Owned by', num: true }, { label: 'Price now', num: true }],
        sold.map((item) => [item.name, item.slot, fmt(item.owned), `${fmt(item.price)} ${item.currency === 'diamonds' ? 'diamonds' : 'points'}`]),
      ) : el('p', 'note', 'Nobody owns an item yet.'),
      el('h3', '', 'Beasts players have'),
      el('p', 'note', 'Every player starts with one random beast for free, so these are not all purchases.'),
      table(
        ['Beast', { label: 'Players with one', num: true }, { label: 'Egg price now', num: true }],
        e.beasts.filter((b) => b.owned > 0).sort((a, b) => b.owned - a.owned).map((b) => [
          b.species, fmt(b.owned), b.price === null ? 'starter only' : `${fmt(b.price)} ${b.currency === 'diamonds' ? 'diamonds' : 'points'}`,
        ]),
      ));
  },

  async flags() {
    const { flags } = await api('/suspicious');
    $('tab-flags').replaceChildren(
      el('p', 'note', 'Step counts come from the player\'s phone and are taken on trust. These are walk reports from the last 30 days that arrived faster than anyone walks. A flag is a reason to look, not proof: a phone that was offline for a while can also report a lot at once.'),
      flags.length ? table(
        ['When', 'Player', 'What looked wrong', { label: 'Points earned', num: true }],
        flags.map((flag) => [timeOf(flag.at), flag.username, flag.reason, fmt(flag.points)]),
        { onRow: (i) => openPlayer(flags[i].userId) },
      ) : el('p', 'note', 'Nothing flagged.'));
  },

  async settings() {
    const { settings } = await api('/settings');
    const groups = [...new Set(settings.map((rule) => rule.group))];
    $('tab-settings').replaceChildren(
      el('p', 'note', 'These take effect straight away for everyone. Rest times apply to battles lost from now on.'),
      ...groups.flatMap((group) => [
        el('h3', '', group),
        table(
          ['Setting', { label: 'Default', num: true }, 'Value', ''],
          settings.filter((rule) => rule.group === group).map((rule) => {
            const input = Object.assign(el('input', 'inline-input'), { type: 'number', min: 0, max: rule.max, step: 1, value: rule.value });
            const save = (amount, done) => async () => { if (await act(() => api('/settings', { name: rule.name, amount }), done)) TABS.settings(); };
            return [
              { node: el('span', rule.changed ? 'changed' : '', rule.label, rule.changed && el('span', 'tag', 'changed')) },
              `${fmt(rule.default)} ${rule.unit}`,
              { node: input },
              { node: el('span', '',
                button('Save', () => save(Number(input.value), `${rule.label} saved.`)(), 'small'), ' ',
                rule.changed && button('Reset', save(null, `${rule.label} back to default.`), 'quiet small')) },
            ];
          }),
        ),
      ]));
  },

  async announce() {
    const { announcements } = await api('/announcements');
    const message = Object.assign(el('textarea', 'message'), { maxLength: 300, rows: 4, placeholder: 'What should every player know?' });
    const left = el('span', 'note', '300 characters left');
    message.addEventListener('input', () => { left.textContent = `${300 - message.value.length} characters left`; });
    const length = el('select', '', ...[['24', '1 day'], ['72', '3 days'], ['168', '1 week'], ['', 'Until I stop it']]
      .map(([hours, label]) => Object.assign(el('option', '', label), { value: hours })));
    const send = button('Send to everyone', async () => {
      const text = message.value.trim();
      if (!text) return toast('Write a message first.');
      if (!confirm(`Send this to every player?\n\n${text}`)) return;
      if (await act(() => api('/announce', { message: text, hours: length.value ? Number(length.value) : null }), 'Announcement sent.')) {
        TABS.announce();
      }
    });
    $('tab-announce').replaceChildren(
      el('p', 'note', 'Every player sees the newest running announcement once, as a pop-up, the next time their app is open. A newer one replaces an older one for anyone who hasn\'t seen it yet.'),
      message,
      el('div', 'give', el('span', 'note', 'Show it for'), length, send, left),
      el('h3', '', 'Sent'),
      announcements.length ? table(
        ['Sent', 'Message', 'Status', ''],
        announcements.map((a) => [
          timeOf(a.at),
          { className: 'wrap', node: el('span', '', a.message) },
          a.active ? (a.expiresAt ? `Running until ${timeOf(a.expiresAt)}` : 'Running until stopped') : 'Ended',
          { node: a.active
            ? button('Stop', async () => { if (await act(() => api('/announce/stop', { id: a.id }), 'Announcement stopped.')) TABS.announce(); }, 'quiet small')
            : el('span') },
        ]),
      ) : el('p', 'note', 'No announcements yet.'));
  },

  async log() {
    const { entries } = await api('/log');
    $('tab-log').replaceChildren(
      el('p', 'note', 'Everything done from this dashboard, newest first. The dashboard uses one shared key, so the log can\'t say which person did it.'),
      entries.length ? table(
        ['When', 'Action', 'Player', 'Detail'],
        entries.map((entry) => [timeOf(entry.at), entry.action, entry.username ?? '–', entry.detail]),
      ) : el('p', 'note', 'Nothing has been done yet.'));
  },
};

async function showTab(name) {
  tab = name;
  for (const node of $('tabs').children) node.setAttribute('aria-selected', String(node.dataset.tab === name));
  for (const id of Object.keys(TABS)) $(`tab-${id}`).hidden = id !== name;
  await act(TABS[name]);
}

// ---------- Gate and wiring ----------

function showGate(note) {
  key = '';
  sessionStorage.removeItem(KEY_STORE);
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('dashboard').hidden = true;
  $('gate').hidden = false;
  if (note) $('gate-note').textContent = note;
  $('key').value = '';
  $('key').focus();
}

async function unlock() {
  try {
    catalog = await api('/catalog');
  } catch (err) {
    if (err.status === 401) return showGate('That key was not accepted.');
    if (err.status === 404) return showGate('The admin dashboard is off: set ADMIN_KEY in the server\'s .env and restart it.');
    return toast(err.message);
  }
  sessionStorage.setItem(KEY_STORE, key);
  $('gate').hidden = true;
  $('dashboard').hidden = false;
  showTab(tab);
}

$('key-form').addEventListener('submit', (event) => {
  event.preventDefault();
  key = $('key').value.trim();
  unlock();
});
$('tabs').addEventListener('click', (event) => {
  const name = event.target.closest('[data-tab]')?.dataset.tab;
  if (name) showTab(name);
});
$('search').addEventListener('input', renderPlayers);
$('hide-demo').addEventListener('change', renderPlayers);
$('online-only').addEventListener('change', renderPlayers);
// Who is online changes by the minute: keep the list fresh while it is the thing being looked at.
setInterval(() => {
  const busy = document.querySelector('dialog[open]') || document.visibilityState !== 'visible';
  if (key && tab === 'players' && !$('dashboard').hidden && !busy) loadPlayers().catch(() => {});
}, 30_000);
$('reload').addEventListener('click', () => showTab(tab));
$('lock').addEventListener('click', () => showGate('The key is ADMIN_KEY in the server\'s .env file.'));
$('export').addEventListener('click', exportCsv);
$('gift-all').addEventListener('click', () => openGift(null, () => act(loadPlayers)));
$('gift-cancel').addEventListener('click', () => $('gift').close());
$('gift-take').addEventListener('click', () => sendGift(-1));
$('gift-form').addEventListener('submit', (event) => {
  event.preventDefault();
  sendGift(1);
});

if (key) unlock();
else showGate();

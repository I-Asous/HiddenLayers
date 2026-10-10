import { api } from '../api.js';
import { buddySvg, stageName } from '../buddy.js';
import { ELEMENT_BEATS, ELEMENT_LABELS, elementTag, matchup, weakTo } from '../elements.js';
import { buddySay, confetti, escapeHtml, fmt, punchSound, reducedMotion, sfx, sleep, toast } from '../fx.js';
import { icons } from '../icons.js';
import { app } from '../state.js';

const BOARDS = {
  steps: { label: 'Steps', unit: 'steps this week' },
  wins: { label: 'Wins', unit: 'battles won' },
  level: { label: 'Level', unit: 'buddy level' },
};

const segmented = (name, options, selected, extra = '') => `
  <div class="segmented ${extra}" role="tablist">${Object.entries(options).map(([value, label]) => `
    <button role="tab" aria-selected="${value === selected}" data-${name}="${value}">${label}</button>`).join('')}
  </div>`;

// How the player's beast fares against this one, before they pick a fight.
const EDGE = {
  strong: '<span class="edge is-strong">You have the edge</span>',
  weak: '<span class="edge is-weak">They have the edge</span>',
  even: '',
};

// Time left as m:ss, for the rest a beast needs after losing.
const clock = (ms) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
const restLeft = () => (app.state.buddy.restingUntil ?? 0) - Date.now();

// The Battle button, or a countdown while the player's beast is resting.
const battleButton = (userId) => (restLeft() > 0
  ? `<button class="btn btn-primary btn-small" disabled>Resting <span data-rest>${clock(restLeft())}</span></button>`
  : `<button class="btn btn-primary btn-small" data-challenge="${userId}">${icons.sword}Battle</button>`);

function buddyRow(o, detail, actions) {
  return `
    <li class="opponent">
      <div class="opponent-art">${buddySvg(o)}<span class="art-level">Lv ${o.level}</span></div>
      <div class="opponent-info">
        <b>${escapeHtml(o.name)}</b>
        <span>${stageName(o)} ${elementTag(o.element)}</span>
        ${EDGE[matchup(app.state.buddy.element, o.element)]}
        <small>@${escapeHtml(o.username)}${detail}</small>
      </div>
      <div class="opponent-actions">${actions}</div>
    </li>`;
}

export function mount(el) {
  let view = 'friends'; // friends | everyone | ranks
  let friends = null;
  let opponents = null;
  let board = 'steps';
  let scope = 'friends';
  let ranks = null;
  let busy = false;

  function friendsHtml() {
    const form = `
      <form class="add-friend" id="add-friend">
        <label for="friend-name">Add a friend by username</label>
        <div>
          <input id="friend-name" name="username" required maxlength="21" autocomplete="off" autocapitalize="none"
            spellcheck="false" placeholder="username">
          <button class="btn btn-primary btn-small">Add</button>
        </div>
      </form>`;
    if (friends === null) return `${form}<p class="empty">Loading friends…</p>`;
    if (!friends.length) {
      return `${form}<div class="empty-buddy">
        <p class="bubble">No friends yet! Add one above to battle and race them — try mira, theo or ana.</p>
        ${buddySvg(app.state.buddy, { background: false, className: 'is-idle' })}
      </div>`;
    }
    return `${form}<ul class="opponents">${friends.map((f) => buddyRow(
      f,
      ` · you ${f.headToHead.wins}–${f.headToHead.losses}`,
      `${battleButton(f.userId)}
       <button class="btn btn-ghost btn-small" data-remove="${f.userId}"
         aria-label="Remove ${escapeHtml(f.username)} from friends">Remove</button>`,
    )).join('')}</ul>`;
  }

  function everyoneHtml() {
    if (opponents === null) return '<p class="empty">Looking for challengers…</p>';
    if (!opponents.length) return '<p class="empty">No other buddies yet. Invite someone to sign up!</p>';
    return `<ul class="opponents">${opponents.map((o) => buddyRow(
      o,
      '',
      `${battleButton(o.userId)}
       ${o.isFriend
        ? '<span class="tag is-win">Friend</span>'
        : `<button class="btn btn-small btn-icon" data-add="${escapeHtml(o.username)}"
            aria-label="Add ${escapeHtml(o.username)} as a friend">${icons.plus}</button>`}`,
    )).join('')}</ul>`;
  }

  function ranksHtml() {
    const controls = `
      ${segmented('board', Object.fromEntries(Object.entries(BOARDS).map(([id, b]) => [id, b.label])), board, 'segmented-sub')}
      ${segmented('scope', { friends: 'Friends', all: 'Everyone' }, scope, 'segmented-sub')}`;
    if (ranks === null) return `${controls}<p class="empty">Tallying scores…</p>`;
    const alone = scope === 'friends' && ranks.length <= 1
      ? '<p class="hint">Add friends to see how you stack up against them.</p>'
      : '';
    // With three or more on the board, the top three stand on a podium.
    const top = ranks.length >= 3 ? ranks.slice(0, 3) : [];
    const podium = top.length ? `
      <div class="podium">${[[top[1], 2], [top[0], 1], [top[2], 3]].map(([entry, place]) => `
        <div class="podium-col place-${place} ${entry.isMe ? 'is-me' : ''}">
          <div class="podium-art">${buddySvg(entry.buddy, { background: false, className: place === 1 ? 'is-idle' : '' })}</div>
          <b>${escapeHtml(entry.buddy.name)}</b>
          <small>@${escapeHtml(entry.username)}${entry.isMe ? ' · you' : ''}</small>
          <div class="podium-step"><span>${entry.rank}</span><em>${fmt(entry.value)}</em></div>
        </div>`).join('')}
      </div>` : '';
    const rest = ranks.slice(top.length);
    return `${controls}
      <p class="hint hint-top">Ranked by ${BOARDS[board].unit}.</p>${podium}
      ${rest.length ? `<ol class="board" start="${top.length + 1}">${rest.map((entry) => `
        <li class="${entry.isMe ? 'is-me' : ''}">
          <span class="rank rank-${Math.min(entry.rank, 4)}">${entry.rank}</span>
          <div class="board-art">${buddySvg(entry.buddy)}</div>
          <div class="opponent-info">
            <b>${escapeHtml(entry.buddy.name)}</b>
            <small>@${escapeHtml(entry.username)}${entry.isMe ? ' · you' : ''}</small>
          </div>
          <span class="board-value">${fmt(entry.value)}</span>
        </li>`).join('')}</ol>` : ''}${alone}`;
  }

  function render() {
    const { record, buddy } = app.state;
    const typed = el.querySelector('#friend-name')?.value ?? '';
    el.innerHTML = `
      <header class="topbar">
        <h1>Battle</h1>
        <div class="record-pill" aria-label="${record.wins} wins, ${record.losses} losses">
          <span class="is-win">${record.wins} W</span><span class="is-loss">${record.losses} L</span></div>
      </header>
      ${segmented('view', { friends: 'Friends', everyone: 'Everyone', ranks: 'Ranks' }, view)}
      ${view === 'ranks' ? '' : `<p class="hint hint-top">${escapeHtml(buddy.name)} ${elementTag(buddy.element)} has
        ${buddy.attack} attack and ${buddy.evasion} evasion. Strong against ${ELEMENT_LABELS[ELEMENT_BEATS[buddy.element]]},
        weak against ${ELEMENT_LABELS[weakTo(buddy.element)]}. Win a battle to earn 5 bonus Stride Points.
        ${restLeft() > 0 ? `<span class="edge is-weak">Resting after a loss: ready in
          <span data-rest>${clock(restLeft())}</span>.${app.state.resting.some((b) => !b.restingUntil || b.restingUntil <= Date.now())
            ? ' <a href="#home">Switch to another beast</a> to keep battling.' : ''}</span>` : ''}</p>`}
      ${view === 'friends' ? friendsHtml() : view === 'everyone' ? everyoneHtml() : ranksHtml()}`;
    // Keep what was being typed when a background refresh redraws the screen.
    const input = el.querySelector('#friend-name');
    if (input && typed) input.value = typed;
  }

  async function loadFriends() {
    friends = (await api('/friends')).friends;
    render();
  }

  async function loadOpponents() {
    opponents = (await api('/opponents')).opponents;
    render();
  }

  async function loadRanks() {
    const wanted = `${board}/${scope}`;
    const data = await api(`/leaderboard?board=${board}&scope=${scope}`);
    if (wanted !== `${board}/${scope}`) return; // a newer choice was made while this loaded
    ranks = data.entries;
    render();
  }

  const loaders = { friends: loadFriends, everyone: loadOpponents, ranks: loadRanks };
  const refresh = () => loaders[view]().catch((err) => toast(err.message, 'warn'));

  async function addFriend(username) {
    friends = (await api('/friends', { method: 'POST', body: { username } })).friends;
    if (opponents) opponents = opponents.map((o) => (o.username === username ? { ...o, isFriend: true } : o));
    toast(`You and ${username} are now friends!`, 'good');
    render();
  }

  async function challenge(opponentId) {
    let battle;
    try {
      ({ battle } = await api('/battles', { method: 'POST', body: { opponentId } }));
    } catch (err) {
      // 429: the beast is resting and this screen didn't know; fetch the countdown.
      if (err.status === 429) app.refresh().catch(() => {});
      throw err;
    }
    const state = await playBattle(battle);
    // No state comes back when the battle was lost track of; ask for it instead.
    if (state) app.setState(state);
    else await app.refresh();
    if (view === 'friends') refresh(); // head-to-head records changed
  }

  // One action at a time, so a double tap can't start two battles.
  async function exclusive(action) {
    if (busy) return;
    busy = true;
    try {
      await action();
    } catch (err) {
      toast(err.message, 'warn');
    } finally {
      busy = false;
    }
  }

  const onClick = (event) => {
    const hit = (name) => event.target.closest(`[data-${name}]`)?.dataset[name];
    if (hit('view')) {
      view = hit('view');
      render();
      return refresh();
    }
    if (hit('board') || hit('scope')) {
      board = hit('board') ?? board;
      scope = hit('scope') ?? scope;
      ranks = null;
      render();
      return refresh();
    }
    if (hit('challenge')) return exclusive(() => challenge(Number(hit('challenge'))));
    if (hit('add')) return exclusive(() => addFriend(hit('add')));
    if (hit('remove')) {
      return exclusive(async () => {
        friends = (await api('/friends/remove', { method: 'POST', body: { userId: Number(hit('remove')) } })).friends;
        opponents = null;
        render();
      });
    }
  };

  const onSubmit = (event) => {
    if (event.target.id !== 'add-friend') return;
    event.preventDefault();
    const input = event.target.querySelector('input');
    const username = input.value.trim().replace(/^@/, '');
    if (!username) return;
    exclusive(async () => {
      await addFriend(username);
      el.querySelector('#friend-name').value = '';
    });
  };

  // Count the rest down in place, so typing in the friend box isn't disturbed,
  // and bring the Battle buttons back once it is over.
  const tick = setInterval(() => {
    const counters = el.querySelectorAll('[data-rest]');
    if (!counters.length) return;
    if (restLeft() <= 0) return render();
    for (const counter of counters) counter.textContent = clock(restLeft());
  }, 1000);

  el.addEventListener('click', onClick);
  el.addEventListener('submit', onSubmit);
  render();
  refresh();

  return {
    update: render,
    destroy() {
      clearInterval(tick);
      el.removeEventListener('click', onClick);
      el.removeEventListener('submit', onSubmit);
    },
  };
}

function fighterHtml(side, buddy, subtitle, hpMax) {
  return `
    <div class="fighter" data-side="${side}">
      <div class="fighter-name"><b>${escapeHtml(buddy.name)}</b><small>${escapeHtml(subtitle)}</small></div>
      ${elementTag(buddy.element)}
      <div class="hp" role="img" aria-label="${escapeHtml(buddy.name)} HP"><i style="width:100%"></i><span>${hpMax}</span></div>
      <div class="energy" role="img" aria-label="Energy 0 of 3"><i></i><i></i><i></i></div>
      <div class="fighter-art">${buddySvg(buddy, { background: false })}</div>
    </div>`;
}

const SPECIAL_COST = 2;
const MOVES = {
  attack: { label: 'Attack', icon: icons.sword, hint: 'Hit now' },
  guard: { label: 'Guard', icon: icons.shield, hint: 'Half damage, +2 energy' },
  special: { label: 'Special', icon: icons.flame, hint: 'Double hit, costs 2' },
};
const MATCHUP_LINES = {
  strong: 'Your element has the edge: your hits land harder.',
  weak: 'Their element has the edge: your hits land softer.',
  even: 'No element has the edge here.',
};

// What one side did in a round, in words.
function describe(action) {
  if (action.move === 'guard') return 'guarded';
  if (action.dodged) return 'attack missed';
  if (action.blocked) return 'special blocked';
  const effect = action.effect === 'strong' ? ', strong' : action.effect === 'weak' ? ', weak' : '';
  return `${action.move} hit for ${action.damage}${effect}`;
}

const RESULT = {
  win: { title: 'You win!', detail: '+5 Stride Points' },
  loss: { title: 'You lost', detail: 'Train up and try again!' },
  draw: { title: 'It\'s a draw!', detail: 'So evenly matched.' },
};

// Shown in the aftermath when the buddy's voice line can't be fetched.
const FALLBACK_LINES = {
  win: 'We did it! All those walks paid off!',
  loss: 'We\'ll get them next time. Let\'s train!',
  draw: 'So close! One more walk and we win.',
};

/**
 * Plays a battle round by round: the player picks a move, the server answers
 * with what both beasts did. Resolves with the server state once the player
 * closes the result or runs away.
 */
export function playBattle(start) {
  return new Promise((resolve) => {
    let battle = start;
    const overlay = document.createElement('div');
    overlay.className = 'overlay arena';
    overlay.innerHTML = `
      <div class="arena-card" role="dialog" aria-modal="true" aria-label="Battle">
        <p class="eyebrow" id="round">Round 1</p>
        <div class="fighters">
          ${fighterHtml('a', battle.challenger, 'You', battle.hpMax)}
          <span class="versus">VS</span>
          ${fighterHtml('b', battle.opponent, `@${battle.opponent.username}`, battle.hpMax)}
        </div>
        <div class="arena-result" id="result" aria-live="assertive"><p>${MATCHUP_LINES[battle.matchup]}</p></div>
        <div class="moves" id="moves">${Object.entries(MOVES).map(([move, { label, icon, hint }]) => `
          <button class="move" data-move="${move}">${icon}<b>${label}</b><small>${hint}</small></button>`).join('')}
        </div>
        <button class="btn btn-ghost btn-block" id="flee">Run away (counts as a loss)</button>
      </div>`;
    document.body.append(overlay);

    const fighters = {
      a: overlay.querySelector('[data-side="a"]'),
      b: overlay.querySelector('[data-side="b"]'),
    };
    const pause = (ms) => (reducedMotion() ? Promise.resolve() : sleep(ms));
    let busy = false;

    function close(state) {
      overlay.remove();
      resolve(state);
    }

    function showHp(side, value) {
      fighters[side].querySelector('.hp i').style.width = `${(value / battle.hpMax) * 100}%`;
      fighters[side].querySelector('.hp span').textContent = value;
    }

    // Bars, energy and buttons, straight from the server's view of the battle.
    function sync() {
      for (const side of ['a', 'b']) {
        showHp(side, battle.hp[side]);
        const energy = fighters[side].querySelector('.energy');
        energy.setAttribute('aria-label', `Energy ${battle.energy[side]} of 3`);
        [...energy.children].forEach((pip, i) => pip.classList.toggle('is-on', i < battle.energy[side]));
      }
      for (const button of overlay.querySelectorAll('[data-move]')) {
        button.disabled = busy || (button.dataset.move === 'special' && battle.energy.a < SPECIAL_COST);
      }
    }

    function float(side, text, className = '') {
      if (reducedMotion()) return;
      const label = document.createElement('span');
      label.className = `float ${className}`;
      label.textContent = text;
      fighters[side].querySelector('.fighter-art').append(label);
      label.addEventListener('animationend', () => label.remove());
    }

    async function act(side, action, hp) {
      const defender = side === 'a' ? 'b' : 'a';
      if (action.move === 'guard') {
        float(side, 'GUARD', 'is-miss');
        return pause(450);
      }
      fighters[side].classList.add('is-lunging');
      await pause(220);
      hp[defender] = Math.max(0, hp[defender] - action.damage);
      showHp(defender, hp[defender]);
      if (action.dodged || action.blocked) {
        float(defender, action.dodged ? 'MISS!' : 'BLOCKED!', 'is-miss');
        sfx('miss');
      } else {
        float(defender, `-${action.damage}`, action.move === 'special' || action.effect === 'strong' ? 'is-strong' : '');
        sfx(punchSound(side === 'a' ? battle.challenger : battle.opponent));
        fighters[defender].classList.add('is-hit');
        setTimeout(() => fighters[defender].classList.remove('is-hit'), 350);
      }
      await pause(330);
      fighters[side].classList.remove('is-lunging');
      await pause(300);
    }

    async function play(move) {
      if (busy) return;
      busy = true;
      sync();
      let data;
      try {
        data = await api('/battles/move', { method: 'POST', body: { battleId: battle.id, move } });
      } catch (err) {
        toast(err.message, 'warn');
        // 409: the server no longer has this battle (it restarted, or another one was started).
        if (err.status === 409) return close(null);
        busy = false;
        return sync();
      }
      const hp = { ...battle.hp };
      // Guards go up first, so a blocked or softened hit makes sense when it lands.
      const order = data.round.b.move === 'guard' && data.round.a.move !== 'guard' ? ['b', 'a'] : ['a', 'b'];
      for (const side of order) await act(side, data.round[side], hp);
      battle = data.battle;
      overlay.querySelector('#result').innerHTML =
        `<p>You: ${describe(data.round.a)}<br>Them: ${describe(data.round.b)}</p>`;
      if (battle.over) return finish(data);
      overlay.querySelector('#round').textContent = `Round ${battle.round}`;
      busy = false;
      sync();
    }

    // A loss also says how long the beast now has to rest.
    function resultFor(state) {
      const rest = (state.buddy.restingUntil ?? 0) - Date.now();
      if (battle.outcome !== 'loss' || rest <= 0) return RESULT[battle.outcome];
      return { ...RESULT.loss, detail: `${escapeHtml(battle.challenger.name)} rests for ${clock(rest)}` };
    }

    function finish(state) {
      sync();
      const result = resultFor(state);
      overlay.querySelector('#round').textContent = 'Battle over';
      overlay.querySelector('#result').innerHTML = `
        <h2 class="is-${battle.outcome}">${result.title}</h2>
        <p>${result.detail} · ${battle.totals.a} vs ${battle.totals.b} damage</p>`;
      if (battle.outcome !== 'draw') {
        fighters[battle.outcome === 'win' ? 'a' : 'b'].classList.add('is-winner');
        fighters[battle.outcome === 'win' ? 'b' : 'a'].classList.add('is-loser');
      }
      overlay.querySelector('#moves').remove();
      overlay.querySelector('#flee').remove();
      if (battle.outcome === 'win') sfx('win');
      else if (battle.outcome === 'loss') sfx('lose');
      // Ask for the buddy's line now so it's ready by the time the aftermath shows.
      const line = buddySay(battle.outcome);
      pause(1400).then(() => showAftermath(line, state));
    }

    // The after-battle screen: your buddy, reacting, with what it has to say.
    function showAftermath(line, state) {
      const result = resultFor(state);
      const card = overlay.querySelector('.arena-card');
      card.classList.add('aftermath');
      card.setAttribute('aria-label', 'Battle result');
      card.innerHTML = `
        <h2 class="aftermath-title is-${battle.outcome}">${result.title}</h2>
        <p class="aftermath-detail">${result.detail} · ${battle.totals.a} vs ${battle.totals.b} damage</p>
        <div class="bubble aftermath-bubble is-thinking" aria-live="polite"><span class="dots">...</span></div>
        <div class="aftermath-buddy is-${battle.outcome}">${buddySvg(battle.challenger, { background: false })}</div>
        <button class="btn btn-primary btn-block" id="done">Done</button>`;
      card.querySelector('#done').onclick = () => close(state);
      if (battle.outcome === 'win') confetti();
      line.then((text) => {
        const bubble = card.querySelector('.aftermath-bubble');
        bubble.classList.remove('is-thinking');
        bubble.textContent = text || FALLBACK_LINES[battle.outcome];
        if (text) app.say(text);
      });
    }

    overlay.querySelector('#moves').addEventListener('click', (event) => {
      const move = event.target.closest('[data-move]')?.dataset.move;
      if (move) play(move);
    });
    overlay.querySelector('#flee').onclick = async () => {
      if (busy) return;
      busy = true;
      sync();
      close(await api('/battles/forfeit', { method: 'POST', body: { battleId: battle.id } }).catch(() => null));
    };
    sync();
  });
}

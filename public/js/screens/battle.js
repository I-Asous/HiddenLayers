import { api } from '../api.js';
import { buddySvg, stageName } from '../buddy.js';
import { buddySay, confetti, escapeHtml, fmt, reducedMotion, sleep, toast } from '../fx.js';
import { app } from '../state.js';

const BOARDS = {
  steps: { label: 'Steps', unit: 'steps this week' },
  wins: { label: 'Wins', unit: 'battles won' },
  level: { label: 'Level', unit: 'buddy level' },
};

const segmented = (name, options, selected) => `
  <div class="segmented" role="tablist">${Object.entries(options).map(([value, label]) => `
    <button role="tab" aria-selected="${value === selected}" data-${name}="${value}">${label}</button>`).join('')}
  </div>`;

function buddyRow(o, detail, actions) {
  return `
    <li class="opponent">
      <div class="opponent-art">${buddySvg(o)}</div>
      <div class="opponent-info">
        <b>${escapeHtml(o.name)}</b>
        <span>Lv ${o.level} ${stageName(o)}</span>
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
      return `${form}<p class="empty">No friends yet. Add one above to battle them and race them on the
        leaderboard — try mira, theo or ana.</p>`;
    }
    return `${form}<ul class="opponents">${friends.map((f) => buddyRow(
      f,
      ` · you ${f.headToHead.wins}–${f.headToHead.losses}`,
      `<button class="btn btn-primary btn-small" data-challenge="${f.userId}">Battle</button>
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
      `<button class="btn btn-primary btn-small" data-challenge="${o.userId}">Battle</button>
       ${o.isFriend
        ? '<span class="tag is-win">Friend</span>'
        : `<button class="btn btn-small" data-add="${escapeHtml(o.username)}">+ Friend</button>`}`,
    )).join('')}</ul>`;
  }

  function ranksHtml() {
    const controls = `
      ${segmented('board', Object.fromEntries(Object.entries(BOARDS).map(([id, b]) => [id, b.label])), board)}
      ${segmented('scope', { friends: 'Friends', all: 'Everyone' }, scope)}`;
    if (ranks === null) return `${controls}<p class="empty">Tallying scores…</p>`;
    const alone = scope === 'friends' && ranks.length <= 1
      ? '<p class="hint">Add friends to see how you stack up against them.</p>'
      : '';
    return `${controls}
      <p class="hint hint-top">Ranked by ${BOARDS[board].unit}.</p>
      <ol class="board">${ranks.map((entry) => `
        <li class="${entry.isMe ? 'is-me' : ''}">
          <span class="rank rank-${Math.min(entry.rank, 4)}">${entry.rank}</span>
          <div class="board-art">${buddySvg(entry.buddy)}</div>
          <div class="opponent-info">
            <b>${escapeHtml(entry.buddy.name)}</b>
            <small>@${escapeHtml(entry.username)}${entry.isMe ? ' · you' : ''}</small>
          </div>
          <span class="board-value">${fmt(entry.value)}</span>
        </li>`).join('')}</ol>${alone}`;
  }

  function render() {
    const { record, buddy } = app.state;
    const typed = el.querySelector('#friend-name')?.value ?? '';
    el.innerHTML = `
      <header class="topbar">
        <h1>Battle</h1>
        <div class="record-pill"><b>${record.wins}</b> W · <b>${record.losses}</b> L</div>
      </header>
      ${segmented('view', { friends: 'Friends', everyone: 'Everyone', ranks: 'Ranks' }, view)}
      ${view === 'ranks' ? '' : `<p class="hint hint-top">${escapeHtml(buddy.name)} has ${buddy.attack} attack and
        ${buddy.evasion} evasion. Win a battle to earn 5 bonus Stride Points.</p>`}
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
    const result = await api('/battles', { method: 'POST', body: { opponentId } });
    await playBattle(result.battle);
    app.setState(result);
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

  el.addEventListener('click', onClick);
  el.addEventListener('submit', onSubmit);
  render();
  refresh();

  return {
    update: render,
    destroy() {
      el.removeEventListener('click', onClick);
      el.removeEventListener('submit', onSubmit);
    },
  };
}

function fighterHtml(side, buddy, subtitle, hpMax) {
  return `
    <div class="fighter" data-side="${side}">
      <div class="fighter-name"><b>${escapeHtml(buddy.name)}</b><small>${escapeHtml(subtitle)}</small></div>
      <div class="hp" role="img"><i style="width:100%"></i><span>${hpMax}</span></div>
      <div class="fighter-art">${buddySvg(buddy, { background: false })}</div>
    </div>`;
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

/** Replays the server's turn-by-turn log. Resolves when the player closes the result. */
function playBattle(battle) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay arena';
    overlay.innerHTML = `
      <div class="arena-card" role="dialog" aria-modal="true" aria-label="Battle">
        <p class="eyebrow" id="round">Round 1 of 5</p>
        <div class="fighters">
          ${fighterHtml('a', battle.challenger, 'You', battle.hpMax)}
          <span class="versus">VS</span>
          ${fighterHtml('b', battle.opponent, `@${battle.opponent.username}`, battle.hpMax)}
        </div>
        <div class="arena-result" id="result" aria-live="assertive"></div>
        <button class="btn btn-ghost btn-block" id="skip">Skip</button>
      </div>`;
    document.body.append(overlay);

    const fighters = {
      a: overlay.querySelector('[data-side="a"]'),
      b: overlay.querySelector('[data-side="b"]'),
    };
    const hp = { a: battle.hpMax, b: battle.hpMax };
    let skipped = reducedMotion();
    const pause = (ms) => (skipped ? Promise.resolve() : sleep(ms));

    function hit(defender, turn) {
      const el = fighters[defender];
      hp[defender] = Math.max(0, hp[defender] - turn.damage);
      el.querySelector('.hp i').style.width = `${(hp[defender] / battle.hpMax) * 100}%`;
      el.querySelector('.hp span').textContent = hp[defender];
      if (skipped) return;
      const float = document.createElement('span');
      float.className = `float ${turn.dodged ? 'is-miss' : ''}`;
      float.textContent = turn.dodged ? 'MISS!' : `-${turn.damage}`;
      el.querySelector('.fighter-art').append(float);
      float.addEventListener('animationend', () => float.remove());
      if (!turn.dodged) {
        el.classList.add('is-hit');
        setTimeout(() => el.classList.remove('is-hit'), 350);
      }
    }

    async function run() {
      await pause(600);
      for (const turn of battle.log) {
        overlay.querySelector('#round').textContent = `Round ${turn.round} of 5`;
        const defender = turn.attacker === 'a' ? 'b' : 'a';
        const attacker = fighters[turn.attacker];
        if (!skipped) attacker.classList.add('is-lunging');
        await pause(220);
        hit(defender, turn);
        await pause(330);
        attacker.classList.remove('is-lunging');
        await pause(300);
      }
      finish();
    }

    function finish() {
      const result = RESULT[battle.outcome];
      overlay.querySelector('#round').textContent = 'Battle over';
      overlay.querySelector('#result').innerHTML = `
        <h2 class="is-${battle.outcome}">${result.title}</h2>
        <p>${result.detail} · ${battle.totals.a} vs ${battle.totals.b} damage</p>`;
      if (battle.outcome !== 'draw') {
        fighters[battle.outcome === 'win' ? 'a' : 'b'].classList.add('is-winner');
        fighters[battle.outcome === 'win' ? 'b' : 'a'].classList.add('is-loser');
      }
      overlay.querySelector('#skip').remove();
      // Ask for the buddy's line now so it's ready by the time the aftermath shows.
      const line = buddySay(battle.outcome);
      pause(1400).then(() => showAftermath(line));
    }

    // The after-battle screen: your buddy, reacting, with what it has to say.
    function showAftermath(line) {
      const result = RESULT[battle.outcome];
      const card = overlay.querySelector('.arena-card');
      card.classList.add('aftermath');
      card.setAttribute('aria-label', 'Battle result');
      card.innerHTML = `
        <h2 class="aftermath-title is-${battle.outcome}">${result.title}</h2>
        <p class="aftermath-detail">${result.detail} · ${battle.totals.a} vs ${battle.totals.b} damage</p>
        <div class="bubble aftermath-bubble is-thinking" aria-live="polite"><span class="dots">...</span></div>
        <div class="aftermath-buddy is-${battle.outcome}">${buddySvg(battle.challenger, { background: false })}</div>
        <button class="btn btn-primary btn-block" id="done">Done</button>`;
      card.querySelector('#done').onclick = () => {
        overlay.remove();
        resolve();
      };
      if (battle.outcome === 'win') confetti();
      line.then((text) => {
        const bubble = card.querySelector('.aftermath-bubble');
        bubble.classList.remove('is-thinking');
        bubble.textContent = text || FALLBACK_LINES[battle.outcome];
        if (text) app.say(text);
      });
    }

    overlay.querySelector('#skip').onclick = () => {
      skipped = true;
    };
    run();
  });
}

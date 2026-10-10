import { api } from '../api.js';
import { SPECIES, buddySvg, stageName } from '../buddy.js';
import { buddySay, confetti, escapeHtml, fmt, toast, voice } from '../fx.js';
import { app } from '../state.js';
import { walk } from '../steps.js';
import { openProfile } from './profile.js';

const NEXT_STAGE = { egg: ['baby', 1, 5], baby: ['teen', 5, 10], teen: ['adult', 10, 20] };

function upgradeButton(type, label, detail, cost, points) {
  const short = points < cost;
  return `
    <button class="upgrade ${short ? 'is-short' : ''}" data-upgrade="${type}" aria-disabled="${short}">
      <span class="upgrade-label">${label}</span>
      <span class="upgrade-detail">${detail}</span>
      <span class="cost">${pointIcon}${fmt(cost)}</span>
    </button>`;
}

// An 8×8 pixel coin.
export const pointIcon = `<svg class="point-icon" viewBox="0 0 8 8" shape-rendering="crispEdges" aria-hidden="true">
  <path d="M2 0h4v1h1v1h1v4h-1v1h-1v1h-4v-1h-1v-1h-1v-4h1v-1h1z" fill="#1a1c2c"/>
  <path d="M2 1h4v1h1v4h-1v1h-4v-1h-1v-4h1z" fill="#ffcd75"/>
  <path d="M4 2h1v1h-1v1h1v1h-1v1h-1v-1h1v-1h-1v-1h1z" fill="#ef7d57"/>
  <path d="M2 2h1v1h-1z" fill="#f4f4f4"/></svg>`;

export function mount(el) {
  let busy = false;

  function render() {
    const { user, buddy, record } = app.state;
    const today = app.todaySteps;
    const speaking = app.spoken && app.spoken.until > Date.now();
    const goalPct = Math.min(100, (today / user.dailyGoal) * 100);
    const next = NEXT_STAGE[buddy.stage];
    const nextTitle = next && (SPECIES[buddy.species] ?? SPECIES.dragon).titles[next[0]];
    const evolveHtml = next
      ? `<div class="evolve">
          <div class="evolve-text"><span>Evolves into ${nextTitle} at Lv ${next[2]}</span>
            <span>Lv ${buddy.level}</span></div>
          <div class="bar"><i style="width:${((buddy.level - next[1]) / (next[2] - next[1])) * 100}%"></i></div>
        </div>`
      : '<div class="evolve"><div class="evolve-text"><span>Fully grown!</span><span>Lv ' + buddy.level + '</span></div></div>';

    el.innerHTML = `
      <header class="topbar">
        <button class="chip" id="profile-btn" aria-label="Open profile">
          <span class="avatar">${escapeHtml(user.username[0].toUpperCase())}</span>
          <span class="chip-text"><b>${escapeHtml(user.username)}</b>
            <small>${record.wins}W · ${record.losses}L</small></span>
        </button>
        <div class="balance" aria-label="${user.points} Stride Points">${pointIcon}<b>${fmt(user.points)}</b></div>
      </header>

      <section class="stage-card">
        <div class="bubble home-bubble" aria-live="polite" ${speaking ? '' : 'hidden'}>${speaking ? escapeHtml(app.spoken.text) : ''}</div>
        ${buddySvg(buddy, { className: `is-idle ${today === 0 && !walk.walking ? 'is-sleepy' : ''}` })}
        <div class="nameplate">
          <b>${escapeHtml(buddy.name)}</b>
          <span>Lv ${buddy.level} ${stageName(buddy)} · ${fmt(buddy.xp)} XP</span>
        </div>
        <p class="traits">${escapeHtml([
          `Feeling ${buddy.mood}`, ...(buddy.personality ? [...buddy.personality.traits, buddy.personality.quirk] : []),
        ].join(' · '))}</p>
      </section>

      ${evolveHtml}

      <div class="upgrades">
        ${upgradeButton('level', 'Level Up', `Lv ${buddy.level} → ${buddy.level + 1}`, buddy.costs.level, user.points)}
        ${upgradeButton('attack', '+1 Attack', `${buddy.attack} → ${buddy.attack + 1}`, buddy.costs.attack, user.points)}
        ${upgradeButton('evasion', '+1 Evasion', `${buddy.evasion} → ${buddy.evasion + 1}`, buddy.costs.evasion, user.points)}
      </div>

      <button class="btn btn-pink btn-block" id="talk-btn">
        <svg viewBox="0 0 8 8" width="16" height="16" shape-rendering="crispEdges" aria-hidden="true"><path
          fill="currentColor" d="M1 1h6v4h-3v1h-1v1h-1v-2h-1z"/></svg>
        Talk to ${escapeHtml(buddy.name)}
      </button>

      <a class="today-card" href="#walk">
        <div><small>Today</small><b>${fmt(today)}</b> <span>/ ${fmt(user.dailyGoal)} steps</span></div>
        <div class="bar"><i style="width:${goalPct}%"></i></div>
      </a>`;
  }

  async function upgrade(type) {
    const { user, buddy } = app.state;
    const cost = buddy.costs[type];
    if (user.points < cost) {
      toast(`You need ${fmt(cost - user.points)} more Stride Points. Time for a walk!`, 'warn');
      return;
    }
    if (busy) return;
    busy = true;
    try {
      const result = await api('/buddy/upgrade', { method: 'POST', body: { type } });
      app.setState(result);
      if (result.evolvedTo) {
        celebrateEvolution(result.evolvedFrom, result.buddy);
        app.say(await buddySay('evolve'));
      } else if (type === 'level') {
        toast(`${result.buddy.name} reached level ${result.buddy.level}!`, 'good');
        el.querySelector('.buddy')?.classList.add('is-happy');
        app.say(await buddySay('levelup'));
      } else {
        toast(type === 'attack' ? 'Attack up!' : 'Evasion up!', 'good');
      }
    } catch (err) {
      toast(err.message, 'warn');
    } finally {
      busy = false;
    }
  }

  async function talk(button) {
    button.disabled = true;
    button.classList.add('is-loading');
    const text = await buddySay('chat');
    if (text) {
      app.say(text);
      // The first talk gives the buddy its personality; fetch it so the traits show.
      if (!app.state.buddy.personality) app.refresh().catch(() => {});
    } else {
      toast('Your buddy is feeling shy. Try again in a moment.', 'warn');
    }
    // The screen may have re-rendered while waiting; the old button is gone then.
    button.disabled = false;
    button.classList.remove('is-loading');
  }

  const onClick = (event) => {
    const upgradeBtn = event.target.closest('[data-upgrade]');
    if (upgradeBtn) return upgrade(upgradeBtn.dataset.upgrade);
    const talkBtn = event.target.closest('#talk-btn');
    if (talkBtn && !talkBtn.disabled) return talk(talkBtn);
    if (event.target.closest('#profile-btn')) return openProfile();
  };
  el.addEventListener('click', onClick);
  // The bubble goes away shortly after the buddy finishes talking.
  let quietTimer;
  const onVoiceEnd = () => {
    clearTimeout(quietTimer);
    const line = app.spoken;
    quietTimer = setTimeout(() => {
      if (app.spoken !== line) return; // a newer line started meanwhile
      app.spoken = null;
      render();
    }, 1200);
  };
  voice.addEventListener('end', onVoiceEnd);
  // Re-render when a spoken line expires so the bubble goes away, and
  // fetch the new mood once a short-lived one (upset) wears off.
  let refreshedFor = null;
  const tick = setInterval(() => {
    if (app.spoken && app.spoken.until <= Date.now()) {
      app.spoken = null;
      render();
    }
    const until = app.state?.buddy.moodUntil;
    if (until && until <= Date.now() && refreshedFor !== until) {
      refreshedFor = until;
      app.refresh().catch(() => {});
    }
  }, 1000);
  // Steps arrive a couple of times a second during a walk. Only the step card
  // is touched for those, so the buddy's animation isn't restarted each time.
  let wasWalking = walk.walking;
  const onWalk = () => {
    if (walk.walking !== wasWalking) {
      wasWalking = walk.walking;
      return render();
    }
    const card = el.querySelector('.today-card');
    if (!card) return;
    const today = app.todaySteps;
    card.querySelector('b').textContent = fmt(today);
    card.querySelector('.bar i').style.width = `${Math.min(100, (today / app.state.user.dailyGoal) * 100)}%`;
  };
  walk.addEventListener('change', onWalk);
  render();

  return {
    update: render,
    destroy() {
      el.removeEventListener('click', onClick);
      walk.removeEventListener('change', onWalk);
      voice.removeEventListener('end', onVoiceEnd);
      clearInterval(tick);
      clearTimeout(quietTimer);
    },
  };
}

export function celebrateEvolution(fromStage, buddy) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay evolution';
  overlay.innerHTML = `
    <div class="evolution-card" role="dialog" aria-modal="true" aria-label="Your buddy evolved">
      <p class="eyebrow">Evolution!</p>
      <div class="evolution-stage">
        ${buddySvg({ ...buddy, stage: fromStage }, { background: false, className: 'evo-from' })}
        ${buddySvg(buddy, { background: false, className: 'evo-to' })}
      </div>
      <h2>${escapeHtml(buddy.name)} evolved into ${/^[aeiou]/i.test(stageName(buddy)) ? 'an' : 'a'} ${stageName(buddy)}!</h2>
      <button class="btn btn-primary btn-block">Yay!</button>
    </div>`;
  document.body.append(overlay);
  setTimeout(() => confetti(3200), 900);
  overlay.querySelector('button').addEventListener('click', () => overlay.remove());
}

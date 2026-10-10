import { api } from '../api.js';
import { SPECIES, buddySvg, cosmeticIcon, stageName } from '../buddy.js';
import { buddySay, confetti, escapeHtml, fmt, toast, voice } from '../fx.js';
import { icons } from '../icons.js';
import { app } from '../state.js';
import { walk } from '../steps.js';
import { openProfile } from './profile.js';

const NEXT_STAGE = { egg: ['baby', 1, 5], baby: ['teen', 5, 10], teen: ['adult', 10, 20] };

function upgradeButton(type, icon, label, detail, cost, points) {
  const short = points < cost;
  return `
    <button class="upgrade ${short ? 'is-short' : ''}" data-upgrade="${type}" aria-disabled="${short}">
      ${icon}
      <span class="upgrade-label">${label}</span>
      <span class="upgrade-detail">${detail}</span>
      <span class="cost">${short ? `Need ${fmt(cost - points)}` : `${pointIcon}${fmt(cost)}`}</span>
    </button>`;
}

const TEAM_SIZE = 6;

// The player's beasts, the one walking with them first. Tapping another swaps to it.
function teamHtml(buddy, resting) {
  const slot = (beast, walking) => `
    <button class="team-slot ${walking ? 'is-walking' : ''}" ${walking ? 'disabled' : `data-switch="${beast.id}"`}
      aria-pressed="${walking}" aria-label="${escapeHtml(beast.name)}, ${stageName(beast)}, level ${beast.level}${
        walking ? ', walking with you' : ''}">
      ${buddySvg(beast, { background: false })}
      <span>Lv ${beast.level}</span>
    </button>`;
  return `<div class="team">${slot(buddy, true)}${
    resting.slice(0, TEAM_SIZE - 1).map((beast) => slot(beast, false)).join('')}</div>`;
}

const WARDROBE_SLOTS = {
  hat: { tab: 'Hats', name: 'hats' },
  eyewear: { tab: 'Eyes', name: 'eyewear' },
  accessory: { tab: 'Extras', name: 'accessories' },
  background: { tab: 'Scenes', name: 'backgrounds' },
};

// The wardrobe sits right under the beast: pick a slot, then tap something the
// player owns to put it on or take it off. items is null until the store answers.
function wardrobeHtml(buddy, items, open) {
  const tabs = Object.entries(WARDROBE_SLOTS).map(([slot, { tab, name }]) => `
    <button role="tab" aria-selected="${slot === open}" aria-label="Wardrobe: ${name}" data-slot="${slot}">${tab}</button>`);
  let shelf = '';
  if (open) {
    const owned = (items ?? []).filter((item) => item.owned && item.slot === open);
    shelf = owned.length
      ? `<div class="wardrobe-shelf">${owned.map((item) => {
        const on = buddy.equipped[open] === item.id;
        return `
          <button class="wardrobe-item ${on ? 'is-equipped' : ''}" data-equip="${item.id}" aria-pressed="${on}"
            aria-label="${escapeHtml(item.name)}${on ? ', wearing' : ''}">${cosmeticIcon(item)}</button>`;
      }).join('')}</div>`
      : `<p class="wardrobe-empty">${items === null
        ? 'Opening the wardrobe…'
        : `No ${WARDROBE_SLOTS[open].name} yet. <a href="#store">Visit the Store</a>`}</p>`;
  }
  return `<div class="wardrobe"><div class="segmented segmented-sub" role="tablist">${tabs.join('')}</div>${shelf}</div>`;
}

// An 8×8 pixel coin.
export const pointIcon = `<svg class="point-icon" viewBox="0 0 8 8" shape-rendering="crispEdges" aria-hidden="true">
  <path d="M2 0h4v1h1v1h1v4h-1v1h-1v1h-4v-1h-1v-1h-1v-4h1v-1h1z" fill="#1a1c2c"/>
  <path d="M2 1h4v1h1v4h-1v1h-4v-1h-1v-4h1z" fill="#ffcd75"/>
  <path d="M4 2h1v1h-1v1h1v1h-1v1h-1v-1h1v-1h-1v-1h1z" fill="#ef7d57"/>
  <path d="M2 2h1v1h-1z" fill="#f4f4f4"/></svg>`;

export function mount(el) {
  let busy = false;
  let items = null; // everything in the store, marked with what the player owns
  let wardrobeSlot = null; // the wardrobe slot that is open, if any

  function render() {
    const { user, buddy, resting, record } = app.state;
    const shelfScroll = el.querySelector('.wardrobe-shelf')?.scrollLeft ?? 0;
    const today = app.todaySteps;
    const speaking = app.spoken && app.spoken.until > Date.now();
    const next = NEXT_STAGE[buddy.stage];
    const nextTitle = next && (SPECIES[buddy.species] ?? SPECIES.dragon).titles[next[0]];
    const evolveHtml = next
      ? `<div class="evolve">
          <div class="evolve-text"><span>Lv ${buddy.level}</span><span>${nextTitle} at Lv ${next[2]}</span></div>
          <div class="bar"><i style="width:${((buddy.level - next[1]) / (next[2] - next[1])) * 100}%"></i></div>
        </div>`
      : '<div class="evolve"><div class="evolve-text"><span>Fully grown!</span></div></div>';

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
        <div class="scene-hud">
          <span class="hud-badge hud-level">Lv ${buddy.level}</span>
          <span class="hud-badge" aria-label="${today} steps today">${icons.boot}${fmt(today)}</span>
        </div>
        <div class="bubble home-bubble" aria-live="polite" ${speaking ? '' : 'hidden'}>${speaking ? escapeHtml(app.spoken.text) : ''}</div>
        ${buddySvg(buddy, { className: `is-idle ${today === 0 && !walk.walking ? 'is-sleepy' : ''}` })}
        <div class="nameplate">
          <div>
            <b>${escapeHtml(buddy.name)}</b>
            <span>${stageName(buddy)} · ${fmt(buddy.xp)} XP</span>
          </div>
          <div class="nameplate-stats">
            <span class="stat-badge is-attack" aria-label="Attack ${buddy.attack}">${icons.sword}${buddy.attack}</span>
            <span class="stat-badge is-evasion" aria-label="Evasion ${buddy.evasion}">${icons.dash}${buddy.evasion}</span>
          </div>
          <button class="btn btn-pink icon-talk" id="talk-btn" aria-label="Talk to ${escapeHtml(buddy.name)}">
            <svg viewBox="0 0 8 8" width="20" height="20" shape-rendering="crispEdges" aria-hidden="true"><path
              fill="currentColor" d="M1 1h6v4h-3v1h-1v1h-1v-2h-1z"/></svg>
          </button>
        </div>
        ${evolveHtml}
        ${wardrobeHtml(buddy, items, wardrobeSlot)}
      </section>

      <div class="upgrades">
        ${upgradeButton('level', icons.arrowUp, 'Level Up', `Lv ${buddy.level} → ${buddy.level + 1}`, buddy.costs.level, user.points)}
        ${upgradeButton('attack', icons.sword, '+1 Attack', `${buddy.attack} → ${buddy.attack + 1}`, buddy.costs.attack, user.points)}
        ${upgradeButton('evasion', icons.dash, '+1 Evasion', `${buddy.evasion} → ${buddy.evasion + 1}`, buddy.costs.evasion, user.points)}
      </div>
      ${teamHtml(buddy, resting)}`;
    // Keep the shelf where it was scrolled to when trying things on.
    const shelf = el.querySelector('.wardrobe-shelf');
    if (shelf) shelf.scrollLeft = shelfScroll;
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

  async function switchBeast(id) {
    if (busy) return;
    busy = true;
    try {
      app.setState(await api('/buddy/switch', { method: 'POST', body: { id } }));
      toast(`${app.state.buddy.name} is walking with you now.`, 'good');
    } catch (err) {
      toast(err.message, 'warn');
    } finally {
      busy = false;
    }
  }

  // Tapping what the beast already wears takes it off.
  async function equip(id) {
    if (busy) return;
    busy = true;
    try {
      const wearing = app.state.buddy.equipped[wardrobeSlot] === id;
      app.setState(await api('/buddy/equip', { method: 'POST', body: { slot: wardrobeSlot, itemId: wearing ? null : id } }));
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
    const switchBtn = event.target.closest('[data-switch]');
    if (switchBtn) return switchBeast(Number(switchBtn.dataset.switch));
    const slotBtn = event.target.closest('.wardrobe [data-slot]');
    if (slotBtn) {
      wardrobeSlot = slotBtn.dataset.slot === wardrobeSlot ? null : slotBtn.dataset.slot;
      return render();
    }
    const equipBtn = event.target.closest('[data-equip]');
    if (equipBtn) return equip(equipBtn.dataset.equip);
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
  // Steps arrive a couple of times a second during a walk. Only re-render when
  // walking starts or stops, so the buddy's animation isn't restarted each time.
  let wasWalking = walk.walking;
  const onWalk = () => {
    if (walk.walking !== wasWalking) {
      wasWalking = walk.walking;
      render();
    }
  };
  walk.addEventListener('change', onWalk);
  render();
  api('/store').then((data) => {
    items = data.items;
    if (wardrobeSlot) render();
  }).catch((err) => {
    items = [];
    toast(err.message, 'warn');
  });

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

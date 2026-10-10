import { buddySvg } from '../buddy.js';
import { fmt, toast } from '../fx.js';
import { icons } from '../icons.js';
import { app } from '../state.js';
import { walk } from '../steps.js';
import { pointIcon } from './home.js';
import { chooseWalkVisibility } from './map.js';
import { diamondIcon } from './store.js';

const RADIUS = 96;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function mount(el) {
  let sensorCheck;

  el.innerHTML = `
    <header class="topbar">
      <h1>Walk Mode</h1>
      <div class="topbar-balances">
        <div class="balance" id="walk-balance">${pointIcon}<b id="walk-points"></b></div>
        <div class="balance balance-diamonds" id="walk-diamonds">${diamondIcon}<b id="walk-diamonds-val"></b></div>
      </div>
    </header>

    <section class="ring-card">
      <svg class="ring" viewBox="0 0 220 220" role="img" aria-labelledby="ring-label">
        <circle cx="110" cy="110" r="${RADIUS}" class="ring-track"/>
        <circle cx="110" cy="110" r="${RADIUS}" class="ring-fill" id="ring-fill"
          stroke-dasharray="${CIRCUMFERENCE}" transform="rotate(-90 110 110)"/>
        <circle cx="110" cy="110" r="${RADIUS}" class="ring-notches"
          stroke-dasharray="3 ${CIRCUMFERENCE / 30 - 3}" transform="rotate(-90 110 110)"/>
      </svg>
      <div class="ring-center" id="ring-label">
        <div class="ring-buddy">${buddySvg(app.state.buddy, { background: false, className: 'is-idle' })}</div>
        <small class="eyebrow">Today</small>
        <b id="today-steps"></b>
        <span id="goal-text"></span>
      </div>
    </section>

    <div class="stat-row">
      <div class="stat"><small>${icons.boot}This walk</small><b id="session-steps">0</b></div>
      <div class="stat"><small>${pointIcon}Points this walk</small><b id="session-points">0</b></div>
    </div>

    <p class="status" id="walk-status" aria-live="polite"></p>

    <button class="btn btn-block btn-xl" id="walk-toggle"></button>
    ${app.demo ? '<button class="btn btn-demo btn-block" id="demo-add">DEMO: +1,000 steps</button>' : ''}

    <p class="hint">Keep StepBuddy open with your phone in your hand or pocket. Steps are counted from
      the motion sensor and saved every 30 seconds.</p>`;

  const $ = (id) => el.querySelector(`#${id}`);

  function update() {
    const { user } = app.state;
    const today = app.todaySteps;
    const pct = Math.min(1, today / user.dailyGoal);
    $('walk-points').textContent = fmt(user.points);
    $('walk-balance').setAttribute('aria-label', `${user.points} Stride Points`);
    $('walk-diamonds-val').textContent = fmt(app.diamonds);
    $('walk-diamonds').setAttribute('aria-label', `${app.diamonds} Diamonds`);
    $('today-steps').textContent = fmt(today);
    $('goal-text').textContent = today >= user.dailyGoal
      ? 'Goal reached!'
      : `${Math.floor(pct * 100)}% of ${fmt(user.dailyGoal)}`;
    $('ring-fill').style.strokeDashoffset = CIRCUMFERENCE * (1 - pct);
    $('ring-fill').classList.toggle('is-done', pct >= 1);
    $('session-steps').textContent = fmt(walk.sessionSteps);
    $('session-points').textContent = fmt(Math.floor(walk.sessionSteps / 100));

    const toggle = $('walk-toggle');
    toggle.innerHTML = walk.walking ? 'End Walk' : `${icons.play}Start Walking`;
    toggle.className = `btn btn-block btn-xl ${walk.walking ? 'btn-pink is-walking' : 'btn-primary'}`;
    el.querySelector('.ring-buddy .buddy').classList.toggle('is-walking', walk.walking);
    if (walk.walking) {
      if (walk.sensorSeen) setStatus('Counting your steps…');
      else if (!$('walk-status').dataset.sticky) setStatus('Waiting for the motion sensor…');
    } else if (!$('walk-status').dataset.sticky) {
      $('walk-status').textContent = '';
    }
  }

  function setStatus(text, sticky = false) {
    const status = $('walk-status');
    status.textContent = text;
    if (sticky) status.dataset.sticky = '1';
    else delete status.dataset.sticky;
  }

  async function toggle() {
    const button = $('walk-toggle');
    button.disabled = true;
    try {
      if (walk.walking) {
        clearTimeout(sensorCheck);
        const steps = walk.sessionSteps;
        await walk.stop();
        setStatus(steps ? `Nice walk! ${fmt(steps)} steps saved.` : 'Walk ended.', true);
      } else {
        setStatus('');
        if (await chooseWalkVisibility() === null) return;
        await walk.start();
        // Desktop browsers expose the API but never fire it.
        sensorCheck = setTimeout(() => {
          if (walk.walking && !walk.sensorSeen) {
            setStatus(location.protocol === 'https:' || location.hostname === 'localhost'
              ? 'No motion data yet. This device may not have a motion sensor — try it on your phone.'              : 'No motion data. Phones only share motion over HTTPS — open the https:// address.', true);
          }
        }, 3000);
      }
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      button.disabled = false;
      update();
    }
  }

  const onClick = async (event) => {
    if (event.target.closest('#walk-toggle')) return toggle();
    if (event.target.closest('#demo-add')) {
      await walk.addSteps(1000);
      toast('+1,000 demo steps', 'good');
    }
  };
  el.addEventListener('click', onClick);
  walk.addEventListener('change', update);
  update();

  return {
    update,
    destroy() {
      clearTimeout(sensorCheck);
      el.removeEventListener('click', onClick);
      walk.removeEventListener('change', update);
    },
  };
}

// Toasts, confetti and the buddy's voice.
import { api } from './api.js';

export const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const fmt = (n) => Math.round(n).toLocaleString('en-US');

// Distance units ('km' or 'mi') are a display preference kept on this device.
const UNITS_KEY = 'stepbuddy.units';
const M_PER_MI = 1609.344;
const FT_PER_M = 3.28084;

export function distanceUnits() {
  try {
    return localStorage.getItem(UNITS_KEY) === 'mi' ? 'mi' : 'km';
  } catch {
    return 'km';
  }
}

export function setDistanceUnits(units) {
  try {
    localStorage.setItem(UNITS_KEY, units);
  } catch {}
}

/**
 * Metres in the player's units. Short distances drop to m / ft unless
 * `small` is false (then it's always km / mi).
 */
export function fmtDistance(meters, { decimals = 2, small = true } = {}) {
  if (distanceUnits() === 'mi') {
    const miles = meters / M_PER_MI;
    return small && miles < 0.1 ? `${fmt(meters * FT_PER_M)} ft` : `${miles.toFixed(decimals)} mi`;
  }
  return small && meters < 1000 ? `${fmt(meters)} m` : `${(meters / 1000).toFixed(decimals)} km`;
}

export const reducedMotion =() => matchMedia('(prefers-reduced-motion: reduce)').matches;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let toastTimer;
export function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2600);
}

const CONFETTI_COLORS = ['#ffcd75', '#ef7d57', '#b13e53', '#a7f070', '#41a6f6', '#73eff7', '#f4f4f4'];

export function confetti(durationMs = 2600) {
  if (reducedMotion()) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  document.body.append(canvas);
  const ratio = Math.min(devicePixelRatio || 1, 2);
  const width = (canvas.width = innerWidth * ratio);
  const height = (canvas.height = innerHeight * ratio);
  const ctx = canvas.getContext('2d');
  const pieces = Array.from({ length: 140 }, () => ({
    x: width / 2 + (Math.random() - 0.5) * width * 0.3,
    y: height * 0.35,
    vx: (Math.random() - 0.5) * 16 * ratio,
    vy: (-6 - Math.random() * 12) * ratio,
    size: (5 + Math.random() * 7) * ratio,
    spin: Math.random() * Math.PI,
    spinSpeed: (Math.random() - 0.5) * 0.4,
    color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
  }));
  const startedAt = performance.now();
  const frame = (now) => {
    const elapsed = now - startedAt;
    ctx.clearRect(0, 0, width, height);
    ctx.globalAlpha = Math.max(0, Math.min(1, (durationMs - elapsed) / 500));
    for (const p of pieces) {
      p.vy += 0.35 * ratio;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.spin += p.spinSpeed;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.spin);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
    }
    if (elapsed < durationMs) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

// One shared <audio> element. iOS only lets a page start audio from a tap, but
// an element that has been played once inside a tap may be reused later — so
// the first tap anywhere plays a silent clip through it.
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
const audio = new Audio();
audio.preload = 'auto';

/** Fires 'end' when the buddy finishes saying a line out loud. */
export const voice = new EventTarget();
const finished = () => voice.dispatchEvent(new Event('end'));
audio.addEventListener('ended', () => {
  if (audio.src !== SILENCE) finished();
});

// Sound effects get their own elements so they never cut off the buddy's voice.
const SFX_VOLUME = 0.4;
const SOUNDS = Object.fromEntries(['punch', 'punch2', 'punch3', 'miss', 'win', 'lose'].map((name) => {
  const el = new Audio(`/sounds/${name}.mp3`);
  el.preload = 'auto';
  el.volume = SFX_VOLUME;
  return [name, el];
}));

// Each species throws its own punch.
const PUNCH_BY_SPECIES = { dragon: 'punch', phoenix: 'punch2', kraken: 'punch3' };
export const punchSound = (buddy) => PUNCH_BY_SPECIES[buddy.species] ?? 'punch';

/** Plays a sound effect (see SOUNDS) from the start. Never throws. */
export function sfx(name) {
  const el = SOUNDS[name];
  if (!el) return;
  el.currentTime = 0;
  el.play().catch(() => {});
}

// Background music: loops quietly under everything. Browsers only allow it to
// start from a tap, so it begins on the first one, and it pauses while the app
// is in the background.
const music = new Audio('/sounds/music.mp3');
music.loop = true;
music.volume = 0.15;
music.preload = 'auto';
let musicStarted = false;

document.addEventListener('visibilitychange', () => {
  if (!musicStarted) return;
  if (document.hidden) music.pause();
  else music.play().catch(() => {});
});

addEventListener('pointerdown', () => {
  music.play().then(() => { musicStarted = true; }, () => {});
  audio.src = SILENCE;
  audio.play().catch(() => {});
  // Same iOS unlock for the effects: play each once, muted, inside the tap.
  for (const el of Object.values(SOUNDS)) {
    el.muted = true;
    el.play().then(() => { el.pause(); el.currentTime = 0; el.muted = false; }, () => { el.muted = false; });
  }
}, { once: true, capture: true });

function browserSpeak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.pitch = 1.6;
  utterance.rate = 1.05;
  utterance.onend = finished;
  speechSynthesis.speak(utterance);
}

async function play({ text, audioUrl }) {
  if (audioUrl) {
    try {
      audio.src = audioUrl;
      await audio.play();
      return;
    } catch {}
  }
  browserSpeak(text);
}

/**
 * Asks the server for a line (chat, levelup, evolve, win, loss, draw), speaks
 * it and returns the text. Never throws: the voice is a nicety.
 */
export async function buddySay(event) {
  try {
    const line = await api('/talk', { method: 'POST', body: { event } });
    play(line);
    return line.text;
  } catch (err) {
    console.warn('Buddy voice failed', err);
    return null;
  }
}

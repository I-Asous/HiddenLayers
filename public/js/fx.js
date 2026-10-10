// Toasts, confetti and the buddy's voice.
import { api } from './api.js';

export const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const fmt = (n) => Math.round(n).toLocaleString('en-US');

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

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

addEventListener('pointerdown', () => {
  audio.src = SILENCE;
  audio.play().catch(() => {});
}, { once: true, capture: true });

function browserSpeak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.pitch = 1.6;
  utterance.rate = 1.05;
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

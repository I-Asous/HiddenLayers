// Step counting. Browsers have no pedometer, so steps are picked out of the
// accelerometer signal while the app is open.
import { api } from './api.js';
import { stepsFromMeters } from './geo.js';

const SESSION_KEY = 'stepbuddy.walk';
const SYNC_INTERVAL_MS = 30_000;

/**
 * Peak detector over acceleration magnitude (m/s²).
 * A slow low-pass tracks gravity, a fast one smooths out jitter; a step is a
 * local peak of the difference that clears the threshold, at most one per
 * 250ms.
 */
export class StepDetector {
  constructor({ threshold = 1.2, minGapMs = 250, smoothing = 0.3 } = {}) {
    this.threshold = threshold;
    this.minGapMs = minGapMs;
    this.smoothing = smoothing;
    this.gravity = null;
    this.smooth = 0;
    this.prev = 0;
    this.rising = false;
    this.lastStepAt = -Infinity;
  }

  /** Feed one sample; returns true when it completes a step. */
  push(magnitude, timeMs) {
    if (this.gravity === null) {
      this.gravity = magnitude;
      return false;
    }
    this.gravity += 0.02 * (magnitude - this.gravity);
    this.smooth += this.smoothing * (magnitude - this.gravity - this.smooth);
    const value = this.smooth;
    let step = false;
    if (value > this.prev) {
      this.rising = true;
    } else if (this.rising) {
      // The previous sample was a peak.
      this.rising = false;
      if (this.prev > this.threshold && timeMs - this.lastStepAt >= this.minGapMs) {
        this.lastStepAt = timeMs;
        step = true;
      }
    }
    this.prev = value;
    return step;
  }
}

// A walk is measured two ways: steps felt by the accelerometer and distance
// seen by GPS. GPS is the backup — it only counts when it implies more steps
// than the accelerometer caught (phone in a bag, sensor permission denied).
const sessionTotal = (session) => Math.max(session.total, stepsFromMeters(session.gpsMeters));

function loadSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (saved && typeof saved.id === 'string' && Number.isInteger(saved.total)) {
      return { gpsMeters: 0, ...saved };
    }
  } catch {}
  return null;
}

class Walk extends EventTarget {
  session = loadSession(); // { id, total (accelerometer steps), gpsMeters, synced }
  walking = false;
  sensorSeen = false;
  #detector = null;
  #timer = null;
  #wakeLock = null;
  #syncing = Promise.resolve();
  #onState = () => {};

  /** Called with fresh server state after every sync. */
  onServerState(fn) {
    this.#onState = fn;
  }

  get sessionSteps() {
    return this.session ? sessionTotal(this.session) : 0;
  }

  /** Steps counted on this device that the server hasn't confirmed yet. */
  get unsynced() {
    return this.session ? sessionTotal(this.session) - this.session.synced : 0;
  }

  get needsPermission() {
    return typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function';
  }

  get supported() {
    return typeof DeviceMotionEvent !== 'undefined';
  }

  get gpsMeters() {
    return this.session?.gpsMeters ?? 0;
  }

  /**
   * Must be called from a tap: iOS only shows its motion prompt from a user gesture.
   * With `motion: false` the walk is measured by GPS alone.
   */
  async start({ motion = true } = {}) {
    if (this.walking) return;
    if (motion) {
      if (!this.supported) throw new Error('This browser has no motion sensor. Open Wanderling on your phone.');
      if (this.needsPermission) {
        const answer = await DeviceMotionEvent.requestPermission();
        if (answer !== 'granted') {
          throw new Error('Motion access was denied. Allow "Motion & Orientation Access" for this site and try again.');
        }
      }
    }
    this.#ensureSession();
    this.#detector = new StepDetector();
    this.sensorSeen = false;
    this.walking = true;
    if (motion) window.addEventListener('devicemotion', this.#onMotion);
    this.#timer = setInterval(() => this.sync(), SYNC_INTERVAL_MS);
    this.#requestWakeLock();
    this.#emit();
  }

  async stop() {
    if (!this.walking) return;
    this.walking = false;
    window.removeEventListener('devicemotion', this.#onMotion);
    clearInterval(this.#timer);
    this.#wakeLock?.release().catch(() => {});
    this.#wakeLock = null;
    this.#emit();
    await this.sync({ ended: true });
  }

  /** Demo helper: adds steps as if they had been walked. */
  async addSteps(count) {
    this.#ensureSession();
    this.session.total += count;
    this.#save();
    this.#emit();
    await this.sync({ ended: !this.walking });
  }

  /** Distance covered according to GPS; only counted during a walk. */
  addGpsMeters(meters) {
    if (!this.walking || !this.session) return;
    this.session.gpsMeters += meters;
    this.#save();
    this.#emit();
  }

  /** Finishes a walk that was cut short by a reload or a closed tab. */
  async recover() {
    if (this.session && !this.walking) await this.sync({ ended: true });
  }

  sync({ ended = false, keepalive = false } = {}) {
    const run = async () => {
      const session = this.session;
      if (!session) return;
      const total = sessionTotal(session);
      if (total === session.synced && !ended) return;
      try {
        const state = await api('/steps/sync', {
          method: 'POST',
          body: { sessionId: session.id, total, ended },
          keepalive,
        });
        session.synced = total;
        // Steps taken while the request was in flight keep the session open.
        if (ended && this.session === session && sessionTotal(session) === total && !this.walking) {
          this.session = null;
        }
        this.#save();
        this.#onState(state);
        this.#emit();
      } catch (err) {
        // Leave the session as it is; the next sync sends the same running
        // total and the server only counts what it hasn't seen.
        console.warn('Step sync failed', err);
      }
    };
    this.#syncing = this.#syncing.then(run, run);
    return this.#syncing;
  }

  /** Signing out: stop listening and forget the walk so it can't leak into another account. */
  reset() {
    this.walking = false;
    window.removeEventListener('devicemotion', this.#onMotion);
    clearInterval(this.#timer);
    this.#wakeLock?.release().catch(() => {});
    this.#wakeLock = null;
    this.session = null;
    this.#save();
  }

  #ensureSession() {
    if (!this.session) {
      this.session = { id: crypto.randomUUID(), total: 0, gpsMeters: 0, synced: 0 };
      this.#save();
    }
  }

  #onMotion = (event) => {
    const a = event.accelerationIncludingGravity;
    if (!a || a.x === null) return;
    this.sensorSeen = true;
    const magnitude = Math.hypot(a.x, a.y, a.z);
    if (this.#detector.push(magnitude, event.timeStamp)) {
      this.session.total += 1;
      this.#save();
      this.#emit();
    }
  };

  async #requestWakeLock() {
    try {
      this.#wakeLock = await navigator.wakeLock?.request('screen');
    } catch {}
  }

  /** Coming back to the tab: the OS drops the wake lock whenever the page is hidden. */
  resume() {
    if (this.walking) this.#requestWakeLock();
  }

  #save() {
    try {
      if (this.session) localStorage.setItem(SESSION_KEY, JSON.stringify(this.session));
      else localStorage.removeItem(SESSION_KEY);
    } catch {}
  }

  #emit() {
    this.dispatchEvent(new Event('change'));
  }
}

export const walk = new Walk();

// Live position tracking for the Map tab. Feeds counted distance into the
// current walk and tells the map where the buddy should be heading.
import { api } from './api.js';
import { GpsFilter, bearingDeg, distanceM } from './geo.js';
import { walk } from './steps.js';

// How often the position is shared, so nearby players see each other on the map.
const SHARE_EVERY_MS = 15_000;
const SHARE_AFTER_M = 25;

class Gps extends EventTarget {
  /** Where the buddy should be: { lng, lat }, or null before the first fix. */
  position = null;
  /** Direction of travel in compass degrees. */
  heading = 0;
  /** performance.now() of the last counted movement; drives Walking vs Idle. */
  lastMovedAt = -Infinity;
  /** 'off' | 'waiting' | 'tracking' | 'denied' | 'unavailable' */
  status = 'off';
  /** While a demo walk plays, real fixes are ignored so the two don't fight. */
  simulating = false;
  #watchId = null;
  #filter = new GpsFilter();

  #mapOpen = false;
  #shared = null; // { point, at } of the last position sent to the server

  constructor() {
    super();
    // Tracking outlives the Map tab during a walk (GPS keeps backing up the
    // step count on other tabs) and ends with the walk.
    walk.addEventListener('change', () => {
      if (walk.walking) return;
      this.#shared = null; // the server forgets you when a walk ends; share again right away next walk
      if (!this.#mapOpen) this.stop();
    });
  }

  /** The Map tab is showing: start watching the phone's position. */
  open() {
    this.#mapOpen = true;
    this.start();
  }

  close() {
    this.#mapOpen = false;
    if (!walk.walking) this.stop();
  }

  start() {
    if (this.#watchId !== null) return;
    if (!('geolocation' in navigator)) {
      this.#setStatus('unavailable');
      return;
    }
    this.#setStatus('waiting');
    this.#watchId = navigator.geolocation.watchPosition(
      (fix) => {
        if (this.simulating) return;
        const point = { lng: fix.coords.longitude, lat: fix.coords.latitude };
        const result = this.#filter.push(point);
        if (!result.accepted) return;
        this.status = 'tracking';
        this.#moveTo(point, result);
      },
      (err) => this.#setStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20_000 },
    );
  }

  stop() {
    if (this.#watchId !== null) navigator.geolocation.clearWatch(this.#watchId);
    this.#watchId = null;
    this.#filter = new GpsFilter();
    this.status = 'off';
  }

  /** Demo walk: place the buddy directly, counting `meters` as walked. */
  simulate(point, meters) {
    this.#moveTo(point, { meters, teleport: this.position === null });
  }

  #moveTo(point, { meters, teleport }) {
    if (meters > 0 && this.position) {
      this.heading = bearingDeg(this.position, point);
      this.lastMovedAt = performance.now();
      walk.addGpsMeters(meters);
    }
    this.position = point;
    this.share(point);
    this.dispatchEvent(Object.assign(new Event('fix'), { teleport }));
  }

  /** While walking, tells the server where the player is, at most every 15s unless they moved 25m. */
  share(point) {
    if (!walk.walking) return;
    const now = Date.now();
    if (this.#shared && now - this.#shared.at < SHARE_EVERY_MS && distanceM(this.#shared.point, point) < SHARE_AFTER_M) return;
    this.#shared = { point, at: now };
    return api('/location', { method: 'POST', body: point }).catch(() => {});
  }

  #setStatus(status) {
    this.status = status;
    this.dispatchEvent(new Event('status'));
  }
}

export const gps = new Gps();

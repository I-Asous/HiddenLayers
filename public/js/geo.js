// GPS maths. Pure functions and a small filter, so they can be tested without
// a browser. Points are { lng, lat } in degrees.

export const STEPS_PER_KM = 1300;
export const MAX_JUMP_M = 50;
export const MIN_MOVE_M = 4;

const RAD = Math.PI / 180;
const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in metres. */
export function distanceM(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Compass bearing from a to b in degrees: 0 = north, 90 = east. */
export function bearingDeg(a, b) {
  const y = Math.sin((b.lng - a.lng) * RAD) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) -
    Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lng - a.lng) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

export const stepsFromMeters = (meters) => Math.floor((meters / 1000) * STEPS_PER_KM);

/**
 * Decides what each GPS fix means.
 *
 * - A fix more than 50m from the last good one is a jump and is ignored. If the
 *   next fix agrees with it, the phone really is somewhere new (the app was in
 *   a pocket, a tunnel, another city): we move there without counting distance.
 * - Wobble under 4m is shown but not counted, so standing still earns nothing.
 */
export class GpsFilter {
  #anchor = null; // last point distance was measured from
  #rejected = null;

  /** @returns {{ accepted: boolean, meters: number, teleport: boolean }} */
  push(point) {
    if (!this.#anchor) {
      this.#anchor = point;
      return { accepted: true, meters: 0, teleport: true };
    }
    const moved = distanceM(this.#anchor, point);
    if (moved > MAX_JUMP_M) {
      if (this.#rejected && distanceM(this.#rejected, point) <= MAX_JUMP_M) {
        this.#anchor = point;
        this.#rejected = null;
        return { accepted: true, meters: 0, teleport: true };
      }
      this.#rejected = point;
      return { accepted: false, meters: 0, teleport: false };
    }
    this.#rejected = null;
    if (moved < MIN_MOVE_M) return { accepted: true, meters: 0, teleport: false };
    this.#anchor = point;
    return { accepted: true, meters: moved, teleport: false };
  }
}

/** Total length of a path of points, in metres. */
export function pathLengthM(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distanceM(points[i - 1], points[i]);
  return total;
}

/** The point `meters` along a path (clamped to its ends). */
export function pointAlong(points, meters) {
  let remaining = Math.max(0, meters);
  for (let i = 1; i < points.length; i++) {
    const length = distanceM(points[i - 1], points[i]);
    if (remaining <= length) {
      const t = length ? remaining / length : 0;
      return {
        lng: points[i - 1].lng + (points[i].lng - points[i - 1].lng) * t,
        lat: points[i - 1].lat + (points[i].lat - points[i - 1].lat) * t,
      };
    }
    remaining -= length;
  }
  return points.at(-1);
}

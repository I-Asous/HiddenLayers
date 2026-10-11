// The session lives in an HttpOnly cookie the page can't read, so nothing
// here handles tokens. Every request carries the x-wanderling header, which
// the server requires on anything that changes data (see server/auth.js).

// Sign-ins from before passwords existed kept a token here. It no longer opens
// the game; it can only be traded, once, for a password (POST /api/claim).
const LEGACY_TOKEN_KEY = 'stepbuddy.token';

export function legacyToken() {
  try {
    return localStorage.getItem(LEGACY_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function clearLegacyToken() {
  try {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {}
}

let onSignedOut = () => {};

export function handleSignedOut(fn) {
  onSignedOut = fn;
}

// Answers that mean "wrong details", not "your session ended".
const AUTH_PATHS = ['/login', '/signup', '/claim'];

export async function api(path, { method = 'GET', body, keepalive = false } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    keepalive,
    credentials: 'same-origin',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      'x-wanderling': '1',
      'x-tz-offset': String(new Date().getTimezoneOffset()),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !AUTH_PATHS.includes(path)) onSignedOut();
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong');
    err.status = res.status;
    throw err;
  }
  return data;
}

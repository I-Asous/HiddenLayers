const TOKEN_KEY = 'stepbuddy.token';

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

let token = read(TOKEN_KEY);
let onSignedOut = () => {};

export const hasToken = () => Boolean(token);

export function setToken(value) {
  token = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

export function handleSignedOut(fn) {
  onSignedOut = fn;
}

export async function api(path, { method = 'GET', body, keepalive = false } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    keepalive,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-tz-offset': String(new Date().getTimezoneOffset()),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    setToken(null);
    onSignedOut();
  }
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong');
    err.status = res.status;
    throw err;
  }
  return data;
}

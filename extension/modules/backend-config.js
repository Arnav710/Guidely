/**
 * backend-config.js — Lumineer server host/port (chrome.storage.local).
 * Default localhost:8000 for same-machine setup; LAN IP for remote clients.
 */

const STORAGE_KEY = 'lumineer_backend';
const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 8000;

/** @type {{ host: string, port: number } | null} */
let _cached = null;

export function buildBackendUrl(host, port) {
  return `http://${host}:${port}`;
}

export function validateHost(host) {
  const h = String(host ?? '').trim();
  if (!h || h.length > 253) return false;
  if (/[\/\s:]/.test(h) || h.includes('..')) return false;
  return /^[a-zA-Z0-9.\-_]+$/.test(h);
}

export function validatePort(port) {
  const p = typeof port === 'number' ? port : parseInt(String(port), 10);
  return Number.isInteger(p) && p >= 1 && p <= 65535;
}

export function parseBackendInput(host, port) {
  const h = String(host ?? '').trim();
  const p = typeof port === 'number' ? port : parseInt(String(port), 10);
  if (!validateHost(h) || !validatePort(p)) {
    throw new Error('Invalid host or port');
  }
  return { host: h, port: p };
}

export async function loadBackendConfig() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const cfg = data[STORAGE_KEY];
    if (cfg?.host && validatePort(cfg.port)) {
      _cached = { host: String(cfg.host).trim(), port: cfg.port };
    } else {
      _cached = { host: DEFAULT_HOST, port: DEFAULT_PORT };
    }
  } catch {
    _cached = { host: DEFAULT_HOST, port: DEFAULT_PORT };
  }
  return _cached;
}

export async function getBackendBase() {
  if (!_cached) await loadBackendConfig();
  return buildBackendUrl(_cached.host, _cached.port);
}

export function getBackendDisplay() {
  const c = _cached ?? { host: DEFAULT_HOST, port: DEFAULT_PORT };
  return `${c.host}:${c.port}`;
}

export function getBackendHostPort() {
  const c = _cached ?? { host: DEFAULT_HOST, port: DEFAULT_PORT };
  return { host: c.host, port: c.port };
}

export async function saveBackendConfig(host, port) {
  const parsed = parseBackendInput(host, port);
  await chrome.storage.local.set({ [STORAGE_KEY]: parsed });
  _cached = parsed;
  return buildBackendUrl(parsed.host, parsed.port);
}

/** GET /ping — connectivity check for LAN / remote server setup. */
export async function pingBackend(baseUrl = null) {
  const base = baseUrl ?? await getBackendBase();
  try {
    const res = await fetch(`${base}/ping`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const json = await res.json().catch(() => ({}));
    return json?.ok === true;
  } catch {
    return false;
  }
}

'use strict';

/**
 * Google session cookie rotation — runs in the relay because the relay owns
 * the cookies. Rotating `__Secure-1PSIDTS` / `SIDCC` is a plain HTTP call to
 * `accounts.google.com/RotateCookies`; it needs no WAA proof, so the signer
 * stays a pure signer.
 *
 * Ported from waa-runtime `src/google/auth.js` (rotateGoogleCookies /
 * applySetCookies / toCookieHeader).
 */

const ACCOUNT_HOST_ONLY_COOKIES = new Set([
  'LSID',
  '__Host-1PLSID',
  '__Host-3PLSID',
  '__Host-GAPS',
  'ACCOUNT_CHOOSER',
]);

function toCookieHeader(cookieMap, { includeAccountHost = true } = {}) {
  const pairs = [];
  for (const [k, v] of cookieMap) {
    if (!includeAccountHost && ACCOUNT_HOST_ONLY_COOKIES.has(k)) continue;
    pairs.push(`${k}=${v}`);
  }
  return pairs.join('; ');
}

/** Apply `Set-Cookie` headers to a cookie map; returns the updated cookie names. */
function applySetCookies(cookieMap, setCookieHeaders) {
  const updated = [];
  if (!cookieMap || !Array.isArray(setCookieHeaders)) return updated;
  for (const raw of setCookieHeaders) {
    if (!raw || typeof raw !== 'string') continue;
    const parts = raw.split(';').map((s) => s.trim());
    const [nv, ...attrs] = parts;
    if (!nv) continue;
    const eq = nv.indexOf('=');
    if (eq <= 0) continue;
    const name = nv.slice(0, eq).trim();
    const val = nv.slice(eq + 1).trim();
    if (!val || val === 'deleted') continue;
    const attrStr = attrs.join('; ');
    if (/domain=[^;]*gstatic\.com/i.test(attrStr)) continue;
    if (/expires=[^;]*19[789]\d/i.test(attrStr)) continue;
    if (cookieMap.get(name) !== val) {
      cookieMap.set(name, val);
      updated.push(name);
    }
  }
  return updated;
}

/**
 * Refresh short-lived `__Secure-1PSIDTS` / `__Secure-3PSIDTS` / `SIDCC` cookies
 * from the long-lived `SID` / `__Secure-1PSID` session cookies.
 *
 * Requires the accounts.google.com host-only cookies (`LSID` / `__Host-*PLSID`);
 * without them Google may invalidate the SID session, so we skip instead.
 */
async function rotateGoogleCookies(cookieMap, options = {}) {
  if (!cookieMap || cookieMap.size === 0) {
    return { ok: false, status: 0, updated: [] };
  }
  if (
    !cookieMap.has('LSID') &&
    !cookieMap.has('__Host-1PLSID') &&
    !cookieMap.has('__Host-3PLSID') &&
    !cookieMap.has('__Secure-1PSIDTS') &&
    !cookieMap.has('__Secure-3PSIDTS')
  ) {
    return { ok: false, status: 0, updated: [], skipped: 'missing_lsid' };
  }
  const userAgent =
    options.userAgent ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
  try {
    const res = await globalThis.fetch('https://accounts.google.com/RotateCookies', {
      method: 'POST',
      headers: {
        cookie: toCookieHeader(cookieMap),
        'user-agent': userAgent,
        'content-type': 'application/json',
        origin: 'https://accounts.google.com',
        referer: 'https://accounts.google.com/RotateCookiesPage',
      },
      body: JSON.stringify([null, '-1234567890', 0]),
      signal: AbortSignal.timeout(options.timeoutMs || 15000),
    });
    const setCookies =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const updated = applySetCookies(cookieMap, setCookies);
    return { ok: res.status === 200, status: res.status, updated };
  } catch (err) {
    return { ok: false, status: 0, updated: [], error: err && err.message };
  }
}

module.exports = { rotateGoogleCookies, applySetCookies, toCookieHeader };

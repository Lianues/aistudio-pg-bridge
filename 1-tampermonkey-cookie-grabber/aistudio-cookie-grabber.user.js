// ==UserScript==
// @name         AI Studio WAA Cookie & User Grabber
// @namespace    https://aistudio.google.com/
// @version      1.2.0
// @description  在 AI Studio 网页一键抓取包含 HttpOnly 的核心 Cookie、authUser、Pro 等级并导出到剪切板或推送至本地中转端
// @match        https://aistudio.google.com/*
// @match        https://accounts.google.com/*
// @connect      127.0.0.1
// @connect      localhost
// @grant        GM_cookie
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULT_LOCAL_RELAY = 'http://127.0.0.1:18802';

  const WHITELIST = new Set([
    'SID',
    'HSID',
    'SSID',
    'APISID',
    'SAPISID',
    '__Secure-1PSID',
    '__Secure-3PSID',
    '__Secure-1PAPISID',
    '__Secure-3PAPISID',
    '__Secure-1PSIDTS',
    '__Secure-3PSIDTS',
    'SIDCC',
    '__Secure-1PSIDCC',
    '__Secure-3PSIDCC',
    'NID',
    'LSID',
    '__Host-1PLSID',
    '__Host-3PLSID',
    '__Host-GAPS',
    'ACCOUNT_CHOOSER',
  ]);

  const capturedMeta = {
    authUser: null,
    g1Tier: null,
  };

  // Hook XMLHttpRequest to capture X-Goog-AuthUser, X-AIStudio-G1-Tier & GetAiStudioBenefitTier response
  try {
    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const origOpen = win.XMLHttpRequest.prototype.open;
    const origSetHeader = win.XMLHttpRequest.prototype.setRequestHeader;
    win.XMLHttpRequest.prototype.open = function (method, url) {
      try {
        if (String(url || '').includes('GetAiStudioBenefitTier')) {
          this.addEventListener('load', function () {
            try {
              const data = JSON.parse(this.responseText);
              const code = Array.isArray(data) ? data[0] : 0;
              if (code === 1) capturedMeta.g1Tier = 'TIER1';
              else if (code === 2) capturedMeta.g1Tier = 'TIER2';
              else if (code === 3) capturedMeta.g1Tier = 'TIER0';
            } catch {}
          });
        }
      } catch {}
      return origOpen.apply(this, arguments);
    };
    win.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      try {
        const lower = String(name || '').toLowerCase();
        if (lower === 'x-goog-authuser' && value !== undefined) {
          capturedMeta.authUser = Number(value);
        } else if (lower === 'x-aistudio-g1-tier' && value) {
          capturedMeta.g1Tier = String(value);
        }
      } catch {}
      return origSetHeader.apply(this, arguments);
    };
  } catch {}

  function detectUserMetaFromPage() {
    let authUser = capturedMeta.authUser;
    if (authUser === null || Number.isNaN(authUser)) {
      const uMatch =
        location.pathname.match(/\/u\/(\d+)\//) ||
        location.search.match(/[?&]authuser=(\d+)/i);
      authUser = uMatch ? Number(uMatch[1]) : 0;
    }

    let tier = capturedMeta.g1Tier;
    if (!tier) {
      try {
        const bodyText = document.body ? document.body.innerText : '';
        if (/\bULTRA\b/.test(bodyText)) tier = 'TIER2';
        else if (/\bPRO\b/.test(bodyText)) tier = 'TIER1';
      } catch {}
    }

    return {
      authUser,
      g1Tier: tier || 'TIER0',
    };
  }

  function listCookiesByUrl(url) {
    return new Promise((resolve) => {
      if (typeof GM_cookie === 'undefined' || typeof GM_cookie.list !== 'function') {
        return resolve({ error: 'GM_cookie.list is not available', cookies: [] });
      }
      GM_cookie.list({ url }, (cookies, error) => {
        if (error) {
          resolve({ error: String(error), cookies: [] });
        } else {
          resolve({ error: null, cookies: Array.isArray(cookies) ? cookies : [] });
        }
      });
    });
  }

  async function grabAllData() {
    const [aisRes, accRes] = await Promise.all([
      listCookiesByUrl('https://aistudio.google.com/'),
      listCookiesByUrl('https://accounts.google.com/'),
    ]);

    const mergedMap = new Map();
    const httpOnlyNames = [];
    for (const c of [...aisRes.cookies, ...accRes.cookies]) {
      if (c && c.name && c.value && WHITELIST.has(c.name)) {
        mergedMap.set(c.name, c.value);
        if (c.httpOnly && !httpOnlyNames.includes(c.name)) {
          httpOnlyNames.push(c.name);
        }
      }
    }

    const cookieHeader = Array.from(mergedMap.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    const meta = detectUserMetaFromPage();
    return {
      ok: mergedMap.size > 0 && httpOnlyNames.length > 0,
      authUser: meta.authUser,
      g1Tier: meta.g1Tier,
      cookieCount: mergedMap.size,
      httpOnlyCount: httpOnlyNames.length,
      cookieNames: Array.from(mergedMap.keys()),
      httpOnlyNames,
      errors: {
        aistudio: aisRes.error,
        accounts: accRes.error,
      },
      cookies: cookieHeader,
    };
  }

  async function grabAllAndCopyToClipboard() {
    const payload = await grabAllData();
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(JSON.stringify(payload, null, 2), 'text');
    }
    return payload;
  }

  function pushToLocalRelay(payload, relayBase = DEFAULT_LOCAL_RELAY) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        return reject(new Error('GM_xmlhttpRequest unavailable'));
      }
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${relayBase.replace(/\/+$/, '')}/v1/accounts/add`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({
          cookies: payload.cookies,
          authUser: payload.authUser,
          g1Tier: payload.g1Tier,
        }),
        onload: (res) => {
          try {
            resolve(JSON.parse(res.responseText));
          } catch (e) {
            reject(e);
          }
        },
        onerror: (err) => reject(err),
      });
    });
  }

  try {
    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    win.__waaGrabToClipboard = grabAllAndCopyToClipboard;
  } catch {}

  try {
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('📋 复制 WAA Cookie JSON 到剪切板', async () => {
        await grabAllAndCopyToClipboard();
      });
      GM_registerMenuCommand('🚀 推送 Cookie 到本地中转端 (127.0.0.1:18802)', async () => {
        const data = await grabAllAndCopyToClipboard();
        await pushToLocalRelay(data);
      });
    }
  } catch {}

  function ensureFloatingWidget() {
    if (!location.hostname.endsWith('google.com')) return;
    const root = document.body || document.documentElement;
    if (!root || document.getElementById('waa-tm-grab-box')) return;

    const box = document.createElement('div');
    box.id = 'waa-tm-grab-box';
    box.style.cssText = [
      'position:fixed',
      'right:20px',
      'bottom:20px',
      'z-index:2147483647',
      'display:flex',
      'gap:8px',
      'align-items:center',
    ].join(';');

    const btnCopy = document.createElement('button');
    btnCopy.id = 'waa-tm-grab-btn';
    btnCopy.textContent = '📋 复制 WAA Cookie 到剪切板';
    btnCopy.style.cssText = [
      'padding:9px 14px',
      'border-radius:8px',
      'border:1px solid #10b981',
      'background:#065f46',
      'color:#ecfdf5',
      'font-size:13px',
      'font-weight:600',
      'cursor:pointer',
      'box-shadow:0 4px 14px rgba(0,0,0,0.45)',
    ].join(';');

    btnCopy.onclick = async () => {
      btnCopy.textContent = '⏳ 正在读取 HttpOnly Cookie...';
      const res = await grabAllAndCopyToClipboard();
      if (res.ok) {
        btnCopy.textContent = `✅ 已复制 (${res.cookieCount}项 / HttpOnly:${res.httpOnlyCount} / u=${res.authUser} / ${res.g1Tier})`;
      } else {
        btnCopy.textContent = `❌ 缺少 HttpOnly (仅${res.cookieCount}项) - 请在油猴开启 All Cookie 权限`;
      }
    };

    const btnPush = document.createElement('button');
    btnPush.textContent = '🚀 推送本地 18802';
    btnPush.style.cssText = [
      'padding:9px 12px',
      'border-radius:8px',
      'border:1px solid #3b82f6',
      'background:#1e3a8a',
      'color:#eff6ff',
      'font-size:13px',
      'font-weight:600',
      'cursor:pointer',
      'box-shadow:0 4px 14px rgba(0,0,0,0.45)',
    ].join(';');

    btnPush.onclick = async () => {
      btnPush.textContent = '⏳ 推送中...';
      try {
        const res = await grabAllAndCopyToClipboard();
        if (!res.ok) {
          btnPush.textContent = '❌ 缺 HttpOnly';
          return;
        }
        const out = await pushToLocalRelay(res);
        if (out && out.ok) {
          btnPush.textContent = `✅ 已入池 (${out.account.accountId.slice(0, 10)})`;
        } else {
          btnPush.textContent = '❌ 推送失败';
        }
      } catch {
        btnPush.textContent = '❌ 18802 未启动';
      }
    };

    box.appendChild(btnCopy);
    box.appendChild(btnPush);
    root.appendChild(box);
  }

  setInterval(ensureFloatingWidget, 1000);
})();

'use strict';

/**
 * Account Store & Local Web Dashboard for Relay Client Gateway
 *
 * Persistence:
 *   - When a storage directory is configured, every imported account is written
 *     as one JSON credential file (`cookies/acc_<hash>.json`, mode 0600) and
 *     automatically reloaded on startup.
 *   - Without a storage directory the store stays strictly in RAM.
 *
 * Security:
 *   - Dashboard API outputs only whitelisted, anonymized fields (`accountId`,
 *     `authUser`, `g1Tier`, `cookieCount`, `cookieNames`, `status`, `addedAt`,
 *     `requestsCount`), never exposing raw Cookie or Authorization strings.
 */

const crypto = require('node:crypto');
const { CookieStore } = require('./cookie-store');

const MINIMAL_COOKIE_WHITELIST = new Set([
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

function parseCookieString(rawInput) {
  const map = new Map();
  if (!rawInput) return map;
  if (typeof rawInput === 'object' && !(rawInput instanceof Map)) {
    for (const [k, v] of Object.entries(rawInput)) {
      if (k && v) map.set(String(k).trim(), String(v).trim());
    }
    return map;
  }
  const str = String(rawInput)
    .replace(/^\s*cookie\s*:\s*/i, '')
    .trim();
  for (const part of str.split(/;\s*/)) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k && v) map.set(k, v);
  }
  return map;
}

function extractMinimalCookies(rawInput) {
  const fullMap = parseCookieString(rawInput);
  const minMap = new Map();
  for (const [k, v] of fullMap.entries()) {
    if (MINIMAL_COOKIE_WHITELIST.has(k) && v) {
      minMap.set(k, v);
    }
  }
  const header = Array.from(minMap.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return { map: minMap, header };
}

function computeAccountId(cookieMap, authUser = 0) {
  const anchor =
    cookieMap.get('SAPISID') ||
    cookieMap.get('__Secure-3PAPISID') ||
    cookieMap.get('__Secure-1PAPISID') ||
    cookieMap.get('SID') ||
    cookieMap.get('__Secure-3PSID') ||
    Array.from(cookieMap.values()).join(';');
  const digest = crypto
    .createHash('sha256')
    .update(`${anchor}|u=${Number(authUser || 0)}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `acc_${digest}`;
}

function resolveModelAlias(modelInput, fallback = 'models/gemini-3.8-flash') {
  const raw = String(modelInput || '').trim();
  if (!raw) return fallback;
  const lower = raw.toLowerCase();
  if (
    lower === 'gemini-3.8-flash' ||
    lower === 'models/gemini-3.8-flash'
  ) {
    return 'models/gemini-3.8-flash';
  }
  if (
    lower === 'argon' ||
    lower === '4-argon' ||
    lower === 'gemini-4-argon' ||
    lower === 'models/gemini-4-argon'
  ) {
    return 'models/gemini-4-argon';
  }
  return raw.startsWith('models/') ? raw : `models/${raw}`;
}

class RelayAccountStore {
  /**
   * @param {object} [options]
   * @param {string} [options.storageDir] Directory for per-account JSON credentials.
   *        When set, the directory is auto-created and all `*.json` files are
   *        loaded on startup; every add/remove is persisted back to disk.
   */
  constructor(options = {}) {
    this.accounts = new Map();
    this.rrIndex = 0;
    this.storageDir = null;
    this.cookieStore = null;
    this.loadedFiles = 0;
    if (options.storageDir) {
      this.cookieStore = new CookieStore(options.storageDir);
      this.storageDir = this.cookieStore.dir;
      this.loadedFiles = this.loadFromDisk();
    }
  }

  /** Restore every persisted credential file into the in-memory store. */
  loadFromDisk() {
    if (!this.cookieStore) return 0;
    const files = this.cookieStore.list();
    let loaded = 0;
    this._loading = true;
    try {
      for (const { file, data } of files) {
        try {
          this.addAccount(
            {
              cookies: data.cookies,
              authUser: data.authUser ?? 0,
              g1Tier: data.g1Tier || null,
            },
            data.authUser ?? 0,
            data.g1Tier || null,
            data.source || 'disk',
          );
          loaded += 1;
        } catch (err) {
          console.warn(`[relay] 跳过无效 Cookie 文件 ${file}: ${err.message}`);
        }
      }
    } finally {
      this._loading = false;
    }
    return loaded;
  }

  /** Persist a single account entry (no-op when persistence is disabled). */
  persist(entry) {
    if (!this.cookieStore || this._loading) return;
    try {
      this.cookieStore.save(entry);
    } catch (err) {
      console.warn(`[relay] Cookie 持久化失败 (${entry.accountId}): ${err.message}`);
    }
  }

  /**
   * Add or update an account in the Relay Client's in-memory store.
   * Accepts:
   *   - Tampermonkey JSON export (`{ cookies, authUser, g1Tier }`)
   *   - Raw Cookie string (`SID=...; SAPISID=...`)
   *   - Full cURL command snippet
   */
  addAccount(rawInput, authUser = 0, g1Tier = null, source = 'manual') {
    let text = '';
    let jsonAuthUser = null;
    let jsonTier = null;

    if (rawInput && typeof rawInput === 'object' && typeof rawInput.cookies === 'string') {
      text = rawInput.cookies.trim();
      if (rawInput.authUser !== undefined && rawInput.authUser !== null) {
        jsonAuthUser = Number(rawInput.authUser);
      }
      if (rawInput.g1Tier) jsonTier = String(rawInput.g1Tier).trim().toUpperCase();
    } else {
      text = String(rawInput || '').trim();
    }

    // Unwrap nested JSON string (e.g., when Dashboard submits `{ cookies: "<Tampermonkey JSON>", authUser: 0 }`)
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.cookies === 'string') {
          text = parsed.cookies.trim();
          if (parsed.authUser !== undefined && parsed.authUser !== null) {
            jsonAuthUser = Number(parsed.authUser);
          }
          if (parsed.g1Tier) {
            jsonTier = String(parsed.g1Tier).trim().toUpperCase();
          }
        }
      } catch {}
    }

    const rawTextForHeaders =
      typeof rawInput === 'string'
        ? rawInput
        : rawInput && typeof rawInput.cookies === 'string'
          ? rawInput.cookies
          : text;

    const curlCookieMatch =
      text.match(/(?:-H|--header)\s+['"]cookie:\s*([^'"]+)['"]/i) ||
      text.match(/(?:-b|--cookie)\s+['"]([^'"]+)['"]/i);
    if (curlCookieMatch) {
      text = curlCookieMatch[1];
    }

    const authUserMatch = String(rawTextForHeaders || '').match(
      /(?:-H|--header)\s+['"]x-goog-authuser:\s*(\d+)['"]/i,
    );
    const tierHeaderMatch = String(rawTextForHeaders || '').match(
      /(?:-H|--header)\s+['"]x-aistudio-g1-tier:\s*(TIER\d+)['"]/i,
    );

    const resolvedAuthUser =
      jsonAuthUser !== null && !Number.isNaN(jsonAuthUser)
        ? jsonAuthUser
        : authUserMatch
          ? Number(authUserMatch[1])
          : Number(authUser ?? 0);

    const min = extractMinimalCookies(text);
    if (
      min.map.size === 0 ||
      (!min.map.has('SAPISID') && !min.map.has('__Secure-3PAPISID') && !min.map.has('SID'))
    ) {
      throw new Error('未检测到有效的 Google 核心鉴权 Cookie (需包含 SID / SAPISID / __Secure-1PSID)');
    }
    if (
      !min.map.has('__Secure-1PSID') &&
      !min.map.has('__Secure-3PSID') &&
      !min.map.has('HSID')
    ) {
      throw new Error(
        `仅检测到 ${min.map.size} 项非 HttpOnly Cookie，缺少 __Secure-1PSID / HSID / SSID（请在油猴设置开启 Cookie All 权限后重新抓取，切勿使用 document.cookie）`,
      );
    }

    const accountId = computeAccountId(min.map, resolvedAuthUser);
    const now = Date.now();
    const existing = this.accounts.get(accountId);
    const resolvedTier =
      jsonTier ||
      (tierHeaderMatch ? tierHeaderMatch[1].toUpperCase() : null) ||
      (g1Tier ? String(g1Tier).trim().toUpperCase() : null) ||
      (existing && existing.g1Tier) ||
      'TIER0';
    const entry = {
      accountId,
      authUser: resolvedAuthUser,
      g1Tier: resolvedTier,
      cookies: min.header,
      cookieCount: min.map.size,
      cookieNames: Array.from(min.map.keys()),
      source: existing ? existing.source : source,
      status: 'ready',
      addedAt: existing ? existing.addedAt : now,
      updatedAt: now,
      lastUsedAt: existing ? existing.lastUsedAt : 0,
      requestsCount: existing ? existing.requestsCount : 0,
      lastError: null,
    };
    this.accounts.set(accountId, entry);
    this.persist(entry);
    return this.toPublicView(entry);
  }

  removeAccount(accountId) {
    const removed = this.accounts.delete(accountId);
    if (removed && this.cookieStore) {
      try {
        this.cookieStore.remove(accountId);
      } catch (err) {
        console.warn(`[relay] 删除 Cookie 文件失败 (${accountId}): ${err.message}`);
      }
    }
    return removed;
  }

  /**
   * Replace an account's cookies in place.
   * Used after a local `RotateCookies` refresh or a `Set-Cookie` update, so the
   * next request starts from the refreshed set instead of the stale one.
   */
  updateCookies(rawInput, authUser = 0, newCookies = '') {
    const oldMin = extractMinimalCookies(rawInput);
    if (oldMin.map.size === 0) return null;
    const accountId = computeAccountId(oldMin.map, Number(authUser || 0));
    const entry = this.accounts.get(accountId);
    if (!entry) return null;
    const min = extractMinimalCookies(newCookies);
    if (min.map.size === 0) return null;
    entry.cookies = min.header;
    entry.cookieCount = min.map.size;
    entry.cookieNames = Array.from(min.map.keys());
    entry.updatedAt = Date.now();
    this.persist(entry);
    return this.toPublicView(entry);
  }

  countReady() {
    let count = 0;
    for (const account of this.accounts.values()) {
      if (account.status === 'ready') count += 1;
    }
    return count;
  }

  pickAccount() {
    return this.pickAccountExcluding();
  }

  /**
   * Round-robin pick among ready accounts, skipping any id already tried by
   * the current request (used for automatic failover).
   */
  pickAccountExcluding(excludedIds = null) {
    const list = Array.from(this.accounts.values()).filter((a) => a.status === 'ready');
    if (list.length === 0) return null;
    const excluded = excludedIds instanceof Set ? excludedIds : new Set(excludedIds || []);
    for (let i = 0; i < list.length; i += 1) {
      const idx = (this.rrIndex + i) % list.length;
      const candidate = list[idx];
      if (excluded.has(candidate.accountId)) continue;
      this.rrIndex = (idx + 1) % list.length;
      candidate.lastUsedAt = Date.now();
      candidate.requestsCount += 1;
      return candidate;
    }
    return null;
  }

  toPublicView(entry) {
    return {
      accountId: entry.accountId,
      authUser: entry.authUser,
      g1Tier: entry.g1Tier || 'TIER0',
      cookieCount: entry.cookieCount,
      cookieNames: entry.cookieNames,
      source: entry.source,
      status: entry.status,
      addedAt: entry.addedAt,
      updatedAt: entry.updatedAt,
      lastUsedAt: entry.lastUsedAt,
      requestsCount: entry.requestsCount,
      lastError: entry.lastError,
    };
  }

  listPublic() {
    return Array.from(this.accounts.values()).map((e) => this.toPublicView(e));
  }
}

function renderDashboardHtml({ apiKey, defaultModel = 'gemini-3.8-flash' }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WAA 本地中转网关 — Cookie 状态与 OpenAI / Gemini 接口</title>
<style>
  :root {
    --bg: #0b1120;
    --card: #1e293b;
    --border: #334155;
    --text: #f8fafc;
    --muted: #94a3b8;
    --accent: #3b82f6;
    --green: #10b981;
    --amber: #f59e0b;
    --red: #ef4444;
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
  .container { max-width: 1000px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.25); }
  h1, h2 { margin: 0 0 12px 0; }
  h1 { font-size: 21px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
  h2 { font-size: 16px; color: #e2e8f0; border-bottom: 1px solid var(--border); padding-bottom: 10px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; }
  .pill.green { background: rgba(16,185,129,0.18); color: #34d399; border: 1px solid rgba(16,185,129,0.4); }
  .pill.amber { background: rgba(245,158,11,0.18); color: #fbbf24; border: 1px solid rgba(245,158,11,0.4); }
  .pill.gray { background: rgba(148,163,184,0.15); color: #94a3b8; border: 1px solid rgba(148,163,184,0.35); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
  .stat-box { background: #0f172a; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
  .stat-label { font-size: 12px; color: var(--muted); }
  .stat-val { font-size: 20px; font-weight: 700; margin-top: 4px; }
  .stat-sub { font-size: 12px; color: var(--muted); margin-top: 4px; word-break: break-all; }
  .kv-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
  .kv-label { width: 150px; font-size: 13px; color: var(--muted); flex-shrink: 0; }
  code.box { background: #0f172a; border: 1px solid var(--border); padding: 6px 12px; border-radius: 6px; font-family: ui-monospace, monospace; font-size: 13px; color: #38bdf8; word-break: break-all; flex: 1; }
  button { padding: 8px 14px; border-radius: 8px; border: none; background: var(--accent); color: #fff; font-weight: 600; font-size: 13px; cursor: pointer; }
  button.green { background: var(--green); }
  button.secondary { background: #334155; }
  button.danger { background: var(--red); padding: 4px 10px; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 600; background: rgba(15,23,42,0.5); }
  textarea, input[type="number"] { width: 100%; background: #0f172a; border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 10px 12px; font-size: 13px; font-family: ui-monospace, monospace; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 14px; }
  pre { background: #0f172a; border: 1px solid var(--border); border-radius: 8px; padding: 12px; overflow-x: auto; font-size: 12px; color: #cbd5e1; margin: 10px 0 0 0; }
</style>
</head>
<body>
<div class="container">
  <div class="card">
    <h1>
      <span>⚡ WAA 中转网关（Cookie 持久化 · 支持 SSE 流式响应）</span>
      <span id="overall-badge" class="pill amber">检测中...</span>
    </h1>
    <div class="grid">
      <div class="stat-box">
        <div class="stat-label">已加载账号</div>
        <div class="stat-val" id="stat-accounts">0</div>
      </div>
      <div class="stat-box">
        <div class="stat-label" id="stat-pool-label">当前账号池状态</div>
        <div class="stat-val" id="stat-pool">—</div>
        <div class="stat-sub" id="stat-pool-sub">未连接签名服务</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Cookie 持久化</div>
        <div class="stat-val" id="stat-persist" style="font-size:15px;">—</div>
        <div class="stat-sub" id="stat-persist-sub"></div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>
      <span>🔑 1. 导入油猴抓取的 Cookie JSON / 原始 Cookie</span>
      <button class="secondary" onclick="refreshStatus()">🔄 刷新状态</button>
    </h2>
    <div style="margin-bottom:12px;">
      <div style="font-size:13px;color:var(--muted);margin-bottom:6px;">粘贴油猴脚本复制到剪切板的 JSON、原始 Cookie 字符串或 cURL 命令：</div>
      <textarea id="manual-cookie" rows="3" placeholder='直接粘贴油猴导出的 JSON ({"ok":true,"authUser":0,"g1Tier":"TIER1","cookies":"..."}) 或 SID=...; SAPISID=...'></textarea>
      <div style="display:flex;gap:10px;margin-top:8px;align-items:center;">
        <span style="font-size:13px;color:var(--muted);">AuthUser (默认 0):</span>
        <input id="manual-authuser" type="number" value="0" style="width:80px;" />
        <button class="green" onclick="submitManualCookie()">✅ 导入并保存</button>
      </div>
    </div>

    <div style="overflow-x:auto;">
      <table>
        <thead>
          <tr>
            <th>账号 ID</th>
            <th>等级 (Tier)</th>
            <th>AuthUser</th>
            <th>Cookie 数</th>
            <th>池状态</th>
            <th>调用次数</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="accounts-tbody">
          <tr><td colspan="7" style="text-align:center;color:var(--muted);">暂无账号，请先导入 Cookie</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="card">
    <h2>🔌 2. 本地 OpenAI / Gemini 兼容接口（支持 stream: true 实时 SSE）</h2>
    <div class="kv-row">
      <span class="kv-label">OpenAI Base URL:</span>
      <code class="box" id="oai-base-url"></code>
    </div>
    <div class="kv-row">
      <span class="kv-label">API Key:</span>
      <code class="box" id="oai-api-key">${apiKey}</code>
    </div>
    <div class="kv-row">
      <span class="kv-label">支持模型:</span>
      <code class="box">gemini-3.8-flash / gemini-4-argon（argon）/ 其他 Gemini 模型名直传</code>
    </div>
    <pre id="curl-example"></pre>
  </div>
</div>

<script>
const API_KEY = ${JSON.stringify(apiKey)};
const DEFAULT_MODEL = ${JSON.stringify(defaultModel)};
const originUrl = window.location.origin;
document.getElementById('oai-base-url').textContent = originUrl + '/v1';
document.getElementById('curl-example').textContent =
\`curl -N \${originUrl}/v1/chat/completions \\\\
  -H "Content-Type: application/json" \\\\
  -H "Authorization: Bearer \${API_KEY}" \\\\
  -d '{
    "model": "\${DEFAULT_MODEL}",
    "stream": true,
    "messages": [{"role": "user", "content": "你好，请介绍一下自己"}]
  }'\`;

function fmtRemain(ts) {
  if (!ts) return '';
  const ms = ts - Date.now();
  if (ms <= 0) return '已过期';
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + ' 分钟后到期';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时后到期';
  return Math.floor(h / 24) + ' 天后到期';
}

function poolBadgeHtml(pool) {
  if (!pool) return '<span class="pill gray">未入库</span>';
  const cls = pool.state === 'hot' ? 'green' : 'amber';
  return '<span class="pill ' + cls + '" title="' + fmtRemain(pool.expiresAt) + '">' + pool.state + '</span>';
}

async function refreshStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    const accs = data.accounts || [];
    document.getElementById('stat-accounts').textContent = accs.length;

    const primary = accs[0];
    const pool = primary && primary.pool;
    document.getElementById('stat-pool-label').textContent =
      primary ? '当前账号池状态 (' + primary.accountId + ')' : '当前账号池状态';
    document.getElementById('stat-pool').textContent = primary ? (pool ? pool.state : '未入库') : '—';
    document.getElementById('stat-pool-sub').textContent = pool
      ? '累计签名 ' + pool.mints + ' 次 · ' + fmtRemain(pool.expiresAt)
      : (primary ? '尚未在该签名服务中初始化' : '先导入一个 Cookie 账号');

    document.getElementById('stat-persist').textContent = data.cookiesDir
      ? '已开启 · ' + (data.cookieFiles || 0) + ' 个文件'
      : '未开启（仅内存）';
    document.getElementById('stat-persist-sub').textContent = data.cookiesDir || '';

    const badge = document.getElementById('overall-badge');
    if (accs.length > 0) {
      badge.className = 'pill green';
      badge.textContent = '✅ Cookie 已就绪 (' + accs.length + ' 个账号)';
    } else {
      badge.className = 'pill amber';
      badge.textContent = '⚠️ 暂无 Cookie 账号 (请导入)';
    }

    const tbody = document.getElementById('accounts-tbody');
    if (accs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);">暂无账号，请先导入 Cookie</td></tr>';
    } else {
      tbody.innerHTML = accs.map(a => \`
        <tr>
          <td><code>\${a.accountId}</code></td>
          <td><code>\${a.g1Tier || 'TIER0'}</code></td>
          <td>\${a.authUser}</td>
          <td title="\${(a.cookieNames || []).join(', ')}">\${a.cookieCount}</td>
          <td>\${poolBadgeHtml(a.pool)}</td>
          <td>\${a.requestsCount}</td>
          <td><button class="danger" onclick="removeAcc('\${a.accountId}')">移除</button></td>
        </tr>
      \`).join('');
    }
  } catch (e) {}
}

async function submitManualCookie() {
  const raw = document.getElementById('manual-cookie').value.trim();
  const authUser = Number(document.getElementById('manual-authuser').value || 0);
  if (!raw) return alert('请粘贴 Cookie 或油猴导出的 JSON');
  let bodyPayload = { cookies: raw, authUser };
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.cookies === 'string') {
        bodyPayload = {
          cookies: parsed.cookies,
          authUser: parsed.authUser !== undefined ? Number(parsed.authUser) : authUser,
          g1Tier: parsed.g1Tier || null,
        };
      }
    } catch {}
  }
  const res = await fetch('/api/accounts/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyPayload)
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    return alert('导入失败: ' + (data.error || '未知错误'));
  }
  document.getElementById('manual-cookie').value = '';
  document.getElementById('manual-authuser').value = '0';
  refreshStatus();
}

async function removeAcc(accountId) {
  await fetch('/api/accounts/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId })
  });
  refreshStatus();
}

refreshStatus();
setInterval(refreshStatus, 5000);
</script>
</body>
</html>`;
}

module.exports = {
  MINIMAL_COOKIE_WHITELIST,
  extractMinimalCookies,
  computeAccountId,
  resolveModelAlias,
  RelayAccountStore,
  renderDashboardHtml,
};

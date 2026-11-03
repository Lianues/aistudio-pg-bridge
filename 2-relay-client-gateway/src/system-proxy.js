'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { Readable } = require('node:stream');
const { execFileSync } = require('node:child_process');

const PROXY_CACHE_TTL_MS = 10_000;
const COMMON_PROXY_PORTS = [7890, 7897, 7891, 10809, 10808, 2080];
const CLASH_CONTROLLER_PORTS = [9090, 9097];

let _cachedProxy = {
  checkedAt: 0,
  proxyUrl: null,
  source: 'direct/tun',
};
let _resolvingPromise = null;

function normalizeProxyUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim().replace(/^["']|["']$/g, '');
  if (!s) return null;

  // Handle Windows multi-protocol format: "http=127.0.0.1:10809;https=127.0.0.1:10809;socks=..."
  if (s.includes('=')) {
    const parts = s.split(';').map((p) => p.trim()).filter(Boolean);
    const map = {};
    for (const part of parts) {
      const eq = part.indexOf('=');
      if (eq > 0) {
        const k = part.slice(0, eq).trim().toLowerCase();
        const v = part.slice(eq + 1).trim();
        if (v) map[k] = v;
      }
    }
    s = map.https || map.http || Object.values(map)[0] || '';
    if (!s) return null;
  }

  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
    s = `http://${s}`;
  }

  try {
    const u = new URL(s);
    if (!u.hostname || !u.port) return null;
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return null;
    }
    return `http://${u.hostname}:${u.port}`;
  } catch {
    return null;
  }
}

function parseWindowsRegOutput(stdout) {
  if (!stdout || typeof stdout !== 'string') return null;
  const enableMatch = stdout.match(/ProxyEnable\s+REG_DWORD\s+(0x[0-9a-fA-F]+|\d+)/i);
  if (!enableMatch) return null;
  const enabled = Number(enableMatch[1]);
  if (!enabled) return null;

  const serverMatch = stdout.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
  if (!serverMatch || !serverMatch[1]) return null;
  return normalizeProxyUrl(serverMatch[1].trim());
}

function parseMacScutilOutput(stdout) {
  if (!stdout || typeof stdout !== 'string') return null;
  const getVal = (key) => {
    const m = stdout.match(new RegExp(`\\b${key}\\s*:\\s*([^\\r\\n]+)`));
    return m ? m[1].trim() : '';
  };
  if (getVal('HTTPSEnable') === '1') {
    const host = getVal('HTTPSProxy');
    const port = getVal('HTTPSPort');
    if (host && port) return normalizeProxyUrl(`${host}:${port}`);
  }
  if (getVal('HTTPEnable') === '1') {
    const host = getVal('HTTPProxy');
    const port = getVal('HTTPPort');
    if (host && port) return normalizeProxyUrl(`${host}:${port}`);
  }
  return null;
}

function detectEnvProxy() {
  const keys = [
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'ALL_PROXY',
    'all_proxy',
  ];
  for (const k of keys) {
    const val = process.env[k];
    const parsed = normalizeProxyUrl(val);
    if (parsed) {
      return { proxyUrl: parsed, source: `env:${k}` };
    }
  }
  return null;
}

function detectOsSystemProxy() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
        { encoding: 'utf8', timeout: 1500, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const proxyUrl = parseWindowsRegOutput(out);
      if (proxyUrl) return { proxyUrl, source: 'win32-system-proxy' };
    } else if (process.platform === 'darwin') {
      const out = execFileSync('scutil', ['--proxy'], {
        encoding: 'utf8',
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const proxyUrl = parseMacScutilOutput(out);
      if (proxyUrl) return { proxyUrl, source: 'macos-system-proxy' };
    } else if (process.platform === 'linux') {
      const mode = execFileSync('gsettings', ['get', 'org.gnome.system.proxy', 'mode'], {
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().replace(/^'|'$/g, '');
      if (mode === 'manual') {
        const host = execFileSync('gsettings', ['get', 'org.gnome.system.proxy.http', 'host'], {
          encoding: 'utf8',
          timeout: 1000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim().replace(/^'|'$/g, '');
        const port = execFileSync('gsettings', ['get', 'org.gnome.system.proxy.http', 'port'], {
          encoding: 'utf8',
          timeout: 1000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const proxyUrl = normalizeProxyUrl(`${host}:${port}`);
        if (proxyUrl) return { proxyUrl, source: 'linux-gsettings-proxy' };
      }
    }
  } catch {
    // Ignore when system proxy CLI is unavailable or disabled
  }
  return null;
}

function probeTcpPort(host, port, timeoutMs = 150) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {}
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function queryClashControllerPort(ctrlPort, timeoutMs = 200) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port: ctrlPort,
        path: '/configs',
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const cfg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const p = Number(cfg['mixed-port'] || cfg.port || 0);
            if (p > 0 && p < 65536) {
              resolve({ proxyUrl: `http://127.0.0.1:${p}`, source: `mihomo/clash-api:${p}` });
              return;
            }
          } catch {}
          resolve(null);
        });
      },
    );
    req.on('timeout', () => {
      try {
        req.destroy();
      } catch {}
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

async function detectLocalProxyPort() {
  for (const ctrlPort of CLASH_CONTROLLER_PORTS) {
    const found = await queryClashControllerPort(ctrlPort);
    if (found && found.proxyUrl) {
      const portNum = Number(new URL(found.proxyUrl).port);
      if (await probeTcpPort('127.0.0.1', portNum)) {
        return found;
      }
    }
  }
  for (const port of COMMON_PROXY_PORTS) {
    if (await probeTcpPort('127.0.0.1', port)) {
      return { proxyUrl: `http://127.0.0.1:${port}`, source: `auto-port:${port}` };
    }
  }
  return null;
}

async function resolveSystemProxyInfo(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _cachedProxy.checkedAt && now - _cachedProxy.checkedAt < PROXY_CACHE_TTL_MS) {
    return _cachedProxy;
  }
  if (_resolvingPromise && !forceRefresh) {
    return _resolvingPromise;
  }
  _resolvingPromise = (async () => {
    try {
      const syncDetected = detectEnvProxy() || detectOsSystemProxy();
      if (syncDetected && syncDetected.proxyUrl) {
        const u = new URL(syncDetected.proxyUrl);
        const reachable = await probeTcpPort(u.hostname, Number(u.port), 250);
        if (reachable) {
          _cachedProxy = {
            checkedAt: Date.now(),
            proxyUrl: syncDetected.proxyUrl,
            source: syncDetected.source,
          };
          return _cachedProxy;
        }
      }
      const autoDetected = await detectLocalProxyPort();
      if (autoDetected && autoDetected.proxyUrl) {
        _cachedProxy = {
          checkedAt: Date.now(),
          proxyUrl: autoDetected.proxyUrl,
          source: autoDetected.source,
        };
        return _cachedProxy;
      }
      _cachedProxy = {
        checkedAt: Date.now(),
        proxyUrl: null,
        source: 'direct/tun',
      };
      return _cachedProxy;
    } finally {
      _resolvingPromise = null;
    }
  })();
  return _resolvingPromise;
}

function getSystemProxyInfo() {
  return _cachedProxy;
}

function invalidateSystemProxyCache() {
  _cachedProxy = { checkedAt: 0, proxyUrl: null, source: 'direct/tun' };
}

function isLocalOrPrivateHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return true;
  if (h.startsWith('127.') || h.startsWith('10.') || h.startsWith('192.168.')) return true;
  const m172 = h.match(/^172\.(\d+)\./);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

function createFetchCompatibleResponse(res) {
  const rawHeaders = res.headers || {};
  const setCookieHeader = rawHeaders['set-cookie'];
  const setCookieList = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];

  let bodyConsumed = false;
  let webStream = null;

  const collectBuffer = () =>
    new Promise((resolve, reject) => {
      if (bodyConsumed) {
        resolve(Buffer.alloc(0));
        return;
      }
      bodyConsumed = true;
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });

  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode || 500,
    statusText: res.statusMessage || '',
    headers: {
      get(name) {
        if (!name) return null;
        const val = rawHeaders[String(name).toLowerCase()];
        if (val === undefined) return null;
        return Array.isArray(val) ? val.join(', ') : String(val);
      },
      getSetCookie() {
        return setCookieList;
      },
    },
    get body() {
      if (!webStream) {
        bodyConsumed = true;
        webStream = Readable.toWeb(res);
      }
      return webStream;
    },
    async text() {
      const buf = await collectBuffer();
      return buf.toString('utf8');
    },
    async json() {
      const txt = await this.text();
      return JSON.parse(txt);
    },
  };
}

function requestViaHttpProxy(targetUrlStr, options, proxyUrlStr) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(targetUrlStr);
    const proxyUrl = new URL(proxyUrlStr);
    const proxyHost = proxyUrl.hostname;
    const proxyPort = Number(proxyUrl.port || 80);
    const isHttps = targetUrl.protocol === 'https:';
    const targetPort = Number(targetUrl.port || (isHttps ? 443 : 80));
    const method = (options && options.method) || 'GET';
    const headers = { ...((options && options.headers) || {}) };
    const body = options && options.body != null ? options.body : null;
    const signal = options && options.signal ? options.signal : null;

    if (body != null && !headers['content-length'] && !headers['Content-Length']) {
      headers['content-length'] = String(Buffer.byteLength(body));
    }

    if (!isHttps) {
      const req = http.request(
        {
          host: proxyHost,
          port: proxyPort,
          method,
          path: targetUrl.toString(),
          headers: {
            ...headers,
            Host: targetUrl.host,
          },
          agent: false,
          signal,
        },
        (res) => resolve(createFetchCompatibleResponse(res)),
      );
      req.on('error', (err) => {
        err._proxyConnectError = true;
        reject(err);
      });
      if (body != null) req.write(body);
      req.end();
      return;
    }

    const connectReq = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetUrl.hostname}:${targetPort}`,
      headers: {
        Host: `${targetUrl.hostname}:${targetPort}`,
      },
      agent: false,
      timeout: 5000,
    });

    let settled = false;
    const failConnect = (err) => {
      if (settled) return;
      settled = true;
      err._proxyConnectError = true;
      try {
        connectReq.destroy();
      } catch {}
      reject(err);
    };

    connectReq.on('timeout', () => failConnect(new Error('System proxy CONNECT timeout')));
    connectReq.on('error', failConnect);

    connectReq.on('connect', (connectRes, socket, head) => {
      if (connectRes.statusCode !== 200) {
        socket.destroy();
        failConnect(new Error(`System proxy CONNECT returned HTTP ${connectRes.statusCode}`));
        return;
      }
      if (head && head.length > 0) {
        socket.unshift(head);
      }

      const tlsSocket = tls.connect({
        socket,
        servername: targetUrl.hostname,
        ALPNProtocols: ['http/1.1'],
      });

      const req = https.request(
        {
          host: targetUrl.hostname,
          port: targetPort,
          method,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          headers: {
            ...headers,
            Host: targetUrl.host,
          },
          agent: false,
          createConnection: () => tlsSocket,
          signal,
        },
        (res) => {
          settled = true;
          resolve(createFetchCompatibleResponse(res));
        },
      );

      req.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });

      if (body != null) req.write(body);
      req.end();
    });

    connectReq.end();
  });
}

async function fetchWithSystemProxyFallback(url, options = {}) {
  const urlStr = String(url);
  let parsedUrl;
  try {
    parsedUrl = new URL(urlStr);
  } catch {
    return globalThis.fetch(url, options);
  }

  if (isLocalOrPrivateHost(parsedUrl.hostname)) {
    return globalThis.fetch(url, options);
  }

  const proxyInfo = await resolveSystemProxyInfo();
  if (proxyInfo && proxyInfo.proxyUrl) {
    try {
      return await requestViaHttpProxy(urlStr, options, proxyInfo.proxyUrl);
    } catch (err) {
      if (err && err._proxyConnectError) {
        invalidateSystemProxyCache();
        return globalThis.fetch(url, options);
      }
      throw err;
    }
  }

  return globalThis.fetch(url, options);
}

module.exports = {
  normalizeProxyUrl,
  parseWindowsRegOutput,
  parseMacScutilOutput,
  resolveSystemProxyInfo,
  getSystemProxyInfo,
  invalidateSystemProxyCache,
  fetchWithSystemProxyFallback,
};

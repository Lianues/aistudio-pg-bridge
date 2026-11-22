#!/usr/bin/env node
'use strict';

const dns = require('node:dns');
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

function tuneGlobalFetchDispatcher() {
  try {
    // 访问 globalThis.fetch 触发 Node 懒加载内置 undici Dispatcher
    const _f = globalThis.fetch;
    if (typeof _f !== 'function') return;
    const sym = Symbol.for('undici.globalDispatcher.1');
    const cur = globalThis[sym];
    if (!cur || typeof cur.constructor !== 'function') return;
    const Agent = cur.constructor;
    globalThis[sym] = new Agent({
      headersTimeout: 900_000,
      bodyTimeout: 900_000,
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 10_000,
      connect: { family: 4 },
    });
  } catch (err) {
    console.warn('[Relay Gateway] Undici 全局连接池调优失败，回退默认配置:', err && err.message);
  }
}
tuneGlobalFetchDispatcher();

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadEnv, PROJECT_ROOT, parseEnv } = require('../src/env');

// Configuration lives in `<project>/.env` — no `--env-file` / CLI flags needed.
loadEnv();

const { createRelayServer } = require('../src/relay-server');

function isLoopbackUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
  } catch {
    return false;
  }
}

async function isProofServerReady(baseUrl) {
  try {
    const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/v1/pool/summary`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureLocalProofServer() {
  if (process.env.AUTO_START_PROOF === '0') return null;

  const proofDir = path.resolve(PROJECT_ROOT, '..', '3-waa-proof-server');
  const proofEntry = path.join(proofDir, 'bin', 'start-proof-server.js');
  if (!fs.existsSync(proofEntry)) {
    throw new Error(`未找到本地签名服务入口: ${proofEntry}`);
  }

  let parsedProofEnv = {};
  const proofEnvFile = path.join(proofDir, '.env');
  if (fs.existsSync(proofEnvFile)) {
    try {
      parsedProofEnv = parseEnv(fs.readFileSync(proofEnvFile, 'utf8'));
    } catch {}
  }

  // 彻底走本地 3-waa-proof-server（忽略旧版 .env 中残留的 PROOF_SERVER_URL）
  delete process.env.PROOF_SERVER_URL;
  const localHost = process.env.PROOF_HOST || parsedProofEnv.PROOF_HOST || '127.0.0.1';
  const localPort = process.env.PROOF_PORT || parsedProofEnv.PROOF_PORT || '18801';
  const connectHost = localHost === '0.0.0.0' ? '127.0.0.1' : localHost;
  const localUrl = `http://${connectHost}:${localPort}`;

  if (await isProofServerReady(localUrl)) {
    return null;
  }

  const childEnv = {
    ...parsedProofEnv,
    ...process.env,
    PROOF_HOST: localHost,
    PROOF_PORT: String(localPort),
  };

  console.log(`[Relay Gateway] 正在自动启动本地 WAA 签名服务 (${localUrl})...`);
  const child = spawn(process.execPath, [proofEntry], {
    cwd: proofDir,
    env: childEnv,
    stdio: 'inherit',
  });

  const stopChild = () => {
    if (!child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
  };
  process.once('SIGINT', stopChild);
  process.once('SIGTERM', stopChild);
  process.once('exit', stopChild);

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`本地 WAA 签名服务提前退出 (exitCode=${child.exitCode})`);
    }
    if (await isProofServerReady(localUrl)) {
      return child;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.warn('[Relay Gateway] 本地 WAA 签名服务启动等待超时，继续启动网关');
  return child;
}

async function main() {
  await ensureLocalProofServer();

  const srv = createRelayServer();
  const info = await srv.listen();
  const apiKey = process.env.RELAY_API_KEY || 'sk-waa-local-relay-key';
  const cookiesDir = srv.relayClient.accountStore.storageDir;

  console.log(`[Relay Gateway] Dashboard:   ${info.url}/`);
  console.log(`[Relay Gateway] OpenAI Base: ${info.url}/v1`);
  console.log(`[Relay Gateway] API Key:     ${apiKey}`);
  console.log(`[Relay Gateway] Proof Srv:   ${srv.relayClient.proofServerUrl}`);
  console.log(`[Relay Gateway] Cookie Dir:  ${cookiesDir || '(memory only)'}`);
  console.log(`[Relay Gateway] Config:      ${PROJECT_ROOT}/.env`);
}

main().catch((err) => {
  console.error('[Relay Gateway] Fatal error:', err);
  process.exit(1);
});

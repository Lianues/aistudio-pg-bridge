#!/usr/bin/env node
'use strict';

const { loadEnv, PROJECT_ROOT } = require('../src/env');

// Configuration lives in `<project>/.env` — no `--env-file` / CLI flags needed.
loadEnv();

const { createRelayServer } = require('../src/relay-server');

async function main() {
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

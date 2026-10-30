'use strict';

/**
 * Minimal `.env` loader (no external dependency).
 *
 * The relay is configured exclusively through `.env` / `process.env`; this
 * loader lets `node bin/start-relay.js` work without `--env-file`.
 * Real environment variables always win over values from the file.
 */

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load `<project>/.env` into `process.env` (existing variables are kept).
 * Returns the parsed map, or `{}` when the file is missing.
 */
function loadEnv(filePath = path.join(PROJECT_ROOT, '.env'), options = {}) {
  const { override = false } = options;
  if (!fs.existsSync(filePath)) return {};
  let parsed = {};
  try {
    parsed = parseEnv(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`[relay] 读取 .env 失败: ${err.message}`);
    return {};
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
  return parsed;
}

module.exports = { PROJECT_ROOT, loadEnv, parseEnv };

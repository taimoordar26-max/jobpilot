#!/usr/bin/env node
// start.js — Zero-setup bootstrap. This is what the user's agent launches.
// On first run it: (1) installs npm deps if missing, (2) ensures Playwright's
// Chromium is present, (3) makes sure a debug-enabled Chrome is reachable,
// then (4) hands off to the real MCP server over the SAME stdio pipes.
//
// MCP config points here:  { "command": "node", "args": ["<path>/start.js"] }
//
// All setup logs go to STDERR so they never corrupt the MCP stdout channel.
import { spawnSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import net from 'net';
import os from 'os';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => process.stderr.write('[bootstrap] ' + a.join(' ') + '\n');

// ── 1. Dependencies ───────────────────────────────────────────────────────────
function ensureDeps() {
  const need = ['@modelcontextprotocol/sdk', 'playwright', 'sql.js', 'node-fetch'];
  const missing = need.filter(d => !fs.existsSync(path.join(__dir, 'node_modules', d)));
  if (!missing.length) return;
  log(`Installing dependencies (first run): ${missing.join(', ')} …`);
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: __dir, stdio: ['ignore', 'inherit', 'inherit'], shell: true,
  });
  if (r.status !== 0) { log('npm install failed'); process.exit(1); }
  log('Dependencies installed.');
}

// ── 2. Playwright Chromium (only used as a fallback browser) ──────────────────
function ensureChromium() {
  // We prefer the user's real Chrome; Chromium is only the no-login fallback.
  // Skip heavy download unless the user has no Chrome at all.
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium',
  ];
  return chromePaths.find(p => fs.existsSync(p)) || null;
}

// ── 3. Chrome debug port ──────────────────────────────────────────────────────
function portOpen(port, host = '127.0.0.1', timeout = 1000) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    sock.setTimeout(timeout);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(false));
    sock.connect(port, host);
  });
}

async function ensureChrome() {
  if (await portOpen(9222)) { log('Debug Chrome already up on :9222.'); return; }

  const chrome = ensureChromium();
  if (!chrome) {
    log('No Chrome found. The agent can still scrape public APIs; logged-in sites need Chrome.');
    return;
  }

  // Dedicated debug profile — SEPARATE from your real Chrome, never touches it.
  const debugDir = path.join(__dir, 'data', 'chrome-debug-profile');
  fs.mkdirSync(debugDir, { recursive: true });
  const firstRun = !fs.existsSync(path.join(debugDir, 'Default'));

  log(`Launching dedicated debug Chrome (separate window, your normal Chrome untouched)…`);
  const child = spawn(chrome, [
    '--remote-debugging-port=9222',
    `--user-data-dir=${debugDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--no-service-autorun', '--disable-sync',
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  for (let i = 0; i < 20; i++) {
    if (await portOpen(9222)) {
      if (firstRun) log('FIRST RUN: log into LinkedIn + Gmail in the debug Chrome window once — it stays logged in.');
      else log('Debug Chrome up (your LinkedIn/Gmail logins persist here).');
      return;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  log('Debug Chrome did not expose the debug port in time.');
}

// ── 4. Hand off to the MCP server over the same stdio ─────────────────────────
async function main() {
  ensureDeps();
  await ensureChrome();
  log('Starting MCP server …');

  // NEVER STOP: supervise the MCP server. A clean exit (code 0 — the agent closed the
  // connection) ends normally; a CRASH (non-zero / signal) is auto-restarted with backoff
  // so the server is never left down while the agent/CLI is still using it.
  let restarts = 0;
  const startServer = () => {
    const srv = spawn(process.execPath, [path.join(__dir, 'mcp-server.js')], {
      cwd: __dir, stdio: ['inherit', 'inherit', 'inherit'],
    });
    srv.on('exit', (code, signal) => {
      if (code === 0) { process.exit(0); return; }            // clean shutdown — honor it
      restarts++;
      if (restarts > 20) { log(`MCP server crashed ${restarts}× — giving up.`); process.exit(code ?? 1); return; }
      const wait = Math.min(30000, 2000 * restarts);
      log(`MCP server exited (code=${code} signal=${signal}) — restarting in ${Math.round(wait / 1000)}s (#${restarts})`);
      setTimeout(startServer, wait);
    });
  };
  startServer();
}

main().catch(e => { log('FATAL: ' + e.message); process.exit(1); });

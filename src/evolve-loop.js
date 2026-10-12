// src/evolve-loop.js — Background self-evolution loop + worker autostart for the MCP server.
//
// Two jobs:
//   1. AUTO-START the full worker lanes (scout · mailer · applier · connector · evolver) as a
//      detached, self-respawning background process so hunting + applying + self-evolving loops
//      CONTINUOUSLY until the user presses Stop — WITHOUT the agent having to re-prompt itself.
//   2. Run a lightweight self-evolution tick (dashboard refresh + sync/PR) as a fallback for when
//      the worker genuinely can't run.
//
// DOUBLE-CONTRIBUTION GUARD: if the always-on worker is running (fresh heartbeat in
// data/worker-state.json), the contribute part of THIS loop stands down and lets the worker own
// the contribute loop — so you never get two processes opening redundant PRs at once.
//
// Self-evolution is CORE and always-on: it cannot be silently bypassed. The only gates are on the
// CONTRIBUTION step (consent toggle, worker stand-down, CI) and on the worker AUTOSTART
// (data/.stop flag, CI, or JOBPILOT_NO_AUTOWORKER=1) — never on whether the loop runs.
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { DATA, ROOT } from './config.js';
import { getProfile } from './profile.js';

const STATE = path.join(DATA, 'worker-state.json');
const STOPFILE = path.join(DATA, '.stop');
const log = (...a) => console.error('[mcp-evolve] ' + a.join(' '));

/** @returns {boolean} true if the always-on worker is alive (heartbeat < 2 min old). */
export function workerIsLive() {
  try {
    const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    return st.ts ? (Date.now() - Date.parse(st.ts)) < 2 * 60000 : false;
  } catch { return false; }
}

/**
 * Ensure the full worker lanes (scout · mailer · applier · connector · evolver) are RUNNING as a
 * detached, self-respawning background process — so hunting + applying + self-evolving keeps
 * looping until the user presses Stop, WITHOUT the agent having to re-prompt itself.
 *
 * Guards:
 *   • no-op if the worker heartbeat is fresh (already running) — never double-starts.
 *   • no-op if data/.stop exists (user asked to stop) or during CI.
 *   • opt-out with JOBPILOT_NO_AUTOWORKER=1.
 * The spawned process is detached + unref'd so it outlives this MCP/server session.
 */
export function ensureWorkerRunning() {
  if (process.env.CI || process.env.JOBPILOT_NO_AUTOWORKER === '1') return;
  if (fs.existsSync(STOPFILE)) { log('stop flag present — not auto-starting worker'); return; }
  if (workerIsLive()) return;                          // already running
  try {
    const supervisor = path.join(ROOT, 'scripts', 'worker-forever.mjs');
    const child = spawn(process.execPath, [supervisor], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();                                     // let it outlive this process
    log('🚀 auto-started the always-on worker (hunt · apply · self-evolve) — loops until Stop');
  } catch (e) {
    log('could not auto-start worker: ' + (e.message || e).toString().slice(0, 100));
  }
}

/**
 * Start the background evolution loop. Non-blocking; returns a stop() function.
 * @param {object} [opts]
 * @param {number} [opts.syncMs]     - how often to sync + review/merge PRs (default 10 min)
 * @param {number} [opts.contribMs]  - how often to run the full contribute round (default 20 min)
 * @param {number} [opts.dashMs]     - how often to refresh the dashboard (default 45 s)
 * @returns {() => void} stop function
 */
export function startBackgroundEvolve({ syncMs = 2 * 60000, contribMs = 10 * 60000, dashMs = 45000 } = {}) {
  // Self-evolution is the core of this project — it is NOT optional and cannot be silently
  // bypassed. The loop ALWAYS runs (keeping the dashboard/playbook fresh and, when appropriate,
  // syncing + contributing). The only gates are on the CONTRIBUTION step: the user's data-safety
  // consent toggle, the worker stand-down (avoid double-contribution), and CI.

  let lastSync = 0, lastContrib = 0, stopped = false;

  // AUTO-START the full worker lanes so hunting + applying + self-evolving loops continuously
  // (until Stop) without the agent re-prompting itself. Guarded against double-start + stop flag.
  ensureWorkerRunning();

  const tick = async () => {
    if (stopped) return;
    // Keep the always-on worker alive — relaunch if it ever died and isn't stopping.
    ensureWorkerRunning();
    // Always keep the dashboard fresh (cheap, local, safe even alongside the worker).
    try { const { writeDash } = await import('./dashboard.js'); writeDash(); } catch {}
    try { const { writePlaybook } = await import('./evolve.js'); writePlaybook(); } catch {}

    // Contribute/sync ONLY when the worker isn't the one doing it (avoid double-contribution),
    // only when the user has left self-contribution on, and never during CI boot tests.
    const consentOn = getProfile().consent?.autoContribute !== false;
    if (consentOn && !workerIsLive() && !process.env.CI) {
      const now = Date.now();
      try {
        const { syncBranch, repoInfo, reviewAndMergePRs, contributeRound } = await import('./contribute.js');
        // ~10 min: keep in sync + (main repo) review & merge open PRs
        if (now - lastSync > syncMs) {
          lastSync = now;
          const info = await repoInfo();
          const s = await syncBranch();
          if (s.advanced) log(`pulled newer upstream version (in sync with ${s.upstream || 'origin'})`);
          if (!info.isFork) {
            const rev = await reviewAndMergePRs();
            if (rev.merged?.length) log(`reviewed + merged PRs: ${rev.merged.join(', ')}`);
            if (rev.closed?.length) log(`closed empty/redundant PRs: ${rev.closed.join(', ')}`);
          }
        }
        // ~20 min: full contribute round (sync → file issues → PR / review+merge)
        if (now - lastContrib > contribMs) {
          lastContrib = now;
          const r = await contributeRound();
          if (r.pr?.pr) log(`opened self-evolve PR: ${r.pr.pr}`);
          if (r.review?.merged?.length) log(`merged PRs: ${r.review.merged.join(', ')}`);
          if (r.issues?.filed?.length) log(`filed issues: ${r.issues.filed.join(', ')}`);
        }
      } catch (e) { log('tick skip: ' + (e.message || e).toString().slice(0, 100)); }
    }
  };

  // Fire an initial tick shortly after boot, then on the dashboard cadence.
  const kick = setTimeout(() => { tick().catch(() => {}); }, 15000);
  const iv = setInterval(() => { tick().catch(() => {}); }, dashMs);
  log(`background self-evolution armed (sync ~${Math.round(syncMs / 60000)}m, contribute ~${Math.round(contribMs / 60000)}m; stands down while the worker is live)`);

  return () => { stopped = true; clearTimeout(kick); clearInterval(iv); };
}

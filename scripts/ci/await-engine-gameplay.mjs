import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { requireReadyEngineSha, UNKNOWN_EXIT_CODE } from './production-e2e-provenance.mjs';

// One prerequisite inside the existing certification job, never a release retry.
// Allow the two-minute last-hand lead, five-minute break, v3 release tail,
// and 10.5-second resume spread. Client-triggered checks may arrive during the lead.
// On September 27 the same engine needed 663.712 seconds from announcement
// through its certified v3 release and all eight resume waves. The former
// 600s deadline expired 62.457s before those waves finished in run 36292616717.
// 720s retains over one health-request/poll interval of headroom for that
// observed path. It is a fixed prerequisite limit, not a future-release promise.
export const GAMEPLAY_WAIT_MS = 12 * 60_000;
const POLL_MS = 5_000;
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * THE RESTART INSIDE THE BREAK IS PART OF THE BREAK (2026-10-03).
 *
 * This wait used to stop on the first non-2xx answer. The engine process is
 * genuinely replaced at :55-:58 of every hour (CLAUDE.md section 13), so the
 * proxy in front of it answers 502 for about two minutes of exactly the window
 * this step exists to wait out. Runs 37094718899 (03:55:46Z) and 37097809882
 * (04:55:14Z) both died on `Engine health returned HTTP 502` - the engine
 * keeping the schedule we set, reported as a production failure. The first
 * read of this job (read-engine-release.mjs) already treats that silence as
 * "not yet"; this later wait now does the same, inside the SAME fixed budget.
 *
 * Silence (a gateway 502/503/504, a refused or timed-out connection, or an
 * engine that is up but still warming its liveness) keeps waiting. An answer
 * that cannot be read - malformed JSON, no releaseSha, an unknown maintenance
 * phase - is still a refusal, never coerced into "keep waiting" (10.86 rule 2).
 *
 * And the restart can bring up a DIFFERENT engine: release cutovers happen
 * inside this break. When the engine that answers is a later commit on
 * protected main, the release this run was certifying has been superseded by
 * one that dispatches its own certificate. That is a non-verdict (exit 3), not
 * a red. A rollback or an off-lineage engine is still refused.
 */
const GATEWAY_SILENCE = new Set([502, 503, 504]);

function readHealth(raw) {
  let value;
  try {
    value = JSON.parse(String(raw));
  } catch {
    throw new Error('Production engine health is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Production engine health must be one JSON object.');
  }
  if (!Object.hasOwn(value, 'releaseSha') || !FULL_SHA.test(value.releaseSha)) {
    throw new Error('Production engine health must contain one full lowercase releaseSha.');
  }
  return value;
}

export function gameplayHasResumed(raw, expected) {
  requireReadyEngineSha(raw, expected);
  const { maintenance } = JSON.parse(raw);
  if (!maintenance || typeof maintenance.active !== 'boolean') {
    throw new Error('Engine health omitted authoritative maintenance state.');
  }
  if (maintenance.active) {
    if (!['last_hand', 'counting_down', 'finalizing'].includes(maintenance.phase)) {
      throw new Error('Engine health reported an unknown active maintenance phase.');
    }
    return false;
  }
  if (maintenance.phase !== 'idle') throw new Error('Engine maintenance is not idle.');
  const waves = maintenance.resumeWaves;
  if (waves == null) return true;
  if (
    !Number.isSafeInteger(waves.total) ||
    waves.total < 1 ||
    !Number.isSafeInteger(waves.done) ||
    waves.done < 0 ||
    waves.done > waves.total
  ) {
    throw new Error('Engine health reported invalid resume-wave progress.');
  }
  return waves.done === waves.total;
}

function gitSucceeds(args) {
  try {
    execFileSync('git', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Is `to` a later commit than `from` on protected main? Fetches main once if `to` is new. */
export function isForwardMainRelease(from, to) {
  const known = () => gitSucceeds(['cat-file', '-e', `${to}^{commit}`]);
  if (!known()) {
    gitSucceeds([
      'fetch',
      '--no-tags',
      '--filter=blob:none',
      'origin',
      '+refs/heads/main:refs/remotes/origin/main',
    ]);
    if (!known()) return false;
  }
  return (
    gitSucceeds(['merge-base', '--is-ancestor', from, to]) &&
    gitSucceeds(['merge-base', '--is-ancestor', to, 'refs/remotes/origin/main'])
  );
}

export async function awaitEngineGameplay(
  expected,
  {
    fetchImpl = fetch,
    now = () => performance.now(),
    pause = sleep,
    report = (message) => console.error(message),
    isForwardRelease = isForwardMainRelease,
  } = {}
) {
  if (!/^[0-9a-f]{40}$/.test(expected)) throw new Error('Expected one full engine SHA.');
  const deadline = now() + GAMEPLAY_WAIT_MS;
  let announced = false;
  let silence = null;
  const wait = (why) => {
    if (why !== silence) report(`Waiting: ${why}.`);
    silence = why;
  };
  while (now() < deadline) {
    let raw = null;
    try {
      const response = await fetchImpl('https://engine.smarter.poker/health', {
        headers: { 'Cache-Control': 'no-store' },
        signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, Math.ceil(deadline - now())))),
      });
      if (response.ok) raw = await response.text();
      else if (GATEWAY_SILENCE.has(response.status)) {
        wait(`engine health answered HTTP ${response.status} (the engine may be restarting)`);
      } else throw new Error(`Engine health returned HTTP ${response.status}.`);
    } catch (error) {
      if (/^Engine health returned HTTP/.test(error?.message)) throw error;
      wait(`engine health could not be reached (${error?.message || error})`);
    }
    if (now() >= deadline) break;
    if (raw !== null) {
      const health = readHealth(raw);
      if (health.releaseSha !== expected) {
        if (isForwardRelease(expected, health.releaseSha)) {
          return { verdict: 'superseded', sha: health.releaseSha };
        }
        throw new Error(
          `Production engine ${health.releaseSha} has not reached required ${expected}; this run cannot begin certification.`
        );
      }
      if (health.running !== true || health.liveness !== 'ok') {
        wait('the exact engine is up but not yet running with healthy liveness');
      } else {
        silence = null;
        if (gameplayHasResumed(raw, expected)) return { verdict: 'resumed', sha: expected };
        if (!announced) {
          report('Waiting for this exact engine to finish maintenance and resume its tables.');
          announced = true;
        }
      }
    }
    await pause(Math.min(POLL_MS, Math.max(0, deadline - now())));
  }
  throw new Error(
    'The exact engine did not resume gameplay within the twelve-minute prerequisite budget' +
      (silence ? ` (last: ${silence}).` : '.')
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  (async () => {
    if (args.length !== 1) throw new Error('Usage: await-engine-gameplay.mjs <exact-engine-sha>');
    const result = await awaitEngineGameplay(args[0]);
    if (result.verdict === 'resumed') {
      console.log(result.sha);
      return;
    }
    console.error(
      `::warning::UNKNOWN: engine ${args[0]} was replaced by the later protected-main release ` +
        `${result.sha} during its maintenance break. That release dispatches its own certificate; ` +
        'this run cannot certify a superseded engine and it is not a report of a defect.'
    );
    process.exitCode = UNKNOWN_EXIT_CODE;
  })().catch((error) => {
    console.error(`[await-engine-gameplay] ${error.message}`);
    process.exitCode = 1;
  });
}

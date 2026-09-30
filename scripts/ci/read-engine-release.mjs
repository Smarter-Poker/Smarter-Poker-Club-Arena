#!/usr/bin/env node
/**
 * READ THE ENGINE'S RELEASE THROUGH THE BREAK WE SCHEDULED OURSELVES.
 *
 * `live-table-e2e` opened with a single `curl -fsS https://engine.smarter.poker/health`
 * and no tolerance at all. The engine restarts at :55 of EVERY hour inside an
 * announced five-minute break (CLAUDE.md section 13) and is genuinely down for
 * about two of those minutes, so that one shot returns 502 and the job goes
 * red. Run 36717851302, started 12:54:24Z, died at 12:55:36Z on exactly that:
 *
 *   curl: (22) The requested URL returned error: 502
 *   [production-e2e-provenance] Production engine health is not valid JSON.
 *
 * Nothing was broken. The engine was doing the thing we told it to do, on the
 * minute we told it to do it, and the certificate called that a failure. That
 * is CLAUDE.md 10.86 rule 1 - "I could not tell YET" folded into a red.
 *
 * This is NOT a retry loop over a defect (10.12). A scheduled restart is a
 * published contract with a known duration, and the rest of this job already
 * waits for it: `await-engine-gameplay.mjs` spends up to GAMEPLAY_WAIT_MS on
 * the same break a few steps later. All that was missing was letting the FIRST
 * read reach the same engine the later steps are already willing to wait for.
 * The budget is that same measured one, reused rather than re-guessed: on
 * 2026-09-27 the engine needed 663.712s from announcement through its
 * certified v3 release and all eight resume waves, and GAMEPLAY_WAIT_MS is
 * 720s. Beyond it the engine is not on a break, it is unreachable, and the
 * refusal below is a real verdict.
 *
 * Three outcomes, never two:
 *   exit 0 - one full lowercase releaseSha, printed on stdout.
 *   exit 3 - UNKNOWN: the engine never answered inside its own break budget.
 *   exit 1 - the engine answered and the answer was not a healthy release.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { GAMEPLAY_WAIT_MS } from './await-engine-gameplay.mjs';
import { readReadyEngineSha, UNKNOWN_EXIT_CODE } from './production-e2e-provenance.mjs';

const POLL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * A transport failure or a 5xx during the break is silence, not an answer.
 * A 200 whose body is not one healthy release IS an answer, and a wrong one,
 * so it is never swallowed into "keep waiting" - that is 10.86 rule 2, never
 * coerce an unreadable answer into an empty one.
 */
export async function readEngineRelease(
  url,
  {
    fetchImpl = fetch,
    budgetMs = GAMEPLAY_WAIT_MS,
    pollMs = POLL_MS,
    now = Date.now,
    log = () => {},
  } = {}
) {
  const deadline = now() + budgetMs;
  let silence = 'the engine health endpoint was never reached';
  let attempt = 0;
  for (;;) {
    attempt += 1;
    let body = null;
    try {
      const response = await fetchImpl(url, {
        headers: { 'cache-control': 'no-store' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        silence = `the engine health endpoint answered HTTP ${response.status}`;
      } else {
        body = await response.text();
      }
    } catch (error) {
      silence = `the engine health endpoint could not be reached (${error?.message || error})`;
    }

    // An answer that arrived is a verdict either way; never poll past one.
    if (body !== null) return { verdict: 'ready', sha: readReadyEngineSha(body) };

    if (now() >= deadline) return { verdict: 'unknown', reason: silence, attempts: attempt };
    log(`  attempt ${attempt}: ${silence}; the engine may be inside its announced break`);
    await sleep(pollMs);
  }
}

async function main() {
  const [url] = process.argv.slice(2);
  if (!url) throw new Error('Usage: read-engine-release.mjs <engine-health-url>');
  const result = await readEngineRelease(url, { log: (line) => console.error(line) });
  if (result.verdict === 'ready') {
    process.stdout.write(`${result.sha}\n`);
    return;
  }
  console.error(
    `::warning::UNKNOWN: ${result.reason} in ${Math.round(GAMEPLAY_WAIT_MS / 1000)}s ` +
      `across ${result.attempts} attempts. This run could not read the engine's release; ` +
      'that is not a verdict on production.'
  );
  process.exitCode = UNKNOWN_EXIT_CODE;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[read-engine-release] ${error.message}`);
    process.exit(1);
  });
}

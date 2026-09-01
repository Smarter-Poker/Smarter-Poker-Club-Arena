/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SWEEP THAT DEADLOCKED ITSELF INTO DOING NOTHING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fn_sweep_unsettled_tournament_rake` is the safety net under tournament rake
 * settlement: any terminal event with banked rake and no settlement row gets
 * settled by it. The engine calls it every ten minutes.
 *
 * On 2026-08-31 it settled NOTHING for two and a half hours while 29 terminal
 * events holding 215.98 in union rake piled up behind it. The alert it left
 * said four words: "deadlock detected".
 *
 * The cause was the batch size. The whole sweep is ONE transaction, and every
 * settlement inside it updates the same `club_wallets` row and the same union
 * wallet. At `p_limit: 200` that is minutes of held row locks, against a live
 * engine settling its own finishing tournaments on those exact rows. The sweep
 * lost the deadlock every pass, and because it is one transaction, losing meant
 * rolling back every settlement it had managed - so a failing pass made no
 * progress at all, forever.
 *
 * Ten per pass is about five seconds of locking, and at one pass per ten
 * minutes it drains sixty events an hour against an arrival rate near one.
 *
 * This guard pins the number. A future edit that raises the batch back into
 * the hundreds - for throughput, which is the obvious and wrong instinct here -
 * fails in CI instead of silently reintroducing a sweep that cannot run.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBlockAfter } from '../testHelpers/sourceWindow.js';

const SRC = readFileSync(resolve(__dirname, '../GameServer.ts'), 'utf8');
const sweepBlock = sliceBlockAfter(SRC, 'if (Date.now() - this.lastRakeSweepAt');

describe('the tournament rake sweep runs in small batches', () => {
  it('asks for a batch small enough to finish before it deadlocks', () => {
    const match = sweepBlock.match(/p_limit:\s*(\d+)/);
    expect(match, 'the sweep call must pass an explicit p_limit').not.toBeNull();
    const limit = Number(match![1]);
    expect(limit).toBeGreaterThan(0);
    // 200 is the value that deadlocked every pass for two and a half hours.
    expect(limit).toBeLessThanOrEqual(25);
  });

  it('still sweeps a long history, so an old miss is never abandoned', () => {
    expect(sweepBlock).toMatch(/p_since_days:\s*(\d+)/);
    const days = Number(sweepBlock.match(/p_since_days:\s*(\d+)/)![1]);
    expect(days).toBeGreaterThanOrEqual(30);
  });

  it('reports a failed pass rather than swallowing it', () => {
    expect(sweepBlock).toMatch(/rake_sweep_failed/);
  });

  it('explains why the batch is small, so the next reader does not raise it', () => {
    // The reasoning lives next to the number on purpose.
    expect(SRC).toMatch(/THE BATCH IS SMALL ON PURPOSE/);
    expect(SRC).toMatch(/deadlock/i);
  });
});

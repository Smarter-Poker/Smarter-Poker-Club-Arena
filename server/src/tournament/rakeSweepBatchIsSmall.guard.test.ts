/**
 * Tournament terminal settlement now books rake inside the same database
 * transaction as the immutable terminal receipt. The old periodic sweep was a
 * second money-moving authority, so the safe batch size is now zero: no engine
 * schedule and no executable RPC call may survive the atomic cutover.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, '../GameServer.ts'), 'utf8');
const executable = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('the tournament rake sweep has no engine schedule', () => {
  it('removes the legacy RPC, timer and retry telemetry from executable source', () => {
    for (const retired of [
      'fn_sweep_unsettled_tournament_rake',
      'lastRakeSweepAt',
      'GameServer.rake_sweep_failed',
      'GameServer.rake_sweep_threw',
    ]) {
      expect(executable).not.toContain(retired);
    }
  });

  it('preserves legitimate lifecycle recovery and unfilled-Spin cancellation', () => {
    expect(executable).toContain('recoverStuckCompletingTournaments');
    expect(executable).toContain("supabase.rpc('fn_spin_expire_unfilled'");
  });
});

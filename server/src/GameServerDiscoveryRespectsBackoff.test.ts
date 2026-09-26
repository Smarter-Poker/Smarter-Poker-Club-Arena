import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('cash table discovery respects the per-table causal backoff', () => {
  it('hasPendingDirectTableRecovery reflects the armed/disarmed backoff timer', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder-key';
    const { GameServer } = await import('./GameServer.js');
    const directTableRecoveryTimers = new Map<string, NodeJS.Timeout>();
    const server = Object.assign(Object.create(GameServer.prototype), {
      directTableRecoveryTimers,
    }) as InstanceType<typeof GameServer>;
    const hasPending = (tableId: string): boolean =>
      (server as unknown as { hasPendingDirectTableRecovery(id: string): boolean })
        .hasPendingDirectTableRecovery(tableId);

    expect(hasPending('table-1')).toBe(false);

    const timer = setTimeout(() => {}, 15_000);
    timer.unref?.();
    directTableRecoveryTimers.set('table-1', timer);
    expect(hasPending('table-1')).toBe(true);
    expect(hasPending('table-2')).toBe(false);

    clearTimeout(timer);
    directTableRecoveryTimers.delete('table-1');
    expect(hasPending('table-1')).toBe(false);
  });

  /**
   * Root-cause regression for the 2026-09-23 kill storm (see the note beside
   * this call in GameServer.ts): a table whose engine keeps failing to start
   * (e.g. `retained_hand_submission_pending`, a correct refusal with no proof
   * row for the prior hand) had its map entry deleted on every kill, which
   * made it look brand-new to the cash-table discovery spawn loop on the
   * very next 5-second sweep — bypassing `scheduleDirectTableRecovery`'s
   * exponential backoff entirely and re-admitting it immediately, forever.
   * Three tables logged 150k+ kills over 4+ days this way while the storm
   * alert (fire-once-per-episode by design) notified exactly once.
   *
   * A full integration test through the real discovery sweep would need to
   * mock the Supabase RPC, the admission pipeline and the engine lifecycle;
   * this instead pins the one-line invariant directly against the source so
   * the guard cannot be quietly dropped by a future edit: the spawn loop
   * must consult `hasPendingDirectTableRecovery` for a table before it is
   * allowed to start (or restart) that table's engine.
   */
  it('the spawn loop skips a table with a pending recovery backoff before starting its engine', () => {
    const source = readFileSync(new URL('./GameServer.ts', import.meta.url), 'utf8');
    const spawnLoopStart = source.indexOf('for (const row of (ready || []) as Array<{');
    expect(spawnLoopStart).toBeGreaterThan(-1);

    const alreadyRunningGuard = source.indexOf(
      'if (this.tableEngines.has(row.table_id)) continue;',
      spawnLoopStart
    );
    expect(alreadyRunningGuard).toBeGreaterThan(spawnLoopStart);

    const backoffGuard = source.indexOf(
      'if (this.hasPendingDirectTableRecovery(row.table_id)) continue;',
      alreadyRunningGuard
    );
    expect(backoffGuard).toBeGreaterThan(alreadyRunningGuard);

    const engineStartLog = source.indexOf('[GameServer] Starting engine for cash table', backoffGuard);
    expect(engineStartLog).toBeGreaterThan(backoffGuard);
  });
});

/**
 * A closed cash table stays closed across a restart.
 *
 * cleanupStaleData() runs on every boot. In normal mode (no E2E table, horse
 * fleet enabled) it reset cash tables so the fleet could re-populate them, and
 * its status filter was ['waiting', 'running', 'closed'] - so it did not just
 * reset counts, it RESURRECTED every closed cash table.
 *
 * That made 'closed' meaningless for cash:
 *   - a club admin's fn_admin_close_table lasted until the next deploy;
 *   - and nothing could retire a table, so the 487 duplicate rows left by the
 *     ensureAllTablesExist bug could not be cleaned up - closing them would
 *     have survived until the next restart and no longer.
 *
 * The fleet used to reopen what it owned: ensureAllTablesExist reactivated the
 * canonical row for each config when it found it closed. Since Gate 7
 * (2026-09-05) the fleet reopens nothing; the cluster controller keeps each
 * game's Main 1 open (R3). This test pins the blanket resurrection, not that.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/GameServer.ts'), 'utf8');

/** The normal-mode branch of cleanupStaleData, code only. */
function normalModeBranch(): string {
  const m = /Normal mode: reset to waiting[\s\S]*?console\.log\([\s\S]*?\);/.exec(SRC);
  if (!m) throw new Error('normal-mode reset branch not found - this test is measuring nothing');
  return m[0]
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

describe('cleanupStaleData normal-mode reset', () => {
  it('is found in the shipped source', () => {
    expect(normalModeBranch()).toContain(".from('tables')");
  });

  it('does not resurrect closed cash tables', () => {
    const branch = normalModeBranch();
    expect(branch).toContain("'waiting', 'running'");
    expect(branch).not.toContain("'closed'");
  });

  it('still normalises waiting and running tables', () => {
    const branch = normalModeBranch();
    expect(branch).not.toMatch(/current_players\s*:/);
    expect(branch).toContain("status: 'waiting'");
    expect(branch).toContain("is('tournament_id', null)"); // cash only, never tournaments
  });

  it('the E2E and fleet-disabled branches are untouched - they still close on purpose', () => {
    // Both of those deliberately WRITE 'closed'; only the resurrecting read
    // filter was wrong. If these disappear, the test above would pass for the
    // wrong reason.
    expect(SRC).toContain('E2E mode: closed all cash tables except');
    expect(SRC).toContain('Closed all running cash tables (horse fleet disabled)');
  });

  it('the fleet reopens nothing; the controller keeps Main 1 open and the closure of the rest stands', () => {
    /* Moved 2026-09-05 for Gate 7. This used to pin the fleet's reactivate
       path in ensureAllTablesExist: `existing.status === 'closed' && ... ->
       updates.status = 'waiting'`, with its retire_when_empty and night-park
       qualifications and the union-scoped lookup. That path is deleted
       (OPORD 1.4 s2.11: a cash table is opened and closed only by the cluster
       controller). What "the fleet still reopens what it owns" protected is
       now R3 in SQL: fn_cash_cluster_tick RECONCILE reopens an enabled game's
       Main 1 on every tick. Every other closure stands, exactly as the
       blanket-resurrection pins above require. */
    const fleet = readFileSync(join(process.cwd(), 'src/services/HorseFleetManager.ts'), 'utf8');
    expect(fleet).not.toMatch(/updates\.status = 'waiting'/);
    expect(fleet).not.toMatch(/\.update\(\{[^}]*status:\s*'waiting'/);
    expect(fleet).not.toMatch(/\.from\(['"]tables['"]\)\s*\.insert\(/);
    const tick = readFileSync(
      join(process.cwd(), '../supabase/migrations/20260905010500_cluster_controller_slice_2.sql'),
      'utf8'
    );
    expect(tick).toMatch(/IF g\.enabled AND \(v_main1\.id IS NULL OR v_main1\.status NOT IN/);
  });
});

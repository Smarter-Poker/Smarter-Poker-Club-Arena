/**
 * STARTUP CLEANUP NEVER OWNS TERMINAL TABLE OR SEAT REPAIR.
 *
 * Atomic finish/cancellation closes the felt. The seat-authority cutover moves
 * the exact historical backlog once and records every id. Leaving the old
 * process-start writer in place would make every boot retry rows the permanent
 * guard now correctly refuses.
 *
 * This is a source-order guard because cleanupStaleData is private and every
 * useful runtime path talks to Supabase. The property under test is the actual
 * control-flow boundary around the production query, not a mocked copy of it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sliceMethod } from './testHelpers/sourceWindow.js';

const source = readFileSync(new URL('./GameServer.ts', import.meta.url), 'utf8');
const cleanup = sliceMethod(source, 'private async cleanupStaleData(');

describe('startup stale-cleanup success reporting', () => {
  it('does not call a failed stale-tournament list a completed sweep', () => {
    expect(cleanup).toMatch(
      /const \{ data: staleTourneys, error: staleTourneysError \} = await supabase[\s\S]*?if \(staleTourneysError\) \{[\s\S]*?GameServer\.stale_tournament_list_failed[\s\S]*?\}[\s\S]*?const staleTournamentCandidates = staleTourneysError \? \[\] : staleTourneys \|\| \[\][\s\S]*?if \(!staleTourneysError\) \{[\s\S]*?Stale-tournament sweep complete/
    );
  });

  it('keeps later COMPLETING recovery reachable after a stale-list failure', () => {
    expect(cleanup).toMatch(
      /if \(!staleTourneysError\) \{[\s\S]*?Stale-tournament sweep complete[\s\S]*?\}\s*\/\/ 7\.[\s\S]*?recoverStuckCompletingTournaments\('startup-cleanup'\)/
    );
  });

  it('never manufactures finish evidence from elapsed time', () => {
    const staleStart = cleanup.indexOf('const twelveHoursAgo =');
    const staleEnd = cleanup.indexOf('// 7. Recover stuck COMPLETING tournaments', staleStart);
    const staleSweep = cleanup.slice(staleStart, staleEnd);
    expect(staleSweep).toContain('GameServer.stale_tournament_left_for_resume');
    expect(staleSweep).not.toMatch(/update\(\{\s*status:\s*'COMPLETING'/);
    expect(staleSweep).not.toContain('recoverStuckCompletingTournaments(');
  });

  it('contains no applying terminal table or seat sweep', () => {
    expect(cleanup).not.toContain('orphanPageSize');
    expect(cleanup).not.toContain('orphanCandidates');
    expect(cleanup).not.toContain('orphan table list failed');
    expect(cleanup).not.toContain('GameServer.orphan_table_sweep');
    expect(cleanup).not.toContain('.update({ left_at: new Date().toISOString() })');
    expect(cleanup).not.toContain("console.log('[GameServer] Stale data cleanup complete')");
  });
});

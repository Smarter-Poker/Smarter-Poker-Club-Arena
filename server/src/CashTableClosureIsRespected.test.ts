/**
 * A closed cash table stays closed across a restart.
 *
 * cleanupStaleData() runs on every boot. In normal mode (no E2E table, horse
 * fleet enabled) it reset cash tables so the fleet could re-populate them, and
 * its status filter was ['waiting', 'running', 'closed'] — so it did not just
 * reset counts, it RESURRECTED every closed cash table.
 *
 * That made 'closed' meaningless for cash:
 *   - a club admin's fn_admin_close_table lasted until the next deploy;
 *   - and nothing could retire a table, so the 487 duplicate rows left by the
 *     ensureAllTablesExist bug could not be cleaned up — closing them would
 *     have survived until the next restart and no longer.
 *
 * The fleet still reopens what it owns: ensureAllTablesExist reactivates the
 * canonical row for each config when it finds it closed. This test pins the
 * blanket resurrection, not that.
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
    expect(branch).toContain('current_players: 0');
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

  it('the fleet can still reopen the table it owns', () => {
    const fleet = readFileSync(join(process.cwd(), 'src/services/HorseFleetManager.ts'), 'utf8');
    /* Qualifications have joined this line and none of them weakens it.
       2026-09-03: the lookup above it is scoped to the fleet's own union (it
       matched on NAME alone, platform-wide, and would reopen and annex another
       club's table), and a table the club RETIRED is not reopened - "close any
       tables over 2/5" would otherwise be undone on the next boot.
       2026-09-04: a table PARKED for the night is not reopened while it is
       still night, or the hourly engine restart would undo the parking every
       hour. Outside the night window it is reopened like any other, which is
       the whole difference between a park and a retirement.
       What the fleet owns, the fleet still reopens. */
    expect(fleet).toMatch(
      /existing\.status === 'closed' &&\s*!isRetiringTable\(existing as \{ settings\?: unknown \}\) &&\s*!\(parkedForNight && stillNight\)\s*\)\s*updates\.status = 'waiting';/
    );
    // and the park is time-boxed: the guard reads the clock, not just a flag.
    expect(fleet).toContain('const stillNight = isNightWindow(chicagoNow().hour);');
    expect(fleet).toMatch(
      /\.eq\('name', config\.name\)[\s\S]{0,1400}?\.eq\('union_id', MIDWAY_UNION_ID\)/
    );
  });
});

/**
 * LAW: A SEAT-FIRST BOARD THE FILL JUST COMPLETED STARTS AT ONCE, AND AN IDLE
 * TABLE'S SLOW READ IS NOT REPORTED AS A DEALING ERROR (2026-10-09).
 *
 * Every Spin on 2026-10-09 overran its one-second reveal window because the
 * fill job that bought its last seat never told the start path; the board
 * waited for the next fast-lane poll. This is a source-order guard because both
 * methods are private and every useful runtime path talks to Supabase.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sliceMethod } from './testHelpers/sourceWindow.js';

const server = readFileSync(new URL('./GameServer.ts', import.meta.url), 'utf8');
const dealing = readFileSync(
  new URL('./engine/ServerTableEngineDealing.ts', import.meta.url),
  'utf8'
);
const topUp = sliceMethod(server, 'private async topUpPartialSeatFirst(');
const start = sliceMethod(server, 'private startFilledSeatFirstBoard(');

describe('a filled seat-first board starts at once', () => {
  it('the fill that completes a board asks for its start, and only then', () => {
    expect(topUp).toMatch(
      /if \(added >= shortfall\) \{[\s\S]*?this\.startFilledSeatFirstBoard\(tournamentId, seats\);\s*\} else/
    );
    expect(topUp.match(/startFilledSeatFirstBoard/g)).toHaveLength(1);
  });

  it('the start goes through the one front door, under every gate the fast lane keeps', () => {
    expect(start).toContain('if (!this.directAdmissionIsCurrent(generation)) return;');
    expect(start).toContain('if (isMaintenanceFrozen()) return;');
    expect(start).toContain('if (spinLaunchParks.isParked(tournamentId)) return;');
    expect(start).toContain('if (this.tournamentEngines.has(tournamentId)) return;');
    expect(start).toMatch(
      /this\.launchDiscoveryJob\(\s*this\.ensureTournamentManagerAdmission\(\s*tournamentId,\s*'start',/
    );
    expect(start).toContain("'GameServer.seat_first_fast_start_failed'");
  });

  it('an idle phase that blows its step budget is logged, a dealing phase is still reported', () => {
    expect(dealing).toMatch(
      /if \(errMsg\.includes\('deal_step_timeout'\)\) \{\s*this\.markProgress\(\);[\s\S]*?if \(ServerTableEngineDealing\.IDLE_LOOP_PHASES\.has\(this\.loopPhase\)\) \{\s*console\.warn\([\s\S]*?\} else \{\s*reportError\(err, 'ServerTableEngine\.' \+ this\.tableId \+ '\.deal_step_timeout'/
    );
    expect(dealing).toMatch(/IDLE_LOOP_PHASES = new Set\(\[[\s\S]*?'idle_cluster_closed',/);
  });
});

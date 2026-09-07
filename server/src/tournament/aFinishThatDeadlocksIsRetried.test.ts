/**
 * A FINISH IS A DATABASE CERTIFICATE, AND A MANAGER THAT NEVER CAME BACK DOES
 * NOT HIDE THE ROW (2026-09-07).
 *
 * 15:01, 15:06, 15:07 UTC: three events paid their winners, settled rake, and
 * deadlocked on COMPLETING -> COMPLETED. finishTournament logged "left for
 * recoverStuckCompletingTournaments" and never returned; the manager stayed
 * registered; the watchdog skipped the row every pass because a manager
 * existed. Fifty minutes, two pager alerts on rows that were paid, one
 * operator with psql.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sliceEnclosingBlock, sliceMethod } from '../testHelpers/sourceWindow.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  COMPLETING_DWELL_MS,
  COMPLETING_MANAGED_GRACE_MS,
  managerHasOverstayed,
} from './completingDwell.js';

const here = dirname(fileURLToPath(import.meta.url));
const ELIM = readFileSync(join(here, 'TournamentManagerEliminations.ts'), 'utf8');
const RECOVERY = readFileSync(join(here, 'tournamentRecovery.ts'), 'utf8');
const SERVER = readFileSync(join(here, '..', 'GameServer.ts'), 'utf8');

describe('the finish boundary is owned by one database contract', () => {
  it('claims the canonical winner before any settlement and certifies only after rake', () => {
    const finish = sliceMethod(ELIM, 'protected async finishTournament(winnerId: string)');
    expect(finish).toContain('claimTournamentFinish(');
    expect(finish).toContain('certifyTournamentFinish(');
    expect(finish.indexOf('claimTournamentFinish(')).toBeLessThan(
      finish.indexOf('this.tournamentFinished = true')
    );
    expect(finish.indexOf('await this.settleTournamentRake(tournament)')).toBeLessThan(
      finish.indexOf('certifyTournamentFinish(')
    );
    expect(finish.indexOf('certifyTournamentFinish(')).toBeLessThan(
      finish.indexOf("await this.broadcast('tournament_winner'")
    );
    expect(finish).toContain('this.tournamentFinished = false;');
    expect(finish).not.toMatch(/\.from\('tournaments'\)[\s\S]*?status:\s*'COMPLETED'/);
  });

  it('the deal and every recovery tail use that same contract', () => {
    const deal = sliceMethod(ELIM, 'private async settleFinalTableDeal()');
    expect(deal).toContain('claimTournamentFinish(');
    expect(deal).toContain('certifyTournamentFinish(');
    expect(deal.indexOf('certifyTournamentFinish(')).toBeLessThan(
      deal.indexOf('// Release the players and close the tables')
    );
    expect(RECOVERY.match(/claimTournamentFinish\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(RECOVERY.match(/certifyTournamentFinish\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(RECOVERY).not.toMatch(/\.update\(\{\s*status:\s*'COMPLETED'/);
  });
});

describe('a manager past the grace is the thing that is stuck', () => {
  it('the grace is two dwells - ten minutes', () => {
    expect(COMPLETING_MANAGED_GRACE_MS).toBe(2 * COMPLETING_DWELL_MS);
    expect(COMPLETING_MANAGED_GRACE_MS).toBe(10 * 60 * 1000);
  });

  it("a row first seen under ten minutes ago is still the manager's", () => {
    const now = 1_000_000_000;
    expect(managerHasOverstayed(now - COMPLETING_MANAGED_GRACE_MS + 1, now)).toBe(false);
    expect(managerHasOverstayed(now, now)).toBe(false);
    expect(managerHasOverstayed(undefined, now)).toBe(false);
  });

  it('at ten minutes it is not', () => {
    const now = 1_000_000_000;
    expect(managerHasOverstayed(now - COMPLETING_MANAGED_GRACE_MS, now)).toBe(true);
    expect(managerHasOverstayed(now - 50 * 60_000, now)).toBe(true);
  });

  it('the watchdog stops and drops the overstayed manager, then recovers through the same door', () => {
    /* The window is the loop body the guard lives in, not a byte count:
       tests/helpers/sourceWindow, and the publish outage its header records. */
    const loop = sliceEnclosingBlock(
      SERVER,
      'managerHasOverstayed(dwell.seenAt.get(String(stuck.id)), Date.now())'
    );
    expect(loop).toContain('await this.stopTournamentManagerIfOwned(');
    expect(loop).toContain("'GameServer.completing_manager_stop_failed'");
    expect(loop).toContain(
      "await recoverStuckCompletingTournaments('discovery-watchdog', stuck.id);"
    );
    // The awaited identity-CAS teardown happens BEFORE the has() test that
    // gates recovery, so a replacement can never be deleted by the stale
    // watchdog continuation and recovery still enters through the ordinary
    // managerless door.
    expect(loop.indexOf('await this.stopTournamentManagerIfOwned(')).toBeLessThan(
      loop.indexOf('if (!this.tournamentEngines.has(stuck.id))')
    );
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ═════════════════════════════════════════════════════════════════════════
 *  A TOURNAMENT THAT STOPS DEALING MUST BE NOTICED (2026-09-01, Phase 4)
 * ═════════════════════════════════════════════════════════════════════════
 *
 * Three wirings, each measured live before it was written. They live in
 * GameServer's discovery pass, which has no unit-testable seam, so they are
 * pinned here the way the other GameServer laws in this directory are: by
 * reading the source. A pin that reads source is worth exactly what it says on
 * the tin - it cannot prove the sweep works, only that the wiring did not
 * quietly disappear, which is the failure this repo has actually suffered
 * (see TournamentFixes.guard.test.ts for the two reverts that started it).
 *
 * If one of these is deliberately replaced by something better, move the pin
 * to the new mechanism in the SAME commit and say so in the pull request.
 */

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const GAME_SERVER = 'src/GameServer.ts';

describe('a stalled tournament is noticed', () => {
  /**
   * "$100 Freeroll - 12:00 AM" (73ebcc3b) sat RUNNING and silent for 5 hours
   * 21 minutes on 2026-09-01: two entrants, one on the open table, one still
   * seated on a table that had been closed. No existing sweep covers that
   * shape - decided-but-running wants <= 1 playing, started-but-never-dealt
   * wants zero hands, and the reopen sweep declines while an open table
   * exists.
   */
  it('runs the orphaned-seat repair on the discovery cadence', () => {
    const src = read(GAME_SERVER);

    expect(src).toContain('lastOrphanSeatSweepAt');
    expect(src).toContain('this.repairOrphanedTournamentSeats()');
    // Every minute, not once per boot: the stall it repairs is created while
    // the engine is up and healthy, not at start-up.
    expect(src).toMatch(/Date\.now\(\) - this\.lastOrphanSeatSweepAt > 60 \* 1000/);
  });

  it('moves stranded players only through executePlayerMoves', () => {
    const manager = read('src/tournament/TournamentManager.ts');

    expect(manager).toContain('absorbOrphanedSeats');
    expect(manager).toContain('planOrphanReseats');
    // The repair must not grow a second way to move a player. Every
    // duplicate-seat incident on this platform came from a seat write that
    // was not this one.
    const absorb = manager.slice(
      manager.indexOf('public async absorbOrphanedSeats'),
      manager.indexOf('protected async executePlayerMoves')
    );
    expect(absorb).toContain('this.executePlayerMoves(moves)');
    expect(absorb).not.toMatch(/from\('table_seats'\)[\s\S]{0,80}\.update\(/);
    expect(absorb).not.toMatch(/from\('table_seats'\)[\s\S]{0,80}\.insert\(/);
  });

  /**
   * The comment above the stuck-COMPLETING scan promised a five-minute rule
   * from the day it was written and the query never had one. `updated_at` on
   * `tournaments` is not maintained by the writers on that path, so the dwell
   * is measured by the watching process instead.
   */
  it('holds the stuck-COMPLETING recovery for the five minutes it always claimed', () => {
    const src = read(GAME_SERVER);

    expect(src).toContain('selectCompletingDue');
    expect(src).toContain('completingFirstSeenAt');
    const scan = src.slice(src.indexOf('STUCK COMPLETING RECOVERY'));
    const gate = scan.indexOf('dueIds.has');
    const call = scan.indexOf("recoverStuckCompletingTournaments('discovery-watchdog'");
    expect(gate).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(gate);
  });

  /**
   * A MANAGER THAT HAS HELD A FINISH FOR FIFTEEN MINUTES IS NOT FINISHING IT
   * (2026-09-02). The recovery skips any row a manager still holds, which is
   * right for the seconds a finish takes and was unbounded after that - so a
   * wedged manager held its row out of reach of the only thing that could
   * rescue it. Found live: a satellite with 23 entrants, 207 chips of pool,
   * 448 hands, one survivor, zero payout records, sixteen minutes in
   * COMPLETING, and no incident naming it.
   */
  it('takes a wedged manager off a finish it is not finishing', () => {
    const src = read(GAME_SERVER);

    expect(src).toContain('isCompletingWedged');
    expect(src).toContain('COMPLETING_WEDGED_MS');
    expect(src).toContain("'GameServer.completing_manager_wedged'");
    // Stopped and DROPPED, or the very next line skips it again.
    const block = src.slice(
      src.indexOf('const wedged ='),
      src.indexOf('if (!this.tournamentEngines.has(stuck.id)) {')
    );
    expect(block).toContain('wedgedTm?.stop()');
    expect(block).toContain('this.tournamentEngines.delete(stuck.id)');
    // The escalation is strictly later than the dwell that lets recovery act.
    expect(src).toContain('dueIds.has(String(stuck.id))');
  });

  /**
   * `tournamentOwnedTables` was add-only for the life of the process. On a
   * board that creates roughly 7,000 tournament tables a day that is an
   * unbounded set, and worse than the memory: a dead table id in it tells the
   * zombie reaper the table "should be dealing" and keeps its hub room alive.
   */
  it('bounds tournamentOwnedTables to the tables still owned', () => {
    const src = read(GAME_SERVER);

    expect(src).toContain('pruneTournamentOwnedTables');
    expect(src).toContain('this.tournamentOwnedTables.delete(id)');
    expect(src).toContain('this.pruneTournamentOwnedTables();');
    // Pruning against GameServer's own engines alone would drop the hub room
    // of a tournament table while its manager is rebuilding the engine, which
    // is the case the set exists to protect.
    const prune = src.slice(
      src.indexOf('private pruneTournamentOwnedTables'),
      src.indexOf('private lastOrphanSeatSweepAt')
    );
    expect(prune).toContain('tm.getTableIds()');
  });
});

/**
 * LAW: A SEAT-FIRST BOARD THE FILL JUST COMPLETED STARTS AT ONCE, AND AN IDLE
 * TABLE'S SLOW READ IS NOT REPORTED AS A DEALING ERROR (2026-10-09).
 *
 * Every Spin on 2026-10-09 overran its one-second reveal window because the
 * fill job that bought its last seat never told the start path; the board
 * waited for the next fast-lane poll. This is a source-order guard because both
 * methods are private and every useful runtime path talks to Supabase.
 *
 * 2026-10-11: with the lead-in at two seconds, about one Spin in five still
 * overran. Every late one was found by the start path late, never dealt late:
 * the walk's top-up and the fast lane's fill worked the same board side by
 * side, and the start the winning fill asked for was refused while the losing
 * one was still in flight, then forgotten; and a board the walk's top-up
 * completed waited for the next fast-lane poll. One filler per board, a start
 * refused for a top-up is run the moment that top-up settles, and the walk's
 * own fill asks for the start too.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { sliceMethod } from './testHelpers/sourceWindow.js';
import { GameServer } from './GameServer.js';
import * as freezeState from './maintenance/freezeState.js';

const server = readFileSync(new URL('./GameServer.ts', import.meta.url), 'utf8');
const dealing = readFileSync(
  new URL('./engine/ServerTableEngineDealing.ts', import.meta.url),
  'utf8'
);
const topUp = sliceMethod(server, 'private async topUpPartialSeatFirst(');
const start = sliceMethod(server, 'private startFilledSeatFirstBoard(');
const fill = sliceMethod(server, 'private async fillPartialSeatFirstGame(');
const door = sliceMethod(server, 'private ensureTournamentManagerAdmission(');

function bareServer(): any {
  const s = Object.create(GameServer.prototype) as any;
  s.running = true;
  s.lifecycleGeneration = 7;
  s.tournamentEngines = new Map();
  s.tournamentManagerAdmissionOperations = new Map<string, Promise<void>>();
  s.tournamentManagerAdmissionRetryTimers = new Map();
  s.tournamentTopUpsInFlight = new Map<string, Promise<void>>();
  s.discoveryJobs = new Set<Promise<void>>();
  s.performTournamentManagerAdmission = vi.fn(async () => undefined);
  return s;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

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

  it('a start refused for an in-flight top-up runs the moment that top-up settles, once', async () => {
    const freeze = vi.spyOn(freezeState, 'isMaintenanceFrozen').mockReturnValue(false);
    try {
      const s = bareServer();
      let settle!: () => void;
      const topUp = new Promise<void>((resolve) => (settle = resolve));
      s.tournamentTopUpsInFlight.set('spin-1', topUp);
      await s.ensureTournamentManagerAdmission('spin-1', 'start', 'filled', 7);
      await s.ensureTournamentManagerAdmission('spin-1', 'start', 'filled again', 7);
      await flush();
      expect(s.performTournamentManagerAdmission).not.toHaveBeenCalled();
      s.tournamentTopUpsInFlight.delete('spin-1');
      settle();
      await flush();
      expect(s.performTournamentManagerAdmission).toHaveBeenCalledOnce();
      expect(s.performTournamentManagerAdmission.mock.calls[0].slice(0, 2)).toEqual([
        'spin-1',
        'start',
      ]);
    } finally {
      freeze.mockRestore();
    }
  });

  it('a kept start still meets every gate at the moment it runs', async () => {
    const freeze = vi.spyOn(freezeState, 'isMaintenanceFrozen').mockReturnValue(false);
    try {
      const stopped = bareServer();
      let settleStopped!: () => void;
      stopped.tournamentTopUpsInFlight.set(
        'spin-2',
        new Promise<void>((resolve) => (settleStopped = resolve))
      );
      await stopped.ensureTournamentManagerAdmission('spin-2', 'start', 'filled', 7);
      stopped.lifecycleGeneration = 8;
      stopped.tournamentTopUpsInFlight.delete('spin-2');
      settleStopped();
      await flush();
      expect(stopped.performTournamentManagerAdmission).not.toHaveBeenCalled();

      const frozen = bareServer();
      let settleFrozen!: () => void;
      frozen.tournamentTopUpsInFlight.set(
        'spin-3',
        new Promise<void>((resolve) => (settleFrozen = resolve))
      );
      await frozen.ensureTournamentManagerAdmission('spin-3', 'start', 'filled', 7);
      freeze.mockReturnValue(true);
      frozen.tournamentTopUpsInFlight.delete('spin-3');
      settleFrozen();
      await flush();
      expect(frozen.performTournamentManagerAdmission).not.toHaveBeenCalled();
    } finally {
      freeze.mockRestore();
    }
  });

  it('a resume is never held behind a top-up', async () => {
    const s = bareServer();
    s.tournamentTopUpsInFlight.set('mtt-1', new Promise<void>(() => undefined));
    await s.ensureTournamentManagerAdmission('mtt-1', 'resume', 'resume', 7);
    expect(s.performTournamentManagerAdmission).toHaveBeenCalledOnce();
  });

  it('the door keeps the ask rather than dropping it', () => {
    expect(door).toMatch(
      /const fillInFlight =\s*mode === 'start' \? this\.tournamentTopUpsInFlight\.get\(tournamentId\) : undefined;\s*if \(fillInFlight\) \{\s*this\.startWhenTopUpSettles\(tournamentId, fillInFlight, description, generation\);/
    );
  });

  it('one filler per board: the fast lane leaves a board another lane is filling, and claims its own', () => {
    const skip = fill.indexOf('if (this.tournamentTopUpsInFlight.has(tournamentId)) return;');
    const throttle = fill.indexOf('this.lastHumanFillAt.set(tournamentId, now);');
    const claim = fill.indexOf('this.tournamentTopUpsInFlight.set(tournamentId, claim);');
    const ask = fill.indexOf('await this.topUpPartialSeatFirst(');
    expect(skip).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(throttle);
    expect(claim).toBeGreaterThan(throttle);
    expect(claim).toBeLessThan(ask);
    expect(fill).toMatch(
      /\} finally \{[\s\S]*?this\.tournamentTopUpsInFlight\.delete\(tournamentId\);\s*\}\s*settle\(\);/
    );
  });

  it("the walk's top-up that completes a seat-first board asks for its start", () => {
    expect(server).toMatch(
      /if \(isSngOrSpin && added > 0 && paidSeats \+ added >= target\) \{\s*this\.startFilledSeatFirstBoard\(tournament\.id, target\);/
    );
  });
});

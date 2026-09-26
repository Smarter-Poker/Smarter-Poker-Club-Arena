/**
 * A SEAT DOES NOT MOVE UNDER A RELEASE WALK (2026-09-24).
 *
 * The legacy engine checkpoint captures every table in the fleet, writes each
 * one's park row, reads every row back, and re-verifies each capture against
 * the live engine at each step. A capture whose CUSTODY signature has moved
 * between two observations refuses the release as `engine_state_changed`,
 * because the row it would stand behind no longer describes the table.
 *
 * #5215 split that signature after run 36056765988 wrote 79 tables and then
 * refused on the re-verification. PRESENCE (the disconnect FSM) may change its
 * values between observations, because a socket drops during a five minute
 * break exactly as it does at any other time and the successor re-observes it
 * from heartbeats within seconds. CUSTODY may not, and custody includes the
 * ROSTER: each seat's user, occupancy, seat number and STACK.
 *
 * That split only works because nothing can move a seat or a stack while the
 * walk runs. #5215 attributed that to the Postgres half of the freeze, and for
 * this signature the Postgres half is the wrong half twice over:
 *
 *   1. `fn_refuse_while_frozen` returns early when the caller's
 *      `request.jwt.claims` carry `role = service_role`, which is exactly what
 *      this engine presents. `zz_freeze_guard` on `table_seats` holds back
 *      browsers and pg_cron, which is what it is for; it does not hold back
 *      this process.
 *   2. The signature does not read `table_seats` at all. It reads
 *      `engine.seatedPlayers`, an in-memory array that no trigger can reach.
 *
 * What actually holds the roster still is the ENGINE's half of the freeze, the
 * process-wide flag in `maintenance/freezeState.ts` that is set from the
 * announcement at :53. Two gates read it on the paths that would otherwise
 * move a seat under the walk, and until today neither had a test: deleting
 * either one left every suite green and turned the next release into the same
 * lottery #5215 had just removed.
 *
 * This is that test. It pins the dependency (the checkpoint's custody
 * signature reads the stack), and then pins both gates that make the
 * dependency safe.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { blankNonCode, sliceMethod, sliceEnclosingBlock } from './helpers/sourceWindow';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const GUARD = 'server/scripts/legacy-engine-checkpoint-guard.mjs';
const SEATING = 'server/src/engine/ServerTableEngineSeating.ts';
const BASE = 'server/src/engine/ServerTableEngineBase.ts';

const { ServerTableEngine } = await import('../server/src/engine/ServerTableEngine.js');
const { supabase } = await import('../server/src/services/supabase.js');
const { setMaintenanceFrozen, isMaintenanceFrozen } =
  await import('../server/src/maintenance/freezeState.js');

const TABLE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

function seatedEngine(stack: number) {
  const engine = new ServerTableEngine(TABLE) as any;
  engine.seatedPlayers = [{ user_id: 'hero', seat_number: 1, stack, is_horse: false }];
  engine.getMaxBuyIn = () => 1000;
  engine.handController = null;
  engine.hub = { emitEvent: vi.fn(), sendToUser: vi.fn().mockReturnValue(1) };
  engine.broadcastCurrentState = vi.fn();
  engine.requestPendingAddOnSweep = vi.fn();
  engine.chipContinuity = { evaluate: vi.fn().mockResolvedValue(undefined) };
  engine.isContinuityActive = () => false;
  return engine;
}

describe('a seat does not move under a release walk', () => {
  beforeEach(() => {
    setMaintenanceFrozen(false);
  });
  afterEach(() => {
    setMaintenanceFrozen(false);
    vi.restoreAllMocks();
  });

  /* THE DEPENDENCY. If the checkpoint stops pinning the stack, the two gates
     below stop being load-bearing for it and this law should be re-argued
     rather than quietly kept. Anchored in code, never in a comment. */
  it('the checkpoint pins each seat and its stack as custody', () => {
    const custody = blankNonCode(sliceMethod(read(GUARD), 'const custody = {'));
    expect(custody).toContain('engine.seatedPlayers.map');
    expect(custody).toContain('seat.user_id');
    expect(custody).toContain('seat.occupancy_id');
    expect(custody).toContain('seat.seat_number');
    expect(custody).toContain('seat.stack');
  });

  /* GATE ONE: a top-up. The only path that raises a seated stack between
     hands, and the only one a player can fire at any second of the break. */
  it('a top-up is refused while the freeze is on, and the seat does not move', async () => {
    const engine = seatedEngine(100);
    const rpc = vi.spyOn(supabase, 'rpc');
    setMaintenanceFrozen(true);
    const res = await engine.addChips('hero', 25, 'op-frozen');
    expect(res).toMatchObject({ success: false, error: 'Scheduled maintenance is in progress' });
    expect(rpc).not.toHaveBeenCalled();
    expect(engine.seatedPlayers[0].stack).toBe(100);
    expect(engine.pendingAddOns.size).toBe(0);
  });

  /* The same request, thawed, must NOT take the frozen answer: a gate that
     refused every top-up for ever would be a forever-block, not a freeze. */
  it('the same top-up is not refused for that reason once the freeze lifts', async () => {
    const engine = seatedEngine(100);
    vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: null, error: null } as any);
    expect(isMaintenanceFrozen()).toBe(false);
    const res = await engine.addChips('hero', 25, 'op-thawed');
    expect(res.error).not.toBe('Scheduled maintenance is in progress');
  });

  /* And the gate is the FIRST thing the method does, so no debit, no cap
     arithmetic and no seat lookup happens on a frozen tick. */
  it('the freeze gate precedes the seat and the debit in a top-up', () => {
    const body = blankNonCode(sliceMethod(read(SEATING), 'public async addChips('));
    const gate = body.indexOf('isMaintenanceFrozen()');
    const seat = body.indexOf('this.seatedPlayers.find(');
    const debit = body.indexOf('supabase.rpc(');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(seat).toBeGreaterThan(gate);
    expect(debit).toBeGreaterThan(gate);
  });

  /* GATE TWO: the roster sweep. The wait-for-players loop re-reads the seats
     every five seconds and hands the result to `adoptSeatRoster`, which is
     what replaces `seatedPlayers` wholesale. It must not be reachable inside
     the loop without passing the pause gate first. */
  it('the wait-for-players loop parks before it adopts a roster', () => {
    const loop = blankNonCode(
      sliceEnclosingBlock(read(BASE), 'this.adoptSeatRoster(nextRoster)', 0, 2)
    );
    const gate = loop.indexOf('this.maintenancePaused ||');
    const park = loop.indexOf('await this.awaitPauseGate()');
    const adopt = loop.indexOf('this.adoptSeatRoster(nextRoster)');
    // The maintenance flag is a conjunct of the gate's own condition, the gate
    // waits, and only then does the sweep get to replace the roster.
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(park).toBeGreaterThan(gate);
    expect(adopt).toBeGreaterThan(park);
  });
});

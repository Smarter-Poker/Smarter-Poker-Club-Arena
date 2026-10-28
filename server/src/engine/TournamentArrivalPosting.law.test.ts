/** Tournament arrivals owe only the natural blinds, never a cash-style entry post. */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../services/supabase/client.js', () => ({ supabase: {}, maintenanceSupabase: {} }));

const { ServerTableEngine } = await import('./ServerTableEngine.js');

const TABLE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const engines: any[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.preciseTimer.dispose();
  vi.restoreAllMocks();
});

/**
 * Six seats, all funded. lastButtonSeat = 1, so the coming hand has the button
 * on seat 2, the small blind on seat 3 and the big blind on seat 4 — meaning
 * the big blind has just passed seats 2 and 3.
 */
function tournamentEngine(opts: { tournament: boolean; seats?: number[] }) {
  const engine = new ServerTableEngine(TABLE) as any;
  engines.push(engine);
  const list = opts.seats ?? [1, 2, 3, 4, 5, 6];
  engine.seatedPlayers = list.map((s) => ({
    user_id: `u${s}`,
    seat_number: s,
    stack: 1000,
    is_horse: false,
  }));
  engine.tableInfo = { id: TABLE, tournament_id: opts.tournament ? 'tid' : null };
  engine.lastButtonSeat = 1;
  engine.disconnectEngine = { isSittingOut: () => false };
  return engine;
}

describe('tournament arrivals never owe an entry blind', () => {
  it.each([1, 2, 3, 4, 5, 6])('discards a legacy entry obligation at seat %s', (seat) => {
    const engine = tournamentEngine({ tournament: true });
    engine.mustPostBB.add(`u${seat}`);
    engine.noteTournamentArrival(seat, `u${seat}`);
    expect(engine.mustPostBB.size).toBe(0);
  });
  it('never charges an arrival on the button', () => {
    const engine = tournamentEngine({ tournament: true });
    // Receiving the button on arrival creates no blind obligation.
    engine.noteTournamentArrival(2, 'u2');
    expect(engine.mustPostBB.has('u2')).toBe(false);
  });

  it('never charges an arrival in the small blind seat a second blind (Dan 2026-10-21)', () => {
    const engine = tournamentEngine({ tournament: true });
    // Seat 3 is the small blind for the coming hand. The arrival posts that
    // small blind and is dealt in; it owes nothing more. Under the dead button
    // the seat is the button next hand, and billing a big blind there is the
    // "paid the small blind, then had to pay the big blind again" bug.
    engine.noteTournamentArrival(3, 'u3');
    expect(engine.mustPostBB.has('u3')).toBe(false);
  });

  it('charges nothing for a seat whose big blind is still ahead of it', () => {
    const engine = tournamentEngine({ tournament: true });
    // Seat 4 IS the big blind this hand — it posts naturally.
    engine.noteTournamentArrival(4, 'u4');
    // Seats 5 and 6 reach the big blind inside the current orbit on their own.
    engine.noteTournamentArrival(5, 'u5');
    engine.noteTournamentArrival(6, 'u6');
    expect(engine.mustPostBB.size).toBe(0);
  });

  it('does nothing on a cash table (that path has its own rules)', () => {
    const engine = tournamentEngine({ tournament: false });
    engine.noteTournamentArrival(2, 'u2');
    engine.noteTournamentArrival(3, 'u3');
    expect(engine.mustPostBB.size).toBe(0);
  });

  it('leaves heads-up natural blinds to the deal', () => {
    // Heads-up: the button IS the small blind and both players pay every hand.
    const engine = tournamentEngine({ tournament: true, seats: [1, 2] });
    engine.noteTournamentArrival(2, 'u2');
    expect(engine.mustPostBB.size).toBe(0);
  });
});

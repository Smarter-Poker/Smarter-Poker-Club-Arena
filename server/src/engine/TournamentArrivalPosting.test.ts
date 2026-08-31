/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  B2 — A TOURNAMENT ARRIVAL DOES NOT GET A FREE ORBIT, AND DOES NOT PAY TWICE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every entry-posting mechanism this engine has was switched off for tournament
 * tables: `registerWaitForBB` returns without doing anything, and `deadBlinds`
 * and `bbOnlyPosts` were both gated on `!isTournamentTable()`. A late registrant
 * or a player moved in by the balancer was therefore dealt in wherever they
 * landed and paid nothing until the blinds happened to reach them — up to a full
 * orbit of free hands if they landed on the seat the big blind had just passed,
 * which is exactly the seat TableBalancer's lowest-free-seat-number placement
 * handed out at random.
 *
 * `mustPostBB` is the tournament counterpart of `postingBBToEnter`: one live big
 * blind, into the pot, on the arrival's first dealt hand, charged only for the
 * two seats the big blind has just gone past.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sliceBlockAfter, sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';

vi.mock('../services/supabase.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/supabase.js');
  return { ...actual };
});

const { ServerTableEngine } = await import('./ServerTableEngine.js');

const TABLE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Six seats, all funded. lastButtonSeat = 1, so the coming hand has the button
 * on seat 2, the small blind on seat 3 and the big blind on seat 4 — meaning
 * the big blind has just passed seats 2 and 3.
 */
function tournamentEngine(opts: { tournament: boolean; seats?: number[] }) {
  const engine = new ServerTableEngine(TABLE) as any;
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

describe('B2 noteTournamentArrival - who owes a big blind', () => {
  it('charges an arrival that took the seat the big blind just passed', () => {
    const engine = tournamentEngine({ tournament: true });
    // Seat 2 is the button for the coming hand: the big blind passed it two
    // hands ago, so sitting there buys most of an orbit for nothing.
    engine.noteTournamentArrival(2, 'u2');
    expect(engine.mustPostBB.has('u2')).toBe(true);

    // Seat 3 is the small blind for the coming hand — passed one hand ago.
    engine.noteTournamentArrival(3, 'u3');
    expect(engine.mustPostBB.has('u3')).toBe(true);
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

  it('charges nothing when there is no orbit to ride for free', () => {
    // Heads-up: the button IS the small blind and both players pay every hand.
    const engine = tournamentEngine({ tournament: true, seats: [1, 2] });
    engine.noteTournamentArrival(2, 'u2');
    expect(engine.mustPostBB.size).toBe(0);
  });
});

describe('B2 the charge itself', () => {
  const read = async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    return strip(readFileSync(resolve(__dirname, 'ServerTableEngineDealing.ts'), 'utf8'));
  };

  it('routes tournament arrivals through bbOnlyPosts - one LIVE big blind, no dead small blind', async () => {
    const src = await read();
    // The live-BB-only path. A dead blind would take a small blind on top and
    // is a cash concept: a tournament player is blinded off, not penalised.
    expect(src).toMatch(/this\.isTournamentTable\(\)\s*&&\s*this\.mustPostBB\.size\s*>\s*0/);
    expect(src).toMatch(/bbOnlyPosts:\s*bbOnlyPostSeats\.length/);
    // deadBlinds stays cash-only.
    const dead = sliceEnclosingBlock(src, 'deadBlinds:');
    expect(dead).toMatch(/!this\.isTournamentTable\(\)/);
    expect(dead).not.toMatch(/mustPostBB/);
  });

  it('settles the debt after the hand it is charged on, keeping the small blind seat on the hook', async () => {
    const src = await read();
    const at = src.indexOf('if (this.mustPostBB.size > 0) {');
    expect(at, 'mustPostBB settle block not found').toBeGreaterThan(-1);
    const block = sliceBlockAfter(src, 'if (this.mustPostBB.size > 0) {');
    expect(block).toMatch(/p\.seat_number !== sbSeat/);
    expect(block).toMatch(/this\.mustPostBB\.delete/);
  });

  it('forgets the debt when the player leaves the table', async () => {
    const src = await read();
    expect(src).toMatch(/this\.mustPostBB\.delete\(id\)/);
  });
});

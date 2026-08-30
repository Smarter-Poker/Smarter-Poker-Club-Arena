/**
 * A SATELLITE WINNER WHO ALREADY HOLDS A SEAT MUST STILL BE PAID.
 *
 * fn_award_satellite_seat is idempotent by design: a winner already entered in
 * the target returns ok:true, awarded:false and moves no money. That is right —
 * a player cannot hold two seats, and the prize pool must not be credited twice
 * for one chair.
 *
 * What was wrong is what happened next. That case fell into the same branch as
 * a freshly awarded seat, logged "Seat awarded", and paid nothing — while the
 * write below it still stamped `prize = ticketCost` on the player's row. The
 * winner received neither a seat they did not already have nor its value, and
 * the tournament recorded a prize that never moved.
 *
 * Seen on the 2026-08-30 Sunday Deep Stack Satellite $25: two of its five
 * winners (BoatGhost, NutShark) were already in the Main Event from the
 * original field, so two 200-chip tickets evaporated.
 *
 * A ticket that cannot be spent as a seat is worth its cash value — the same
 * conclusion this method already reaches when the target is unavailable.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
/** Strip comments so a guard cannot pass on a mention in prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const SRC = code(read('src/tournament/TournamentManager.ts'));

describe('the duplicate-seat winner is cashed, not silently skipped', () => {
  it('branches on the awarded flag, not just on ok', () => {
    // ok:true covers BOTH a real award and a dedupe. Only `awarded` separates
    // them, and it was being ignored.
    expect(SRC).toMatch(/seat\?\.ok === true && seat\?\.awarded === false/);
  });

  it('reads awarded off the rpc result type', () => {
    expect(SRC).toMatch(/awarded\?: boolean/);
  });

  it('pays the ticket value in that branch', () => {
    const at = SRC.indexOf('seat?.ok === true && seat?.awarded === false');
    expect(at).toBeGreaterThan(-1);
    const window = SRC.slice(at, at + 900);
    expect(window).toMatch(/await payCash\(/);
    expect(window).toMatch(/ticketCost/);
  });

  it('shares the idempotency key with the other ticket-cash paths, so a re-drive cannot double-pay', () => {
    const at = SRC.indexOf('seat?.ok === true && seat?.awarded === false');
    const window = SRC.slice(at, at + 900);
    expect(window).toMatch(/tourney:\$\{this\.tournamentId\}:prize:place:\$\{w\.position\}/);
  });

  it('no longer claims a seat was awarded when none was', () => {
    const at = SRC.indexOf('seat?.ok === true && seat?.awarded === false');
    const window = SRC.slice(at, at + 900);
    expect(window).toMatch(/already held a seat/);
    // The misleading log belongs only to the genuine-award branch.
    const before = SRC.slice(Math.max(0, at - 400), at);
    expect(before).not.toMatch(/Seat awarded/);
  });

  it('a genuine award still just logs, and still moves no cash', () => {
    // The pool was already credited inside the RPC for a real seat; paying cash
    // on top would be a double payment.
    //
    // The window stops at the NEXT branch on purpose: three lines below this
    // one, the target-unavailable branch legitimately calls payCash, and a
    // looser window would read that as a failure.
    const at = SRC.indexOf('Seat awarded:');
    expect(at).toBeGreaterThan(-1);
    const nextBranch = SRC.indexOf('} else {', at);
    expect(nextBranch).toBeGreaterThan(at);
    expect(SRC.slice(at, nextBranch)).not.toMatch(/payCash/);
  });
});

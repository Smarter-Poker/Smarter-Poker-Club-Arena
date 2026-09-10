/**
 * A RECOVERY MAY NOT INVENT A PODIUM (2026-08-31).
 *
 * Sunday $200 Deep Stack dfae9288 was walked through the stuck-COMPLETING
 * recovery on 2026-08-30 at 19:47 UTC — 73 minutes before its own start — and
 * paid places 1..9 to entrants who were still `registered`. Two of them were
 * handed 1st and 2nd and went on to finish 107th and 87th. The real podium was
 * then paid again by fn_tournament_payout_reconcile (whose key carries a
 * `:reconcile` suffix and so does not dedupe against the recovery key), and the
 * event disbursed 62,841.60 against a 44,640.00 pool — 141%.
 *
 * Two mechanisms, both pinned here:
 *  (1) tournamentRecovery refuses to pay when NO surviving entrant is
 *      'playing' — nobody in that set has been dealt a card, so the chips sort
 *      that assigns places is arbitrary order, not a ranking;
 *  (2) the obsolete played-but-registering sweep no longer exists. Launch
 *      setup is proven before its atomic receipt changes the row to RUNNING,
 *      and only then may any dealer be admitted; there is no periodic relabel
 *      path capable of inventing lifecycle truth.
 *
 * `registered` survivors remain payable whenever at least one player is
 * 'playing' — a genuine late registrant concurrently completing atomic
 * admission is owed their place, and that case is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

describe('a recovery may not invent a podium', () => {
  it('tournamentRecovery pays nobody when no surviving entrant was dealt in', () => {
    const src = read('./tournamentRecovery.ts');

    // A sole survivor must be an actual playing entrant, and the hand table
    // must prove that this tournament dealt at least one hand.
    expect(src).toMatch(/live\.length === 1 && live\[0\]\.status !== 'playing'/);
    expect(src).toContain('GameServer.recoverStuckCompleting_no_dealt_in_survivor');
    expect(src).toContain('const hand = await hasHandEvidence(tournament)');

    // It must sit before the atomic batch that credits every place, or it
    // guards nothing.
    const guardAt = src.indexOf("live.length === 1 && live[0].status !== 'playing'");
    const payAt = src.indexOf('requestTournamentTerminalReceipt(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(payAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(payAt);

    // Registered rows remain part of the ambiguity check but can never be the
    // sole result witness.
    expect(src).toMatch(/row\.status === 'playing' \|\| row\.status === 'registered'/);
  });

  it('has no receipt-free played-but-registering reconciliation path', () => {
    const src = read('../GameServer.ts');
    expect(src).not.toContain('const { data: playedButRegistering }');
    expect(src).not.toContain('GameServer.played_registering_zero_playing');
    expect(src).not.toContain('GameServer.played_registering_relabel_failed');
  });
});

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
 *  (2) GameServer's played-but-registering sweep treats zero 'playing' as a
 *      mislabelled game rather than a decided one, instead of letting 0 fall
 *      into the `<= 1` settle branch.
 *
 * `registered` survivors remain payable whenever at least one player is
 * 'playing' — a genuine late registrant waiting on ensureLateRegSeated is owed
 * their place, and that case is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

describe('a recovery may not invent a podium', () => {
  it('tournamentRecovery pays nobody when no surviving entrant was dealt in', () => {
    const src = read('./tournamentRecovery.ts');

    // The guard exists, and is computed from the alive set.
    expect(src).toMatch(/const anyDealtIn = alive\.some\(\(r\) => r\.status === 'playing'\)/);
    expect(src).toMatch(/if \(alive\.length > 0 && !anyDealtIn\)/);
    expect(src).toContain('GameServer.recoverStuckCompleting_no_dealt_in_survivor');

    // It must sit BEFORE the loop that credits places, or it guards nothing.
    // (2026-09-02: the place is settled as the obligation (tournament, 'place',
    // N) through settleTournamentObligation; the marker is that call.)
    const guardAt = src.indexOf('const anyDealtIn');
    const payAt = src.indexOf("{ kind: 'place', place }");
    expect(guardAt).toBeGreaterThan(-1);
    expect(payAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(payAt);

    // A registered survivor is still payable alongside a playing one: the
    // alive filter itself must not have been narrowed.
    expect(src).toMatch(/r\.status === 'playing' \|\| r\.status === 'registered'/);
  });

  it('the played-but-registering sweep does not settle a game with nobody playing', () => {
    const src = read('../GameServer.ts');
    const sweepAt = src.indexOf('PLAYED-BUT-STILL-REGISTERING RECOVERY');
    expect(sweepAt).toBeGreaterThan(-1);

    const handAt = src.indexOf(
      "recoverStuckCompletingTournaments('played-but-registering'",
      sweepAt
    );
    expect(handAt).toBeGreaterThan(sweepAt);

    const block = src.slice(sweepAt, handAt);
    expect(block).toMatch(/if \(stillPlaying === 0\)/);
    expect(block).toContain('GameServer.played_registering_zero_playing');
  });
});

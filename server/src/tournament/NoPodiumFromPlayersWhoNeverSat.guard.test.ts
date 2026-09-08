/**
 * A RECOVERY MAY NOT INVENT A PODIUM (2026-08-31).
 *
 * Sunday $200 Deep Stack dfae9288 was walked through the stuck-COMPLETING
 * recovery on 2026-08-30 at 19:47 UTC — 73 minutes before its own start — and
 * paid places 1..9 to entrants who were still `registered`. Two of them were
 * handed 1st and 2nd and went on to finish 107th and 87th. The real podium was
 * then paid again by a later repair arm under a different key, and the event
 * disbursed 62,841.60 against a 44,640.00 pool, or 141%.
 *
 * Two mechanisms, both pinned here:
 *  (1) tournamentRecovery never ranks survivors at all. It requires exactly
 *      one durable `winner` row at position 1 and asks the locked database
 *      settlement door to replay the already-decided finish;
 *  (2) GameServer's played-but-registering sweep treats zero 'playing' as a
 *      mislabelled game rather than a decided one, instead of letting 0 fall
 *      into the `<= 1` settle branch.
 *
 * Recovery cannot turn either `registered` or `playing` rows into finishers.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

describe('a recovery may not invent a podium', () => {
  it('tournamentRecovery requires one durable winner and ranks nobody', () => {
    const src = read('./tournamentRecovery.ts');

    const guardAt = src.indexOf('const durableChampions');
    const payAt = src.indexOf('requestTournamentTerminalReceipt(t.id, settlementMode, winnerId)');
    expect(guardAt).toBeGreaterThan(-1);
    expect(payAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(payAt);
    expect(src).toMatch(/player\.status === 'winner' && Number\(player\.position\) === 1/);
    expect(src).toMatch(/durableChampions\.length !== 1 \|\| otherFirstPlaces\.length > 0/);
    expect(src).toContain('GameServer.recoverStuckCompleting_durable_winner_absent');
    expect(src).not.toMatch(/\.sort\(\(a, b\) => Number\(b\.chips/);
    expect(src).not.toMatch(/status:\s*place === 1 \? 'winner'/);
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

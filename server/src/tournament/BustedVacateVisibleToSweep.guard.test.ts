/**
 * THE VACATED BUST MUST STAY VISIBLE TO THE ELIMINATION SWEEP (2026-08-30).
 *
 * Regression pinned: the bust-vacates-the-seat rule removed the 0-stack seat
 * row before the sweep's chip sync (which reads OPEN seats only) could run,
 * so `tournament_players.chips` froze at a stale positive value, the player
 * never matched `chips <= 0`, remainingCount never reached 1, and the
 * tournament never finished. Live impact on 2026-08-30: 10 of 16 RUNNING
 * MTTs stranded heads-up-won, blinds escalating past level 100, first prize
 * never paid.
 *
 * Two mechanisms, both pinned here:
 *  (1) the dealing engine zeroes tournament_players.chips in the same breath
 *      as the seat vacate;
 *  (2) the sweep carries a seatless-phantom backstop that zeroes any
 *      'playing' player with stale chips and no open seat after a strike
 *      window, so a lost write or restart still converges.
 *
 * If you deliberately replace either mechanism, move the pin to the new one
 * IN THE SAME COMMIT.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

describe('busted-vacate stays visible to the elimination sweep', () => {
  it('the dealing engine zeroes tournament_players.chips when it vacates a busted seat', () => {
    const src = read('../engine/ServerTableEngineDealing.ts');
    const vacateAt = src.indexOf("reason: 'busted_awaiting_rebuy_decision'");
    expect(vacateAt).toBeGreaterThan(-1);
    // The chips-zero write lives in the same successful-vacate branch.
    const branch = src.slice(Math.max(0, vacateAt - 4000), vacateAt);
    expect(branch).toContain('.update({ chips: 0 })');
    expect(branch).toContain(".eq('status', 'playing')");
  });

  it('the sweep has a seatless-phantom backstop that fires on >= strikes', () => {
    const src = read('./TournamentManagerEliminations.ts');
    expect(src).toContain('SEATLESS_PHANTOM_STRIKES');
    expect(src).toContain('seatlessPlayingStrikes');
    expect(src).toMatch(/strikes >= TournamentManagerEliminations\.SEATLESS_PHANTOM_STRIKES/);
    // The backstop feeds the ordinary sync path, not a bespoke money write.
    const guardAt = src.indexOf('A PHANTOM IS NOT A PLAYER');
    expect(guardAt).toBeGreaterThan(-1);
    const syncAt = src.indexOf('fn_sync_tournament_chips', guardAt);
    expect(syncAt).toBeGreaterThan(guardAt);
  });
});

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
 * The dealing engine persists zero and emits an event wake. The sweep is
 * deliberately forbidden from guessing that an absent seat is a knockout:
 * a legitimate player can be seatless while a table move is in flight.
 *
 * If you deliberately replace either mechanism, move the pin to the new one
 * IN THE SAME COMMIT.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

describe('busted-vacate stays visible to the elimination sweep', () => {
  it('the hand transaction mirrors zero chips before it vacates the busted seat', () => {
    const src = read('../engine/ServerTableEngineDealing.ts');
    const vacateAt = src.indexOf("reason: 'busted_awaiting_rebuy_decision'");
    expect(vacateAt).toBeGreaterThan(-1);
    // The process publishes the durable result but owns neither database write.
    const branch = src.slice(Math.max(0, vacateAt - 4000), vacateAt);
    expect(branch).not.toContain(".from('tournament_players')");
    expect(branch).not.toContain(".from('table_seats')");

    const sql = readFileSync(
      join(
        __dirname,
        '../../../supabase/migrations/20260909014534_non_satellite_terminal_settlement_commits_one_stored_receipt.sql'
      ),
      'utf8'
    );
    const start = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_ca_settle_hand_stacks_absolute('
    );
    const end = sql.indexOf('$function$;', start);
    const authority = sql.slice(start, end);
    const mirror = authority.indexOf('UPDATE public.tournament_players tp');
    const vacate = authority.indexOf('UPDATE public.table_seats ts', mirror);
    expect(mirror).toBeGreaterThan(-1);
    expect(vacate).toBeGreaterThan(mirror);
    expect(authority.slice(mirror, vacate)).toContain('SET chips = target.stack');
  });

  it('the sweep never manufactures a bust from elapsed seatlessness', () => {
    const src = read('./TournamentManagerEliminations.ts');
    expect(src).not.toContain('SEATLESS_PHANTOM_MS');
    expect(src).not.toContain('seatlessPlayingSince');
    expect(src).toMatch(
      /\.from\('tournament_players'\)[\s\S]*?\.eq\('tournament_id', this\.tournamentId\)[\s\S]*?\.eq\('status', 'playing'\)[\s\S]*?\.lte\('chips', 0\)/
    );
    expect(src).not.toMatch(/seatless[\s\S]{0,300}Date\.now|Date\.now[\s\S]{0,300}seatless/i);
  });
});

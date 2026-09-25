/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A HUMAN IS NEVER LEFT WAITING (2026-08-29, round 13)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The live failure, measured in production: Dan bought a spin seat at
 * 18:06:38Z, sat alone for 24 seconds while no horse came, and left - the
 * horses filled that exact game at 18:13:22, six minutes after he gave up.
 * The fill lived only in discoverTournaments' past-start branch, and each of
 * the day's TWENTY engine deploys opened a 3-13 minute window where that
 * loop was not running (29 dead windows in 12 hours, ~2.5 hours total). A
 * human who sat during one waited it out in silence.
 *
 * Three pins:
 *  1. The seat-first FAST lane (the lightest loop, alive from the first
 *     seconds of boot) now owns the human case: a partially-paid seat-first
 *     game is handed to fillHumanSeatFirstGame on every 5s pass.
 *  2. fillHumanSeatFirstGame fills ONLY games where a human holds a seat -
 *     a horse-only partial is the horse-opened board holding its last seat
 *     for a human, and the held-empty rotation; both designs survive.
 *  3. The client footer names a stalled wait after 30 seconds instead of
 *     repeating the same line forever, and reports it once per seat session.
 */

import { describe, expect, it } from 'vitest';
import { seatCopy } from '../../src/components/table/seatExitCopy';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceBlockAfter, sliceEnclosingBlock } from '../helpers/sourceWindow';

const root = join(__dirname, '..', '..');
const GAME_SERVER = readFileSync(join(root, 'server', 'src', 'GameServer.ts'), 'utf8');
const TABLE_PAGE = readFileSync(join(root, 'src', 'pages', 'TablePage.tsx'), 'utf8');

describe('the fast lane owns the human case', () => {
  const lane = sliceBlockAfter(GAME_SERVER, 'private async discoverSeatFirstStarts(');

  it('hands every partially-paid seat-first game to the human fill', () => {
    expect(lane).toContain('paid > 0 && paid < seats');
    expect(lane).toContain('fillPartialSeatFirstGame(id, seats, paid, windowClosed)');
  });

  it('still fast-starts full games exactly as before', () => {
    expect(lane).toContain('paid < seats) continue');
    expect(lane).toContain('Fast-starting seat-first game');
  });
});

describe('fillHumanSeatFirstGame', () => {
  const fill = sliceBlockAfter(GAME_SERVER, 'private async fillPartialSeatFirstGame(');

  it('fills only when a HUMAN holds a seat - horse-only partials keep their designs', () => {
    expect(fill).toContain('if (!hasHuman) return');
  });

  it('is throttled per game so the 5s lane cannot stampede the top-up', () => {
    expect(fill).toContain('lastHumanFillAt');
    expect(fill).toContain('12_000');
  });

  it('every read is error-bound and reported', () => {
    expect(fill).toContain('human_fill_primary_table_read_failed');
    expect(fill).toContain('human_fill_occupant_read_failed');
    expect(fill).toContain('human_fill_profile_read_failed');
  });

  it('a short fill raises the human-waiting alarm, throttled', () => {
    expect(GAME_SERVER).toContain('seat_first_human_waiting');
    expect(GAME_SERVER).toContain('lastHumanWaitReportAt');
    expect(GAME_SERVER).toContain('SEAT-FIRST BOARD CANNOT FILL');
  });

  it('resolves the table through the same occupancy election as everything else', () => {
    expect(fill).toContain("supabase.rpc('fn_tournament_primary_table'");
  });
});

describe('the client wait is named, never silent', () => {
  it('escalates the footer after 30 stalled seconds and says the seat is safe', () => {
    /* The sentence lives in components/table/seatExitCopy since 2026-09-19,
       keyed by the seat's asset; a chip seat still reads exactly this. */
    expect(seatCopy('chips').stillFillingSeatIsSafe).toBe(
      'Still Filling Your Game, Your Seat And Chips Are Safe'
    );
    expect(TABLE_PAGE).toContain('seatCopy(tableState.arenaAsset).stillFillingSeatIsSafe');
    const arm = sliceEnclosingBlock(TABLE_PAGE, 'seat_first_wait_exceeded', 0, 3);
    expect(arm).toContain('30_000');
  });

  it('reports the long wait once per seat session', () => {
    const arm = sliceEnclosingBlock(TABLE_PAGE, 'seat_first_wait_exceeded', 0, 3);
    expect(arm).toContain('seatFirstWaitReportedRef.current = true');
  });

  it('the timer re-arms on roster movement, so it measures STALL, not elapsed time', () => {
    expect(TABLE_PAGE).toContain('tableState.players.filter(Boolean).length,\n  ]);');
  });
});

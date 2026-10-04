/**
 * The seat's view of the partner hold (2026-10-04): a seated player waiting
 * for a second person sees the wait named and counted down, never a felt that
 * looks frozen. Mirrors TournamentRecurringService.seatFirstHumanPartnerHoldUntilMs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  seatFirstPartnerHoldClock,
  seatFirstPartnerHoldEndsAtMs,
  seatFirstPartnerHoldLabel,
  seatFirstPartnerHoldStatus,
} from '../../src/utils/seatFirstPartnerHold';
import { sliceEnclosingBlock } from '../helpers/sourceWindow';

const TABLE_PAGE = readFileSync(
  join(__dirname, '..', '..', 'src', 'pages', 'TablePage.tsx'),
  'utf8'
);
const SERVER = readFileSync(
  join(__dirname, '..', '..', 'server', 'src', 'services', 'TournamentRecurringService.ts'),
  'utf8'
);

describe('seatFirstPartnerHoldEndsAtMs', () => {
  const sat = 1_000_000;
  it('is the later of the window and 90 s after the seat, capped at 350 s', () => {
    expect(seatFirstPartnerHoldEndsAtMs(sat + 15_000, sat)).toBe(sat + 90_000);
    expect(seatFirstPartnerHoldEndsAtMs(sat + 200_000, sat)).toBe(sat + 200_000);
    expect(seatFirstPartnerHoldEndsAtMs(sat + 999_000, sat)).toBe(sat + 350_000);
  });
  it('falls back to the window alone after a reload (no seat time)', () => {
    expect(seatFirstPartnerHoldEndsAtMs(sat, null)).toBe(sat);
    expect(seatFirstPartnerHoldEndsAtMs(null, null)).toBe(-Infinity);
  });
  it('uses the same constants as the engine', () => {
    expect(SERVER).toContain(
      'export const SEAT_FIRST_HUMAN_PARTNER_HOLD_MS = SEAT_FIRST_HUMAN_WINDOW_MIN_MS;'
    );
    expect(SERVER).toContain('export const SEAT_FIRST_HUMAN_WINDOW_MIN_MS = 90 * 1000;');
    expect(SERVER).toContain('export const SEAT_FIRST_HUMAN_WINDOW_MAX_MS = 350 * 1000;');
  });
});

describe('copy', () => {
  it('counts down in whole seconds and never reads 0:00 while waiting', () => {
    expect(seatFirstPartnerHoldClock(65_000)).toBe('1:05');
    expect(seatFirstPartnerHoldClock(1)).toBe('0:01');
    expect(seatFirstPartnerHoldStatus(30_500)).toBe('Deals In 0:31 At The Latest');
  });
  it('names one seat or several', () => {
    expect(seatFirstPartnerHoldLabel(1)).toBe('Seat Reserved, Holding The Other Seat For A Player');
    expect(seatFirstPartnerHoldLabel(2)).toBe('Seat Reserved, Holding 2 Seats For Other Players');
  });
});

describe('the table wires it', () => {
  it('reads start_time on both seat-first reads and keeps it on the sheet', () => {
    expect(TABLE_PAGE).toContain('startTimeMs: parseStartTimeMs(tournData.start_time)');
    expect(TABLE_PAGE).toContain(
      'startTimeMs: parseStartTimeMs((row as { start_time?: unknown }).start_time)'
    );
    expect(TABLE_PAGE).toMatch(/prize_pool_finalized, start_time'/);
    expect(TABLE_PAGE).toMatch(/buy_in_fee, starting_chips, start_time'/);
  });
  it('the footer shows the hold, and the stall alarm starts only after it', () => {
    expect(TABLE_PAGE).toContain('return seatFirstPartnerHoldLabel(left);');
    expect(TABLE_PAGE).toContain('seatFirstPartnerHoldStatus(holdEnds - seatFillClock)');
    expect(TABLE_PAGE).toContain('}, holdLeftMs + 30_000);');
  });
});

describe('the felt deals the moment the game does', () => {
  it('a full board re-reads its row each second, bounded, instead of every 10 s', () => {
    expect(TABLE_PAGE).toContain(
      'if (seatRows.length >= seatFirstBuyIn.seats && fullRechecks < 15 && !fullRecheckTimer)'
    );
    expect(TABLE_PAGE).toContain('if (fullRecheckTimer) window.clearTimeout(fullRecheckTimer);');
  });
  it('the socket is asked to join when play begins, until it is up, for at most 30 s', () => {
    expect(TABLE_PAGE).toContain('seatFirstDealtAtRef.current = Date.now();');
    const effect = sliceEnclosingBlock(
      TABLE_PAGE,
      "if (!playHasBegun || began === null || engineWsStatus === 'connected') return;"
    );
    expect(effect).toContain('const began = seatFirstDealtAtRef.current;');
    expect(effect).toContain('reconnectEngineNow();');
    expect(effect).toContain('}, 1_500);');
    expect(effect).toContain('Date.now() - began > 30_000');
    expect(TABLE_PAGE).toContain('}, [playHasBegun, engineWsStatus, reconnectEngineNow]);');
  });
});

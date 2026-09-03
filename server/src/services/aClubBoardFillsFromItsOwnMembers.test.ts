/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A CLUB BOARD FILLS FROM ITS OWN MEMBERS, OR IT NEVER FILLS AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-01 (Deep Stack Society directive): heads-up / SNG boards must
 * open for activated CLUB owners, not just the house board.
 * Dan, 2026-09-02: DSS horses "PLAY OPENLY INSIDE THE DEEP STACK SOCIETY ONLY."
 * Dan, 2026-09-02 and again 2026-09-03: those boards sit at 1/2 forever.
 *
 * One story. checkAndLaunchSNGs was taught to open boards for activated club
 * owners; topUpWithHorses was never taught to fill them and refused every
 * top-up outside the house board. The platform opened boards it had forbidden
 * itself to fill. Measured on production 2026-09-03:
 *
 *   Midway Union (house)   62 heads-up RUNNING, 60 spins RUNNING
 *   Deep Stack Society      6 heads-up REGISTERING, ZERO EVER RUNNING
 *
 * Each DSS board took a real buy-in from the first player to sit and held it
 * forever - 64 of them across two nights, cancelled and refunded by hand - and
 * was retried every twelve seconds, which is where 24,490 calls of
 * fn_sync_seat_first_player_count in 76 minutes came from.
 *
 * Source pins, because the regression would come back at the call site and
 * nothing about its absence looks wrong in a diff.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { automatedRegistrationIsPermitted } from './TournamentRecurringService.js';

const RECURRING = readFileSync(
  join(process.cwd(), 'src/services/TournamentRecurringService.ts'),
  'utf8'
);

/** The body of topUpWithHorses, from its declaration to the next method. */
function topUpSource(): string {
  const start = RECURRING.indexOf('async topUpWithHorses(');
  expect(start).toBeGreaterThan(-1);
  const rest = RECURRING.slice(start);
  const end = rest.indexOf('\n  private async', 1);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('automatedRegistrationIsPermitted', () => {
  const HOUSE = 'fade0000-0000-0000-0000-000000000001';

  it('is the house board, and only the house board', () => {
    expect(automatedRegistrationIsPermitted(HOUSE, HOUSE)).toBe(true);
    expect(automatedRegistrationIsPermitted('2a1132b9-5ba2-42e6-9f01-30a7fcffebe3', HOUSE)).toBe(
      false
    );
  });

  it('an absent id is never permission', () => {
    expect(automatedRegistrationIsPermitted(null, HOUSE)).toBe(false);
    expect(automatedRegistrationIsPermitted(undefined, HOUSE)).toBe(false);
    expect(automatedRegistrationIsPermitted('', HOUSE)).toBe(false);
    // A missing HOUSE id must not turn every club into the house board.
    expect(automatedRegistrationIsPermitted(HOUSE, null)).toBe(false);
    expect(automatedRegistrationIsPermitted(HOUSE, '')).toBe(false);
  });
});

describe('a seat-first board fills wherever it was opened', () => {
  const body = topUpSource();

  it('the refusal applies to MTT registration ONLY, never to a seat-first board', () => {
    // `!seatFirst &&` is the whole fix: without it, a club board opened by
    // checkAndLaunchSNGs could never be topped up and never started.
    expect(body).toMatch(/!seatFirst &&\s*!automatedRegistrationIsPermitted\(/);
  });

  it('and it no longer pays for its own refusal', () => {
    // The refusal branch used to call fn_sync_seat_first_player_count on every
    // attempt - ~100 ms, every 12 seconds, per unfillable board, forever.
    const refusal = body.slice(
      body.indexOf('!automatedRegistrationIsPermitted('),
      body.indexOf('MEASURE THE SHORTFALL')
    );
    expect(refusal).not.toMatch(/rpc\('fn_sync_seat_first_player_count'/);
    expect(refusal).toMatch(/return 0;/);
  });
});

describe('the membership rule still holds - it moved into the pool', () => {
  it('every free candidate is narrowed to the tournament club members', () => {
    // This is what makes it safe to let a club board fill: the pool cannot
    // contain anyone who did not join that club.
    expect(RECURRING).toMatch(
      /const clubIds = tournamentId \? await this\.clubMemberIdsForTournament\(tournamentId\) : null;/
    );
    expect(RECURRING).toMatch(
      /const inClub = clubIds \? fleetIds\.filter\(\(id\) => clubIds\.has\(id\)\) : fleetIds;/
    );
  });

  it('the seat-first fill passes the tournament id, so that narrowing runs', () => {
    // pickFreeHorses(count, allLanes, tournamentId) - drop the third argument
    // and the pool silently becomes every horse on the platform.
    expect(topUpSource()).toMatch(/this\.pickFreeHorses\(poolWanted, false, tournamentId\)/);
  });

  it('a standalone club draws on its own members, a union event on the union', () => {
    const scope = RECURRING.slice(
      RECURRING.indexOf('private async clubMemberIdsForTournament'),
      RECURRING.indexOf('private async pickFreeHorses')
    );
    expect(scope).toMatch(/let clubIds: string\[\] = \[hostClubId\];/);
    expect(scope).toMatch(/if \(unionId\) \{/);
  });
});

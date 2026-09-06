/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FEEDER KEEPS ITS BUYERS, AND A BOOKING IS A GAME (2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The arithmetic is proven in HorseGameLoad.test.ts and
 * HorseBuyerAllocation.test.ts. This file asserts the SEEDING PATH is wired
 * to both - a correct module nobody calls is a failure mode this repo has
 * shipped before (HorseBankrollWiring.test.ts and aBarredHorseIsNotABuyer.ts
 * say the same). Source contract rather than a driven seeding run, because
 * seatHorse ends in atomic_table_buyin against production.
 *
 * What was measured on 2026-09-06, from the engine log and the Postgres error
 * log together:
 *   - feeders in four hours: 26 opened, 15 live, 15 abandoned;
 *   - opening feeders in three hours: 156 horses selected, 34 seated, and 30
 *     of 51 feeder cycles seated NOBODY;
 *   - `FOUR TABLE LIMIT` raised 10,577 times in under four hours, the most
 *     common error on the whole database, and not one line of it in the
 *     engine log - seatHorse treats it as an ordinary seeding race;
 *   - 1,000 horses: 2 at four live seats, 351 at the database's four-GAME
 *     limit, 349 of those invisible to the fleet, 2,109 tournament bookings.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/services/HorseFleetManager.ts'), 'utf8');

/** seedAllTables itself, without the helpers that follow it. */
const SEED = SRC.slice(
  SRC.indexOf('private async seedAllTables('),
  SRC.indexOf('\n  private async ', SRC.indexOf('private async seedAllTables(') + 1)
);
const SEAT_HORSE = SRC.slice(
  SRC.indexOf('private async seatHorse('),
  SRC.indexOf('// FLEET HEALTH')
);

describe('a booking is a game: the fleet reads what the database counts', () => {
  it('reads the bookings ONCE per cycle, paged, keyset on id, and only unstarted tournaments', () => {
    expect(SEED).toContain("from('tournament_players')");
    const from = SEED.indexOf("from('tournament_players')");
    const to = SEED.indexOf("label: 'HorseFleet.tournamentBookings'");
    expect(to).toBeGreaterThan(from);
    const read = SEED.slice(from, to);
    expect(read).toContain('tournaments!inner(status)');
    expect(read).toMatch(/\.in\('status', \['registered', 'playing'\]\)/);
    expect(read).toMatch(/\.in\('tournaments\.status', \['ANNOUNCED', 'REGISTERING'\]\)/);
    expect(read).toMatch(/\.order\('id',\s*\{\s*ascending:\s*true\s*\}\)/);
    expect(read).toContain('.limit(want)');
    expect(read).toMatch(/q\.gt\('id',\s*cursor\)/);
    expect(read).not.toContain('.range(');
    expect((SRC.match(/HorseFleet\.tournamentBookings/g) || []).length).toBe(1);
  });

  it('reads the tournament tables too, so a seat-first game is never counted twice', () => {
    const from = SEED.indexOf("label: 'HorseFleet.tournamentBookings'");
    const to = SEED.indexOf("label: 'HorseFleet.tournamentTables'");
    expect(to).toBeGreaterThan(from);
    const read = SEED.slice(from, to);
    expect(read).toMatch(/\.not\('tournament_id', 'is', null\)/);
    expect(read).toMatch(/\.neq\('status', 'closed'\)/);
    expect(SEED).toContain('buildBookingLoad(bookingPage.rows, tournamentByTableId, horseTables)');
  });

  it('is loaded BEFORE the seeding loop and AFTER the seat map it needs', () => {
    const seatsAt = SEED.indexOf('const allActiveSeats = seatPage.rows;');
    const loaderAt = SEED.indexOf("from('tournament_players')");
    const loopAt = SEED.indexOf('for (const table of tablesToSeed)');
    expect(seatsAt).toBeGreaterThan(0);
    expect(loaderAt).toBeGreaterThan(seatsAt);
    expect(loaderAt).toBeLessThan(loopAt);
  });

  it('fails OPEN: a short or failed read counts no bookings and says so in the beat', () => {
    expect(SEED).toContain('beat.bookingsReadFailed = 1;');
    expect(SEED).toContain('tournament booking read incomplete');
    expect(SEED).toContain("reportError(err, 'HorseFleet.tournament_bookings_load_failed')");
  });

  it('the candidate filter asks the ONE rule, before the seat map short-circuit', () => {
    const filter = SEED.slice(
      SEED.indexOf('const candidateHorses'),
      SEED.indexOf('// V8 ACTIVITY WINDOWS')
    );
    expect(filter).toContain('bookings: bookingLoad.get(h.id) ?? 0,');
    expect(filter).toContain('mayEnterAnotherGame(gameLoad)');
    // the platform refusal is counted, so it can never be silent again
    expect(filter).toContain("refusalReason(gameLoad) === 'platform'");
    expect(filter).toContain('bookedOutDropped++');
    // asked BEFORE `if (!tablesForHorse) return true` - a horse with no seat
    // at all can be committed to four tournaments
    expect(filter.indexOf('mayEnterAnotherGame(gameLoad)')).toBeLessThan(
      filter.indexOf('if (!tablesForHorse) return true;')
    );
    // and the old seats-only ceiling test is gone, not sitting beside it
    expect(filter).not.toContain(
      'if (tablesForHorse.size >= tagMaxTables(tag, MAX_TABLES_PER_HORSE)) return false;'
    );
  });

  it('the buyer capacity handed to the allocator is the same rule', () => {
    expect(SEED).toContain('capacityByHorse.set(h.id, remainingGameCapacity(gameLoad));');
  });

  it('says how many pairs it refused, in the cycle line and the beat', () => {
    expect(SEED).toContain('beat.bookedOut = bookedOutDropped;');
    expect(SEED).toContain('four-game limit:');
  });
});

describe('the feeder reserves the buyers it was opened for', () => {
  it('every cluster pool declares its claim, and only an opening feeder reserves', () => {
    expect(SEED).toContain("claim: openingFeeder ? 'reserved' : countOnly ? 'probe' : 'seating',");
    expect(SEED).toContain(
      "const openingFeeder = !!table.cluster_id && table.lifecycle === 'opening';"
    );
  });

  it('the claim is the two it goes live on, less whoever already sat', () => {
    expect(SEED).toContain('Math.max(0, FEEDER_BUYERS_TO_GO_LIVE - currentCount)');
  });

  it('nothing is stored: the claim is derived from the row every cycle', () => {
    // no map, no cache, no table of reservations that could outlive a feeder
    expect(SRC).not.toMatch(/reservedFeeders|feederReservations|this\.reserved/);
  });

  it('the opening-feeder diagnostic reports the reservation', () => {
    expect(SEED).toContain('if (diag) diag.reserved = feederClaim;');
    expect(SEED).toContain('reserved ${diag.reserved}');
    // and the rest of the line is intact
    for (const part of [
      'candidates ${diag.candidates}',
      'sittable ${diag.sittable}',
      'wanted ${diag.wanted}',
      'empty seats ${diag.empty_seats}',
      'selected ${diag.selected}',
      'seated ${diag.seated}',
    ]) {
      expect(SEED).toContain(part);
    }
  });
});

describe('a refused buy-in says why', () => {
  it('seatHorse hands the reason back on every refusal path', () => {
    expect(SEAT_HORSE).toContain('onRefusal?: (reason: BuyInRefusal) => void');
    expect(SEAT_HORSE).toContain("onRefusal?.('frozen')");
    expect(SEAT_HORSE).toContain('onRefusal?.(classifyBuyInRefusal(msg))');
    expect(SEAT_HORSE).toContain('onRefusal?.(classifyBuyInRefusal(err?.message))');
  });

  it('the seeding loop counts it, for the cycle line and for the feeder diagnostic', () => {
    expect(SEED).toContain('const buyInRefused = new Map<BuyInRefusal, number>();');
    expect(SEED).toContain('noteSkip(diag, `buyin_${reason}`)');
    expect(SEED).toContain('buy-in refused: ${formatRefusals(buyInRefused)}');
  });
});

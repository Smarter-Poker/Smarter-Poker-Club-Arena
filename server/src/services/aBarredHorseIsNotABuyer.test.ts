/**
 * THE FLEET READS THE DOOR RULES, AND A BUYER IS COUNTED ONCE (2026-09-05).
 *
 * The arithmetic is proven behaviourally in HorseRejoinConstraints.test.ts
 * and HorseBuyerAllocation.test.ts. This file asserts the SEEDING PATH itself
 * is wired to both - a correct module nobody calls is the failure mode this
 * repo has shipped before (HorseBankrollWiring.test.ts says the same). Source
 * contract rather than a driven seeding run, because seatHorse ends in
 * atomic_table_buyin against production.
 *
 * Measured before this wiring (engine log + DB, 2026-09-05 03:05 CDT):
 *   - 341 of 349 horse buy-in refusals in one hour were VPIP_BARRED, from 35
 *     horses holding 57 active bars, all of them counted as buyers first;
 *   - 12 feeders opened in that hour, 2 went live, 11 abandoned empty at
 *     three minutes and re-opened two minutes later, every 5.5 minutes.
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
const FILTER = SEED.slice(
  SEED.indexOf('const candidateHorses'),
  SEED.indexOf('const tablesForHorse')
);
const CLAIM = SRC.slice(
  SRC.indexOf('private async claimOfferedSeats('),
  SRC.indexOf('private computeHorseBuyIn(')
);
const COMPUTE = SRC.slice(
  SRC.indexOf('private computeHorseBuyIn('),
  SRC.indexOf('private async seatHorse(')
);
/* 2026-09-05: the seat stage reads the floor through the ONE sit predicate. */
const VERDICT = readFileSync(join(process.cwd(), 'src/services/HorseSitVerdict.ts'), 'utf8');

describe('the door rules are read once per cycle', () => {
  it('loads cash_rejoin_constraints through fetchAllRows, keyset on id, active rows only', () => {
    expect(SEED).toContain("from('cash_rejoin_constraints')");
    const from = SEED.indexOf("from('cash_rejoin_constraints')");
    const to = SEED.indexOf("label: 'HorseFleet.rejoinConstraints'");
    expect(to).toBeGreaterThan(from);
    const read = SEED.slice(from, to);
    expect(read).toMatch(/\.gt\('expires_at',/);
    expect(read).toMatch(/\.order\('id',\s*\{\s*ascending:\s*true\s*\}\)/);
    expect(read).toContain('.limit(want)');
    expect(read).toMatch(/q\.gt\('id',\s*cursor\)/);
    expect(read).not.toContain('.range(');
    // every column the two shapes need
    for (const col of [
      'player_id',
      'club_id',
      'variant',
      'sb',
      'bb',
      'required_stack',
      'barred_until',
      'expires_at',
    ]) {
      expect(read).toContain(col);
    }
  });

  it('ONCE - outside the table loop, beside the bankroll loader', () => {
    expect((SRC.match(/HorseFleet\.rejoinConstraints/g) || []).length).toBe(1);
    const loaderAt = SEED.indexOf("from('cash_rejoin_constraints')");
    const loopAt = SEED.indexOf('for (const table of tablesToSeed)');
    expect(loaderAt).toBeGreaterThan(0);
    expect(loaderAt).toBeLessThan(loopAt);
  });

  it('fails OPEN: an incomplete or failed read seats without the door rules, and says so', () => {
    expect(SEED).toContain('let rejoin: RejoinConstraints = EMPTY_REJOIN_CONSTRAINTS;');
    expect(SEED).toMatch(/if \(rejoinPage\.complete\) \{\s*rejoin = buildRejoinConstraints\(/);
    expect(SEED).toContain('rejoin constraints read incomplete');
    expect(SEED).toContain("'HorseFleet.rejoin_constraints_load_failed'");
  });
});

describe('the candidate filter', () => {
  it('keys the table the way the SQL joins it, once per table', () => {
    expect(SEED).toContain('const constraintTableKey = rejoinTableKey(table);');
    expect(SEED.indexOf('const constraintTableKey')).toBeLessThan(
      SEED.indexOf('const candidateHorses')
    );
  });

  it('drops a horse barred from THIS game and counts the drop', () => {
    expect(FILTER).toContain('const doorKey = rejoinPlayerKey(h.id, constraintTableKey);');
    expect(FILTER).toMatch(
      /if \(rejoin\.barred\.has\(doorKey\)\) \{\s*barredDropped\+\+;\s*return false;/
    );
    // reported with the other dropped counters, never silent
    expect(SEED).toMatch(/if \(barredDropped > 0 \|\| floorUnaffordableDropped > 0\)/);
    expect(SEED).toContain('barred from that game for');
  });

  it('applies to every table, cluster or not: the bar gate precedes the tag gates and has no cluster guard', () => {
    const barAt = FILTER.indexOf('rejoin.barred.has(doorKey)');
    const tagAt = FILTER.indexOf('tagAllowsCash(tag)');
    expect(barAt).toBeGreaterThan(0);
    expect(barAt).toBeLessThan(tagAt);
    const barBlock = FILTER.slice(FILTER.indexOf('THE DOOR (2026-09-05)'), barAt);
    expect(barBlock).not.toContain('cluster_id');
  });

  it('drops a horse whose KNOWN roll cannot cover its rejoin floor (clamped to the table max), inside the bankroll gate', () => {
    const gate = FILTER.slice(FILTER.indexOf('if (bankrollsLoaded)'));
    expect(gate).toContain('const rejoinFloorForPair = rejoin.rejoinFloor.get(doorKey);');
    expect(gate).toMatch(/Math\.min\(rejoinFloorForPair, tableMax\)/);
    expect(gate).toMatch(
      /if \(effectiveFloor > roll\) \{\s*floorUnaffordableDropped\+\+;\s*return false;/
    );
    // and only after the unknown-roll fail-open branch, never before it
    expect(gate).toContain('seat_fail_open_roll_unknown');
    expect(gate.indexOf('rejoinFloorForPair')).toBeGreaterThan(gate.indexOf('return true;'));
  });
});

describe('the buy-in brings the floor', () => {
  it('computeHorseBuyIn takes the floor and applies it LAST, clamped to the max', () => {
    /* `note` (the telemetry sink, 2026-09-05) follows the floor in the
       signature; the floor is still the last thing the SIZING reads. */
    expect(COMPUTE).toMatch(
      /rejoinFloor\?: number,\s*(?:\/\*[\s\S]*?\*\/\s*)?note: \(e: BankrollEvent\) => void = bankrollEvent\s*\)/
    );
    expect(COMPUTE).toContain('return applyRejoinFloor(buyIn, rejoinFloor, maxB);');
    // nothing after the floor can lower it
    expect(COMPUTE.slice(COMPUTE.indexOf('return applyRejoinFloor'))).not.toContain('buyIn =');
  });

  it('the seeding loop hands the floor in, keyed on the same table key the filter used', () => {
    const seatLoop = SEED.slice(SEED.indexOf('for (let i = 0; i < selectedHorses.length; i++)'));
    expect(seatLoop).toContain('const verdict = sitVerdictFor(horse.id, table, sitCtx);');
    // the verdict keys the floor the way the filter keyed the bar
    expect(VERDICT).toMatch(
      /const rejoinFloor = ctx\.rejoin\.rejoinFloor\.get\(rejoinPlayerKey\(horseId, rejoinTableKey\(table\)\)\);/
    );
    expect(VERDICT).toMatch(/ctx\.sizeBuyIn\(table, horseId, seatClub, rejoinFloor\)/);
    // and the fleet's sizeBuyIn IS computeHorseBuyIn, telemetry collected
    expect(SEED).toMatch(
      /this\.computeHorseBuyIn\(\s*t,\s*id,\s*bankrolls,\s*bankrollsLoaded,\s*club,\s*floor,\s*\(e\) => telemetry\.push\(e\)\s*\)/
    );
  });

  it('a seat call obeys the same door: barred horses do not answer, floors are brought', () => {
    expect(CLAIM).toContain(
      'const offerDoorKey = rejoinPlayerKey(offer.user_id, rejoinTableKey(table));'
    );
    expect(CLAIM).toContain('if (rejoin.barred.has(offerDoorKey)) continue;');
    expect(CLAIM).toMatch(/seatClub,\s*rejoin\.rejoinFloor\.get\(offerDoorKey\)\s*\)/);
    // and the cycle passes what it read
    expect(SEED).toMatch(/surplusTableIds,\s*seatBudget,\s*rejoin,\s*disabledGameIds\s*\)/);
  });
});

describe('a buyer is counted once', () => {
  it('cluster tables keep their POOL and each horse its remaining capacity; the count is an allocation', () => {
    expect(SEED).toContain('const clusterPools: BuyerPool[] = [];');
    expect(SEED).toContain('const capacityByHorse = new Map<string, number>();');
    expect(SEED).toMatch(/pool: pool\.map\(\(h\) => h\.id\)/);
    expect(SEED).toMatch(
      /for \(const \[tableId, n\] of allocateBuyers\(clusterPools, capacityByHorse\)\)/
    );
    // the allocation lands BEFORE the swap, so a reader never sees pool sizes for cluster tables
    expect(SEED.indexOf('allocateBuyers(clusterPools')).toBeLessThan(
      SEED.indexOf('this.lastEligibleByTable = nextEligible;')
    );
  });

  /* PIN MOVED 2026-09-06. Capacity was the tag ceiling minus the horse's live
     seats. It is now the TIGHTER of that and the platform's four-game limit,
     which counts tournament bookings too - the rule the database was enforcing
     10,577 times in four hours while this arithmetic said the horse was free.
     Same place, same "once per horse", one function instead of a subtraction:
     see HorseGameLoad. */
  it('capacity is what the database would allow, recorded once per horse', () => {
    const cand = SEED.slice(
      SEED.indexOf('const candidateHorses'),
      SEED.indexOf('// V8 ACTIVITY WINDOWS')
    );
    expect(cand).toMatch(
      /if \(!capacityByHorse\.has\(h\.id\)\) \{\s*capacityByHorse\.set\(h\.id, remainingGameCapacity\(gameLoad\)\);\s*\}/
    );
    expect(cand).toContain('ownCashCeiling: tagMaxTables(tag, MAX_TABLES_PER_HORSE),');
    expect(cand).toContain('seats: tablesForHorse?.size ?? 0,');
    expect(cand).toContain('bookings: bookingLoad.get(h.id) ?? 0,');
  });

  /* PIN MOVED 2026-09-06: the same two branches, plus the third the
     reservation added - an OPENING feeder asks for the two 18.3 promotes it
     at, ahead of every other table. */
  it('a FULL table asks for two - the open rule threshold - and a table with room asks for its open seats', () => {
    // 2026-09-06: a SEATING table claims what it will seat this cycle
    // (seatsNeeded), never the whole table - see
    // theFeederFillsFromTheCountItOpenedOn.test.ts.
    expect(SEED).toMatch(
      /seatsWanted: openingFeeder\s*\?\s*feederClaim\s*:\s*countOnly\s*\?\s*FULL_TABLE_BUYER_PROBE\s*:\s*Math\.max\(0, Math\.min\(seatsNeeded, Number\(table\.max_players\) - currentCount\)\)/
    );
    expect(SEED).toContain('Math.max(0, FEEDER_BUYERS_TO_GO_LIVE - currentCount)');
  });

  it('the horses a table actually took lead its pool, so the allocation replays the cycle', () => {
    expect(SEED).toMatch(/if \(seated > 0 && clusterPool\) \{/);
    expect(SEED).toMatch(/\.\.\.clusterPool\.pool\.filter\(\(id\) => seatedIds\.has\(id\)\)/);
  });

  it('non-cluster tables still report their pool size (nobody opens a feeder on them)', () => {
    expect(SEED).toMatch(/\} else \{\s*nextEligible\.set\(table\.id, pool\.length\);\s*\}/);
  });

  it('eligibleHorseCount keeps its shape; the ClusterController is untouched', () => {
    // 2026-09-06: the census ages out (a stale one answers 0) and then reads
    // the same map with the same shape.
    expect(SRC).toMatch(
      /eligibleHorseCount\(tableId: string\): number \{\s*if \(this\.censusIsStale\(\)\) return 0;\s*return this\.lastEligibleByTable\.get\(tableId\) \?\? 0;/
    );
  });
});

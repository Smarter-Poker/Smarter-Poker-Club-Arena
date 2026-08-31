/**
 * The bankroll loop that CLOSES: tournaments, reloads, freerolls, telemetry.
 *
 * The layer shipped before this gated seating and reloads. Three ways to
 * commit chips were still ungated, and every pin below is one of them.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bankrollPolicyFor,
  bankrollTemperamentFor,
  canEnterTournament,
  rebuyDecision,
  referenceBuyIn,
} from './HorseBankroll.js';
import {
  bankrollEvent,
  bankrollCounters,
  bankrollSummaryLine,
  resetBankrollCounters,
} from './HorseBankrollTelemetry.js';
import { atRebuyStopLoss, legacyRebuyAmount } from './HorseRebuyPolicy.js';

const HERE = join(process.cwd(), 'src');
const read = (p: string) => readFileSync(join(HERE, p), 'utf8');

const pol = (t: 'nit' | 'standard' | 'gambler') => {
  for (let i = 0; i < 5000; i++) {
    const id = `h-${i}`;
    if (bankrollTemperamentFor(id) === t) return { id, policy: bankrollPolicyFor(id) };
  }
  throw new Error(`no ${t} horse found`);
};

describe('tournaments are priced in buy-ins, and a freeroll is never gated', () => {
  it('a freeroll is always yes — including for a horse with nothing', () => {
    const { policy } = pol('nit');
    expect(canEnterTournament(0, 0, policy)).toBe(true);
    expect(canEnterTournament(0.5, 0, policy)).toBe(true);
    // ...and this is the point of the whole recovery loop: broke means
    // freerolls, so gating the freeroll on a roll is the loop never closing.
  });

  it('a paid event needs many more buy-ins behind it than a cash game', () => {
    for (const t of ['nit', 'standard', 'gambler'] as const) {
      const { policy } = pol(t);
      expect(policy.tournamentBuyInsToEnter).toBeGreaterThan(policy.buyInsToSit);
    }
  });

  it('the bar is the FULL entry, buy-in plus fee', () => {
    const { policy } = pol('standard'); // 60 buy-ins
    // A 10 + 1 event costs 11, so 60 x 11 = 660, not 60 x 10 = 600.
    expect(canEnterTournament(605, 11, policy)).toBe(false);
    expect(canEnterTournament(660, 11, policy)).toBe(true);
  });

  it('temperament orders the bar: gambler enters what a nit will not', () => {
    const g = pol('gambler').policy;
    const n = pol('nit').policy;
    const roll = 1_000;
    const cost = 20; // 50 buy-ins behind it
    expect(canEnterTournament(roll, cost, g)).toBe(true); // needs 30
    expect(canEnterTournament(roll, cost, n)).toBe(false); // needs 100
  });

  it('a zero bankroll cannot enter a PAID event, however cheap', () => {
    const { policy } = pol('gambler');
    expect(canEnterTournament(0, 0.01, policy)).toBe(false);
  });
});

describe('the rebuy is a decision, not a reflex', () => {
  const table = { minBuyIn: 80, maxBuyIn: 400, bigBlind: 2 };
  const ref = referenceBuyIn(table.bigBlind, table.minBuyIn, table.maxBuyIn); // 200

  it('stops at the temperament stop-loss, and standard is exactly where it was', () => {
    // The old code was a hard-coded `currentRebuys >= 2` for every horse.
    const s = pol('standard');
    expect(s.policy.stopLossBuyIns).toBe(3);
    expect(atRebuyStopLoss(s.id, 1)).toBe(false);
    expect(atRebuyStopLoss(s.id, 2)).toBe(false);
    expect(atRebuyStopLoss(s.id, 3)).toBe(true);
    // and the spread around it
    expect(pol('nit').policy.stopLossBuyIns).toBeLessThan(3);
    expect(pol('gambler').policy.stopLossBuyIns).toBeGreaterThan(3);
  });

  it('REFUSES to reload a stake the roll can no longer carry', () => {
    const { policy } = pol('standard'); // 25 buy-ins to sit -> needs 5,000
    /**
     * 2,000 is the DISCRIMINATING roll and the reason this number is not
     * round. The share alone would permit a reload — 5% of 2,000 is 100,
     * comfortably over the table's 80 minimum — so the only thing that can
     * refuse here is the sit bar. Pick a smaller roll and the sizing arithmetic
     * returns 0 by itself, and the test passes whether the rule exists or not.
     * (Verified by mutation: deleting the canSit line leaves a 1,000-chip case
     * green and this one red.)
     */
    expect(
      rebuyDecision({
        bankroll: 2_000,
        refBuyIn: ref,
        ...table,
        desired: 200,
        rebuysTaken: 0,
        policy,
      })
    ).toBe(0);
  });

  it('reloads when the roll still carries it, capped by the policy share', () => {
    const { policy } = pol('standard'); // 5% share
    // 6,000 roll: sit bar 5,000 is met; 5% of 6,000 is 300, under the 400 max.
    const got = rebuyDecision({
      bankroll: 6_000,
      refBuyIn: ref,
      ...table,
      desired: 400,
      rebuysTaken: 0,
      policy,
    });
    expect(got).toBeGreaterThan(0);
    expect(got).toBeLessThanOrEqual(300);
  });

  it('never returns more than the table allows', () => {
    const { policy } = pol('gambler');
    const got = rebuyDecision({
      bankroll: 1_000_000,
      refBuyIn: ref,
      ...table,
      desired: 10_000,
      rebuysTaken: 0,
      policy,
    });
    expect(got).toBeLessThanOrEqual(table.maxBuyIn);
  });

  it('an unknown reference falls through to sizing rather than standing a horse up', () => {
    const { policy } = pol('nit');
    // refBuyIn 0 means "we could not price this game". A wrong stand-up
    // empties a table; a wrong reload costs one buy-in.
    expect(
      rebuyDecision({
        bankroll: 50_000,
        refBuyIn: 0,
        ...table,
        desired: 200,
        rebuysTaken: 0,
        policy,
      })
    ).toBeGreaterThan(0);
  });

  it('legacy sizing is still the fail-open fallback', () => {
    expect(legacyRebuyAmount(2)).toBe(200);
    expect(legacyRebuyAmount(0)).toBe(200);
  });
});

describe('telemetry says WHY, and stays quiet when there is nothing to say', () => {
  beforeEach(() => resetBankrollCounters());

  it('a silent cycle prints nothing — a line of zeroes is a line nobody reads', () => {
    expect(bankrollSummaryLine()).toBeNull();
  });

  it('counts, and orders the loudest reason first', () => {
    bankrollEvent('seat_refused_underrolled', 5);
    bankrollEvent('buyin_capped');
    expect(bankrollCounters().seat_refused_underrolled).toBe(5);
    expect(bankrollSummaryLine()).toMatch(/^\[Bankroll\] seat_refused_underrolled=5 /);
  });

  it('a standing condition is a GAUGE — re-counting it must not inflate it', () => {
    // 40 stranded horses re-counted every 30 seconds is 115,200 a day, and
    // means nothing. Last value wins for a gauge; events beside it still add.
    bankrollEvent('ladder_exhausted', 40);
    bankrollEvent('ladder_exhausted', 40);
    bankrollEvent('ladder_exhausted', 12);
    expect(bankrollCounters().ladder_exhausted).toBe(12);
    bankrollEvent('topup_refused');
    bankrollEvent('topup_refused');
    expect(bankrollCounters().topup_refused).toBe(2);
  });

  it('the fleet writes the ladder gauge every cycle, so it can fall back to zero', () => {
    const fleet = read('services/HorseFleetManager.ts');
    expect(fleet).toMatch(/bankrollEvent\('ladder_exhausted', stranded\);/);
    /* UNCONDITIONALLY. Guarding the write with `if (stranded > 0)` looks
       harmless — the summary line suppresses zeroes anyway — but it means the
       gauge can never come DOWN: the day the micro relaunch fixes the ladder,
       `bankrollCounters()` still reports the last bad number, forever. */
    expect(fleet).not.toMatch(/if \(stranded > 0\)/);
  });

  it('distinguishes a refusal from an outage — the reason is the whole value', () => {
    bankrollEvent('seat_refused_no_membership');
    bankrollEvent('seat_refused_aggregate_exposure');
    const line = bankrollSummaryLine()!;
    expect(line).toContain('seat_refused_no_membership');
    expect(line).toContain('seat_refused_aggregate_exposure');
  });
});

describe('WIRING — the module exists and something calls it', () => {
  const FLEET = read('services/HorseFleetManager.ts');
  const TOURNEY = read('services/TournamentRecurringService.ts');
  const SETTLE = read('engine/ServerTableEngineSettlement.ts');
  const DEAL = read('engine/ServerTableEngineDealing.ts');

  it('the seat read carries the STACK — exposure cannot be summed without it', () => {
    // Same class of bug as the club_id that was missing from this select on
    // 2026-08-31: every lookup would miss, and the cap would disable itself
    // without failing anything.
    expect(FLEET).toMatch(/select\('id, user_id, table_id, seat_number, stack'\)/);
  });

  it('the fleet manager consults the AGGREGATE ceiling, not just the per-table share', () => {
    // The call must BE the guard, not merely appear in the file: a call
    // short-circuited behind a constant reads as wired and enforces nothing.
    expect(FLEET).toMatch(/if \(\s*!canOpenAnotherTable\(\{/);
    expect(FLEET).toContain("bankrollEvent('seat_refused_aggregate_exposure')");
    /* ...and the refusal must actually SKIP the seat.
       ADJACENCY, not a window. `sliceEnclosingBlock` was tried here first and
       is too coarse: the innermost block containing this guard also holds the
       `capped <= 0` refusal, so its `continue` satisfied the assertion even
       with this one deleted. Verified by mutation — the pin below goes red,
       that one did not. */
    expect(FLEET).toMatch(/bankrollEvent\('seat_refused_aggregate_exposure'\);\s*continue;/);
  });

  it('a seat bought THIS cycle counts as exposure immediately', () => {
    // Without this one line a single pass seats a horse at four tables while
    // every check reads the position the cycle started with.
    const seatIdx = FLEET.indexOf('horseTables.get(horse.id)!.add(table.id)');
    const expIdx = FLEET.indexOf('horseExposure.set(horse.id');
    expect(seatIdx).toBeGreaterThan(-1);
    expect(expIdx).toBeGreaterThan(seatIdx);
  });

  it('tournament registration is gated on the bankroll, not just on solvency', () => {
    // The candidate filter must RETURN the verdict. Mentioning the function
    // elsewhere in the file is not a gate.
    expect(TOURNEY).toMatch(/return canEnterTournament\(roll, cost, bankrollPolicyFor\(h\.id\)\);/);
    expect(TOURNEY).toContain('tournament_refused_underrolled');
    // and the filtered pool is what gets registered, not the unfiltered one
    expect(TOURNEY).toMatch(/const eligiblePool = pool;/);
    expect(TOURNEY).toMatch(/horses = eligiblePool\.slice\(rot\)/);
  });

  it('a broke horse goes to the FRONT of the freeroll queue', () => {
    // The reorder itself, not just the counter beside it.
    expect(TOURNEY).toMatch(/pool = needy\.concat\(pool\.filter\(\(h\) => !broke\(h\.id\)\)\);/);
    expect(TOURNEY).toMatch(/bankrollEvent\('freeroll_entered_broke', Math\.min\(/);
  });

  it('BOTH rebuy sites ask the same question', () => {
    for (const [name, src] of [
      ['settlement', SETTLE],
      ['dealing', DEAL],
    ] as const) {
      expect(src, name).toContain('horseRebuyAmount(');
      // and the flat `bigBlind * 100` sizing is gone from the rebuy path
      expect(src, name).not.toContain('this.tableInfo.big_blind * 100 : 200');
    }
  });

  it('a zero decision stands the horse up rather than rebuying for nothing', () => {
    for (const src of [SETTLE, DEAL]) {
      expect(src).toMatch(/rebuyAmount > 0 &&\s*\(await autoRebuyHorse\(/);
    }
  });
});

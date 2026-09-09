/**
 * Tournament entry had SOLVENCY, not discipline.
 *
 * `fn_register_horse_for_tournament` refuses on `insufficient_balance` and
 * nothing else, so a horse with 1,000 chips to its name could enter a 950
 * event and be broke on one hand of it. And the other half of the loop Dan
 * described - "if they run out of chips, they must play freerolls to earn
 * their chips back" - did not exist anywhere: nothing preferred a broke horse
 * for free money.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bankrollPolicyFor, bankrollTemperamentFor, canEnterTournament } from './HorseBankroll.js';

const TOURNEY = readFileSync(
  join(process.cwd(), 'src/services/TournamentRecurringService.ts'),
  'utf8'
);

/** A horse id of each temperament, found rather than assumed. */
const idOf = (t: 'nit' | 'standard' | 'gambler'): string => {
  for (let i = 0; i < 5000; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    if (bankrollTemperamentFor(id) === t) return id;
  }
  throw new Error(`no ${t} id found`);
};

describe('canEnterTournament prices the FULL entry, and never gates a freeroll', () => {
  it('a freeroll is always yes, at any roll, for every temperament', () => {
    for (const t of ['nit', 'standard', 'gambler'] as const) {
      const p = bankrollPolicyFor(idOf(t));
      expect(canEnterTournament(0, 0, p)).toBe(true);
      expect(canEnterTournament(1, 0, p)).toBe(true);
      // A negative or nonsense cost is still not a paid event.
      expect(canEnterTournament(0, -5, p)).toBe(true);
    }
  });

  it('holds each temperament to its own multiple of the entry', () => {
    const nit = bankrollPolicyFor(idOf('nit'));
    const std = bankrollPolicyFor(idOf('standard'));
    const gam = bankrollPolicyFor(idOf('gambler'));
    expect(nit.tournamentBuyInsToEnter).toBe(100);
    expect(std.tournamentBuyInsToEnter).toBe(60);
    expect(gam.tournamentBuyInsToEnter).toBe(30);

    // A 10 entry: nit needs 1,000, standard 600, gambler 300.
    expect(canEnterTournament(999, 10, nit)).toBe(false);
    expect(canEnterTournament(1000, 10, nit)).toBe(true);
    expect(canEnterTournament(599, 10, std)).toBe(false);
    expect(canEnterTournament(600, 10, std)).toBe(true);
    expect(canEnterTournament(299, 10, gam)).toBe(false);
    expect(canEnterTournament(300, 10, gam)).toBe(true);
  });

  /**
   * The bar must be strictly harder than the cash bar. An MTT pays nothing to
   * most of the field most of the time, so a roll that comfortably survives a
   * cash session is busted by an ordinary run of tournaments.
   */
  it('is stricter than the cash bar for every temperament', () => {
    for (const t of ['nit', 'standard', 'gambler'] as const) {
      const p = bankrollPolicyFor(idOf(t));
      expect(p.tournamentBuyInsToEnter).toBeGreaterThan(p.buyInsToSit);
    }
  });

  it('refuses a roll of zero at a paid event, rather than dividing by nothing', () => {
    expect(canEnterTournament(0, 10, bankrollPolicyFor(idOf('gambler')))).toBe(false);
  });

  /**
   * THE ENTRY IS BUY-IN PLUS FEE. Pricing the rule off the prize contribution
   * alone understates a turbo's real cost by its whole rake, and the rake is
   * what actually leaves the wallet.
   */
  it('the caller prices the entry on buy-in PLUS fee', () => {
    expect(TOURNEY).toMatch(
      /const cost =\s*\(Number\(\(t as any\)\?\.buy_in_amount\) \|\| 0\) \+ \(Number\(\(t as any\)\?\.buy_in_fee\) \|\| 0\);/
    );
  });
});

describe('WIRING - the registration pool actually consults it', () => {
  it('filters the pool through canEnterTournament, not merely imports it', () => {
    expect(TOURNEY).toMatch(/pool = pool\.filter\(\(h\) => \{/);
    expect(TOURNEY).toMatch(/return canEnterTournament\(roll, cost, bankrollPolicyFor\(h\.id\)\);/);
  });

  /**
   * FAILS OPEN, in three separate places, because the same one-line inversion
   * emptied the cash floor for forty minutes on 2026-08-31. Refusing to
   * register on a failed read would silently starve every event on the
   * platform.
   */
  it('an unreadable roll never removes a horse from the pool', () => {
    expect(TOURNEY).toMatch(/if \(roll === undefined\) return true;/);
  });

  it('an incomplete page leaves the pool untouched', () => {
    expect(TOURNEY).toMatch(/if \(rollPage\.complete\) \{/);
  });

  it('a thrown read leaves the pool untouched and is reported, not swallowed', () => {
    expect(TOURNEY).toMatch(
      /\} catch \(err\) \{\s*reportError\(err, 'TournamentRecurring\.bankroll_gate'\);\s*\}/
    );
  });

  it('the gate only applies to PAID events - a freeroll takes the other branch', () => {
    expect(TOURNEY).toMatch(/if \(cost > 0\) \{/);
    expect(TOURNEY).toMatch(
      /bankrollEvent\('tournament_refused_underrolled', before - pool\.length\)/
    );
  });

  /**
   * The recovery loop. Broke horses go to the FRONT of the freeroll queue,
   * and "broke" is measured against the cheapest PAID event actually on the
   * board - a hard-coded floor goes stale the day the schedule changes.
   */
  it('puts broke horses at the front of the freeroll queue', () => {
    expect(TOURNEY).toMatch(/pool = needy\.concat\(pool\.filter\(\(h\) => !broke\(h\.id\)\)\);/);
  });

  it('measures broke against the cheapest paid event on the board, not a constant', () => {
    expect(TOURNEY).toMatch(/const floor = paid\.length > 0 \? Math\.min\(\.\.\.paid\) : 0;/);
    expect(TOURNEY).toMatch(/\.filter\(\(c: number\) => c > 0\)/);
    // No floor readable means nobody is marked broke and the order is left alone.
    expect(TOURNEY).toMatch(/if \(!\(floor > 0\)\) return false;/);
  });

  it('rotates only the GATED pools and puts ticket holders before count truncation', () => {
    // Both partitions must derive from `pool`, after bankroll filtering. A
    // partition from `eligible` would reinstate every horse the gate removed.
    expect(TOURNEY).toContain(
      'const ticketPool = pool.filter((horse) => ticketHintIds.has(horse.id));'
    );
    expect(TOURNEY).toContain(
      'const walletPool = pool.filter((horse) => !ticketHintIds.has(horse.id));'
    );
    expect(TOURNEY).toContain(
      'const horses = orderedTickets.concat(orderedWallets).slice(0, count);'
    );
    expect(TOURNEY).not.toMatch(/const horses = eligible\.slice\(rot\)/);
  });
});

/**
 * The per-table share is checked per table, so it answers identically for the
 * first table and the fourth. Four seats at five percent each is a fifth of
 * the roll in play, and no single-table check can see it. `canOpenAnotherTable`
 * is the only rule that can.
 *
 * Two details would each have silently DISABLED this gate rather than failing
 * anything, and both are pinned below: `stack` missing from the seat select
 * (every exposure lookup reads zero), and a seat bought this cycle not counting
 * until the next one (one pass seats a horse at four tables while every check
 * reads the position the cycle started with). The missing-`club_id` bug of
 * 2026-08-31 was exactly this class.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGGREGATE_EXPOSURE_MULTIPLE,
  bankrollPolicyFor,
  bankrollTemperamentFor,
  canOpenAnotherTable,
} from './HorseBankroll.js';

const FLEET = readFileSync(join(process.cwd(), 'src/services/HorseFleetManager.ts'), 'utf8');

const idOf = (t: 'nit' | 'standard' | 'gambler'): string => {
  for (let i = 0; i < 5000; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    if (bankrollTemperamentFor(id) === t) return id;
  }
  throw new Error(`no ${t} id found`);
};

describe('canOpenAnotherTable sees the whole position, not one seat', () => {
  const std = bankrollPolicyFor(idOf('standard'));

  it('lets a horse with nothing on the felt take its first seat', () => {
    expect(
      canOpenAnotherTable({ bankroll: 10_000, liveExposure: 0, nextBuyIn: 400, policy: std })
    ).toBe(true);
  });

  it('caps the total at three single-table shares, not three tables', () => {
    // standard: 5% of 10,000 is 500 per table, so the ceiling is 1,500.
    const ceiling = 10_000 * std.maxBankrollFraction * AGGREGATE_EXPOSURE_MULTIPLE;
    expect(ceiling).toBe(1500);
    expect(
      canOpenAnotherTable({ bankroll: 10_000, liveExposure: 1100, nextBuyIn: 400, policy: std })
    ).toBe(true);
    expect(
      canOpenAnotherTable({ bankroll: 10_000, liveExposure: 1101, nextBuyIn: 400, policy: std })
    ).toBe(false);
  });

  /**
   * The ceiling counts the seat being opened, not just what is already down.
   * Checking `liveExposure <= ceiling` alone would let every horse cross it by
   * exactly one buy-in, every time.
   */
  it('counts the buy-in being committed, not only what is already at risk', () => {
    expect(
      canOpenAnotherTable({ bankroll: 10_000, liveExposure: 1499, nextBuyIn: 400, policy: std })
    ).toBe(false);
  });

  it('is looser for a gambler and tighter for a nit, at the same roll', () => {
    const nit = bankrollPolicyFor(idOf('nit'));
    const gam = bankrollPolicyFor(idOf('gambler'));
    // nit ceiling is 10,000 * 0.03 * 3 = 900; gambler is 10,000 * 0.10 * 3 = 3,000.
    const args = { bankroll: 10_000, liveExposure: 850, nextBuyIn: 100 };
    expect(canOpenAnotherTable({ ...args, policy: gam })).toBe(true);
    expect(canOpenAnotherTable({ ...args, policy: nit })).toBe(false);
  });
});

describe('WIRING - the two details that would silently disable the gate', () => {
  /**
   * Same class as the `club_id` that was missing from a select on 2026-08-31:
   * every lookup would miss, the gate would read zero exposure for everyone,
   * and nothing would fail.
   */
  it('the seat read carries the STACK, or exposure cannot be summed', () => {
    expect(FLEET).toMatch(/\.select\('id, user_id, table_id, seat_number, stack'\)/);
    expect(FLEET).toMatch(/stack: number \| null;/);
  });

  it('sums the live stack, not the original buy-in', () => {
    expect(FLEET).toMatch(
      /horseExposure\.set\(seat\.user_id, \(horseExposure\.get\(seat\.user_id\) \?\? 0\) \+ st\);/
    );
  });

  it('a seat bought THIS cycle counts as exposure immediately', () => {
    // Without this one line a single pass seats a horse at four tables while
    // every check reads the position the cycle STARTED with.
    const seatIdx = FLEET.indexOf('horseTables.get(horse.id)!.add(table.id)');
    const expIdx = FLEET.indexOf('horseExposure.set(horse.id');
    expect(seatIdx).toBeGreaterThan(-1);
    expect(expIdx).toBeGreaterThan(seatIdx);
  });

  it('the call IS the guard, and the refusal actually skips the seat', () => {
    // A call short-circuited behind a constant reads as wired and enforces
    // nothing. ADJACENCY rather than a byte window: the enclosing block also
    // holds other refusals, so a coarser slice matches their `continue` too.
    expect(FLEET).toMatch(/!canOpenAnotherTable\(\{/);
    expect(FLEET).toMatch(/bankrollEvent\('seat_refused_aggregate_exposure'\);\s*continue;/);
  });

  /**
   * Fails open with the rest of the layer. A gate that refuses on a value it
   * could not read is the bug that emptied the cash floor for forty minutes.
   */
  it('an unreadable roll gets no aggregate opinion either', () => {
    expect(FLEET).toMatch(/roll !== undefined &&\s*!canOpenAnotherTable\(\{/);
  });

  it('checks the ceiling BEFORE buying the seat, not after', () => {
    const guardIdx = FLEET.indexOf("bankrollEvent('seat_refused_aggregate_exposure')");
    const seatIdx = FLEET.indexOf('const success = await this.seatHorse(');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(seatIdx).toBeGreaterThan(guardIdx);
  });
});

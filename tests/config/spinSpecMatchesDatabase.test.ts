/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE LADDER HAS A FOURTH COPY NOW — this is what stops it forking
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * spinSpec.ts exists because this codebase once carried THREE multiplier
 * tables with expectations of 3.00, 2.75 and 2.24, and the one that ran was
 * not the one that was documented. Nobody noticed, because nothing asserted
 * the relationship between the tables.
 *
 * `spinSpecMatchesDatabase` — this file — guards the copy added on 2026-08-31:
 * the `spin_tier_spec` rows seeded by
 * `supabase/migrations/20260831_spin_fairness_guard.sql`, which is what
 * `fn_spin_fairness_check` measures the live wheel against.
 *
 * That copy is worth more than the risk it adds ONLY while it agrees with
 * spinSpec.ts. A fairness guard measuring against a stale ladder is not a
 * guard — it is a machine for generating false confidence, and it would
 * report the exact bug it exists to catch as "pass".
 *
 * So the test parses the migration's INSERT and compares it, row for row,
 * against SPIN_TIERS. It reads the SQL as TEXT deliberately: no database
 * connection, so it runs in CI on every pull request like any other unit test.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SPIN_TIERS, SPIN_FREQ_DENOMINATOR, expectedMultiplier } from '../../src/config/spinSpec';

/**
 * THE LATEST MIGRATION THAT SEEDS THE LADDER, not a hard-coded filename.
 *
 * This was pinned to `20260831_spin_fairness_guard.sql`, and on 2026-09-05 the
 * ladder was reseeded by a newer migration to put E[m] exactly on 2.76. The
 * test went on parsing the 2026-08-31 file and reported that spinSpec.ts had
 * "drifted" from a table that no longer existed anywhere - the assertion still
 * red, but for the wrong reason and pointing at the wrong file. Its own header
 * says "if the ladder moved somewhere else, move this test with it"; following
 * the newest seed means it moves itself.
 */
const MIGRATIONS_DIR = resolve(__dirname, '../../supabase/migrations');
function latestLadderMigration(): string {
  const seeds = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) =>
      readFileSync(join(MIGRATIONS_DIR, f), 'utf8').includes('INSERT INTO public.spin_tier_spec')
    );
  expect(seeds.length, 'no migration seeds spin_tier_spec').toBeGreaterThan(0);
  return join(MIGRATIONS_DIR, seeds[seeds.length - 1]);
}

/**
 * The latest migration DEFINING fn_spin_fairness_check. A different question
 * from "who seeded the ladder last", and conflating the two is how the two
 * guard-body assertions below started reading a migration that only reseeds
 * rows. Same shape, different needle.
 */
function latestFairnessCheckMigration(): string {
  const defs = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) =>
      readFileSync(join(MIGRATIONS_DIR, f), 'utf8').includes('FUNCTION public.fn_spin_fairness_check')
    );
  expect(defs.length, 'no migration defines fn_spin_fairness_check').toBeGreaterThan(0);
  return join(MIGRATIONS_DIR, defs[defs.length - 1]);
}

/** The (multiplier, freq, reserveThresholdX) triples seeded by the migration. */
function ladderFromMigration(): Array<{
  multiplier: number;
  freq: number;
  reserveThresholdX: number;
}> {
  const sql = readFileSync(latestLadderMigration(), 'utf8');

  const insertAt = sql.indexOf('INSERT INTO public.spin_tier_spec');
  expect(
    insertAt,
    'the fairness-guard migration no longer seeds spin_tier_spec — if the ladder ' +
      'moved somewhere else, move this test with it rather than deleting it'
  ).toBeGreaterThan(-1);

  const valuesAt = sql.indexOf('VALUES', insertAt);
  const endAt = sql.indexOf('ON CONFLICT', valuesAt);
  expect(endAt).toBeGreaterThan(valuesAt);

  const body = sql.slice(valuesAt + 'VALUES'.length, endAt);
  const rows = [...body.matchAll(/\(\s*(\d+)\s*,\s*([\d_]+)\s*,\s*([\d.]+)\s*\)/g)].map((m) => ({
    multiplier: Number(m[1]),
    freq: Number(m[2].replace(/_/g, '')),
    reserveThresholdX: Number(m[3]),
  }));

  expect(
    rows.length,
    'parsed no tiers out of the migration — the INSERT shape changed'
  ).toBeGreaterThan(0);
  return rows;
}

describe('the database ladder is the spinSpec ladder', () => {
  it('seeds exactly the tiers spinSpec.ts declares, with the same frequencies', () => {
    const fromSql = ladderFromMigration();
    const fromTs = SPIN_TIERS.map((t) => ({
      multiplier: t.multiplier,
      freq: t.freq,
      reserveThresholdX: t.reserveThresholdX,
    }));

    expect(
      [...fromSql].sort((a, b) => a.multiplier - b.multiplier),
      'spin_tier_spec has drifted from src/config/spinSpec.ts. fn_spin_fairness_check ' +
        'measures the live wheel against the SQL copy, so a drift here makes the ' +
        'fairness guard certify the wrong game as fair — which is worse than having ' +
        'no guard at all. Change both, in the same commit.'
    ).toEqual([...fromTs].sort((a, b) => a.multiplier - b.multiplier));
  });

  it('carries the totals the migration asserts at apply time', () => {
    // The migration RAISEs on these two numbers. If spinSpec.ts ever moves mass
    // between tiers without holding them, this fails in CI rather than at 3am
    // against production.
    const rows = ladderFromMigration();
    const totalFreq = rows.reduce((s, r) => s + r.freq, 0);
    const units = rows.reduce((s, r) => s + r.multiplier * r.freq, 0);

    expect(totalFreq, 'total frequency must match SPIN_FREQ_DENOMINATOR').toBe(
      SPIN_FREQ_DENOMINATOR
    );
    /* MOVED 2026-09-05 with the rebalance that put E[m] exactly on 2.76 - the
       ladder expected 2.763772x, so the product charged 7.874% while booking
       8.00%. Only the 2x/3x split changed; every tier from 4x up holds its
       exact frequency. */
    expect(totalFreq).toBe(10_000_000);
    expect(units, 'weighted units — moving mass between tiers must hold this total').toBe(
      27_600_000
    );
    // The equality the whole product rests on, asserted where the DB copy is
    // read rather than only where the TS copy is.
    expect(units / totalFreq).toBeCloseTo(3 * (1 - 0.08), 10);
    expect(units / totalFreq).toBeCloseTo(expectedMultiplier(), 6);
  });

  it('keeps the 100x reserve gate, and gates nothing else', () => {
    // The reserve threshold is what v_spin_tier_availability enforces and what
    // the fairness guard's "tiers_locked" verdict reports on. A second gated
    // tier would silently change what the odds sheet owes the player.
    const rows = ladderFromMigration();
    const gated = rows.filter((r) => r.reserveThresholdX > 0);
    expect(gated).toEqual([{ multiplier: 100, freq: 1008, reserveThresholdX: 1.5 }]);
  });
});

describe('the guard measures Spins, and only Spins', () => {
  it("uses variant = 'spin', never spin_type IS NOT NULL", () => {
    // spin_type is also set on heads-up sit-and-gos and on ordinary MTTs —
    // 13,709 of them since 2026-08-22, every one carrying spin_multiplier = 0.
    // A population built on spin_type is one third non-Spins, and every
    // percentage computed from it is wrong. Measured 2026-08-31.
    const sql = readFileSync(latestFairnessCheckMigration(), 'utf8');

    expect(sql).toContain("t.variant = 'spin'");

    const offending = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .filter((line) => /spin_type\s+IS\s+NOT\s+NULL/i.test(line));

    expect(
      offending,
      'spin_type IS NOT NULL is not a Spin predicate — it matches heads-up ' +
        'sit-and-gos and MTTs too. Use variant.'
    ).toEqual([]);
  });

  it('never filters horses out of the measurement (CLAUDE.md 10.5)', () => {
    // Horses are ~all of the Spin volume. A guard that excluded them would be
    // measuring a few hundred draws a week and blind to the fleet the wheel
    // actually deals to — and excluding a horse from anything a human gets is
    // the bug this law exists to prevent.
    const sql = readFileSync(latestFairnessCheckMigration(), 'utf8');
    const offending = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .filter((line) => /is_horse/i.test(line));

    expect(
      offending,
      'the fairness guard must never branch on is_horse — horses are players'
    ).toEqual([]);
  });
});

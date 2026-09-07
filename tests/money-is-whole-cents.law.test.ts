/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MONEY IS WHOLE CENTS (Phase 6 of the union accounting programme, 2026-09-07)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Five functions rounded five ways and nobody had written the rule. Measured
 * on production 2026-09-07 22:00 UTC across nine money columns and 1,363,000
 * rows in 24 hours: zero sub-cent values. The policy was already the practice;
 * migration 20260907220528 wrote it down (fn_money_rounding_policy) and put it
 * at the write (ck_whole_cents on nine tables, in force from that timestamp).
 *
 * THE POLICY
 *   1. UNIT     every stored or paid chip amount is a whole number of cents.
 *   2. SHARES   one amount split among players is split in integer cents by the
 *               one allocator (fn_allocate_rake_credits / rakeAllocation.ts),
 *               largest remainder, ties by user id ascending, so the parts sum
 *               to the whole exactly. No other function carries a share formula.
 *   3. RATES    a rate applied to a basis rounds half away from zero to the cent
 *               - EXCEPT the union per-(club, game type) club share, which is
 *               truncated so the remainder stays with the union (Dan 2026-09-03).
 *   4. SUMS     cents are summed as integers; a sum of rounded parts is never
 *               re-rounded.
 *   5. VIP      a VIP credit carries four decimals and converts to whole points
 *               by floor with a per-user carry (20260831100610). Not chips.
 *   6. CONSERVE at every settlement boundary in = out to the cent.
 *
 * This test pins the written policy to the repo: the migration that enforces
 * it, the nine tables it names, and the TS mirror of the allocator.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import {
  allocateWeightedShareCents,
  allocateEqualShareCents,
} from '../server/src/services/rakeAllocation';

const MIG_DIR = resolve(__dirname, '..', 'supabase', 'migrations');
const POLICY_FILE = readdirSync(MIG_DIR).find((f) =>
  /^20260907220528_money_is_whole_cents_and_a_hand_is_one_record_in_the_rakeback_basis\.sql$/.test(
    f
  )
);

const NINE_TABLES = [
  'rake_records',
  'rake_attributions',
  'agent_commissions',
  'union_wallet_transactions',
  'club_wallet_transactions',
  'chip_ledger',
  'rakeback_period_payouts',
  'rakeback_periods',
  'settlement_invoices',
];

describe('money is whole cents', () => {
  it('the policy migration exists and names the rule in the database', () => {
    expect(POLICY_FILE, 'the rounding policy migration is missing').toBeTruthy();
    const sql = readFileSync(resolve(MIG_DIR, POLICY_FILE!), 'utf8');
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_money_rounding_policy\(\)/);
    for (const key of ['unit', 'shares', 'rates', 'sums', 'vip', 'conservation']) {
      expect(sql, `policy key ${key}`).toMatch(new RegExp(`'${key}', '`));
    }
  });

  it('puts the rule at the write on all nine money tables', () => {
    const sql = readFileSync(resolve(MIG_DIR, POLICY_FILE!), 'utf8');
    for (const t of NINE_TABLES) {
      expect(sql, `${t} has no ck_whole_cents`).toMatch(
        new RegExp(`ALTER TABLE public\\.${t}\\s+ADD CONSTRAINT ck_whole_cents CHECK \\(`)
      );
    }
    expect((sql.match(/ADD CONSTRAINT ck_whole_cents/g) ?? []).length).toBe(NINE_TABLES.length);
  });

  it('no later migration drops a ck_whole_cents constraint', () => {
    const later = readdirSync(MIG_DIR).filter((f) => f > POLICY_FILE! && f.endsWith('.sql'));
    for (const f of later) {
      const sql = readFileSync(resolve(MIG_DIR, f), 'utf8').replace(/--[^\n]*/g, '');
      expect(sql, `${f} drops ck_whole_cents`).not.toMatch(
        /DROP CONSTRAINT\s+(IF EXISTS\s+)?ck_whole_cents/i
      );
    }
  });

  it('the allocator splits in integer cents and the parts sum to the whole exactly', () => {
    const users = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ];
    const cases: Array<[number, number[]]> = [
      [1.0, [100, 300, 0.5]],
      [0.24, [10, 10, 10]],
      [7.77, [33.33, 66.67, 0.01]],
      [12345.67, [1, 2, 3]],
    ];
    for (const [amount, contribs] of cases) {
      const w = allocateWeightedShareCents(
        amount,
        users.map((u, i) => [u, contribs[i]] as [string, number])
      );
      let sum = 0;
      for (const v of w.values()) {
        expect(Math.round(v * 100) / 100, 'a weighted share is not whole cents').toBe(v);
        sum += Math.round(v * 100);
      }
      expect(sum).toBe(Math.round(amount * 100));
      const e = allocateEqualShareCents(amount, users);
      let esum = 0;
      for (const v of e.values()) {
        expect(Math.round(v * 100) / 100).toBe(v);
        esum += Math.round(v * 100);
      }
      expect(esum).toBe(Math.round(amount * 100));
    }
  });

  it('the VIP trigger takes its shares from the one allocator (20260907214446)', () => {
    const f = readdirSync(MIG_DIR).find((x) => x.startsWith('20260907214446_'));
    expect(f).toBeTruthy();
    const sql = readFileSync(resolve(MIG_DIR, f!), 'utf8');
    const body = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_award_vip_points_from_rake')
    );
    const fn = body.slice(0, body.indexOf('$function$;'));
    expect(fn).toMatch(/fn_allocate_rake_credits\(/);
    expect(fn).not.toMatch(/jsonb_each_text/);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE UNION HAS ONE RAKE BASIS (Phase 6 of the union accounting programme)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-03: a member club's share is the rake ITS PLAYERS generated at
 * the union's tables, per game type. Round 1 pays on that. On 2026-09-07 the
 * statement described a different basis (the club a player joined first) and
 * on 2026-09-07 21:08 a money report described a third (the hosting club).
 * Same treasury credits, carved three ways: JAQK 14,951 / 285,808, SHARK
 * 633,215 / 290,063 for one identical week.
 *
 * THE LAW. fn_union_club_rake_basis is the one computation. Round 1 calls it
 * live (p_live := true) and stores the rows it paid from; the statement, the
 * ECO adjustment, the reconciliation report and the money report read the
 * same function, which serves a closed period from the settlement record and
 * an open week from the hourly snapshot. No SQL function in a migration on
 * this branch may carry its own copy of the basis arithmetic.
 *
 * Also pinned: the statement function refuses a floored period, a disabled
 * gate and an unclosed period on its own (the Open Claw safety net calls it
 * directly), and the ghost-twin rule lives in exactly one function.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const MIG_DIR = resolve(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(MIG_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (f: string) => readFileSync(resolve(MIG_DIR, f), 'utf8');
const find = (prefix: string) => files.find((f) => f.startsWith(prefix));

describe('the union has one rake basis', () => {
  it('the basis function exists, and the close calls it live', () => {
    const basis = find('20260907215753_');
    const verif = find('20260908020401_');
    expect(basis).toBeTruthy();
    expect(verif).toBeTruthy();
    expect(read(basis!)).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_union_club_rake_basis\(/);
    const v = read(verif!);
    expect(v).toMatch(
      /CREATE FUNCTION public\.fn_union_club_rake_basis\(p_union_id uuid, p_start timestamptz, p_end timestamptz, p_live boolean DEFAULT false\)/
    );
    expect(v).toMatch(/fn_union_club_rake_basis\(p_union_id, p_period_start, p_period_end, true\)/);
  });

  it('every reader of the basis reads the function, not its own copy', () => {
    const verif = read(find('20260908020401_')!);
    expect(verif).toMatch(/fn_union_money_report/);
    expect(verif).toMatch(
      /FROM public\.fn_union_club_rake_basis\(v_union_id, v_week_start, now\(\)\) b/
    );
    const basis = read(find('20260907215753_')!);
    expect(basis).toMatch(/fn_union_eco_adjustment/);
    expect(basis).toMatch(/fn_union_reconciliation_report/);
    expect(basis).toMatch(/fn_union_club_invoice/);
  });

  it('no later migration re-declares the basis arithmetic outside the function', () => {
    const after = files.filter((f) => f > '20260908020401_');
    for (const f of after) {
      const sql = read(f)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/--[^\n]*/g, '');
      // the signature of the basis arithmetic: a per-tournament split by entries
      const hasSplit = /sum\(1 \+ COALESCE\(tp\.rebuys, 0\)/.test(sql);
      const declaresBasis = /FUNCTION public\.fn_union_club_rake_basis\(/.test(sql);
      expect(hasSplit && !declaresBasis, `${f} carries a second copy of the union basis`).toBe(
        false
      );
    }
  });

  it('the statement function carries its own three guards', () => {
    const v = read(find('20260908020401_')!);
    for (const g of ['before_settlement_floor', 'weekly_invoices_disabled', 'period_not_closed']) {
      expect(v, g).toMatch(new RegExp(`''${g}''`));
    }
  });

  it('the ghost-twin rule lives in one function and requires a global hand number', () => {
    const v = read(find('20260908020401_')!);
    expect(v).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_rake_record_is_ghost_twin\(/);
    expect(v).toMatch(/>= 1000000/);
    expect(v).toMatch(
      /AND NOT public\.fn_rake_record_is_ghost_twin\(r\.hand_id, r\.table_id, r\.metadata\)/
    );
  });

  it('the open week is snapshotted by the integrity sweep, never by a new schedule', () => {
    const v = read(find('20260908020401_')!);
    expect(v).toMatch(/fn_union_rake_basis_refresh\(u\.id/);
    expect(v).not.toMatch(/cron\.schedule/);
  });
});

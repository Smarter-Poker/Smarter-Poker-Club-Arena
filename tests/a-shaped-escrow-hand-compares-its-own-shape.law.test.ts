/**
 * LAW: A SHAPED ESCROW HAND COMPARES ITS OWN SHAPE (2026-10-15).
 *
 * union_pnl_cash_outcome_touches stores a hand's participants compacted
 * (fn_union_pnl_compact_participants: user_id, earning_club_id,
 * observed_stack_delta). fn_union_pnl_posthand_escrow_touch compared that
 * compact array with the outcome's FULL participants, so the only hand that
 * carries a posthand escrow certificate (table 1c531058, hand 31008564) raised
 * posthand_escrow_projection_touch_disagrees inside fn_union_pnl_week_hand_lines
 * and the original week's club P&L could never certify.
 *
 * Root: the touch is compared with the compact form of the outcome's
 * participants. Every other refusal (missing outcome, recognized_at, union,
 * accepted rake, any differing participant value) is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SQL = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261015060505_a_shaped_escrow_hand_compares_its_own_shape.sql'
  ),
  'utf8'
);
const CODE = SQL.replace(/^\s*--[^\n]*$/gm, '');

describe('a shaped escrow hand compares its own shape', () => {
  it('is one transaction with a live proof and exact pre and post images', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toMatch(
      /^-- @live-proof: \(SELECT md5\(pg_get_functiondef\('public\.fn_union_pnl_posthand_escrow_touch\(public\.union_pnl_cash_outcome_touches\)'::regprocedure\)\)='e51decda42bbe46dd90aaf1bd3119023'\)$/m
    );
    expect(CODE).toContain("IF md5(def)<>'ea07d6fa0e981ae635e6c5a6f8aeb067' THEN RAISE EXCEPTION");
    expect(CODE).toContain(
      "IF md5(pg_get_functiondef(sig))<>'e51decda42bbe46dd90aaf1bd3119023' THEN RAISE EXCEPTION"
    );
    expect(CODE).toContain('escrow_touch_shape_security_refused');
  });

  it('compares the touch with the compact form the touch was written in, and nothing else changes', () => {
    const before = SQL.split('o text:=$anchor$')[1].split('$anchor$;')[0];
    const after = SQL.split('n text:=$anchor$')[1].split('$anchor$;')[0];
    expect(before).toBe("  OR o.evidence->'participants' IS DISTINCT FROM h.participants THEN");
    expect(after).toBe(
      "  OR public.fn_union_pnl_compact_participants(o.evidence->'participants') IS DISTINCT FROM h.participants THEN"
    );
  });

  it('writes no row, certificate or money', () => {
    expect(CODE).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });
});

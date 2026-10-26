/**
 * A LIGHTNING HAND EARNS FOR THE CLUB THAT FUNDED THE CHAIR (2026-10-25).
 *
 * Since 2026-10-23 22:49:44 UTC every Midway Lightning hand credited each
 * player's rake to the HOST club, Midway Union, because the Lightning branch
 * of fn_cash_earning_club returned cash_player_session.club_id, and
 * fn_cash_session_open stamps that column with the TABLE's club. The buy-in
 * (atomic_table_buyin) debits club_members.chip_balance in v_seat_club, the
 * member club it also writes to table_seats.club_id and to the immutable
 * cash_participant_funding_receipts row. With players drawn from Deep Stack,
 * Felt, KINGS..., the settler's fn_accounting_terms_at('club_members',
 * '<Midway Union>:<player>') refused ~61.7k rake records with
 * accounting_terms_not_observed.
 *
 * The law: the Lightning branch reads the funding chair first (the original
 * pool session's anchor seat, then that seat's buy-in receipt), keeps the
 * unchanged union validation, and falls back to the session reader only when
 * no unambiguous funding chair exists. Classic branches are untouched.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const migrationNamed = (slug: string): string => {
  const hit = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(`_${slug}.sql`))
    .sort();
  expect(hit.length, `exactly one migration should carry the slug ${slug}`).toBe(1);
  return fs.readFileSync(path.join(MIGRATIONS, hit[0]), 'utf8');
};

const SQL = migrationNamed('lightning_earning_club_is_the_funding_chair_club');
const PRIOR = migrationNamed('lightning_rake_uses_original_pool_funding');

/** The edit list spliced into fn_cash_earning_club: anchor n -> replacement n. */
const edit = (n: number): { anchor: string; replacement: string } => {
  const a = new RegExp(`\\$a${n}\\$([\\s\\S]*?)\\$a${n}\\$`).exec(SQL);
  const r = new RegExp(`\\$r${n}\\$([\\s\\S]*?)\\$r${n}\\$`).exec(SQL);
  expect(a, `edit ${n} has an anchor`).not.toBeNull();
  expect(r, `edit ${n} has a replacement`).not.toBeNull();
  return { anchor: a![1], replacement: r![1] };
};
const R = [1, 2, 3, 4].map((n) => edit(n).replacement).join('\n');

describe('the migration is one guarded transaction', () => {
  it('is a single BEGIN/COMMIT with a short lock_timeout', () => {
    expect(SQL.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(SQL).toMatch(/SET LOCAL lock_timeout = '3s';/);
    expect(SQL).not.toMatch(/ca\.break_window_migration_override/);
  });

  it('asserts the exact pre-image of fn_cash_earning_club before replacing it', () => {
    expect(SQL).toContain("md5(source) <> '552fe80a7fb04e1c76088a4c9de26eb5'");
  });

  it('asserts the readback and the post-image md5 it was proven with', () => {
    expect(SQL).toContain('readback mismatch');
    const post = /md5\(patched\) <> '([0-9a-f]{32})'/.exec(SQL);
    expect(post).not.toBeNull();
    // The migration is the byte-exact recording of what production ran
    // (scripts/ci/recorded-migrations.manifest.json), so its post-image is
    // pinned here and in the manifest's production readback, not in a header.
    expect(post![1]).toBe('b1c21e14021e0e2e7bba28048dcec90e');
    expect(fs.readFileSync('scripts/ci/recorded-migrations.manifest.json', 'utf8')).toContain(
      `fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid) reads definition md5 ${post![1]}`
    );
  });

  it('replaces no other function and writes no row', () => {
    expect(SQL).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
    expect(SQL.match(/EXECUTE patched;/g)?.length).toBe(1);
    expect(SQL.match(/pg_get_functiondef\('public\.([a-z_]+)\(/g)?.every((m) => m.includes('fn_cash_earning_club'))).toBe(true);
    expect(SQL).not.toMatch(/^\s*(UPDATE|INSERT INTO|DELETE FROM)\s+public\./im);
    expect(SQL).not.toMatch(/ALTER TABLE|LOCK TABLE/i);
  });
});

describe('the edits land only inside the Lightning branch', () => {
  it('has exactly four edits, each refused unless its anchor is unique', () => {
    expect(SQL).toContain("RAISE EXCEPTION 'fn_cash_earning_club anchor % is not unique', edit.n;");
    expect(/\$a5\$/.test(SQL)).toBe(false);
  });

  it('anchors on text the Lightning branch introduced (20261018135018)', () => {
    for (const n of [2, 3, 4]) {
      expect(PRIOR, `edit ${n} anchor`).toContain(edit(n).anchor.trimEnd());
    }
    expect(edit(2).anchor).toBe('  SELECT array_agg(DISTINCT cs.club_id) INTO clubs\n');
  });

  it('every replacement keeps its anchor text, so the original reader survives intact', () => {
    expect(edit(1).replacement.startsWith('DECLARE started timestamptz;clubs uuid[];')).toBe(true);
    expect(edit(2).replacement).toContain('array_agg(DISTINCT cs.club_id)');
    for (const n of [3, 4]) {
      const { anchor, replacement } = edit(n);
      const first = anchor.split('\n')[0];
      const last = anchor.trimEnd().split('\n').pop()!;
      expect(replacement.startsWith(first)).toBe(true);
      expect(replacement.trimEnd().endsWith(last)).toBe(true);
    }
  });
});

describe('the earning club is the funding chair club', () => {
  it('reads the anchor chair of the original pool session, same player, live at the hand start', () => {
    expect(R).toContain('LEFT JOIN public.table_seats s ON s.id=ps.anchor_seat_id AND s.user_id=hp.player_id');
    expect(R).toContain('s.joined_at<=started AND (s.left_at IS NULL OR s.left_at>started)');
    expect(R).toContain('array_agg(DISTINCT s.club_id) FILTER (WHERE s.club_id IS NOT NULL)');
  });

  it("falls back to that chair's immutable buy-in funding receipt, through its indexed columns", () => {
    expect(R).toContain('FROM public.cash_participant_funding_receipts f');
    expect(R).toContain("f.operation_kind='buyin' AND f.table_id=cs.table_id AND f.account_entity_id=hp.player_id");
    expect(R).toContain('f.user_id=hp.player_id AND f.seat_id=ps.anchor_seat_id');
    expect(R).toContain('f.seat_joined_at<=ps.entered_at AND f.recorded_at<=started');
  });

  it('decides chair first, receipt only when no chair, and never weakens validation', () => {
    const v = (x: string) =>
      `EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=${x}[1]\n    AND (c.is_union IS NOT TRUE OR (p_union_id IS NOT NULL AND (c.id=p_union_id OR c.union_id=p_union_id))))`;
    expect(R).toContain(`IF cardinality(chair)=1\n   AND ${v('chair')}\n  THEN RETURN chair[1]; END IF;`);
    expect(R).toContain(`IF chair IS NULL AND cardinality(paid)=1\n   AND ${v('paid')}\n  THEN RETURN paid[1]; END IF;`);
    expect(R.indexOf('RETURN chair[1]')).toBeLessThan(R.indexOf('RETURN paid[1]'));
  });

  it('then re-enters the unchanged session reader, so nothing that banked today starts raising', () => {
    expect(edit(4).replacement.trimEnd().endsWith('IF cardinality(clubs)=1 AND clubs[1] IS NOT NULL')).toBe(true);
    expect(R).not.toContain('cash_earning_seat_provenance_missing_or_ambiguous');
  });

  it('never reads current membership, the table club or horse status to decide the earner', () => {
    expect(R).not.toMatch(/club_members/);
    expect(R).not.toMatch(/public\.tables\b/);
    expect(R).not.toMatch(/is_horse/);
  });
});

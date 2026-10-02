/**
 * THE LAST STRANDED TRANSFERS OF THE 09-26 COLLAPSE COMPLETE (2026-09-28)
 *
 * Two events frozen by the 2026-09-26 09:33 UTC lease collapse were still held
 * by a mixed custody transfer no door could finish:
 *
 *   21f9013b - admitted transfer; completion refused
 *     F06_MIXED_PRESENCE_ARRIVAL_UNPROVEN for a roster player who busted in the
 *     last committed hand (0 chips, no live chair, no move receipt).
 *   a3a95a1b - never-admitted transfer; the stranded void refused
 *     F06_STRANDED_ORIGINALS_CHANGED because one of its three originals had
 *     already been accepted by the origin after the transfer was prepared.
 *
 * Both new bodies were run in one rolled-back psql transaction against
 * production (pg_temp helpers, the live completion re-pointed at the new
 * presence body): 21f9013b completes with 2430ef3a refused alone; a3a95a1b is
 * voided (2 hands, credit 0), its snapshot has no pending original, and the
 * presence adoption it then reaches refuses 619d99fd alone. This law pins the
 * reviewed source so that exact behaviour is what production installs.
 *
 * docs/changelog/2026-09-28-the-last-stranded-transfers-of-the-0926-collapse-complete.md
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '..', 'supabase', 'migrations');
const SQL = readFileSync(
  join(DIR, '20260928041447_the_last_stranded_transfers_of_the_0926_collapse_complete.sql'),
  'utf8'
);
const PRESENCE_PRIOR = readFileSync(
  join(DIR, '20260928000415_f06_mixed_presence_refuses_one_player_not_the_event.sql'),
  'utf8'
);
const VOID_PRIOR = readFileSync(
  join(DIR, '20260927145449_a_stranded_mixed_original_hand_is_voided_with_every_stack_un.sql'),
  'utf8'
);
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(sql: string, signature: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${signature}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  // Each migration picks its own dollar-quote tag; read the one this body uses.
  const tag = /AS (\$\w*\$)/.exec(sql.slice(start));
  expect(tag).not.toBeNull();
  const open = start + tag!.index + tag![0].length;
  const close = sql.indexOf(tag![1], open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

const PRESENCE = body(SQL, 'smarter_private.f06_mixed_adopt_presence');
const VOID = body(SQL, 'public.fn_f06_void_stranded_mixed_original');
const PRESENCE_BEFORE = body(PRESENCE_PRIOR, 'smarter_private.f06_mixed_adopt_presence');
const VOID_BEFORE = body(VOID_PRIOR, 'public.fn_f06_void_stranded_mixed_original');

describe('the last stranded transfers of the 09-26 collapse complete', () => {
  it('replaces exactly the live pre-images and installs exactly the probed bodies', () => {
    expect(md5(PRESENCE_BEFORE)).toBe('358cdd737ec6dcaeb27fdfa52de48b55');
    expect(md5(VOID_BEFORE)).toBe('618d61ed59a8aef999767c802469949f');
    expect(md5(PRESENCE)).toBe('e6a9689efa793b4665c5d819ccf2c403');
    expect(md5(VOID)).toBe('92466252b142a745157d2ba69c1aa35b');
    for (const pin of [
      "md5(p.prosrc) = '358cdd737ec6dcaeb27fdfa52de48b55'",
      "md5(p.prosrc) = '618d61ed59a8aef999767c802469949f'",
      "md5(p.prosrc) = 'e6a9689efa793b4665c5d819ccf2c403'",
      "md5(p.prosrc) = '92466252b142a745157d2ba69c1aa35b'",
      // The readers the two bodies write for, as probed.
      "'5422e7f73fdbdd34bf73d46e514e844e'",
      "'aeaabb44975b8d138ed447687b0aea22'",
      "'43aa14703d4d8f37a95f7adf6c6ed5c1'",
      "'0d43159f7518f27aa381b3e905508d84'",
    ])
      expect(SQL).toContain(pin);
  });

  it('is one transaction with a lock timeout, and grants nothing to anybody', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toMatch(/SET LOCAL lock_timeout = '2s';/);
    expect(SQL).not.toMatch(/\bGRANT\b/);
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_f06_void_stranded_mixed_original\(uuid\)\s+FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(SQL.match(/p\.proacl::text = '\{postgres=X\/postgres\}'/g)?.length).toBe(4);
    expect(SQL).toContain(
      "has_function_privilege('service_role', 'public.fn_f06_void_stranded_mixed_original(uuid)', 'EXECUTE')"
    );
  });

  it('presence: only a roster player who holds nothing is refused alone, before the arrival refusal', () => {
    // The whole change is one inserted branch; everything else is byte-identical.
    const arrival = " IF n<>1 THEN RAISE EXCEPTION 'F06_MIXED_PRESENCE_ARRIVAL_UNPROVEN'; END IF;\n";
    const at = PRESENCE.indexOf(arrival);
    const branch = PRESENCE.lastIndexOf(' -- A roster player whose chair has emptied', at);
    expect(at).toBeGreaterThan(0);
    expect(branch).toBeGreaterThan(0);
    expect(PRESENCE.slice(0, branch) + PRESENCE.slice(at)).toBe(PRESENCE_BEFORE);
    const inserted = PRESENCE.slice(branch, at);
    // n here is the count of winning move receipts: no arrival anywhere.
    expect(inserted).toContain('tp.chips=0');
    expect(inserted).toContain('(b.left_at IS NULL OR b.stack IS DISTINCT FROM 0)');
    expect(inserted).toContain("'adopted',false,'refused','f06_mixed_presence_holds_nothing'");
    expect(inserted).toContain('CONTINUE;');
    // Nothing is written for that player: no seat, registration or presence row.
    expect(inserted).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    // Every other refusal is still there.
    for (const refusal of [
      'F06_MIXED_PRESENCE_ORIGINAL_UNPROVEN',
      'F06_MIXED_PRESENCE_ARRIVAL_UNPROVEN',
      'F06_MIXED_PRESENCE_DESTINATION_UNPROVEN',
      'F06_MIXED_PRESENCE_TIME_UNPROVEN',
      'F06_MIXED_PRESENCE_CONFLICT',
      'F06_HISTORICAL_LOSS_DESTINATION_CUSTODY_MISSING',
    ])
      expect(PRESENCE).toContain(refusal);
  });

  it('void: reserved hands are a subset of the originals, and every other original committed', () => {
    expect(VOID).not.toContain('reserved_ids IS DISTINCT FROM original_ids');
    expect(VOID).toContain('NOT (reserved_ids <@ original_ids)');
    expect(VOID).toMatch(/o\.state = 'accepted' AND o\.tournament_id = t\s+AND o\.generation = xfer\.origin_generation/);
    expect(VOID).toContain('a.hand_id = o.evidence_id');
    expect(VOID).toContain('a.post_commit_completed_at IS NOT NULL');
    // The function's own post-image asserts the abort receipt for the voided hands.
    expect(VOID).toMatch(/WHERE o\.permit_id = ANY \(reserved_ids\)\s+AND NOT EXISTS \(/);
    // Unchanged: credit 0, byte-identical chairs and registrations, every refusal.
    expect(VOID).toContain("'credit', 0");
    expect(VOID).toContain('v_after IS DISTINCT FROM v_before');
    for (const refusal of [
      'F06_STRANDED_TRANSFER_REQUIRED',
      'F06_STRANDED_TRANSFER_ADMITTED',
      'F06_STRANDED_EVENT_OWNED',
      'F06_STRANDED_PARK_OPEN',
      'F06_STRANDED_ROSTER_CHANGED',
      'F06_ABORT_SAVED_STACKS_CHANGED',
      'F06_STRANDED_CARDS_CHANGED',
      'F06_STRANDED_POSTIMAGE_CHANGED',
    ])
      expect(VOID).toContain(refusal);
  });

  it('settles one event through the door and asserts nothing moved', () => {
    const settle = SQL.slice(SQL.indexOf('DO $void$'));
    expect(settle).toContain("'a3a95a1b-ad40-40f8-ba44-188f17e72402'");
    expect(settle).toContain('public.fn_f06_void_stranded_mixed_original(t)');
    expect(settle).toContain("(r->>'credit')::numeric <> 0");
    expect(settle).toContain('v_chips_after IS DISTINCT FROM v_chips_before');
    expect(settle).toContain('v_ledger_after IS DISTINCT FROM v_ledger_before');
    expect(settle).toContain("'pending_original_tables'");
    // No hand-written money or seat row anywhere in the migration.
    expect(SQL).not.toMatch(/INSERT INTO public\.chip_ledger/i);
    expect(SQL).not.toMatch(/(UPDATE|DELETE FROM) public\.(table_seats|tournament_players|club_members)/i);
  });
});

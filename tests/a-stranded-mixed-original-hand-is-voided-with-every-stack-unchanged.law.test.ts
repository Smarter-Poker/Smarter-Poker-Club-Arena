/**
 * A STRANDED MIXED ORIGINAL HAND IS VOIDED, WITH EVERY STACK UNCHANGED (2026-09-27)
 *
 * 71 RUNNING events (23ef2d58 among them) have held no lease since the
 * 2026-09-26 09:33 UTC collapse: each has one open mixed custody transfer
 * whose successor can only be admitted once every original hand has a
 * terminal disposition, and only the dead origin could give one. The reviewed
 * void writes the receipt the successor's admission already reads
 * (f06_mixed_custody_snapshot's aborted_unsettled evidence), after proving
 * from rows that every chair already holds its pre-deal stack.
 *
 * Behaviour was run in a local PostgreSQL 17 against rows exported from
 * production (23ef2d58 heads-up, 4e2de62d four tables): both voided, replay
 * returns the stored outcome, a lease or a moved chip refuses. This law pins
 * the reviewed source so that exact behaviour is what production installs.
 *
 * docs/changelog/2026-09-27-stranded-f06-doors.md
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20260927145449_a_stranded_mixed_original_hand_is_voided_with_every_stack_un.sql'
  ),
  'utf8'
);
const VOID_MD5 = '49f45101006d8b94d192ac826ad7327f';
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(sql: string): string {
  const start = sql.indexOf(
    'CREATE OR REPLACE FUNCTION public.fn_f06_void_stranded_mixed_original('
  );
  expect(start).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$function$', start) + '$function$'.length;
  const close = sql.indexOf('$function$', open);
  return sql.slice(open, close);
}
const VOID = body(SQL);

describe('a stranded mixed original hand is voided with every stack unchanged', () => {
  it('installs exactly the reviewed body, owned by postgres and callable by nobody else', () => {
    expect(md5(VOID)).toBe(VOID_MD5);
    expect(SQL).toContain(`md5(p.prosrc) = '${VOID_MD5}'`);
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_f06_void_stranded_mixed_original\(uuid\)\s+FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(SQL).not.toMatch(/GRANT [^;]*fn_f06_void_stranded_mixed_original/);
    expect(SQL).toContain("p.proacl::text = '{postgres=X/postgres}'");
  });

  it('pins the evidence reader and admission it writes for', () => {
    for (const pin of [
      '5422e7f73fdbdd34bf73d46e514e844e', // f06_mixed_custody_snapshot
      'aeaabb44975b8d138ed447687b0aea22', // fn_f06_admit_mixed_manager_custody
      '76f64dfc5436d6208c6afbed3ad7da53', // f06_generation_aborted
      '31329a1df4bec9c92e0517b38fd42b93', // f06_immutable_identity
    ])
      expect(SQL).toContain(pin);
  });

  it('moves no chip, registration, ledger row or wallet', () => {
    expect(VOID).not.toMatch(
      /UPDATE public\.(table_seats|tournament_players|tournaments|tables)\b/
    );
    expect(VOID).not.toMatch(
      /INSERT INTO public\.(chip_ledger|wallet_transactions|tournament_payouts|tournament_escrow)\b/
    );
    expect(VOID).toContain("'credit', 0");
    // Chairs and registrations are compared before and after.
    expect(VOID).toContain('IF v_after IS DISTINCT FROM v_before');
  });

  it('proves the pre-deal stacks from rows before it writes', () => {
    expect(VOID).toContain("= (x->>'stack')::numeric + (x->>'totalInvested')::numeric)");
    expect(VOID).toContain("RAISE EXCEPTION 'F06_ABORT_SAVED_STACKS_CHANGED'");
    expect(VOID).toContain("RAISE EXCEPTION 'F06_ABORT_COMMITTED_OR_DISPATCHED'");
    expect(VOID).toContain("RAISE EXCEPTION 'F06_STRANDED_EVENT_OWNED' USING ERRCODE = '40001'");
    expect(VOID).toContain("RAISE EXCEPTION 'F06_STRANDED_TRANSFER_ADMITTED'");
    expect(VOID).toContain("RAISE EXCEPTION 'F06_STRANDED_PARK_OPEN'");
  });

  it('disposes the origin generation only, so the successor stays claimable', () => {
    expect(VOID).toMatch(
      /INSERT INTO smarter_private\.f06_mixed_abort_generations \(tournament_id, generation, receipt_id\)\s+VALUES \(t, xfer\.origin_generation, v_receipt\);/
    );
    expect(VOID).not.toMatch(/f06_mixed_abort_generations[^;]*successor_generation/);
    expect(VOID).toContain(
      'OR smarter_private.f06_generation_aborted(t, xfer.successor_generation)'
    );
    // The hand receipt carries the reserved permit image the reader compares.
    expect(VOID).toContain("'permit', to_jsonb(h)");
  });

  it('takes locks only by trying, and a busy event is deferred, never waited for', () => {
    expect(VOID).toContain('PERFORM smarter_private.f06_try_lane(t);');
    expect(VOID).not.toMatch(/pg_advisory_xact_lock\(/);
    expect(SQL).toContain('WHEN serialization_failure OR lock_not_available THEN');
    expect(SQL).toContain("interval '4 seconds'");
  });
});

/**
 * A HAND A CASH TABLE HAS DEALT PAST IS DISPOSED AT ITS RESUME DOOR (2026-09-29)
 *
 * fn_ca_resume_hand_submission reads a table's lowest unfinished retained
 * request at every start. A request below a hand the table already committed
 * can never be applied (the later hand consumed the stacks it names), so the
 * handoff refused it at every start for ever, and the only way out was an
 * operator batch (fn_ca_dispose_superseded_hand_submissions). Migration
 * 20260929031904 decides it in the live path: the door, under its proven cash
 * lease and locks, writes the receipted zero-credit disposal through
 * smarter_private.hand_submission_dispose_dealt_past and reads the next
 * request.
 *
 * These laws pin the file: the exact pre-image (the door as 20260929022629
 * installed it) and post-image, the single anchored edit, a helper that proves
 * what the operator door proves and writes nothing but the receipt, the
 * untouched money path, and the retirement of 20260929023040, which pinned
 * the door's older body and can never apply. The engine half is pinned by
 * server/src/engine/aStandingRetainedHandRefusalHoldsTheTable.law.test.ts.
 *
 * docs/changelog/2026-09-29-a-retained-hand-is-handed-off-wherever-its-table-still-deals.md
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const FILE = readFileSync(
  join(MIGRATIONS, '20260929031904_a_hand_a_cash_table_dealt_past_is_disposed_at_its_resume_doo.sql'),
  'utf8'
);

/** prosrc of the live door on 2026-09-29 03:19 UTC, as 20260929022629 installed it. */
const PRE_MD5 = '1949cf2d020c48dd1a64c2bfdee433d8';
/** Its body after exactly the one edit below, computed from that live prosrc. */
const POST_MD5 = '4cc9df92758a39ed78ce6ade1e26849c';

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function edits(): Array<{ name: string; old: string; next: string }> {
  const block = FILE.slice(FILE.indexOf('DO $retained_patch$'), FILE.indexOf('$retained_patch$;'));
  const out: Array<{ name: string; old: string; next: string }> = [];
  const re = /-- (\w+)\n {2}v_old := \$a\$([\s\S]*?)\$a\$;\n {2}v_new := \$b\$([\s\S]*?)\$b\$;/g;
  for (let m = re.exec(block); m; m = re.exec(block))
    out.push({ name: m[1], old: m[2], next: m[3] });
  return out;
}

function helperBody(): string {
  const start = FILE.indexOf(
    'CREATE OR REPLACE FUNCTION smarter_private.hand_submission_dispose_dealt_past('
  );
  const open = FILE.indexOf('AS $function$', start) + 'AS $function$'.length;
  const close = FILE.indexOf('$function$', open);
  return FILE.slice(open, close);
}

describe('the migration asserts exactly what it replaces', () => {
  it('is one transaction with a lock timeout', () => {
    expect(FILE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(FILE.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(FILE).toContain("SET LOCAL lock_timeout = '2s';");
  });

  it('refuses unless the live door is the exact pre-image, and proves the post-image', () => {
    expect(FILE).toContain(`AND md5(p.prosrc) = '${PRE_MD5}'`);
    expect(FILE).toContain(`AND md5(pg_get_functiondef(p.oid)) = 'eb795bb2248234e90c8b1a5e646354b5'`);
    expect(FILE).toContain(`AND md5(p.prosrc) = '${POST_MD5}'`);
    expect(FILE).toContain(
      "AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'"
    );
    expect(FILE).toContain(`@live-proof: (SELECT md5(prosrc)='${POST_MD5}'`);
  });

  it('applies one anchored edit, required to occur exactly once', () => {
    expect(edits().map((x) => x.name)).toEqual(['disposal']);
    expect(FILE.match(/IF n <> 1 THEN/g)).toHaveLength(1);
  });

  it('pins the helper body and a private ACL', () => {
    expect(FILE).toContain(`AND md5(p.prosrc) = '${md5(helperBody())}'`);
    expect(FILE).toContain("AND p.proacl::text = '{postgres=X/postgres}'");
    expect(FILE).toContain('FROM PUBLIC, anon, authenticated, service_role;');
  });
});

describe('disposal: a hand the cash table has dealt past is decided at the door', () => {
  const e = () => edits()[0];

  it('runs after the lease proof, only for a cash table below a committed hand, and reads the next request', () => {
    const { old, next } = e();
    expect(old).toContain("'HAND_SUBMISSION_SCOPE_CHANGED'");
    expect(next.startsWith(old)).toBe(true);
    expect(next).toContain('IF tour IS NULL AND EXISTS(SELECT 1 FROM public.hand_atomic_commits');
    expect(next).toContain('WHERE table_id=p_table_id AND hand_number>s.hand_number)');
    expect(next).toContain(
      'smarter_private.hand_submission_dispose_dealt_past(p_table_id,s.hand_number)>0 THEN'
    );
    expect(next).toContain(
      'AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals dd'
    );
    expect(next).toContain("IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;");
    expect(next).toContain(
      "PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||s.table_id::text||':'||s.hand_number::text,0));"
    );
  });

  it('the helper proves what the operator door proves and writes only the receipt', () => {
    const body = helperBody();
    for (const proof of [
      'NOT EXISTS (SELECT 1 FROM public.hand_atomic_commits a',
      'NOT EXISTS (SELECT 1 FROM public.hand_history hh',
      'NOT EXISTS (SELECT 1 FROM smarter_private.hand_submission_disposals dd',
      'NOT EXISTS (SELECT 1 FROM smarter_private.hand_submission_handoffs h',
      'NOT EXISTS (SELECT 1 FROM smarter_private.hand_submission_dispatch d',
      "AND p.state IN ('reserved', 'accepted'))",
      'NOT EXISTS (SELECT 1 FROM public.engine_table_leases l',
      "s.retained_at < clock_timestamp() - interval '30 minutes'",
      'AND s.hand_number < v_witness',
      'tournament_id IS NULL',
      'public.fn_platform_frozen()',
      "pg_try_advisory_xact_lock(hashtextextended('hand:disposal:'",
    ])
      expect(body, proof).toContain(proof);
    const writes = body.match(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+[\w.]+/g) ?? [];
    expect(writes).toEqual(['INSERT INTO smarter_private.hand_submission_disposals']);
  });

  it('the money path is untouched', () => {
    const { old, next } = e();
    for (const text of [old, next]) {
      expect(text).not.toContain('fn_ca_commit_hand_settlement');
      expect(text).not.toContain('hand_submission_handoffs(');
    }
    expect(FILE).not.toMatch(
      /UPDATE public\.table_seats|INSERT INTO public\.(chip_ledger|club_members)/
    );
  });
});

describe('the migration that could never apply stays retired', () => {
  it('20260929023040 pinned the pre-22629 door (32cfcc98) and is deleted', () => {
    expect(
      existsSync(
        join(
          MIGRATIONS,
          '20260929023040_a_retained_hand_is_handed_off_wherever_its_table_still_deals.sql'
        )
      )
    ).toBe(false);
    expect(
      existsSync(
        join(
          MIGRATIONS,
          '20260929022629_a_retained_hand_settles_past_an_undealt_chair_and_on_a_closi.sql'
        )
      )
    ).toBe(true);
  });
});

/**
 * A RETAINED HAND IS HANDED OFF WHEREVER ITS TABLE STILL DEALS (2026-09-29)
 *
 * public.fn_ca_resume_hand_submission refused two finished cash hands whose
 * chairs still held exactly the before-stacks the retained request names, and
 * the engine rebuilt both tables every ~5.6 s into the same refusal:
 *   - 499aa67a (hand 16812749): the table was `lifecycle='breaking'`, and the
 *     door admitted a cash table only while 'live', though a breaking table
 *     still deals and its original settles through a commit door that reads no
 *     lifecycle;
 *   - 6c9ee4b6 (hand 13637742, six days frozen): two chairs that sat down
 *     before the deal but were not dealt in were refused by join time, though
 *     the hand's own players roster says who was dealt.
 *
 * Migration 20260929023040 edits the live door in three anchored places and
 * adds the cash-only disposal the door calls for a hand the table has already
 * dealt past. These laws pin the file: the exact pre-image and post-image it
 * asserts, each anchor and its replacement, the unchanged money path, and a
 * disposal helper that moves no chip and proves what the operator door
 * proves. The engine half is pinned by
 * server/src/engine/aStandingRetainedHandRefusalHoldsTheTable.law.test.ts.
 *
 * docs/changelog/2026-09-29-a-retained-hand-is-handed-off-wherever-its-table-still-deals.md
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FILE = readFileSync(
  join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20260929023040_a_retained_hand_is_handed_off_wherever_its_table_still_deals.sql'
  ),
  'utf8'
);

/** prosrc of the live door on 2026-09-29 02:30 UTC (20260926091630 + 20260928001934). */
const PRE_MD5 = '32cfcc987acdab387067f80ec3704c9b';
/** Its body after exactly the three edits below, computed from the live prosrc. */
const POST_MD5 = 'e0046c683aa98538158ecde30fc52039';

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

/** Every v_old/v_new pair the patch block applies, in order. */
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

describe('the migration asserts exactly what it replaces and what it leaves', () => {
  it('is one transaction with a lock timeout', () => {
    expect(FILE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(FILE.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(FILE).toContain("SET LOCAL lock_timeout = '2s';");
  });

  it('refuses unless the live door is the exact pre-image, and proves the post-image', () => {
    expect(FILE).toContain(`AND md5(p.prosrc) = '${PRE_MD5}'`);
    expect(FILE).toContain(`AND md5(p.prosrc) = '${POST_MD5}'`);
    expect(FILE).toContain("AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'");
    expect(FILE).toContain("AND p.proconfig = ARRAY['search_path=pg_catalog, public']");
    expect(FILE).toContain(`@live-proof: (SELECT md5(prosrc)='${POST_MD5}'`);
  });

  it('applies three anchored edits, each required to occur exactly once', () => {
    const e = edits();
    expect(e.map((x) => x.name)).toEqual(['disposal', 'admission', 'dealt_roster']);
    expect(FILE.match(/IF n <> 1 THEN/g)).toHaveLength(3);
    // Each replacement keeps nothing of the refusal it removes except where stated.
    for (const x of e) expect(x.next).not.toBe(x.old);
  });

  it('pins the helper body it installs', () => {
    expect(FILE).toContain(`AND md5(p.prosrc) = '${md5(helperBody())}'`);
    expect(FILE).toContain("AND p.proacl::text = '{postgres=X/postgres}'");
  });
});

describe('admission: a cash table is admitted wherever it deals', () => {
  const e = () => edits().find((x) => x.name === 'admission')!;

  it('the old rule admitted a cash table only while live', () => {
    expect(e().old).toContain(
      "AND (lifecycle='live' OR (tour IS NOT NULL AND lifecycle IS NULL)))"
    );
  });

  it("the new rule admits every cash lifecycle but 'closed' and leaves tournaments unchanged", () => {
    const next = e().next;
    expect(next).toContain("AND (CASE WHEN tour IS NULL THEN lifecycle IS DISTINCT FROM 'closed'");
    expect(next).toContain('ELSE lifecycle IS NULL END))');
    expect(next).toContain('AND NOT COALESCE(is_deleted,false)');
    expect(next).toContain("lower(status) IN ('waiting','running')");
  });
});

describe('dealt_roster: who was dealt in is read from the hand', () => {
  const e = () => edits().find((x) => x.name === 'dealt_roster')!;

  it('no chair is refused by the time it sat down', () => {
    expect(e().old).toContain("late.joined_at<=(q->'p_hand_row'->>'started_at')::timestamptz");
    expect(e().next).not.toContain('joined_at');
  });

  it("the hand's players roster must be exactly its stack rows", () => {
    const next = e().next;
    expect(next).toContain("OR jsonb_typeof(q->'p_hand_row'->'players') IS DISTINCT FROM 'array'");
    expect(next).toContain("array_agg(DISTINCT x->>'userId' ORDER BY x->>'userId')");
    expect(next).toContain(
      "IS DISTINCT FROM (SELECT array_agg(DISTINCT x->>'user_id' ORDER BY x->>'user_id') FROM jsonb_array_elements(q->'p_stacks') x)"
    );
  });

  it('a hand player seated twice, or a chair in a dealt seat, still refuses', () => {
    const next = e().next;
    expect(next).toContain(
      "AND (late.user_id IN (SELECT (x->>'user_id')::uuid FROM jsonb_array_elements(q->'p_stacks') x)"
    );
    expect(next).toContain(
      "OR late.seat_number::text IN (SELECT x->>'seat' FROM jsonb_array_elements("
    );
  });
});

describe('disposal: a hand the cash table has dealt past is decided at the door', () => {
  const e = () => edits().find((x) => x.name === 'disposal')!;

  it('runs only for a cash table, after the lease proof, and reads the next request', () => {
    const { old, next } = e();
    expect(old).toContain("'HAND_SUBMISSION_SCOPE_CHANGED'");
    expect(next.startsWith(old)).toBe(true);
    expect(next).toContain('IF tour IS NULL AND EXISTS(SELECT 1 FROM public.hand_atomic_commits');
    expect(next).toContain(
      'smarter_private.hand_submission_dispose_dealt_past(p_table_id,s.hand_number)>0 THEN'
    );
    expect(next).toContain("IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;");
    // The next request's own settlement lock, as for the first.
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
    ])
      expect(body, proof).toContain(proof);
    const writes = body.match(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+[\w.]+/g) ?? [];
    expect(writes).toEqual(['INSERT INTO smarter_private.hand_submission_disposals']);
  });
});

describe('the money path is untouched', () => {
  it('no edit touches the commit, the one-time claim or a chip', () => {
    for (const { old, next } of edits()) {
      for (const text of [old, next]) {
        expect(text).not.toContain('fn_ca_commit_hand_settlement');
        expect(text).not.toContain('hand_submission_handoffs(');
        expect(text).not.toMatch(
          /UPDATE public\.table_seats|INSERT INTO public\.(chip_ledger|club_members)/
        );
      }
    }
    expect(FILE).not.toMatch(
      /UPDATE public\.table_seats|INSERT INTO public\.(chip_ledger|club_members)/
    );
  });
});

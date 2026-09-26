/**
 * A RETAINED HAND COMMITS PAST A SEAT TAKEN AFTER ITS DEAL (2026-09-26)
 *
 * public.fn_ca_resume_hand_submission lets the CURRENT lease holder commit a
 * dead generation's retained settlement request exactly as retained, once,
 * through fn_ca_commit_hand_settlement. It refused event 8ec7e81d's finished
 * hand 12976717 for eight days because it required the table's live chair
 * count to EQUAL the hand's stack count, and a late registrant had been
 * seated 53 s after the deal. That chair was never in the hand; the hand
 * cannot move its chips.
 *
 * These laws pin the replacement exactly: an extra live chair is admitted
 * only when it joined after the hand's recorded start and its player is not
 * a hand player; every hand chair must still be live with the same player,
 * joined_at and pre-hand stack; later commits, history and permits still
 * refuse; the commit is still the platform's own core with the retained
 * request, under the one-time handoff claim.
 *
 * 20260926091630. docs/changelog/2026-09-26-a-retained-hand-commits-past-a-seat-taken-after-its-deal.md
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
    '20260926091630_a_retained_hand_commits_past_a_seat_taken_after_its_deal.sql'
  ),
  'utf8'
);

/** prosrc of the successor handoff installed by 20260922022319, read from production. */
const PRE_MD5 = '1aa58a5d89009ae97ddb2e18462a7ec3';

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');
const code = (s: string) =>
  s
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n');

function body(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_resume_hand_submission');
  expect(start, 'the file defines the door').toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$function$', start) + '$function$'.length;
  const close = sql.indexOf('$function$', open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

const COMMENT_BEFORE = `  -- The original exact generations and before-stacks must still occupy the
  -- whole table. No later hand/permit may have consumed this starting state.
`;
const OLD_CLAUSE =
  "   (SELECT count(*) FROM public.table_seats WHERE table_id=s.table_id AND left_at IS NULL)<>jsonb_array_length(q->'p_stacks')\n";

function violations(src: string): string[] {
  const v: string[] = [];
  const c = code(src);
  const handoff = c.slice(
    c.indexOf('q:=s.request;'),
    c.indexOf('HAND_SUBMISSION_HANDOFF_STATE_CHANGED')
  );
  if (!handoff) return ['the handoff has no state proof'];
  if (handoff.includes(OLD_CLAUSE.trim()))
    v.push('a chair taken after the deal holds a finished hand hostage');
  if (!handoff.includes("(q->'p_hand_row'->>'started_at') IS NULL"))
    v.push('a hand with no recorded start can be handed off past an extra chair');
  if (
    !/EXISTS\(SELECT 1 FROM public\.table_seats late WHERE late\.table_id=s\.table_id AND late\.left_at IS NULL\s+AND NOT EXISTS\(SELECT 1 FROM jsonb_array_elements\(q->'p_stacks'\) x WHERE \(x->>'seat_id'\)::uuid=late\.id\)/.test(
      handoff
    )
  )
    v.push('an extra live chair is not identified against the hand chairs');
  if (!handoff.includes("late.joined_at<=(q->'p_hand_row'->>'started_at')::timestamptz"))
    v.push('a chair present at the deal but missing from the hand is admitted');
  if (
    !handoff.includes(
      "late.user_id IN (SELECT (x->>'user_id')::uuid FROM jsonb_array_elements(q->'p_stacks') x)"
    )
  )
    v.push('a hand player seated twice is admitted');
  if (
    !/seat\.user_id=\(x->>'user_id'\)::uuid AND seat\.joined_at=\(x->>'seat_joined_at'\)::timestamptz\s+AND seat\.left_at IS NULL AND seat\.stack=\(x->>'stack_before'\)::numeric/.test(
      handoff
    )
  )
    v.push('a hand chair need not still hold its player and pre-hand stack');
  if (
    !handoff.includes(
      'hand_atomic_commits WHERE table_id=s.table_id AND hand_number>=s.hand_number'
    ) ||
    !handoff.includes('hand_history WHERE table_id=s.table_id AND hand_number>=s.hand_number') ||
    !handoff.includes('f06_hand_permits WHERE table_id=s.table_id AND hand_number>s.hand_number')
  )
    v.push('a later hand no longer fences the handoff');
  // The commit itself is unchanged: the retained request, the core, the claim.
  if (
    !c.includes(
      "r:=public.fn_ca_commit_hand_settlement(s.table_id,s.hand_number,q->'p_stacks',\n    (q->>'p_rake')::numeric,(q->>'p_bbj')::numeric,q->>'p_ref',(q->>'p_inflow')::numeric,\n    q->'p_hand_row',q->'p_units',p_instance_id,p_lease_generation,q->'p_post_commit_obligations');"
    )
  )
    v.push('the handoff no longer commits the retained request through the core');
  if (!c.includes('INSERT INTO smarter_private.hand_submission_handoffs('))
    v.push('the handoff no longer spends its one-time claim');
  if (!c.includes('IF s.lease_generation=p_lease_generation THEN'))
    v.push('the original generation can hand off to itself');
  if (/UPDATE public\.table_seats|INSERT INTO public\.(chip_ledger|club_members)/.test(c))
    v.push('the door writes a chair or money itself');
  return v;
}

/** Undo the two documented edits; what is left must be the definition production held. */
function undo(after: string): string {
  const a = after.indexOf('  -- The original exact generations');
  const b = after.indexOf('  q:=s.request;', a);
  let s = after.slice(0, a) + COMMENT_BEFORE + after.slice(b);
  const c1 = s.indexOf("   (q->'p_hand_row'->>'started_at') IS NULL\n");
  const c2 =
    s.indexOf("jsonb_array_elements(q->'p_stacks') x)))\n", c1) +
    "jsonb_array_elements(q->'p_stacks') x)))\n".length;
  s = s.slice(0, c1) + OLD_CLAUSE + s.slice(c2);
  return s;
}

describe('a retained hand commits past a seat taken after its deal', () => {
  const after = body(FILE);
  const before = undo(after);

  it('starts from the definition production held and lands the one it asserts (md5 pinned)', () => {
    expect(md5(before)).toBe(PRE_MD5);
    expect(FILE).toContain(`md5(p.prosrc) = '${PRE_MD5}'`);
    expect(FILE).toContain(`md5(p.prosrc) = '${md5(after)}'`);
  });

  it('admits only a chair taken after the deal (body in force)', () => {
    expect(violations(after)).toEqual([]);
  });

  it('refutes the door that froze the event (negative proof)', () => {
    expect(violations(before)).toEqual([
      'a chair taken after the deal holds a finished hand hostage',
      'a hand with no recorded start can be handed off past an extra chair',
      'an extra live chair is not identified against the hand chairs',
      'a chair present at the deal but missing from the hand is admitted',
      'a hand player seated twice is admitted',
    ]);
  });

  it('goes red when any one condition is removed (planted regressions)', () => {
    const plant = (from: string, to: string) => {
      expect(after.includes(from), from).toBe(true);
      return violations(after.replace(from, to));
    };
    expect(
      plant("late.joined_at<=(q->'p_hand_row'->>'started_at')::timestamptz", 'false')
    ).toContain('a chair present at the deal but missing from the hand is admitted');
    expect(
      plant(
        "\n       OR late.user_id IN (SELECT (x->>'user_id')::uuid FROM jsonb_array_elements(q->'p_stacks') x)",
        ''
      )
    ).toContain('a hand player seated twice is admitted');
    expect(plant("   (q->'p_hand_row'->>'started_at') IS NULL\n   OR ", '   ')).toContain(
      'a hand with no recorded start can be handed off past an extra chair'
    );
    expect(plant("AND seat.stack=(x->>'stack_before')::numeric", '')).toContain(
      'a hand chair need not still hold its player and pre-hand stack'
    );
    expect(
      plant(
        'hand_history WHERE table_id=s.table_id AND hand_number>=s.hand_number',
        'hand_history WHERE false'
      )
    ).toContain('a later hand no longer fences the handoff');
  });

  it('is one transaction with a preimage and a postimage', () => {
    expect(FILE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(FILE.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(FILE).toMatch(/SET LOCAL lock_timeout/);
    expect(FILE).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_ca_resume_hand_submission(uuid,text,uuid) TO service_role;'
    );
    expect(FILE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_resume_hand_submission(uuid,text,uuid) FROM PUBLIC,anon,authenticated;'
    );
  });
});

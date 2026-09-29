/**
 * A DEAD GENERATION'S HAND THAT NEVER REACHED A COMMIT IS A MISDEAL (2026-09-26)
 *
 * public.fn_f06_abort_abandoned_generation voids the hand a dead lease
 * generation left reserved, so the adopting successor can take the table and
 * the event can go on. It refused two shapes outright, and ten events (23
 * horses, every chair holding exactly its last committed end stack) had been
 * frozen since 2026-09-18 and 2026-09-22 behind those refusals:
 *
 *   F06_ABANDONED_CARDS_WITHOUT_SNAPSHOT  hole cards dealt, the hand-start
 *                                         snapshot never written (6 events)
 *   F06_ABORT_COMMITTED_OR_DISPATCHED     the commit door wrote a dispatch row
 *                                         and refused the hand; the platform
 *                                         recorded it DISPOSED (4 events)
 *
 * The door now voids such a hand under the misdeal ruling, and ONLY when the
 * rows prove the void takes nothing from anybody. These laws pin exactly those
 * conditions, the refusal names that still apply when any one fails, and that
 * the ruling never moves a chip, never deletes a permit and never lets the
 * voided hand number commit later.
 *
 * 20260926075505. docs/changelog/2026-09-26-a-dead-generation-hand-that-never-reached-a-commit-is-a-misdeal.md
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const PREVIOUS = readFileSync(
  join(MIGRATIONS, '20260926043558_a_bust_awaiting_its_elimination_does_not_hold_a_dead_hand.sql'),
  'utf8'
);
const MISDEAL = readFileSync(
  join(
    MIGRATIONS,
    '20260926075505_a_dead_generation_hand_that_never_reached_a_commit_is_a_misdeal.sql'
  ),
  'utf8'
);

const PRE_MD5 = '53950f516ec6139b4ad30d7753ab47e9';
const POST_MD5 = 'f7424f0f1d7df2ad0cf44e99541d7235';

function doorBody(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_f06_abort_abandoned_generation');
  expect(start, 'the file defines the door').toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$function$', start) + '$function$'.length;
  const close = sql.indexOf('$function$', open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');
const code = (s: string) =>
  s
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n');

/** The misdeal branch: from `IF v_misdeal THEN` to the snapshot branch that follows it. */
function misdealBranch(body: string): string {
  const a = body.indexOf('    IF v_misdeal THEN');
  const b = body.indexOf('    ELSIF n = 1 THEN', a);
  return a >= 0 && b > a ? body.slice(a, b) : '';
}

function misdealViolations(body: string): string[] {
  const v: string[] = [];
  const c = code(body);
  if (!c.includes('v_misdeal := v_dispatched OR (n = 0 AND v_cards > 0);'))
    return ['a dealt or dispatched hand that never reached a commit can never be voided'];
  const branch = code(misdealBranch(body));
  if (!branch) return ['the misdeal has no branch of its own'];
  // A dispatch is only a misdeal when the platform itself disposed of the hand.
  if (
    !/IF v_dispatched\s+AND NOT EXISTS \(SELECT 1 FROM smarter_private\.hand_submission_dispositions d\s+WHERE d\.table_id = h\.table_id AND d\.hand_number = h\.hand_number\s+AND d\.disposition = 'disposed' AND d\.submission_id IS NULL\) THEN\s+RAISE EXCEPTION 'F06_ABORT_COMMITTED_OR_DISPATCHED'/.test(
      c
    )
  )
    v.push('a dispatched hand the platform never disposed of can be voided');
  // Commit, history and private state still refuse outright, before any ruling.
  if (
    !/hand_atomic_commits c\s+WHERE c\.table_id = h\.table_id AND c\.hand_number >= h\.hand_number\)[\s\S]{0,400}hand_private_state hp[\s\S]{0,160}RAISE EXCEPTION 'F06_ABORT_COMMITTED_OR_DISPATCHED'/.test(
      c
    )
  )
    v.push('a committed hand, its history or its private state no longer refuses');
  // A retained submission is still never voided.
  if (!c.includes("RAISE EXCEPTION 'F06_ABANDONED_HAND_HAS_A_RETAINED_SUBMISSION'"))
    v.push('a hand with a retained submission can be voided');
  // The proof, every clause of it.
  if (
    !branch.includes('FROM public.hand_history hh') ||
    !branch.includes('hh.hand_number < h.hand_number')
  )
    v.push('the misdeal does not read the table last committed hand');
  if (!branch.includes('OR v_last.id IS NULL'))
    v.push('a table with no committed hand can be voided on no evidence');
  if (!/\(x->>'stack'\)::numeric = \(r->>'stack'\)::numeric/.test(branch))
    v.push('a chair need not hold its last committed end stack');
  if (!/x->>'userId' = r->>'user_id'/.test(branch))
    v.push('the end stack is not matched to the same player');
  if (!branch.includes('FROM public.hand_discards x'))
    v.push('a hand that recorded an action (a discard) can be voided');
  if (
    !/FROM public\.table_hole_cards c[\s\S]{0,200}NOT EXISTS \(SELECT 1 FROM jsonb_array_elements\(roster\) r/.test(
      branch
    )
  )
    v.push('a card dealt to somebody not in a live chair can be voided');
  if (!/n = 1 AND NOT \(v_dispatched AND EXISTS[\s\S]{0,300}s\.is_complete IS TRUE/.test(branch))
    v.push('a hand with an open staged snapshot can be voided as a misdeal');
  // When the proof fails, the refusal is the one each shape always had.
  const refusals = branch.slice(0, branch.indexOf("'ruling', 'misdeal_voided'"));
  if (
    !refusals.includes("RAISE EXCEPTION 'F06_ABORT_COMMITTED_OR_DISPATCHED'") ||
    !refusals.includes("RAISE EXCEPTION 'F06_ABANDONED_CARDS_WITHOUT_SNAPSHOT'")
  )
    v.push('a failed proof does not raise the refusal its shape always had');
  // The ruling is named, fenced and audited.
  if (!branch.includes("'ruling', 'misdeal_voided'"))
    v.push('the ruling is not named on the receipt');
  if (!branch.includes('v_abort_ids := v_abort_ids || h.permit_id;'))
    v.push('a voided hand is not fenced by an abort receipt');
  if (!branch.includes("'last_committed_hand'")) v.push('the receipt does not name the evidence');
  return v;
}

function moneyViolations(body: string): string[] {
  const v: string[] = [];
  const c = code(body);
  if (/UPDATE public\.table_seats/.test(c)) v.push('the door writes a chair');
  if (/UPDATE public\.tournament_players/.test(c)) v.push('the door writes a registration');
  if (/INSERT INTO public\.(chip_ledger|club_members|tournament_escrow)/.test(c))
    v.push('the door moves money');
  if (/DELETE FROM smarter_private\.f06_hand_permits/.test(c)) v.push('the door deletes a permit');
  if (!c.includes("'credit', 0);")) v.push('the door no longer answers credit 0');
  return v;
}

describe('a dead generation hand that never reached a commit is a misdeal', () => {
  const before = doorBody(PREVIOUS);
  const after = doorBody(MISDEAL);

  it('starts from the definition production held and lands the one it asserts (md5 pinned)', () => {
    expect(md5(before)).toBe(PRE_MD5);
    expect(md5(after)).toBe(POST_MD5);
    expect(MISDEAL).toContain(`'${PRE_MD5}'`);
    expect(MISDEAL).toContain(`md5(p.prosrc) = '${POST_MD5}'`);
  });

  it('voids only under the proved conditions (body in force)', () => {
    expect(misdealViolations(after)).toEqual([]);
    expect(moneyViolations(after)).toEqual([]);
  });

  it('refutes the door that could not rule (negative proof)', () => {
    expect(misdealViolations(before)).toEqual([
      'a dealt or dispatched hand that never reached a commit can never be voided',
    ]);
    expect(moneyViolations(before)).toEqual([]);
  });

  it('goes red when any one condition of the proof is removed (planted regressions)', () => {
    const plant = (from: string, to: string) => {
      expect(after.includes(from), from).toBe(true);
      return misdealViolations(after.replace(from, to));
    };
    expect(plant('         OR v_last.id IS NULL\n', '')).toContain(
      'a table with no committed hand can be voided on no evidence'
    );
    expect(plant("AND (x->>'stack')::numeric = (r->>'stack')::numeric", '')).toContain(
      'a chair need not hold its last committed end stack'
    );
    expect(
      plant(
        "                          AND d.disposition = 'disposed' AND d.submission_id IS NULL) THEN",
        '                          ) THEN'
      )
    ).toContain('a dispatched hand the platform never disposed of can be voided');
    expect(plant('FROM public.hand_discards x', 'FROM public.hand_history x')).toContain(
      'a hand that recorded an action (a discard) can be voided'
    );
  });

  it('changes nothing but the documented edits', () => {
    // Undo each edit; what is left must be the previous door exactly.
    const branch = after.slice(
      after.indexOf('    IF v_misdeal THEN'),
      after.indexOf('    ELSIF n = 1 THEN')
    );
    let undone = after
      .replace(
        '  v_busts jsonb;\n  v_dispatched boolean;\n  v_cards integer;\n  v_misdeal boolean;\n  v_last record;\n  v_misdeal_n integer := 0;\n',
        '  v_busts jsonb;\n'
      )
      .replace(branch + '    ELSIF n = 1 THEN', '    IF n = 1 THEN')
      .replace(
        'IF v_break IS NOT NULL OR n = 0 OR v_misdeal\n',
        'IF v_break IS NOT NULL OR n = 0\n'
      )
      .replace(
        "NULLIF(item->>'snapshot_id', '')::uuid, NULLIF(item->>'break_id', '')::uuid, item);",
        "(item->>'snapshot_id')::uuid, (item->>'break_id')::uuid, item);"
      )
      .replace("    'misdeals_voided', v_misdeal_n,\n", '');
    const decide = undone.indexOf(
      '    SELECT count(*) INTO v_cards FROM public.table_hole_cards c'
    );
    const decideEnd =
      undone.indexOf('v_misdeal := v_dispatched OR (n = 0 AND v_cards > 0);\n', decide) +
      'v_misdeal := v_dispatched OR (n = 0 AND v_cards > 0);\n'.length;
    undone = undone.slice(0, decide) + undone.slice(decideEnd);
    const dispatchStart = undone.indexOf('    -- A DISPATCH ROW WITHOUT A COMMIT');
    const dispatchEnd =
      undone.indexOf(
        "RAISE EXCEPTION 'F06_ABORT_COMMITTED_OR_DISPATCHED' USING ERRCODE = '55000';\n    END IF;\n",
        dispatchStart
      ) +
      "RAISE EXCEPTION 'F06_ABORT_COMMITTED_OR_DISPATCHED' USING ERRCODE = '55000';\n    END IF;\n"
        .length;
    undone = undone.slice(0, dispatchStart) + undone.slice(dispatchEnd);
    undone = undone.replace(
      '                   WHERE hh.table_id = h.table_id AND hh.hand_number >= h.hand_number)\n       OR EXISTS (SELECT 1 FROM public.hand_private_state hp',
      '                   WHERE hh.table_id = h.table_id AND hh.hand_number >= h.hand_number)\n       OR EXISTS (SELECT 1 FROM smarter_private.f06_hand_dispatch d WHERE d.permit_id = h.permit_id)\n       OR EXISTS (SELECT 1 FROM public.hand_private_state hp'
    );
    expect(undone).toBe(before);
  });

  it('a misdeal receipt may carry no snapshot, and only a misdeal may', () => {
    expect(MISDEAL).toMatch(
      /ALTER TABLE smarter_private\.f06_generation_abort_hands\s+ALTER COLUMN snapshot_id DROP NOT NULL/
    );
    expect(MISDEAL).toMatch(
      /CHECK \(snapshot_id IS NOT NULL OR expected->>'ruling' = 'misdeal_voided'\)/
    );
  });
});

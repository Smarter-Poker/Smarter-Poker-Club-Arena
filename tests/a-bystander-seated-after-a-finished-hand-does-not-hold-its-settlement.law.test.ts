/**
 * A BYSTANDER SEATED AFTER A FINISHED HAND DOES NOT HOLD ITS SETTLEMENT (2026-09-26)
 *
 * Event 8ec7e81d held a finished, retained hand (table c1ee060b, hand
 * 12976717: +75 / -50 / -25, net 0) that its successor could never commit:
 * fn_ca_resume_hand_submission required the table's live chairs to equal the
 * hand's stack rows, and a late registrant sat down 22 seconds after the hand
 * was retained. The retained submission kept the whole dead generation, five
 * tables, frozen.
 *
 * These laws pin that the successor handoff leaves out of that count ONLY a
 * chair that was provably never in the hand, that nothing protecting a
 * participant moved, and that the door now reads the event's last dealt hand
 * by when it was played, so a late commit of an old hand never turns the
 * clock back.
 *
 * 20260926091455. docs/changelog/2026-09-26-a-bystander-seated-after-a-finished-hand-does-not-hold-its-settlement.md
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const SQL = readFileSync(
  join(
    MIGRATIONS,
    '20260926091455_a_bystander_seated_after_a_finished_hand_does_not_hold_its_s.sql'
  ),
  'utf8'
);
const MISDEAL = readFileSync(
  join(
    MIGRATIONS,
    '20260926075505_a_dead_generation_hand_that_never_reached_a_commit_is_a_misdeal.sql'
  ),
  'utf8'
);

const RESUME_PRE_MD5 = '1aa58a5d89009ae97ddb2e18462a7ec3';
const RESUME_POST_MD5 = '3961a92c0e6e65eb601f5f34bcd1f7fd';
const DOOR_PRE_MD5 = 'f7424f0f1d7df2ad0cf44e99541d7235';
const DOOR_POST_MD5 = 'adeba11b33ec9c234c77d8d26c9e2324';

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  expect(start, `the file defines ${name}`).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$function$', start) + '$function$'.length;
  const close = sql.indexOf('$function$', open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

const RESUME = body(SQL, 'public.fn_ca_resume_hand_submission');
const DOOR = body(SQL, 'public.fn_f06_abort_abandoned_generation');

const OLD_COUNT =
  "   (SELECT count(*) FROM public.table_seats WHERE table_id=s.table_id AND left_at IS NULL)<>jsonb_array_length(q->'p_stacks')";

/** The inserted bystander block, from the new count to the clause after it. */
function bystanderBlock(b: string): string {
  const a = b.indexOf('   (SELECT count(*) FROM public.table_seats b WHERE b.table_id=s.table_id');
  const z = b.indexOf("   OR (SELECT count(DISTINCT x->>'seat_id')", a);
  return a >= 0 && z > a ? b.slice(a, z) : '';
}

function resumeViolations(b: string): string[] {
  const v: string[] = [];
  const block = bystanderBlock(b);
  if (!block) return ['the handoff has no bystander rule where the chair count was'];
  const code = block
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n');
  if (!code.includes('AND NOT (tour IS NOT NULL'))
    v.push('a cash table can drop a chair from the count');
  if (!code.includes('AND b.joined_at > s.retained_at'))
    v.push('a chair seated before the hand was retained can be left out');
  if (!code.includes("AND b.joined_at > (q->'p_hand_row'->>'ended_at')::timestamptz"))
    v.push('a chair seated before the hand ended can be left out');
  if (!code.includes('AND b.stack > 0')) v.push('an empty chair can be left out');
  if (!/x->>'seat_id'=b\.id::text OR x->>'user_id'=b\.user_id::text/.test(code))
    v.push('a chair the hand names can be left out');
  if (
    !/jsonb_array_elements\(q->'p_hand_row'->'players'\) x\s+WHERE x->>'userId'=b\.user_id::text/.test(
      code
    )
  )
    v.push('a hand-row player can be left out');
  if (
    !/FROM public\.table_hole_cards c\s+WHERE c\.table_id=s\.table_id AND c\.hand_number=s\.hand_number AND c\.user_id=b\.user_id/.test(
      code
    )
  )
    v.push('a player dealt cards can be left out');
  if (
    !/tp\.tournament_id=tour AND tp\.user_id=b\.user_id AND tp\.table_id=b\.table_id\s+AND tp\.seat_number=b\.seat_number AND tp\.status='playing' AND tp\.chips=b\.stack/.test(
      code
    )
  )
    v.push('a chair not holding exactly its own playing registration can be left out');
  if (!code.includes("<>jsonb_array_length(q->'p_stacks')"))
    v.push('the remaining chairs need not equal the hand stack rows');
  if (!code.includes("OR jsonb_typeof(q->'p_hand_row'->'players') IS DISTINCT FROM 'array'"))
    v.push('a hand row without players can pass');
  if (
    !code.includes(
      "OR NOT COALESCE(pg_input_is_valid(q->'p_hand_row'->>'ended_at','timestamptz'),false)"
    )
  )
    v.push('a hand row without a valid ended_at can pass');
  // Everything that protects a participant is still there, unchanged.
  for (const kept of [
    "AND seat.user_id=(x->>'user_id')::uuid AND seat.joined_at=(x->>'seat_joined_at')::timestamptz",
    "AND seat.left_at IS NULL AND seat.stack=(x->>'stack_before')::numeric))",
    'OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=s.table_id AND hand_number>=s.hand_number)',
    'OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=s.table_id AND hand_number>=s.hand_number)',
    'OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=s.table_id AND hand_number>s.hand_number) THEN',
    "RAISE EXCEPTION 'HAND_SUBMISSION_HANDOFF_STATE_CHANGED'",
  ])
    if (!b.includes(kept)) v.push(`a participant protection is gone: ${kept}`);
  return v;
}

const OLD_ORDER = `  SELECT hh.small_blind, hh.big_blind, hh.created_at INTO v_hh
    FROM public.hand_history hh WHERE hh.tournament_id = t
   ORDER BY hh.created_at DESC LIMIT 1;`;

function playTimeBlock(b: string): string {
  const a = b.indexOf('  -- PLAY TIME, NOT WRITE TIME (2026-09-26)');
  const z = b.indexOf(
    'ORDER BY COALESCE(hh.ended_at, hh.created_at) DESC, hh.created_at DESC LIMIT 1;',
    a
  );
  return a >= 0 && z > a
    ? b.slice(
        a,
        z + 'ORDER BY COALESCE(hh.ended_at, hh.created_at) DESC, hh.created_at DESC LIMIT 1;'.length
      )
    : '';
}

describe('a bystander seated after a finished hand does not hold its settlement', () => {
  it('installs exactly the reviewed bodies', () => {
    expect(md5(RESUME)).toBe(RESUME_POST_MD5);
    expect(md5(DOOR)).toBe(DOOR_POST_MD5);
  });

  it('changes the handoff by the bystander rule and nothing else', () => {
    const block = bystanderBlock(RESUME);
    expect(block).not.toBe('');
    const reverted = RESUME.replace(block, OLD_COUNT + '\n');
    expect(md5(reverted), 'reverting the one edit gives back the production pre-image').toBe(
      RESUME_PRE_MD5
    );
  });

  it('changes the door by the play-time ordering and nothing else', () => {
    const block = playTimeBlock(DOOR);
    expect(block).not.toBe('');
    const reverted = DOOR.replace(block, OLD_ORDER);
    expect(md5(reverted)).toBe(DOOR_PRE_MD5);
    expect(reverted).toBe(body(MISDEAL, 'public.fn_f06_abort_abandoned_generation'));
    expect(DOOR).not.toContain('ORDER BY hh.created_at DESC LIMIT 1;');
    expect(DOOR).toContain('COALESCE(hh.ended_at, hh.created_at) AS created_at INTO v_hh');
  });

  it('leaves out of the count only a chair that was never in the hand', () => {
    expect(resumeViolations(RESUME)).toEqual([]);
  });

  it('refuses every planted regression', () => {
    const plant = (from: string, to: string) => {
      expect(RESUME.includes(from), `planted text exists: ${from}`).toBe(true);
      return resumeViolations(RESUME.replace(from, to));
    };
    expect(plant('AND NOT (tour IS NOT NULL', 'AND NOT (true')).not.toEqual([]);
    expect(plant('AND b.joined_at > s.retained_at', 'AND true')).not.toEqual([]);
    expect(plant('AND b.stack > 0', 'AND true')).not.toEqual([]);
    expect(plant('AND tp.chips=b.stack', 'AND true')).not.toEqual([]);
    expect(
      plant("x->>'seat_id'=b.id::text OR x->>'user_id'=b.user_id::text", "x->>'seat_id'=b.id::text")
    ).not.toEqual([]);
    expect(plant('AND c.user_id=b.user_id)', ')')).not.toEqual([]);
    expect(
      plant(
        "AND seat.left_at IS NULL AND seat.stack=(x->>'stack_before')::numeric))",
        'AND seat.left_at IS NULL))'
      )
    ).not.toEqual([]);
    expect(resumeViolations(RESUME.replace(bystanderBlock(RESUME), OLD_COUNT + '\n'))).not.toEqual(
      []
    );
  });

  it('is one guarded transaction with explicit service_role grants', () => {
    expect(SQL.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(SQL).not.toMatch(/CONCURRENTLY|VACUUM/);
    for (const m of [RESUME_PRE_MD5, DOOR_PRE_MD5, RESUME_POST_MD5, DOOR_POST_MD5])
      expect(SQL).toContain(`md5(p.prosrc) = '${m}'`);
    expect(SQL).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_ca_resume_hand_submission(uuid, text, uuid)\n  TO service_role;'
    );
    expect(SQL).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_f06_abort_abandoned_generation(uuid, uuid, uuid, text, boolean)\n  TO service_role;'
    );
    expect(SQL.indexOf('$pre$')).toBeLessThan(SQL.indexOf('CREATE OR REPLACE FUNCTION'));
    expect(SQL.lastIndexOf('$post$')).toBeGreaterThan(
      SQL.lastIndexOf('CREATE OR REPLACE FUNCTION')
    );
  });
});

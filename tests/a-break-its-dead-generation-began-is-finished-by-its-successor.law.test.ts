/**
 * A BREAK ITS DEAD GENERATION BEGAN IS FINISHED BY ITS SUCCESSOR (2026-09-26)
 *
 * Event 7c6277e7, table 244a2997, break dce8ddb0: begun by generation
 * 29afae24, one member moved, seven attempts active, the generation dead.
 * The successor's only door into the break's custody,
 * public.fn_f06_admit_parked_movement, refused it for a week with
 * F06_MOVEMENT_ORIGINAL_PROOF_MISSING: a break begun under a live dealer
 * never records a movement admission, and a begun break could not be
 * recaptured from a partial roster.
 *
 * The law is carried by 20260926091645_a_receipted_chip_is_movement_evidence
 * (applied to production 2026-09-26 09:35:51Z; break dce8ddb0 then finished
 * through the protocol and its event completed). A begun break that never
 * recorded an admission takes its proof from f06_movement_prior, member by
 * member: a moved member only by this break's own winning receipt at its
 * proven stack, every other member by its live manifest chair, every chip
 * added after the boundary only by a durable purchase receipt, every
 * manifest member accounted for, and the proof bound to the break. The
 * alternative rebuild of #5328 (20260926092954) was written against the
 * pre-receipt definitions, could never apply over them, and was removed.
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
    '20260926091645_a_receipted_chip_is_movement_evidence.sql'
  ),
  'utf8'
);

// The definitions production holds (the migration's own @live-proof lines).
const PRIOR_LIVE_MD5 = 'b69098029169b71482e827e9a59ed55b';
const DOOR_LIVE_MD5 = 'b77d5c53decccf1b0579ce08ef492a63';

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');
const code = (s: string) =>
  s
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n');

function body(sql: string, tag: string): string {
  const open = sql.indexOf(`AS $${tag}$`);
  expect(open, tag).toBeGreaterThanOrEqual(0);
  const start = open + `AS $${tag}$`.length;
  const close = sql.indexOf(`$${tag}$;`, start);
  expect(close).toBeGreaterThan(start);
  return sql.slice(start, close);
}

function doorViolations(src: string): string[] {
  const v: string[] = [];
  const c = code(src);
  const carried = c.indexOf('proof:=prior.proof;');
  const rebuilt = c.indexOf(
    'proof:=smarter_private.f06_movement_prior(p_tournament_id,p_table_id);'
  );
  if (rebuilt < 0) return ['a break a dead generation began can never be finished'];
  if (carried < 0 || carried > rebuilt)
    v.push('a recorded proof is no longer carried before any rebuild');
  if (
    !c.includes(
      "IF NOT ((o.state='park_requested' AND o.manifest IS NULL) OR (o.state='begun' AND o.manifest IS NOT NULL)) THEN RAISE EXCEPTION 'F06_MOVEMENT_ORIGINAL_PROOF_MISSING'"
    )
  )
    v.push('a break with no proof and no manifest shape is no longer refused');
  if (
    !c.includes(
      "IF o.state='begun' AND proof#>>'{receipts,break_id}' IS DISTINCT FROM p_break_id::text THEN RAISE EXCEPTION 'F06_MOVEMENT_ORIGINAL_PROOF_MISSING'"
    )
  )
    v.push('a begun break may bind a proof taken for another break');
  if (
    !c.includes(
      'claimed:=public.fn_f06_claim_custody(p_tournament_id,p_lease_generation,p_break_id,p_custody_id,p_expected_revision);'
    )
  )
    v.push('custody is no longer taken through fn_f06_claim_custody');
  if ((c.match(/PERFORM smarter_private\.f06_assert_movement\(p_break_id\);/g) ?? []).length !== 2)
    v.push('an admission is no longer asserted against the rows');
  return v;
}

function proofViolations(src: string): string[] {
  const v: string[] = [];
  const c = code(src);
  if (
    !c.includes(
      "SELECT d.receipt INTO winner FROM smarter_private.f06_attempts d WHERE d.break_id=o.break_id AND d.user_id=(x->>'user_id')::uuid AND d.state='winner';"
    )
  )
    v.push("a moved member is not witnessed by this break's winning receipt");
  const w = c.slice(c.indexOf('IF winner IS NOT NULL THEN'), c.indexOf('CONTINUE;'));
  for (const [needle, what] of [
    [
      "(winner->>'break_id')::uuid IS DISTINCT FROM o.break_id",
      'a winning receipt of another break is accepted',
    ],
    [
      "(winner->>'source_lifecycle')::bigint IS DISTINCT FROM o.lifecycle",
      'a winning receipt of another lifecycle is accepted',
    ],
    [
      "(winner->>'source_occupancy_id')::uuid IS DISTINCT FROM member.occupancy_id",
      'the winning receipt need not carry the occupancy',
    ],
    [
      "member.source_seat_id IS DISTINCT FROM (x->>'seat_id')::uuid",
      'the winning receipt need not name the chair',
    ],
    ['movement.stack IS DISTINCT FROM held', 'the winning receipt may carry a different stack'],
    ['movement.moved_at<=a.committed_at', 'a move before the boundary is accepted'],
    [
      'AND left_at IS NULL AND occupancy_id=member.occupancy_id',
      'a moved member need not have vacated its chair',
    ],
  ] as const)
    if (!w.includes(needle)) v.push(what);
  if (
    !c.includes(
      "IF o.state='begun' AND (member.user_id IS NULL OR (member.source_seat_id,member.occupancy_id) IS DISTINCT FROM (seat.id,seat.occupancy_id)) THEN"
    )
  )
    v.push('a chair outside the break manifest is admitted');
  if (
    !c.includes(
      "IF o.state='begun' AND ((SELECT count(*) FROM smarter_private.f06_members WHERE break_id=o.break_id)<>positive"
    ) ||
    !c.includes('m.user_id<>ALL(users)')
  )
    v.push('a manifest member can be unaccounted for');
  if (!c.includes('FROM public.tournament_participant_funding_receipts f'))
    v.push('chips added after the boundary are not counted from purchase receipts');
  if (!c.includes("AND l.status='posted'"))
    v.push('a pre-receipt add-on is admitted without its posted ledger leg');
  for (const refusal of [
    'F06_MOVEMENT_PRIOR_INCOMPLETE',
    'F06_MOVEMENT_PRIOR_NOT_LAST_BOUNDARY',
    'F06_MOVEMENT_POSTCOMMIT_SEAL',
    'F06_MOVEMENT_STACK_RECEIPT',
    'F06_MOVEMENT_REGISTRATION_CHANGED',
    'F06_MOVEMENT_ELIMINATION_UNPROVEN',
    'F06_MOVEMENT_ROSTER_CHANGED',
    'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED',
  ])
    if (!c.includes(`'${refusal}'`)) v.push(`the boundary no longer refuses ${refusal}`);
  if (/UPDATE public\.|INSERT INTO |DELETE FROM /.test(c)) v.push('the proof writes rows');
  return v;
}

describe('a break its dead generation began is finished by its successor', () => {
  const prior = body(FILE, 'movement_prior');
  const door = body(FILE, 'movement_admit');

  it('pins the definitions production holds (md5 of the applied bodies)', () => {
    expect(md5(prior)).toBe(PRIOR_LIVE_MD5);
    expect(md5(door)).toBe(DOOR_LIVE_MD5);
    expect(FILE).toContain(`md5(prosrc)='${PRIOR_LIVE_MD5}'`);
    expect(FILE).toContain(`md5(prosrc)='${DOOR_LIVE_MD5}'`);
  });

  it('proves a begun break member by member, from rows (bodies in force)', () => {
    expect(doorViolations(door)).toEqual([]);
    expect(proofViolations(prior)).toEqual([]);
  });

  it('goes red when any one witness is dropped (planted regressions)', () => {
    const plant = (src: string, from: string, to: string, check: (s: string) => string[]) => {
      expect(src.includes(from), from).toBe(true);
      return check(src.replace(from, to));
    };
    expect(
      plant(
        prior,
        " OR (winner->>'break_id')::uuid IS DISTINCT FROM o.break_id",
        '',
        proofViolations
      )
    ).toContain('a winning receipt of another break is accepted');
    expect(plant(prior, ' OR movement.stack IS DISTINCT FROM held', '', proofViolations)).toContain(
      'the winning receipt may carry a different stack'
    );
    expect(
      plant(
        prior,
        '(SELECT count(*) FROM smarter_private.f06_members WHERE break_id=o.break_id)<>positive',
        'false',
        proofViolations
      )
    ).toContain('a manifest member can be unaccounted for');
    expect(
      plant(
        door,
        "IF o.state='begun' AND proof#>>'{receipts,break_id}' IS DISTINCT FROM p_break_id::text THEN",
        'IF false THEN',
        doorViolations
      )
    ).toContain('a begun break may bind a proof taken for another break');
    expect(
      plant(
        door,
        'proof:=smarter_private.f06_movement_prior(p_tournament_id,p_table_id);',
        'proof:=NULL;',
        doorViolations
      )
    ).toEqual(['a break a dead generation began can never be finished']);
  });

  it('the superseded rebuild is gone, so nothing merged waits on a definition production never held', () => {
    const dir = join(__dirname, '..', 'supabase', 'migrations');
    expect(() =>
      readFileSync(
        join(
          dir,
          '20260926092954_a_break_its_dead_generation_began_is_finished_by_its_successor.sql'
        ),
        'utf8'
      )
    ).toThrow();
  });
});

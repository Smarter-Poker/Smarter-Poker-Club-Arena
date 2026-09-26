/**
 * A BREAK ITS DEAD GENERATION BEGAN IS FINISHED BY ITS SUCCESSOR (2026-09-26)
 *
 * Event 7c6277e7, table 244a2997, break dce8ddb0: begun by generation
 * 29afae24, one member moved, seven attempts active, the generation dead.
 * The successor's only door into the break's custody,
 * public.fn_f06_admit_parked_movement, refused it for a week with
 * F06_MOVEMENT_ORIGINAL_PROOF_MISSING: a break begun under a live dealer
 * never records a movement admission, and a begun break may not be
 * recaptured from a partial roster.
 *
 * The door now rebuilds the proof the dead generation would have taken
 * (smarter_private.f06_movement_abandoned_begun_proof), only for a begun
 * break whose origin and custody generations are both not the caller's and
 * that never recorded an admission. These laws pin that gate, every
 * witness the rebuilt proof accepts in place of a live chair, and that it
 * writes nothing.
 *
 * 20260926092954. docs/changelog/2026-09-26-a-break-its-dead-generation-began-is-finished-by-its-successor.md
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const FILE = readFileSync(
  join(
    MIGRATIONS,
    '20260926092954_a_break_its_dead_generation_began_is_finished_by_its_successor.sql'
  ),
  'utf8'
);
const ORIGINAL = readFileSync(
  join(MIGRATIONS, '20260918095135_parked_tournament_movement_requires_canonical_custody.sql'),
  'utf8'
);

const DOOR_PRE_MD5 = '9bcb1b3bb38fb6abaca0c663e51ab325';
const PRIOR_MD5 = '97c4a1afeaa41512026d3dca6936364a';

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');
const code = (s: string) =>
  s
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n');

function body(sql: string, signature: string): string {
  const start = sql.indexOf(signature);
  expect(start, signature).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('AS $$', start) + 'AS $$'.length;
  const close = sql.indexOf('$$;', open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

const DOOR_SIG = 'FUNCTION public.fn_f06_admit_parked_movement(';
const PROOF_SIG = 'FUNCTION smarter_private.f06_movement_abandoned_begun_proof(';
const PRIOR_SIG = 'FUNCTION smarter_private.f06_movement_prior(';

function doorViolations(src: string): string[] {
  const v: string[] = [];
  const c = code(src);
  if (
    !c.includes(
      'proof:=smarter_private.f06_movement_abandoned_begun_proof(p_tournament_id,p_table_id,p_break_id);'
    )
  )
    return ['a break a dead generation began can never be finished'];
  const gate =
    "IF o.state='begun' AND o.manifest IS NOT NULL\n AND o.origin_generation IS DISTINCT FROM p_lease_generation AND o.custody_generation IS DISTINCT FROM p_lease_generation\n AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions WHERE break_id=p_break_id) THEN\n proof:=smarter_private.f06_movement_abandoned_begun_proof(";
  if (!c.includes(gate)) v.push('the rebuilt proof is reachable outside an abandoned begun break');
  // A recorded proof is still carried first, and the old refusal still stands.
  if (!/IF FOUND THEN\n proof:=prior\.proof;\n ELSE\n IF o\.state='begun'/.test(c))
    v.push('a recorded proof is no longer carried before any rebuild');
  if (
    !c.includes(
      "IF o.state<>'park_requested' OR o.manifest IS NOT NULL THEN RAISE EXCEPTION 'F06_MOVEMENT_ORIGINAL_PROOF_MISSING'"
    )
  )
    v.push('a break with no proof and no abandoned origin is no longer refused');
  // The rest of the door is unchanged: CAS, custody claim, assertion.
  if (
    !c.includes(
      'claimed:=public.fn_f06_claim_custody(p_tournament_id,p_lease_generation,p_break_id,p_custody_id,p_expected_revision);'
    )
  )
    v.push('custody is no longer taken through fn_f06_claim_custody');
  if (
    !c.includes(
      "IF o.revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'F06_MOVEMENT_CAS_CHANGED'"
    )
  )
    v.push('custody is taken without its revision CAS');
  if ((c.match(/PERFORM smarter_private\.f06_assert_movement\(p_break_id\);/g) ?? []).length !== 2)
    v.push('an admission is no longer asserted against the rows');
  return v;
}

function proofViolations(src: string): string[] {
  const v: string[] = [];
  const c = code(src);
  if (
    !c.includes(
      "IF NOT FOUND OR o.state<>'begun' OR jsonb_typeof(o.manifest) IS DISTINCT FROM 'array' OR jsonb_array_length(o.manifest)=0 THEN"
    )
  )
    v.push('the rebuild runs for a break that is not begun with a manifest');
  // The boundary is still the sealed last hand, exactly as f06_movement_prior.
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
  if (
    !c.includes(
      'permits:=smarter_private.f06_movement_permits(p_tournament,p_table,a.hand_number);'
    )
  )
    v.push('an undecided hand permit no longer refuses the rebuild');
  // Purchases after the boundary: debits only, the event's own, its own rates.
  if (
    !/bought:=COALESCE\(\(SELECT sum\(CASE wt\.category WHEN 'rebuy' THEN chips_rebuy ELSE chips_addon END\) FROM public\.wallet_transactions wt\s+WHERE wt\.related_entity_id::text=p_tournament::text AND wt\.user_id=\(x->>'user_id'\)::uuid AND wt\.category IN \('rebuy','addon'\)\s+AND wt\.type='debit' AND wt\.created_at>a\.committed_at\),0\);/.test(
      c
    )
  )
    v.push('chips added after the boundary are not counted from the purchase debits');
  if (
    !/wt\.type<>'debit' AND wt\.created_at>a\.committed_at\) THEN\s+RAISE EXCEPTION 'F06_MOVEMENT_PURCHASE_UNPROVEN'/.test(
      c
    )
  )
    v.push('a refunded or reversed purchase after the boundary is admitted');
  if (
    !c.includes(
      'COALESCE(NULLIF(t.rebuy_chips,0),t.starting_chips,0),COALESCE(NULLIF(t.addon_chips,0),t.starting_chips,0)'
    )
  )
    v.push('purchased chips are not valued at the event rates');
  // A re-seat is renewed only by a rebuy of a chair the last hand emptied.
  if (
    !/OR \(\(x->>'stack'\)::numeric=0 AND joined_at>a\.committed_at AND EXISTS\(SELECT 1 FROM public\.wallet_transactions wt\s+WHERE wt\.related_entity_id::text=p_tournament::text AND wt\.user_id=\(x->>'user_id'\)::uuid AND wt\.category='rebuy'\s+AND wt\.type='debit' AND wt\.created_at>a\.committed_at AND wt\.created_at<=joined_at\)\)\)/.test(
      c
    )
  )
    v.push('a renewed chair is accepted without the rebuy that renewed it');
  // Every chair is a manifest member in its manifest chair and occupancy.
  if (
    !/IF member IS NULL OR \(member->>'source_seat_id'\)::uuid IS DISTINCT FROM seat\.id\s+OR \(member->>'occupancy_id'\)::uuid IS DISTINCT FROM seat\.occupancy_id THEN\s+RAISE EXCEPTION 'F06_MOVEMENT_MANIFEST_CHANGED'/.test(
      c
    )
  )
    v.push('a chair outside the break manifest is admitted');
  // A moved member is witnessed only by this break's own winning receipt.
  const winner = c.slice(
    c.indexOf("d.state='winner';"),
    c.indexOf("'F06_MOVEMENT_WINNER_CHANGED'")
  );
  for (const [needle, what] of [
    ['seat.left_at IS NULL', 'a moved member need not have vacated its chair'],
    [
      "(w->>'source_seat_id')::uuid IS DISTINCT FROM seat.id",
      'the winning receipt need not name the chair',
    ],
    [
      "(w->>'source_occupancy_id')::uuid IS DISTINCT FROM seat.occupancy_id",
      'the winning receipt need not carry the occupancy',
    ],
    [
      "(w->>'stack')::numeric IS DISTINCT FROM expected",
      'the winning receipt may carry a different stack',
    ],
    [
      "(w->>'break_id')::uuid IS DISTINCT FROM p_break",
      'a winning receipt of another break is accepted',
    ],
    [
      "(w->>'source_lifecycle')::bigint IS DISTINCT FROM o.lifecycle",
      'a winning receipt of another lifecycle is accepted',
    ],
    [
      "(w->>'moved_at')::timestamptz IS DISTINCT FROM seat.left_at",
      'the chair may have been left by something other than the move',
    ],
  ] as const)
    if (!winner.includes(needle)) v.push(what);
  if (!c.includes('IF positive=0 OR positive+moved<>jsonb_array_length(o.manifest)'))
    v.push('a manifest member can be unaccounted for');
  if (!c.includes('IF NOT seat_found OR seat.stack IS DISTINCT FROM expected'))
    v.push('a remaining chair need not hold its boundary stack plus its purchases');
  if (/UPDATE public\.|INSERT INTO public\.|DELETE FROM/.test(c)) v.push('the proof writes rows');
  return v;
}

/** Undo the door edit; what is left must be the door production held. */
function undoDoor(after: string): string {
  const a = after.indexOf(' -- A break a now-dead generation BEGAN');
  const b = after.indexOf(
    " IF o.state<>'park_requested' OR o.manifest IS NOT NULL THEN RAISE EXCEPTION",
    a
  );
  const tailStart = after.indexOf(
    ' proof:=smarter_private.f06_movement_prior(p_tournament_id,p_table_id);\n',
    b
  );
  const tailEnd = after.indexOf(' END IF;\n', tailStart) + ' END IF;\n'.length;
  return (
    after.slice(0, a) +
    after.slice(b, tailStart) +
    ' proof:=smarter_private.f06_movement_prior(p_tournament_id,p_table_id);\n' +
    after.slice(tailEnd)
  );
}

describe('a break its dead generation began is finished by its successor', () => {
  const door = body(FILE, DOOR_SIG);
  const proof = body(FILE, PROOF_SIG);
  const prior = body(ORIGINAL, PRIOR_SIG);
  const before = body(ORIGINAL, DOOR_SIG);

  it('starts from the definitions production held and lands the ones it asserts (md5 pinned)', () => {
    expect(md5(before)).toBe(DOOR_PRE_MD5);
    expect(md5(prior)).toBe(PRIOR_MD5);
    expect(md5(undoDoor(door))).toBe(DOOR_PRE_MD5);
    expect(FILE).toContain(`md5(p.prosrc) = '${DOOR_PRE_MD5}'`);
    expect(FILE).toContain(`md5(p.prosrc) = '${PRIOR_MD5}'`);
    expect(FILE).toContain(`md5(p.prosrc) = '${md5(door)}'`);
    expect(FILE).toContain(`md5(p.prosrc) = '${md5(proof)}'`);
  });

  it('rebuilds the proof only for an abandoned begun break, from rows (bodies in force)', () => {
    expect(doorViolations(door)).toEqual([]);
    expect(proofViolations(proof)).toEqual([]);
  });

  it('refutes the door that froze the event (negative proof)', () => {
    expect(doorViolations(before)).toEqual([
      'a break a dead generation began can never be finished',
    ]);
  });

  it('goes red when any one witness is dropped (planted regressions)', () => {
    const plant = (src: string, from: string, to: string, check: (s: string) => string[]) => {
      expect(src.includes(from), from).toBe(true);
      return check(src.replace(from, to));
    };
    expect(
      plant(
        door,
        ' AND o.origin_generation IS DISTINCT FROM p_lease_generation',
        '',
        doorViolations
      )
    ).toContain('the rebuilt proof is reachable outside an abandoned begun break');
    expect(
      plant(proof, "OR (w->>'break_id')::uuid IS DISTINCT FROM p_break ", '', proofViolations)
    ).toContain('a winning receipt of another break is accepted');
    expect(
      plant(
        proof,
        " AND wt.type='debit' AND wt.created_at>a.committed_at),0);",
        ' AND wt.created_at>a.committed_at),0);',
        proofViolations
      )
    ).toContain('chips added after the boundary are not counted from the purchase debits');
    expect(plant(proof, ' AND wt.created_at<=joined_at', '', proofViolations)).toContain(
      'a renewed chair is accepted without the rebuy that renewed it'
    );
    expect(
      plant(
        proof,
        'IF positive=0 OR positive+moved<>jsonb_array_length(o.manifest)',
        'IF positive=0',
        proofViolations
      )
    ).toContain('a manifest member can be unaccounted for');
  });

  it('is private, one transaction, with a preimage and a postimage', () => {
    expect(FILE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(FILE.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(FILE).toMatch(/SET LOCAL lock_timeout/);
    expect(FILE).toContain(
      'REVOKE ALL ON FUNCTION smarter_private.f06_movement_abandoned_begun_proof(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;'
    );
    expect(FILE).not.toMatch(/GRANT [^;]*f06_movement_abandoned_begun_proof/);
    expect(FILE).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_f06_admit_parked_movement(uuid,uuid,uuid,bigint,uuid,uuid,uuid,bigint) TO service_role;'
    );
  });
});

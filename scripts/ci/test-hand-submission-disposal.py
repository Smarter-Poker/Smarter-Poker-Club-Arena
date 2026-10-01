#!/usr/bin/env python3
"""A hand the table has already dealt past is disposed, and stops blocking the start.

LAW (20260928001934_a_hand_the_table_has_already_dealt_past_is_disposed)

  A retained settlement request whose table has since COMMITTED A LATER HAND,
  which has no commit and no hand_history of its own, no successor claim, no
  open dispatch, no unresolved F06 permit and a dealer generation that holds no
  lease, is disposed at ZERO CREDIT - and the table can start again, because
  fn_ca_resume_hand_submission no longer selects it.

  The door REFUSES, and REPORTS which proof is missing, whenever it cannot
  prove the hand is dead. It never guesses. A refused hand keeps blocking the
  start, which is the correct outcome: a hand that might still settle must not
  be thrown away to make a table green.

WHY THIS TEST EXISTS. On 2026-09-28, 141,579 retained submissions sat on 85
live tables that had dealt past them; the resume door picked the oldest every
time, the handoff refused, and those tables could never deal again. The fix
disposes the provably dead ones. The failure mode of such a fix is that it
disposes one that was NOT dead - a hand somebody could still have settled -
and that silently destroys a real pot. So the refusals below are not edge
cases around the feature; they ARE the feature.

It applies the RECORDED migration, byte for byte, to a disposable PG17
cluster. Nothing here retypes the door.
"""
import argparse, datetime, hashlib, json, re, signal, sys
from pathlib import Path
sys.dont_write_bytecode = True
from satellite_qualifier_fixture import module, lit, sha

MIGRATION = Path("supabase/migrations/20260928001934_a_hand_the_table_has_already_dealt_past_is_disposed.sql")
# The repo's own most recent full definition of the door the migration patches.
RESUME_BASE = Path("supabase/migrations/20260926091630_a_retained_hand_commits_past_a_seat_taken_after_its_deal.sql")
WORLD = Path("scripts/ci/fixtures/hand-submission-disposal/world.sql")

TABLE    = '9a000000-0000-4000-8000-000000000001'
ORPHAN   = '9a100000-0000-4000-8000-000000000001'
DEAD_GEN = '9a200000-0000-4000-8000-000000000001'
LIVE_GEN = '9a200000-0000-4000-8000-000000000002'
WITNESS  = '9a300000-0000-4000-8000-000000000001'
PERMIT   = '9a400000-0000-4000-8000-000000000001'
RECEIPT  = '9a500000-0000-4000-8000-000000000001'
RECEIPT2 = '9a500000-0000-4000-8000-000000000002'
ABSENT   = '9a000000-0000-4000-8000-0000000000ff'
SEATED   = '9a600000-0000-4000-8000-000000000001'
# public.hand_atomic_commits requires hand_number >= 1000000 and a 64-hex
# payload hash; the fixture honours the live constraints, not a convenient one.
ORPHAN_HAND, WITNESS_HAND = 1000100, 1000105
# The door refuses a reason under 40 characters: a disposal is a ruling and a
# ruling states itself.
REASON = 'superseded by a later committed hand on the same table; nothing of this hand is durable'

AUTHORITY = "SET request.jwt.claim.role='service_role';\nSET app.smarter_data_actor='service';\n"

# The table is CASH (tournament_id IS NULL): the fleet's 81 stuck cash tables
# are the population this ruling was written for.
SEED = f"""
INSERT INTO public.tables (id, name, game_type) VALUES ({lit(TABLE)}, 'Disposal Law Table', 'cash');
INSERT INTO public.table_seats (table_id, seat_number, user_id, active_game_scope, active_parent_key)
VALUES ({lit(TABLE)}, 1, {lit(SEATED)}, 'table:' || {lit(TABLE)}, 'table:' || {lit(TABLE)});

-- THE WITNESS: a later hand this very table committed and completed. Its
-- commit consumed the stacks the orphan names, so the orphan can never apply.
INSERT INTO public.hand_atomic_commits
  (table_id, hand_number, hand_id, payload_hash, stack_result, committed_at,
   post_commit_payload, post_commit_payload_hash, post_commit_completed_at, post_commit_result)
VALUES ({lit(TABLE)}, {WITNESS_HAND}, {lit(WITNESS)}, md5('witness-payload') || md5('witness-payload'), '{{}}'::jsonb,
        clock_timestamp() - interval '1 hour', '{{}}'::jsonb, md5('witness-post') || md5('witness-post'),
        clock_timestamp() - interval '1 hour', '{{"ok":"true"}}'::jsonb);

-- THE ORPHAN: retained by a dealer that died, never committed, never written
-- to history, retained long past any settlement's statement timeout.
INSERT INTO smarter_private.hand_submissions
  (submission_id, table_id, hand_number, instance_id, lease_generation, request, request_hash, retained_at)
VALUES ({lit(ORPHAN)}, {lit(TABLE)}, {ORPHAN_HAND}, 'dealer-that-died', {lit(DEAD_GEN)},
        '{{"p_stacks": []}}'::jsonb, md5('orphan-request') || md5('orphan-request'), clock_timestamp() - interval '2 hours');

-- The table's lease is held by a LATER generation: the orphan's dealer owns
-- nothing and can never settle.
INSERT INTO public.engine_table_leases
  (table_id, instance_id, lease_generation, protocol_version, heartbeat_at)
VALUES ({lit(TABLE)}, 'successor-one', {lit(LIVE_GEN)}, 2, clock_timestamp());
"""


def call(receipt=RECEIPT, reason=REASON, limit=2000, table=TABLE):
    return (f"public.fn_ca_dispose_superseded_hand_submissions("
            f"{lit(table)}, {lit(receipt)}, {lit(reason)}, {limit})")


def blocks(case):
    """The orphan is still selected, so the table still refuses to start.

    The resume door returns found=false the moment its selection is empty; it
    only reaches the lease check when it HAS selected a submission. So a lease
    refusal is proof of selection, and it is shallow enough to be about
    selection and nothing else."""
    return AUTHORITY + f"""
DO $blocks$
DECLARE r jsonb; got text;
BEGIN
  BEGIN
    r := public.fn_ca_resume_hand_submission({lit(TABLE)}, 'nobody', {lit(ABSENT)});
    got := 'returned ' || r::text;
  EXCEPTION WHEN SQLSTATE '55000' THEN got := SQLERRM;
  END;
  IF got IS DISTINCT FROM 'HAND_SUBMISSION_LEASE_UNPROVEN' THEN
    RAISE EXCEPTION 'the refused hand stopped blocking the start (%): %', {lit(case)}, got;
  END IF;
  RAISE NOTICE 'DISPOSAL PASS: still-blocks-%', {lit(case)};
END $blocks$;
"""


def refusal(case, mutation, reason_code):
    """One missing proof; the door leaves the hand alone and names what it could
    not prove, and the hand goes on blocking the start."""
    return AUTHORITY + mutation + f"""
DO $refuse$
DECLARE r jsonb; named text;
BEGIN
  r := {call()};
  IF (r->>'disposed')::int <> 0 THEN
    RAISE EXCEPTION 'the door disposed a hand it cannot prove dead (%): %', {lit(case)}, r;
  END IF;
  IF (r->>'credit')::int <> 0 THEN
    RAISE EXCEPTION 'a disposal credited chips (%): %', {lit(case)}, r;
  END IF;
  named := r->'blocked'->0->>'reason';
  IF named IS DISTINCT FROM {lit(reason_code)} THEN
    RAISE EXCEPTION 'the door did not report the missing proof (%): expected %, got %',
      {lit(case)}, {lit(reason_code)}, COALESCE(named, '<nothing>');
  END IF;
  IF (r->>'candidates')::int <> 1 THEN
    RAISE EXCEPTION 'the refused hand was not even considered (%): %', {lit(case)}, r;
  END IF;
  IF EXISTS (SELECT 1 FROM smarter_private.hand_submission_disposals) THEN
    RAISE EXCEPTION 'a refusal still wrote a receipt (%)', {lit(case)};
  END IF;
  RAISE NOTICE 'DISPOSAL PASS: refuses-%', {lit(case)};
END $refuse$;
""" + blocks(case)


GRANT_CASE = AUTHORITY + f"""
-- Before: the orphan is what the table's start trips over.
""" + blocks('before-disposal') + f"""
DO $grant$
DECLARE r jsonb; d smarter_private.hand_submission_disposals;
BEGIN
  r := {call()};
  IF (r->>'ok')::boolean IS DISTINCT FROM true OR (r->>'disposed')::int <> 1 THEN
    RAISE EXCEPTION 'the provably dead hand was not disposed: %', r;
  END IF;
  IF (r->>'credit')::int <> 0 THEN
    RAISE EXCEPTION 'the disposal was not at zero credit: %', r;
  END IF;
  IF (r->>'candidates')::int <> 1 OR r->'blocked' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'the disposal reported something it did not do: %', r;
  END IF;
  IF (r->>'witness_hand_number')::bigint <> {WITNESS_HAND} THEN
    RAISE EXCEPTION 'the disposal named the wrong witness: %', r;
  END IF;
  SELECT * INTO d FROM smarter_private.hand_submission_disposals;
  IF d.hand_number <> {ORPHAN_HAND} OR d.submission_id <> {lit(ORPHAN)}
     OR d.receipt_id <> {lit(RECEIPT)} OR d.witness_hand_number <> {WITNESS_HAND} THEN
    RAISE EXCEPTION 'the receipt does not describe the disposed hand: %', to_jsonb(d);
  END IF;
  IF d.expected->>'kind' IS DISTINCT FROM 'superseded_retained_submission'
     OR d.expected->>'dealer_generation' IS DISTINCT FROM {lit(DEAD_GEN)} THEN
    RAISE EXCEPTION 'the receipt does not carry its evidence: %', d.expected;
  END IF;
  RAISE NOTICE 'DISPOSAL PASS: disposes-the-provably-dead-hand';
END $grant$;

-- The whole point: the table can start.
DO $freed$
DECLARE r jsonb;
BEGIN
  r := public.fn_ca_resume_hand_submission({lit(TABLE)}, 'nobody', {lit(ABSENT)});
  IF r->>'found' IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'the disposed hand still blocks the table start: %', r;
  END IF;
  RAISE NOTICE 'DISPOSAL PASS: disposed-hand-stops-blocking-the-start';
END $freed$;

-- Nothing of the hand's own record was rewritten: 'retained' WAS the truth.
DO $history$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM smarter_private.hand_submissions
                  WHERE submission_id = {lit(ORPHAN)}) THEN
    RAISE EXCEPTION 'the disposal deleted the submission instead of receipting it';
  END IF;
  IF EXISTS (SELECT 1 FROM public.hand_atomic_commits
              WHERE table_id = {lit(TABLE)} AND hand_number = {ORPHAN_HAND}) THEN
    RAISE EXCEPTION 'the disposal invented a commit';
  END IF;
  RAISE NOTICE 'DISPOSAL PASS: disposal-rewrites-no-history';
END $history$;

-- Replay on the receipt: the same ruling twice is the same ruling once.
DO $replay$
DECLARE r jsonb;
BEGIN
  r := {call()};
  IF (r->>'replayed')::boolean IS DISTINCT FROM true OR (r->>'disposed')::int <> 1
     OR (r->>'credit')::int <> 0 THEN
    RAISE EXCEPTION 'the receipt did not replay: %', r;
  END IF;
  IF (SELECT count(*) FROM smarter_private.hand_submission_disposals) <> 1 THEN
    RAISE EXCEPTION 'a replay wrote a second receipt';
  END IF;
  RAISE NOTICE 'DISPOSAL PASS: replay-is-the-same-ruling';
END $replay$;

-- The receipt is append-only.
DO $immutable$
DECLARE got text;
BEGIN
  FOR got IN SELECT unnest(ARRAY['UPDATE smarter_private.hand_submission_disposals SET reason = reason',
                                 'DELETE FROM smarter_private.hand_submission_disposals']) LOOP
    BEGIN
      EXECUTE got;
      RAISE EXCEPTION 'the receipt was not append-only: % succeeded', got;
    EXCEPTION WHEN SQLSTATE '55000' THEN
      IF SQLERRM <> 'HAND_SUBMISSION_IMMUTABLE' THEN RAISE; END IF;
    END;
  END LOOP;
  RAISE NOTICE 'DISPOSAL PASS: receipt-is-append-only';
END $immutable$;

-- A disposal receipt is an accepted disposition, so the hand's saved state can
-- be closed. Without the receipt the same write is refused.
DO $snapshot$
DECLARE got text;
BEGIN
  INSERT INTO public.hand_state_snapshots
    (table_id, hand_number, state_json, config_json, dealer_seat, players_json, is_complete)
  VALUES ({lit(TABLE)}, {ORPHAN_HAND}, '{{}}'::jsonb, '{{}}'::jsonb, 1, '[]'::jsonb, true);
  RAISE NOTICE 'DISPOSAL PASS: disposal-receipt-closes-the-snapshot';

  INSERT INTO smarter_private.hand_submission_dispositions
    (table_id, hand_number, disposition, submission_id)
  VALUES ({lit(TABLE)}, 777, 'retained', {lit(RECEIPT2)});
  BEGIN
    INSERT INTO public.hand_state_snapshots
      (table_id, hand_number, state_json, config_json, dealer_seat, players_json, is_complete)
    VALUES ({lit(TABLE)}, 777, '{{}}'::jsonb, '{{}}'::jsonb, 1, '[]'::jsonb, true);
    RAISE EXCEPTION 'a retained hand with no receipt was allowed to close';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM <> 'HAND_SUBMISSION_ACCEPTANCE_REQUIRED_FOR_COMPLETION' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'DISPOSAL PASS: no-receipt-no-close';
END $snapshot$;
"""

AUTHORITY_CASES = f"""
{AUTHORITY}
DO $who$
DECLARE r jsonb; got text;
BEGIN
  -- Only the service role, and only a named service actor.
  SET LOCAL request.jwt.claim.role = 'authenticated';
  BEGIN r := {call()}; got := 'allowed';
  EXCEPTION WHEN SQLSTATE '42501' THEN got := SQLERRM; END;
  IF got <> 'HAND_DISPOSAL_SERVICE_REQUIRED' THEN
    RAISE EXCEPTION 'a non-service caller was let in: %', got;
  END IF;
  -- the role is right again; now the actor is the one that is wrong
  SET LOCAL request.jwt.claim.role = 'service_role';
  SET LOCAL app.smarter_data_actor = 'anybody';
  BEGIN r := {call()}; got := 'allowed';
  EXCEPTION WHEN SQLSTATE '42501' THEN got := SQLERRM; END;
  IF got <> 'HAND_DISPOSAL_SERVICE_REQUIRED' THEN
    RAISE EXCEPTION 'an unnamed actor was let in: %', got;
  END IF;
  RAISE NOTICE 'DISPOSAL PASS: refuses-a-caller-that-is-not-the-service';
END $who$;

DO $stated$
DECLARE r jsonb; got text;
BEGIN
  BEGIN r := {call(reason='too short to be a ruling')}; got := 'allowed';
  EXCEPTION WHEN SQLSTATE '22023' THEN got := SQLERRM; END;
  IF got <> 'HAND_DISPOSAL_IDENTITY_REQUIRED' THEN
    RAISE EXCEPTION 'an unstated ruling was accepted: %', got;
  END IF;
  RAISE NOTICE 'DISPOSAL PASS: refuses-an-unstated-ruling';
END $stated$;

DO $frozen$
DECLARE r jsonb; got text;
BEGIN
  SET LOCAL app.test_platform_frozen = 'true';
  BEGIN r := {call()}; got := 'allowed';
  EXCEPTION WHEN SQLSTATE '55000' THEN got := SQLERRM; END;
  IF got NOT LIKE 'PLATFORM_FROZEN%' THEN
    RAISE EXCEPTION 'the door ran under the platform freeze: %', got;
  END IF;
  IF EXISTS (SELECT 1 FROM smarter_private.hand_submission_disposals) THEN
    RAISE EXCEPTION 'a frozen refusal still wrote a receipt';
  END IF;
  RAISE NOTICE 'DISPOSAL PASS: refuses-under-the-platform-freeze';
END $frozen$;

DO $missing$
DECLARE r jsonb; got text;
BEGIN
  BEGIN r := {call(table=ABSENT)}; got := 'allowed';
  EXCEPTION WHEN SQLSTATE '55000' THEN got := SQLERRM; END;
  IF got <> 'HAND_DISPOSAL_TABLE_MISSING' THEN
    RAISE EXCEPTION 'the door ruled on a table that does not exist: %', got;
  END IF;
  RAISE NOTICE 'DISPOSAL PASS: refuses-a-table-that-does-not-exist';
END $missing$;
""" + blocks('authority-refusals')

# Each refusal: the one proof that is missing, and the word the door must say.
REFUSALS = [
    ('hand-history-exists',
     f"INSERT INTO public.hand_history (table_id, hand_number) VALUES ({lit(TABLE)}, {ORPHAN_HAND});\n",
     'hand_history_exists'),
    ('a-successor-claim-was-spent',
     f"INSERT INTO smarter_private.hand_submission_handoffs"
     f" (submission_id, original_generation, instance_id, lease_generation, request_hash, transaction_id)"
     f" VALUES ({lit(ORPHAN)}, {lit(DEAD_GEN)}, 'successor-one', {lit(LIVE_GEN)},"
     f" md5('orphan-request') || md5('orphan-request'), 1);\n",
     'successor_claim_spent'),
    ('a-dispatch-is-open',
     f"INSERT INTO smarter_private.hand_submission_dispatch"
     f" (transaction_id, submission_id, request_hash, instance_id, lease_generation)"
     f" VALUES (1, {lit(ORPHAN)}, md5('orphan-request') || md5('orphan-request'),"
     f" 'successor-one', {lit(LIVE_GEN)});\n",
     'handoff_dispatch_open'),
    ('an-f06-permit-is-reserved',
     f"INSERT INTO smarter_private.f06_hand_permits"
     f" (permit_id, tournament_id, table_id, lifecycle, hand_number, custody_id, generation, state)"
     f" VALUES ({lit(PERMIT)}, {lit(ABSENT)}, {lit(TABLE)}, 1, {ORPHAN_HAND}, {lit(ABSENT)}, {lit(DEAD_GEN)}, 'reserved');\n",
     'f06_permit_unresolved'),
    ('an-f06-permit-is-accepted',
     f"INSERT INTO smarter_private.f06_hand_permits"
     f" (permit_id, tournament_id, table_id, lifecycle, hand_number, custody_id, generation, state)"
     f" VALUES ({lit(PERMIT)}, {lit(ABSENT)}, {lit(TABLE)}, 1, {ORPHAN_HAND}, {lit(ABSENT)}, {lit(DEAD_GEN)}, 'accepted');\n",
     'f06_permit_unresolved'),
    ('the-dealer-generation-still-holds-the-lease',
     f"UPDATE public.engine_table_leases SET lease_generation = {lit(DEAD_GEN)}"
     f" WHERE table_id = {lit(TABLE)};\n",
     'dealer_generation_still_leased'),
    ('it-was-retained-moments-ago',
     f"UPDATE smarter_private.hand_submissions"
     f" SET retained_at = clock_timestamp() - interval '5 minutes'"
     f" WHERE submission_id = {lit(ORPHAN)};\n",
     'retained_too_recently'),
]

# A witness is a LATER commit by this same table. No commit at all, or only an
# earlier one, is not a witness - and without one nothing is provably dead.
NO_WITNESS = AUTHORITY + f"""
DELETE FROM public.hand_atomic_commits WHERE table_id = {lit(TABLE)};
DO $none$
DECLARE r jsonb; got text;
BEGIN
  BEGIN r := {call()}; got := 'allowed';
  EXCEPTION WHEN SQLSTATE '55000' THEN got := SQLERRM; END;
  IF got <> 'HAND_DISPOSAL_NO_WITNESS' THEN
    RAISE EXCEPTION 'the door disposed with no committed hand to point at: %', got;
  END IF;
  IF EXISTS (SELECT 1 FROM smarter_private.hand_submission_disposals) THEN
    RAISE EXCEPTION 'a witnessless refusal still wrote a receipt';
  END IF;
  RAISE NOTICE 'DISPOSAL PASS: refuses-when-no-hand-committed-at-all';
END $none$;
""" + blocks('no-commit-at-all')

EARLIER_ONLY = AUTHORITY + f"""
DELETE FROM public.hand_atomic_commits WHERE table_id = {lit(TABLE)};
INSERT INTO public.hand_atomic_commits
  (table_id, hand_number, hand_id, payload_hash, stack_result, committed_at,
   post_commit_payload, post_commit_payload_hash, post_commit_completed_at, post_commit_result)
VALUES ({lit(TABLE)}, {ORPHAN_HAND - 50}, {lit(WITNESS)}, md5('earlier-payload') || md5('earlier-payload'), '{{}}'::jsonb,
        clock_timestamp() - interval '9 hours', '{{}}'::jsonb, md5('earlier-post') || md5('earlier-post'),
        clock_timestamp() - interval '9 hours', '{{"ok":"true"}}'::jsonb);
DO $earlier$
DECLARE r jsonb;
BEGIN
  r := {call()};
  IF (r->>'disposed')::int <> 0 OR (r->>'candidates')::int <> 0 THEN
    RAISE EXCEPTION 'an EARLIER commit was treated as proof the table dealt past: %', r;
  END IF;
  IF EXISTS (SELECT 1 FROM smarter_private.hand_submission_disposals) THEN
    RAISE EXCEPTION 'an earlier-commit refusal still wrote a receipt';
  END IF;
  RAISE NOTICE 'DISPOSAL PASS: refuses-when-the-only-commit-is-earlier';
END $earlier$;
""" + blocks('only-an-earlier-commit')


# The snapshot guard as it stood BEFORE this migration, built from the
# migration's own text by removing the one clause it adds - and checked against
# the body md5 that 20260918232101 recorded for the predecessor on 2026-09-18.
# If the migration ever changes more of this guard than the disposal clause,
# this test stops rather than pinning a guess.
GUARD_CLAUSE = (" IF EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals dd\n"
                "   WHERE dd.table_id=NEW.table_id AND dd.hand_number=NEW.hand_number)"
                " THEN RETURN NEW; END IF;\n")
GUARD_BEFORE_MD5 = '02f37342e61d71aeee2cd67ce701d678'
GUARD_TRIGGER = ("CREATE TRIGGER hand_submission_snapshot_guard"
                 " AFTER INSERT OR UPDATE OF is_complete ON public.hand_state_snapshots"
                 " FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_snapshot_guard();")


def snapshot_guard_base(root):
    src = (root / MIGRATION).read_text()
    a = src.index('CREATE OR REPLACE FUNCTION smarter_private.hand_submission_snapshot_guard()')
    b = src.index('$function$;', src.index('AS $function$', a)) + len('$function$;')
    text = src[a:b]
    st = text.index('AS $function$') + len('AS $function$')
    en = text.index('$function$', st)
    body = text[st:en]
    if body.count(GUARD_CLAUSE) != 1:
        raise RuntimeError('the migration no longer adds the disposal clause exactly once')
    before = body.replace(GUARD_CLAUSE, '', 1)
    if hashlib.md5(before.encode()).hexdigest() != GUARD_BEFORE_MD5:
        raise RuntimeError('the migration changes more of the snapshot guard than the disposal clause')
    return text[:st] + before + text[en:] + '\n' + GUARD_TRIGGER + '\n'


def resume_base(root):
    """The repo's own most recent full definition of the door the DO block
    patches. Extracted, never retyped."""
    src = (root / RESUME_BASE).read_text()
    a = src.index('CREATE OR REPLACE FUNCTION public.fn_ca_resume_hand_submission(')
    b = src.index('$function$;', src.index('AS $function$', a)) + len('$function$;')
    text = src[a:b]
    anchor = (' WHERE j.table_id=p_table_id AND (c.hand_id IS DISTINCT FROM j.submission_id'
              ' OR c.post_commit_completed_at IS NULL\n')
    if text.count(anchor) != 1:
        raise RuntimeError('the recorded resume base no longer carries the migration anchor exactly once')
    return text


def expect(execution, database, sql, label, passes):
    code, out, err = execution.sql(database, sql, label=label, check=False)
    if code or re.search(r'^(?:[a-z_]+: )?(ERROR|FATAL|PANIC)', out + '\n' + err, re.M):
        raise RuntimeError(f'{label} failed:\n{err.strip() or out.strip()}')
    seen = re.findall(r'NOTICE:\s*DISPOSAL PASS: (\S+)', err)
    if len(seen) != passes:
        raise RuntimeError(f'{label}: expected {passes} proven assertions, saw {len(seen)}: {seen}')
    return seen



FINAL_SCOPE = Path("supabase/migrations/20260928133817_the_disposal_batch_says_which_rows_it_clears.sql")
FINAL_MIGRATION = Path("supabase/migrations/20260928134553_a_request_that_can_never_apply_is_disposed_and_an_accepted_permit_is_settlement.sql")


def qualify_final(execution, base, root):
    """The original proofs above retain the historical door. This runs its final
    installed successor, with the real retention constraint already installed.
    Writes are confined to clones of this invocation's empty native database.
    """
    e = execution
    for file in (FINAL_SCOPE, FINAL_MIGRATION):
        e.sql(base, file=root / file, label='final-' + file.name[:14], seconds=120)
    _, actual, _ = e.sql(base, "SELECT md5(pg_get_functiondef('public.fn_ca_dispose_superseded_hand_submissions(uuid,uuid,text,integer)'::regprocedure));", label='final-disposal-catalog')
    if actual.strip() != '4333dc1291933bf9296956903952ea6b':
        raise RuntimeError('final fixture door differs from observed production: ' + actual)
    e.report['final_disposal_definition_md5'] = actual.strip()
    seeded = e.database(base)
    e.sql(seeded, SEED, label='final-seed')
    no_witness = f"DELETE FROM public.hand_atomic_commits WHERE table_id={lit(TABLE)};\n"
    named_request = f"""
UPDATE smarter_private.hand_submissions SET request=jsonb_build_object('p_stacks',
 (SELECT jsonb_agg(jsonb_build_object('seat_id',id,'user_id',user_id,
   'seat_joined_at',joined_at,'stack_before',stack)) FROM public.table_seats WHERE table_id={lit(TABLE)}))
 WHERE submission_id={lit(ORPHAN)};
"""
    permit = (f"INSERT INTO smarter_private.f06_hand_permits"
              f" (permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state,evidence_id)"
              f" VALUES ({lit(PERMIT)},{lit(ABSENT)},{lit(TABLE)},1,{ORPHAN_HAND},{lit(ABSENT)},{lit(DEAD_GEN)},'accepted',")

    def allowed(name, mutation, basis):
        return AUTHORITY + mutation + f"""
DO $final$
DECLARE r jsonb; again jsonb; before_seats jsonb; after_seats jsonb; d smarter_private.hand_submission_disposals;
BEGIN
  SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) INTO before_seats FROM public.table_seats s;
  r := {call()};
  IF (r->>'disposed')::int IS DISTINCT FROM 1 OR (r->>'credit')::numeric IS DISTINCT FROM 0
     OR r->'blocked' <> '[]'::jsonb OR r->'bases'->0->>'basis' IS DISTINCT FROM {lit(basis)} THEN
    RAISE EXCEPTION 'final positive {name} differs: %', r;
  END IF;
  SELECT * INTO STRICT d FROM smarter_private.hand_submission_disposals;
  IF d.expected->>'kind' IS DISTINCT FROM {lit(basis)} OR d.witness_hand_number <> d.hand_number THEN
    RAISE EXCEPTION 'final self witness differs: %', to_jsonb(d);
  END IF;
  SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) INTO after_seats FROM public.table_seats s;
  IF before_seats IS DISTINCT FROM after_seats OR EXISTS(SELECT 1 FROM public.hand_history)
     OR EXISTS(SELECT 1 FROM public.hand_atomic_commits) THEN
    RAISE EXCEPTION 'disposal changed seats or invented settlement';
  END IF;
  again := {call()};
  IF (again->>'replayed')::boolean IS DISTINCT FROM true OR (SELECT count(*) FROM smarter_private.hand_submission_disposals) <> 1 THEN
    RAISE EXCEPTION 'final replay changed outcome: %', again;
  END IF;
  r := public.fn_ca_resume_hand_submission({lit(TABLE)},'nobody',{lit(ABSENT)});
  IF (r->>'found')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'disposed request still selected: %',r; END IF;
  RAISE NOTICE 'DISPOSAL PASS: final-{name}';
END $final$;
"""

    positives = [('accepted-permit-evidence', no_witness + permit + lit(ABSENT) + ');\n', 'settled_under_accepted_permit')]
    for name, change in [
        ('seat-left',f"UPDATE public.table_seats SET left_at=clock_timestamp(),active_game_scope=NULL,active_parent_key=NULL WHERE table_id={lit(TABLE)};"),
        ('seat-user-changed',f"UPDATE public.table_seats SET user_id={lit(ABSENT)} WHERE table_id={lit(TABLE)};"),
        ('seat-joined-changed',f"UPDATE public.table_seats SET joined_at=joined_at+interval '1 second' WHERE table_id={lit(TABLE)};"),
        ('seat-stack-changed',f"UPDATE public.table_seats SET stack=stack+1 WHERE table_id={lit(TABLE)};"),
    ]:
        positives.append((name,no_witness+named_request+change,'request_can_never_apply'))
    for name, mutation, basis in positives:
        case=e.database(seeded)
        e.report['proven'].append({'case':'final-'+name,'passes':expect(e,case,allowed(name,mutation,basis),'final-'+name,1)})
        e.discard(case)

    negatives = [
        ('still-applicable',no_witness+named_request,'still_applicable_leave_to_handoff'),
        ('accepted-without-evidence',no_witness+permit+'NULL);\n','still_applicable_leave_to_handoff'),
    ]
    # Each earlier obstruction still refuses even when a named chair changed.
    for name, mutation, reason in REFUSALS:
        if name == 'an-f06-permit-is-accepted': continue
        negatives.append((name,no_witness+named_request+f"UPDATE public.table_seats SET stack=stack+1 WHERE table_id={lit(TABLE)};\n"+mutation,reason))
    for name,mutation,reason in negatives:
        case=e.database(seeded)
        e.report['proven'].append({'case':'final-'+name,'passes':expect(e,case,refusal(name,mutation,reason),'final-'+name,2)})
        e.discard(case)
    case=e.database(seeded)
    e.report['proven'].append({'case':'final-authority','passes':expect(e,case,AUTHORITY_CASES,'final-authority',5)})
    e.discard(case)
    e.discard(seeded)

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--evidence', type=Path, required=True)
    p.add_argument('--pg-bin', type=Path, required=True)
    args = p.parse_args()
    root = Path(__file__).resolve().parents[2]
    out = args.evidence.resolve()
    out.mkdir(parents=True, exist_ok=False)
    native = module(root / 'scripts/ci/test-mtt-unlimited.py', 'hand_disposal_execution')
    e = native.Execution(root, out, args.pg_bin.resolve(), out, 600)
    e.report['source_sha256'] = {str(p): sha(root / p) for p in
                                 [Path(__file__).relative_to(root), MIGRATION, RESUME_BASE, WORLD]}
    e.report['proven'] = []
    for signum in native.CANCELLATION_SIGNALS:
        signal.signal(signum, native.interrupted)
    try:
        e.start()

        # ── The world, and the door as it stands BEFORE this migration ──────
        base = e.database()
        e.sql(base, file=root / WORLD, label='world', seconds=120)
        e.sql(base, resume_base(root), label='resume-door-before')
        e.sql(base, snapshot_guard_base(root), label='snapshot-guard-before')
        e.report['snapshot_guard_before_md5'] = GUARD_BEFORE_MD5

        # ── Without the fix, the law does not hold. Proven, not asserted. ───
        before = e.database(base)
        e.sql(before, SEED, label='unfixed-seed')
        code, _, err = e.sql(before, AUTHORITY + f"SELECT {call()};", label='unfixed-door', check=False)
        if code == 0 or 'fn_ca_dispose_superseded_hand_submissions' not in err:
            raise RuntimeError('the disposal door existed before its own migration')
        expect(e, before, blocks('without-the-migration'), 'unfixed-still-blocked', 1)
        e.report['proven'].append({'case': 'without-the-migration',
                                   'door_absent': True, 'table_still_blocked': True})
        e.discard(before)

        # ── Apply the RECORDED migration, byte for byte ─────────────────────
        e.sql(base, file=root / MIGRATION, label='recorded-migration', seconds=120)
        _, patched, _ = e.sql(base, "SELECT (length(d) - length(replace(d,'hand_submission_disposals','')))"
                                    " / length('hand_submission_disposals') FROM (SELECT"
                                    " pg_get_functiondef('public.fn_ca_resume_hand_submission(uuid,text,uuid)'"
                                    "::regprocedure) d) t;", label='resume-patched')
        if patched.strip() != '1':
            raise RuntimeError('the in-place resume edit did not land exactly once: ' + patched.strip())
        e.report['resume_patch_occurrences'] = 1

        # Applying the recorded migration twice is a no-op, not a second edit.
        e.sql(base, file=root / MIGRATION, label='recorded-migration-replay', seconds=120)
        _, again, _ = e.sql(base, "SELECT (length(d) - length(replace(d,'hand_submission_disposals','')))"
                                  " / length('hand_submission_disposals') FROM (SELECT"
                                  " pg_get_functiondef('public.fn_ca_resume_hand_submission(uuid,text,uuid)'"
                                  "::regprocedure) d) t;", label='resume-patched-replay')
        if again.strip() != '1':
            raise RuntimeError('replaying the migration edited the resume door twice: ' + again.strip())
        e.report['migration_is_idempotent'] = True

        seeded = e.database(base)
        e.sql(seeded, SEED, label='seed')

        # ── The ruling ──────────────────────────────────────────────────────
        case = e.database(seeded)
        e.report['proven'].append({'case': 'disposes-the-provably-dead-hand',
                                   'passes': expect(e, case, GRANT_CASE, 'grant', 8)})
        e.discard(case)

        # ── The refusals ────────────────────────────────────────────────────
        for name, mutation, reason_code in REFUSALS:
            case = e.database(seeded)
            e.report['proven'].append({'case': name, 'reported': reason_code,
                                       'passes': expect(e, case, refusal(name, mutation, reason_code), name, 2)})
            e.discard(case)

        for name, script, passes in [('no-commit-at-all', NO_WITNESS, 2),
                                     ('only-an-earlier-commit', EARLIER_ONLY, 2),
                                     ('authority', AUTHORITY_CASES, 5)]:
            case = e.database(seeded)
            e.report['proven'].append({'case': name, 'passes': expect(e, case, script, name, passes)})
            e.discard(case)

        for path, digest in e.report['source_sha256'].items():
            if sha(root / path) != digest:
                raise RuntimeError('source changed under the run: ' + path)
        e.discard(seeded)
        e.discard(base)
        e.report['status'] = 'passed'
    except BaseException as exc:
        e.report['failure'] = repr(exc)
    finally:
        for signum in native.CANCELLATION_SIGNALS:
            signal.signal(signum, signal.SIG_IGN)
        try:
            e.close()
        except BaseException as exc:
            e.report.update(cleanup_failure=repr(exc), status='failed')
        e.report['ended_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (out / 'result.json').write_text(json.dumps(e.report, indent=2) + '\n')
        print(json.dumps({k: e.report.get(k) for k in ['status', 'failure']}), flush=True)
    return 0 if e.report['status'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())

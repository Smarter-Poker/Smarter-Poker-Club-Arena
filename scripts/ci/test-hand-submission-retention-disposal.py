#!/usr/bin/env python3
"""Retention closes the settlement request it prunes.

LAW (20260928031344_retention_closes_the_settlement_request_it_prunes)

  sp_prune_hand_history deletes a horse hand's public.hand_history and
  public.hand_atomic_commits once it is older than the retention window, but
  it has never touched smarter_private.hand_submissions, which is append-only
  and never pruned. fn_ca_resume_hand_submission decides a table has
  unfinished business by looking for a retained submission whose atomic
  commit is missing or incomplete - and a pruned hand looks exactly like a
  hand that never settled. So retention manufactures a false "unfinished"
  hand on every table whose engine restarts after its hands age out, and the
  successor refuses the stale request forever (HAND_SUBMISSION_HANDOFF_STATE_
  CHANGED).

  The fix: before its DELETEs, sp_prune_hand_history now calls
  smarter_private.hand_submission_retention_disposal(v_doomed, ...), which
  writes the same append-only disposal receipt the supersession law
  (20260928001934) already taught fn_ca_resume_hand_submission to respect -
  so a hand retention prunes is disposed at zero credit in the same
  transaction, and the successor never mistakes it for open again. The
  disposal witness may now be the hand itself (retention) as well as a later
  commit (supersession): the constraint moves from > to >=.

WHY THIS TEST EXISTS. This is the root cause of the recurring fleet-wide
HAND_SUBMISSION_HANDOFF_STATE_CHANGED wedge: not a one-off, but a bug that
refires every ten minutes, forever, on any table whose engine restarts after
its hands age out. The test below proves both directions: run the sweep on
the door as production had it a moment before this migration, on a hand that
settled and simply aged out, and the request is left open - resume() selects
it. Run the SAME sweep after the migration, on an identical hand, and the
request is closed - resume() finds nothing.

It applies both RECORDED migrations, byte for byte, to a disposable PG17
cluster: 20260928001934 (supersession disposal - a prerequisite here, since
retention's receipt is read by the exact guard that migration added to
fn_ca_resume_hand_submission) for real, then 20260928031344 (retention
disposal, under test) for real. sp_prune_hand_history itself has no single
prior migration that fully rewrites it to extract a "before" text from (see
fixtures/hand-submission-retention-disposal/sp_prune_hand_history_before.sql
for why, and how that text was recovered without retyping it). Nothing here
retypes either door.
"""
import argparse, datetime, hashlib, json, re, signal, sys
from pathlib import Path
sys.dont_write_bytecode = True
from satellite_qualifier_fixture import module, lit, sha

# The supersession disposal law: a prerequisite, applied for real, unchanged.
# It creates smarter_private.hand_submission_disposals (which this migration
# ALTERs) and the guard clause in fn_ca_resume_hand_submission that this
# law's own receipt now also satisfies.
DISPOSAL_MIGRATION = Path("supabase/migrations/20260928001934_a_hand_the_table_has_already_dealt_past_is_disposed.sql")
# The repo's own most recent full definitions the two supersession patches
# apply to - extracted, never retyped. Reused unchanged from that law's test.
RESUME_BASE = Path("supabase/migrations/20260926091630_a_retained_hand_commits_past_a_seat_taken_after_its_deal.sql")

# The migration under test.
MIGRATION = Path("supabase/migrations/20260928031344_retention_closes_the_settlement_request_it_prunes.sql")
# sp_prune_hand_history as production had it immediately before MIGRATION -
# recovered by reversing MIGRATION's own DO $patch$ against production's live
# definition, not retyped. See that fixture's header for the two independent
# checks already run against production before this file existed, and the
# THIRD check this test itself performs: MIGRATION's own DO block refuses to
# apply to a body that doesn't carry its anchor exactly once.
PRUNE_BEFORE = Path("scripts/ci/fixtures/hand-submission-retention-disposal/sp_prune_hand_history_before.sql")
PRUNE_BEFORE_MD5 = '2541b09dec48ebed42dbefa5cdd1841e'

WORLD = Path("scripts/ci/fixtures/hand-submission-retention-disposal/world.sql")

AUTHORITY = "SET request.jwt.claim.role='service_role';\nSET app.smarter_data_actor='service';\n"

TABLE    = '9b000000-0000-4000-8000-000000000001'
HORSE    = '9b100000-0000-4000-8000-000000000001'
HAND_ID  = '9b200000-0000-4000-8000-000000000001'
DEAD_GEN = '9b300000-0000-4000-8000-000000000001'
LIVE_GEN = '9b300000-0000-4000-8000-000000000002'
SEATED   = '9b400000-0000-4000-8000-000000000001'
ABSENT   = '9b000000-0000-4000-8000-0000000000ff'
# public.hand_atomic_commits requires hand_number >= 1000000 and a 64-hex
# payload hash; the fixture honours the live constraints, not a convenient one.
HAND_NUMBER = 1000300

# A horse hand that fully settled a month ago: one seat, one commit, COMPLETE
# (post_commit_completed_at set, hand_id = its own submission_id), and a
# retained settlement request - exactly the row hand_submissions never prunes.
# Everything the retention sweep reads is seeded honestly: the hand holds no
# F06 permit and claims no movement boundary (the stand-in leaves in
# world_additions both return false), and nothing in bbj_payouts,
# hand_projection_outbox or tournament_knockout_candidates names this hand.
SEED = f"""
INSERT INTO public.hand_history_retention_policy (horse_retention_days) VALUES (8);
INSERT INTO public.profiles (id, is_horse) VALUES ({lit(HORSE)}, true);
INSERT INTO public.tables (id, name, game_type) VALUES ({lit(TABLE)}, 'Retention Law Table', 'cash');
INSERT INTO public.table_seats (table_id, seat_number, user_id, active_game_scope, active_parent_key)
VALUES ({lit(TABLE)}, 1, {lit(SEATED)}, 'table:' || {lit(TABLE)}, 'table:' || {lit(TABLE)});

-- A successor holds the table's current lease; the settled hand's own
-- generation holds nothing, exactly as a month-old generation should.
INSERT INTO public.engine_table_leases
  (table_id, instance_id, lease_generation, protocol_version, heartbeat_at)
VALUES ({lit(TABLE)}, 'successor-one', {lit(LIVE_GEN)}, 2, clock_timestamp());

-- THE HAND: old enough to be pruned by any retention window worth testing.
INSERT INTO public.hand_history (id, table_id, hand_number, created_at, players)
VALUES ({lit(HAND_ID)}, {lit(TABLE)}, {HAND_NUMBER}, clock_timestamp() - interval '30 days',
        jsonb_build_array(jsonb_build_object('userId', {lit(HORSE)})));

-- THE SETTLEMENT: complete the day it was played. hand_id = submission_id is
-- the identity fn_ca_resume_hand_submission and sp_prune_hand_history's own
-- DELETEs both key off - this hand truly finished.
INSERT INTO public.hand_atomic_commits
  (table_id, hand_number, hand_id, payload_hash, stack_result, committed_at,
   post_commit_payload, post_commit_payload_hash, post_commit_completed_at, post_commit_result)
VALUES ({lit(TABLE)}, {HAND_NUMBER}, {lit(HAND_ID)}, md5('settled-payload') || md5('settled-payload'), '{{}}'::jsonb,
        clock_timestamp() - interval '30 days', '{{}}'::jsonb, md5('settled-post') || md5('settled-post'),
        clock_timestamp() - interval '30 days', '{{"ok":"true"}}'::jsonb);

-- THE RETAINED REQUEST: append-only, and never pruned by design - this is
-- what retention must learn to close instead of abandoning.
INSERT INTO smarter_private.hand_submissions
  (submission_id, table_id, hand_number, instance_id, lease_generation, request, request_hash, retained_at)
VALUES ({lit(HAND_ID)}, {lit(TABLE)}, {HAND_NUMBER}, 'dealer-that-settled-it', {lit(DEAD_GEN)},
        '{{"p_stacks": []}}'::jsonb, md5('settled-request') || md5('settled-request'), clock_timestamp() - interval '30 days');
"""


def quiescent(case):
    """Before any pruning, this hand is fully settled: resume() must find
    nothing to do. Proves the fixture is a genuinely quiescent hand, so
    everything that follows is retention's doing, not a broken fixture."""
    return AUTHORITY + f"""
DO $quiescent$
DECLARE r jsonb;
BEGIN
  r := public.fn_ca_resume_hand_submission({lit(TABLE)}, 'nobody', {lit(ABSENT)});
  IF r->>'found' IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'a settled hand was not quiescent before any pruning (%): %', {lit(case)}, r;
  END IF;
  RAISE NOTICE 'RETENTION PASS: quiescent-%', {lit(case)};
END $quiescent$;
"""


def manufactured_unfinished(case):
    """After pruning with no disposal receipt, the same call must now find
    something and proceed far enough to prove selection: no
    engine_table_leases row exists for this hand's own (dead) generation, so
    the door raises HAND_SUBMISSION_LEASE_UNPROVEN. It never reaches this
    check unless it selected the submission - proof of the bug."""
    return AUTHORITY + f"""
DO $manufactured$
DECLARE r jsonb; got text;
BEGIN
  BEGIN
    r := public.fn_ca_resume_hand_submission({lit(TABLE)}, 'nobody', {lit(ABSENT)});
    got := 'returned ' || r::text;
  EXCEPTION WHEN SQLSTATE '55000' THEN got := SQLERRM;
  END;
  IF got IS DISTINCT FROM 'HAND_SUBMISSION_LEASE_UNPROVEN' THEN
    RAISE EXCEPTION 'a pruned-but-undisposed hand did not manufacture unfinished business (%): %', {lit(case)}, got;
  END IF;
  RAISE NOTICE 'RETENTION PASS: manufactured-unfinished-%', {lit(case)};
END $manufactured$;
"""


def freed(case):
    """After pruning WITH the disposal receipt, resume() finds nothing: the
    fix in action."""
    return AUTHORITY + f"""
DO $freed$
DECLARE r jsonb;
BEGIN
  r := public.fn_ca_resume_hand_submission({lit(TABLE)}, 'nobody', {lit(ABSENT)});
  IF r->>'found' IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'the disposed hand still manufactures unfinished business (%): %', {lit(case)}, r;
  END IF;
  RAISE NOTICE 'RETENTION PASS: freed-%', {lit(case)};
END $freed$;
"""


def prune(case, expect_deleted=1):
    return AUTHORITY + f"""
DO $prune$
DECLARE v_deleted integer;
BEGIN
  v_deleted := public.sp_prune_hand_history(10);
  IF v_deleted <> {expect_deleted} THEN
    RAISE EXCEPTION 'the sweep pruned % hands, expected % (%)', v_deleted, {expect_deleted}, {lit(case)};
  END IF;
  IF EXISTS (SELECT 1 FROM public.hand_history WHERE id = {lit(HAND_ID)}) THEN
    RAISE EXCEPTION 'the settled hand was not pruned (%)', {lit(case)};
  END IF;
  IF EXISTS (SELECT 1 FROM public.hand_atomic_commits WHERE table_id = {lit(TABLE)} AND hand_number = {HAND_NUMBER}) THEN
    RAISE EXCEPTION 'the settled hand''s commit was not pruned (%)', {lit(case)};
  END IF;
  IF NOT EXISTS (SELECT 1 FROM smarter_private.hand_submissions WHERE submission_id = {lit(HAND_ID)}) THEN
    RAISE EXCEPTION 'retention deleted the retained request instead of leaving it for disposal (%)', {lit(case)};
  END IF;
  RAISE NOTICE 'RETENTION PASS: sweep-prunes-the-hand-%', {lit(case)};
END $prune$;
"""


NO_RECEIPT = AUTHORITY + f"""
DO $none$
BEGIN
  IF EXISTS (SELECT 1 FROM smarter_private.hand_submission_disposals
              WHERE table_id = {lit(TABLE)} AND hand_number = {HAND_NUMBER}) THEN
    RAISE EXCEPTION 'a receipt exists before the fix - the fixture, not the migration, wrote it';
  END IF;
  RAISE NOTICE 'RETENTION PASS: no-receipt-without-the-fix';
END $none$;
"""

# The old constraint (witness_hand_number > hand_number) as production had it
# before this migration: a self-witnessed disposal - which is exactly what
# retention's own receipt writes, witness_hand_number = hand_number - is
# rejected outright, independent of any hand ever being pruned.
OLD_CONSTRAINT_REJECTS_SELF_WITNESS = f"""
DO $boundary$
DECLARE got text;
BEGIN
  BEGIN
    INSERT INTO smarter_private.hand_submission_disposals
      (table_id, hand_number, submission_id, receipt_id, witness_hand_number, reason, expected)
    VALUES ('9b500000-0000-4000-8000-000000000001'::uuid, 42, '9b500000-0000-4000-8000-000000000002'::uuid,
            '9b500000-0000-4000-8000-000000000003'::uuid, 42,
            'boundary probe: a self-witnessed disposal under the OLD constraint', '{{}}'::jsonb);
    got := 'accepted';
  EXCEPTION WHEN SQLSTATE '23514' THEN got := SQLSTATE;
  END;
  IF got <> '23514' THEN
    RAISE EXCEPTION 'the OLD constraint let a self-witnessed disposal through: %', got;
  END IF;
  RAISE NOTICE 'RETENTION PASS: old-constraint-rejects-self-witness';
END $boundary$;
"""

GRANT_CASE = AUTHORITY + f"""
DO $grant$
DECLARE d smarter_private.hand_submission_disposals;
BEGIN
  SELECT * INTO d FROM smarter_private.hand_submission_disposals
   WHERE table_id = {lit(TABLE)} AND hand_number = {HAND_NUMBER};
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retention pruned the hand but wrote no disposal receipt';
  END IF;
  IF d.submission_id <> {lit(HAND_ID)} OR d.witness_hand_number <> {HAND_NUMBER}
     OR d.receipt_id <> md5('hand:disposal:retention:' || {lit(HAND_ID)})::uuid THEN
    RAISE EXCEPTION 'the receipt does not describe the pruned hand: %', to_jsonb(d);
  END IF;
  IF d.expected->>'kind' IS DISTINCT FROM 'retention_pruned_settled_hand'
     OR (d.expected->>'table_id')::uuid IS DISTINCT FROM {lit(TABLE)}::uuid
     OR (d.expected->>'hand_number')::bigint IS DISTINCT FROM {HAND_NUMBER}::bigint
     OR (d.expected->>'settled')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'the receipt does not carry its evidence: %', d.expected;
  END IF;
  IF length(btrim(d.reason)) < 40 THEN
    RAISE EXCEPTION 'the receipt did not state a reason: %', d.reason;
  END IF;
  RAISE NOTICE 'RETENTION PASS: receipt-describes-the-pruned-hand';
END $grant$;
""" + freed('after-the-fix')

# The new constraint (>=) accepts the exact self-witnessed row the migration
# just wrote via the sweep above - already proven by GRANT_CASE finding it at
# all. This second, independent probe inserts a SEPARATE self-witnessed row
# directly, to show the acceptance is the constraint's, not an artifact of
# how the sweep happens to call it.
NEW_CONSTRAINT_ACCEPTS_SELF_WITNESS = f"""
DO $boundary2$
BEGIN
  INSERT INTO smarter_private.hand_submission_disposals
    (table_id, hand_number, submission_id, receipt_id, witness_hand_number, reason, expected)
  VALUES ('9b500000-0000-4000-8000-000000000004'::uuid, 43, '9b500000-0000-4000-8000-000000000005'::uuid,
          '9b500000-0000-4000-8000-000000000006'::uuid, 43,
          'boundary probe: a self-witnessed disposal under the NEW constraint', '{{}}'::jsonb);
  RAISE NOTICE 'RETENTION PASS: new-constraint-accepts-self-witness';
END $boundary2$;
"""

# The retention closer's own contract, direct - no sweep, no fixture hand.
CONTRACT_CASES = AUTHORITY + f"""
DO $contract$
DECLARE n integer; got text;
BEGIN
  n := smarter_private.hand_submission_retention_disposal(NULL, 'this reason is stated at forty characters or more');
  IF n <> 0 THEN RAISE EXCEPTION 'a NULL hand_ids disposed %, expected 0', n; END IF;
  n := smarter_private.hand_submission_retention_disposal(ARRAY[]::uuid[], 'this reason is stated at forty characters or more');
  IF n <> 0 THEN RAISE EXCEPTION 'an empty hand_ids disposed %, expected 0', n; END IF;
  RAISE NOTICE 'RETENTION PASS: empty-input-disposes-nothing';

  BEGIN
    PERFORM smarter_private.hand_submission_retention_disposal(
      ARRAY[{lit(HAND_ID)}]::uuid[], 'too short to be a ruling');
    got := 'allowed';
  EXCEPTION WHEN SQLSTATE '22023' THEN got := SQLERRM;
  END;
  IF got <> 'HAND_DISPOSAL_IDENTITY_REQUIRED' THEN
    RAISE EXCEPTION 'an unstated reason was accepted: %', got;
  END IF;
  RAISE NOTICE 'RETENTION PASS: refuses-an-unstated-reason';
END $contract$;
"""


def expect(execution, database, sql, label, passes):
    code, out, err = execution.sql(database, sql, label=label, check=False)
    if code or re.search(r'^(?:[a-z_]+: )?(ERROR|FATAL|PANIC)', out + '\n' + err, re.M):
        raise RuntimeError(f'{label} failed:\n{err.strip() or out.strip()}')
    seen = re.findall(r'NOTICE:\s*RETENTION PASS: (\S+)', err)
    if len(seen) != passes:
        raise RuntimeError(f'{label}: expected {passes} proven assertions, saw {len(seen)}: {seen}')
    return seen


def prune_before(root):
    """sp_prune_hand_history as production had it immediately before
    MIGRATION. Extracted from the fixture file, never retyped; the fixture
    file's own header records how IT was recovered, without retyping either."""
    src = (root / PRUNE_BEFORE).read_text()
    idx = src.index('CREATE OR REPLACE FUNCTION public.sp_prune_hand_history(')
    text = src[idx:]
    if hashlib.md5(text.encode()).hexdigest() != PRUNE_BEFORE_MD5:
        raise RuntimeError('the recorded pre-migration text changed under the run')
    return text


def patch_block(root):
    """MIGRATION's own DO $patch$ block, extracted, never retyped.

    Only this block is guarded to survive a replay (its own
    'IF position(...) > 0 THEN RETURN' short-circuit): the ALTER TABLE
    constraint swap above it is not (a bare ADD CONSTRAINT, no IF NOT
    EXISTS), because production applies a migration exactly once, tracked,
    and never replays it. Idempotency below is checked at the grain the
    migration itself promises it, not by replaying the whole file."""
    src = (root / MIGRATION).read_text()
    idx = src.index('DO $patch$')
    text = src[idx:]
    if not text.rstrip().endswith('$patch$;'):
        raise RuntimeError('the recorded migration no longer ends in the expected DO $patch$ block')
    return text


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--evidence', type=Path, required=True)
    p.add_argument('--pg-bin', type=Path, required=True)
    args = p.parse_args()
    root = Path(__file__).resolve().parents[2]
    out = args.evidence.resolve()
    out.mkdir(parents=True, exist_ok=False)
    native = module(root / 'scripts/ci/test-mtt-unlimited.py', 'retention_disposal_execution')
    disposal = module(root / 'scripts/ci/test-hand-submission-disposal.py', 'hand_disposal_test')
    e = native.Execution(root, out, args.pg_bin.resolve(), out, 600)
    e.report['source_sha256'] = {str(pth): sha(root / pth) for pth in
                                 [Path(__file__).relative_to(root), MIGRATION, DISPOSAL_MIGRATION,
                                  RESUME_BASE, PRUNE_BEFORE, WORLD]}
    e.report['proven'] = []
    for signum in native.CANCELLATION_SIGNALS:
        signal.signal(signum, native.interrupted)
    try:
        e.start()

        # ── The world, and both doors as they stood BEFORE this migration ───
        base = e.database()
        e.sql(base, file=root / WORLD, label='world', seconds=120)
        e.sql(base, disposal.resume_base(root), label='resume-door-before')
        e.sql(base, disposal.snapshot_guard_base(root), label='snapshot-guard-before')
        e.sql(base, prune_before(root), label='prune-sweep-before')

        # The supersession disposal law is a real prerequisite here: retention's
        # receipt is read by the exact guard 20260928001934 added to
        # fn_ca_resume_hand_submission. Applied for real, byte for byte.
        e.sql(base, file=root / DISPOSAL_MIGRATION, label='disposal-prerequisite', seconds=120)

        # ── Without the retention fix: the sweep prunes, but manufactures ───
        # ── unfinished business, exactly as the fleet-wide wedge described. ──
        before = e.database(base)
        e.sql(before, SEED, label='unfixed-seed')
        e.report['proven'].append({'case': 'before-any-pruning',
                                   'passes': expect(e, before, quiescent('before-pruning'), 'quiescent-before', 1)})
        e.report['proven'].append({'case': 'sweep-prunes-without-disposing',
                                   'passes': expect(e, before, prune('without-the-fix'), 'prune-unfixed', 1)})
        e.report['proven'].append({'case': 'no-receipt-without-the-fix',
                                   'passes': expect(e, before, NO_RECEIPT, 'no-receipt', 1)})
        e.report['proven'].append({'case': 'manufactures-unfinished-business',
                                   'passes': expect(e, before, manufactured_unfinished('without-the-fix'),
                                                    'manufactured', 1)})
        e.report['proven'].append({'case': 'old-constraint-rejects-self-witness',
                                   'passes': expect(e, before, OLD_CONSTRAINT_REJECTS_SELF_WITNESS,
                                                    'old-constraint', 1)})
        e.discard(before)

        # ── Apply the RECORDED migration under test, byte for byte ─────────
        e.sql(base, file=root / MIGRATION, label='recorded-migration', seconds=120)
        _, patched, _ = e.sql(base, "SELECT (length(d) - length(replace(d,'hand_submission_retention_disposal','')))"
                                    " / length('hand_submission_retention_disposal') FROM (SELECT"
                                    " pg_get_functiondef('public.sp_prune_hand_history(integer)'"
                                    "::regprocedure) d) t;", label='prune-patched')
        if patched.strip() != '1':
            raise RuntimeError('the in-place prune edit did not land exactly once: ' + patched.strip())
        e.report['prune_patch_occurrences'] = 1

        # Replaying the migration's OWN DO $patch$ block is a no-op, not a
        # second edit - exactly the guarantee its 'IF position(...) > 0 THEN
        # RETURN' short-circuit makes. (The ALTER TABLE constraint swap above
        # it is not replay-safe on its own - a bare ADD CONSTRAINT, no IF NOT
        # EXISTS - but production applies a migration exactly once, tracked,
        # and never replays the file as a whole; this checks idempotency at
        # the grain the migration itself promises it.)
        e.sql(base, patch_block(root), label='patch-block-replay', seconds=120)
        _, again, _ = e.sql(base, "SELECT (length(d) - length(replace(d,'hand_submission_retention_disposal','')))"
                                  " / length('hand_submission_retention_disposal') FROM (SELECT"
                                  " pg_get_functiondef('public.sp_prune_hand_history(integer)'"
                                  "::regprocedure) d) t;", label='prune-patched-replay')
        if again.strip() != '1':
            raise RuntimeError('replaying the patch block edited the prune sweep twice: ' + again.strip())
        e.report['migration_patch_block_is_idempotent'] = True

        # ── With the fix: the sweep prunes AND disposes, in the same run. ───
        after = e.database(base)
        e.sql(after, SEED, label='fixed-seed')
        e.report['proven'].append({'case': 'before-any-pruning-after-the-fix',
                                   'passes': expect(e, after, quiescent('before-pruning-fixed'), 'quiescent-after', 1)})
        e.report['proven'].append({'case': 'sweep-prunes-with-disposal',
                                   'passes': expect(e, after, prune('with-the-fix'), 'prune-fixed', 1)})
        e.report['proven'].append({'case': 'disposes-the-pruned-settled-hand',
                                   'passes': expect(e, after, GRANT_CASE, 'grant', 2)})
        e.report['proven'].append({'case': 'new-constraint-accepts-self-witness',
                                   'passes': expect(e, after, NEW_CONSTRAINT_ACCEPTS_SELF_WITNESS,
                                                    'new-constraint', 1)})
        e.discard(after)

        # ── The closer's own contract, direct ───────────────────────────────
        contract = e.database(base)
        e.report['proven'].append({'case': 'retention-disposal-contract',
                                   'passes': expect(e, contract, CONTRACT_CASES, 'contract', 2)})
        e.discard(contract)

        for pth, digest in e.report['source_sha256'].items():
            if sha(root / pth) != digest:
                raise RuntimeError('source changed under the run: ' + pth)
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

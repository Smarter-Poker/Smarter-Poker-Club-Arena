-- 20261001231409_the_fees_a_hand_takes_stay_on_the_felt_until_their_legs_are_posted
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-01 23:14:09 UTC.
--
-- ============================================================================
-- THE FEES A HAND TAKES STAY ON THE FELT UNTIL THEIR LEGS ARE POSTED
-- ============================================================================
--
-- Dan, 2026-10-01: "why hasn't this been made atomic yet? chip drifts should
-- not be possible." 20261001160611 installed the per-transaction ledger
-- invariant in observe mode. In its first 28 minutes of live traffic
-- (22:24-22:52 UTC) it recorded 4,491 findings, every one of them on the one
-- account `table_stack`, in exactly two shapes and no other:
--
--   2,242  fn_ca_commit_hand_submission     felt moved -5,822.06, legs 0.00
--   2,240  fn_ca_process_hand_post_commit_  felt moved 0.00,      legs -5,828.75
--          obligations / fn_project_hand_side_effects / fn_ca_resume_hand_submission
--
-- THE CAUSE, READ FROM THE FUNCTIONS. The engine commits a hand in two
-- transactions by design:
--
--   1. fn_ca_commit_hand_settlement (through fn_ca_commit_hand_submission)
--      moves the seats so that sum(stack deltas) = inflow - rake - bbj
--      (fn_ca_settle_hand_stacks_absolute's conservation rule), inserts the
--      hand_atomic_commits receipt, and stores the post-commit envelope on it
--      (post_commit_payload). No leg: the rake and the jackpot drop have left
--      the seats and are, for now, nowhere.
--   2. fn_ca_process_hand_post_commit_obligations (called by the engine, by the
--      projection worker fn_project_hand_side_effects, or by the restart path
--      fn_ca_resume_hand_submission) posts the legs - table_stack -> union_wallet
--      or chip_retirement for the rake (atomic_distribute_rake), three
--      table_stack -> bbj_pool legs for the drop (bbj_record_contribution), the
--      insurance bank's leg for any inflow (record_insurance_transaction) - and
--      stamps post_commit_completed_at. The felt does not move.
--
-- Each half fails a per-transaction invariant; only the pair nets to zero,
-- and only once the second half has run. A hand whose second half never runs
-- is the felt reading short of its journal: the drift Dan asked about.
--
-- WHY THE LEGS CANNOT SIMPLY BE POSTED AT COMMIT (measured, not assumed).
-- atomic_distribute_rake takes the club's club_wallets row (and, through the
-- rake_records triggers, every player's vip_points_carry row and the horse
-- claims' profiles rows) and holds them to COMMIT. Postgres log, 2026-10-01
-- 21:00-23:00 UTC, "canceling statement due to statement timeout":
--
--   fn_ca_process_hand_post_commit_obligations   2,674  (1,122 of them on
--        UPDATE public.club_wallets SET period_rake_collected ..., the rest
--        waiting on club_wallets tuples, vip_points_carry index inserts)
--   fn_project_hand_side_effects                   285
--   fn_ca_commit_hand_submission                    18
--
-- Folding the obligations into the commit transaction would make every hand
-- of a club queue on that one wallet row inside the commit path, and turn
-- 9 refused commits an hour into roughly 1,300: each one rolls the hand back
-- and the engine kills the table for restart (authoritative_hand_commit_not_
-- proved). It would also hold the table and seat locks the commit already
-- owns while waiting on the banks - the lock order 20261001000000 dissolved
-- 3,605 deadlocks a day to establish, with the banks taken before the player
-- rows. So the legs stay in the second transaction, and the rule the invariant
-- states is applied the other way round: a balance whose leg is posted later
-- must not move earlier.
--
-- WHAT CHANGES. Nothing about any amount, receipt, refusal name, idempotency
-- key, lock, or the engine. One branch is added to the tally trigger function
-- and the two invariant triggers are installed on hand_atomic_commits:
--
--   * While a hand's envelope is stored and not yet completed
--     (post_commit_payload IS NOT NULL AND post_commit_completed_at IS NULL)
--     on a cash chip table (fn_ca_felt_counts_table), its receipt row counts
--     rake + bbj - inflow (stack_result, written by the stack core from the
--     same arguments the door asserts against the envelope) as FELT.
--   * Transaction 1 therefore moves the felt by (inflow - rake - bbj) on the
--     seats and by +(rake + bbj - inflow) on the receipt: zero, no leg owed.
--   * Transaction 2 completes the envelope, -(rake + bbj - inflow) on the
--     receipt, in the same transaction as the legs -(rake + bbj) + inflow.
--     Zero. A second half that posts its legs and does not complete, or
--     completes without its legs, is refused by name.
--   * The restart path (fn_ca_resume_hand_submission runs both halves in one
--     transaction), a replay (already_completed, no write), a tournament or
--     Diamond hand (not the cash felt), and the eight-day retention prune
--     (completed rows only) all net to zero by the same arithmetic.
--
-- The pending-add-on float already follows this exact pattern (20260912,
-- "the felt is owed what a mid-hand add-on already paid for"): chips whose leg
-- lands in one transaction and whose seat lands in another are counted on the
-- felt in between. The fees are the mirror image: seat first, leg later.
--
-- MEASURED BEFORE (pg_stat_statements, cumulative to 22:58 UTC 2026-10-01):
--   fn_ca_commit_hand_submission        3,059,514 calls  mean 119.4 ms
--   fn_ca_process_hand_post_commit_obl. 3,063,766 calls  mean 144.4 ms
-- This file adds two row-trigger firings per hand (one INSERT, one UPDATE in
-- transaction 1; one UPDATE in transaction 2), each a jsonb read and one
-- primary-key lookup through fn_ca_felt_counts_table. The after figures are
-- in the changelog.
--
-- LOCKS. CREATE TRIGGER takes ShareRowExclusiveLock on hand_atomic_commits,
-- which every hand inserts into. Taken explicitly first, under a 250 ms
-- lock_timeout with rollback-and-retry (the 20261001160611 pattern), so no
-- live commit ever waits on this file past deadlock_timeout. No DROP TRIGGER
-- and no DROP POLICY anywhere in this file: on this database the supautils
-- hook turns either into AccessExclusiveLock on auth.users (see 20261001160611's
-- header and PR #5741).
--
-- PINNED: fn_ca_tally_balance_move live md5(pg_get_functiondef)
--   before 7e2ead66788e37e4449c8d725ac4654f -> after b7911a245d4bf33134a9a2f474c1f410
--   (read 2026-10-01 23:15 UTC; the substitution is asserted on its anchor and
--   read back, so a body that has moved refuses rather than being overwritten).
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_tally_balance_move()'::regprocedure)) = 'b7911a245d4bf33134a9a2f474c1f410')
-- @live-proof: (SELECT count(*) = 2 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'hand_atomic_commits' AND tg.tgname IN ('zy_ca_tally_balance_move','zz_ca_balance_has_its_ledger_row') AND tg.tgenabled <> 'D')
--
-- CLAUDE.md section 2: one migration, one transaction; applied outside the
-- :50-:03 break window through apply-merged-migration.yml only, once.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. The tally learns the hand receipt (asserted substitution, read back)
-- ---------------------------------------------------------------------------

DO $sub$
DECLARE
  v_sig constant text := 'public.fn_ca_tally_balance_move()';
  v_anchor constant text := $anc$    WHEN 'union_wallets' THEN
$anc$;
  v_branch constant text := $br$    WHEN 'hand_atomic_commits' THEN
      /* THE FEES A HAND TAKES OFF ITS SEATS STAY ON THE FELT UNTIL THEIR LEGS
         ARE POSTED (20261001231409). The accepted-hand transaction moves the
         seats by inflow - rake - bbj and writes no leg for the fees. Their
         legs - table_stack -> union_wallet or chip_retirement for the rake,
         table_stack -> bbj_pool for the drop, the insurance bank's leg for the
         inflow - are posted by fn_ca_process_hand_post_commit_obligations in
         a LATER transaction, under the club wallet, VIP carry and pool locks
         the commit path must not wait on. So the hand's own receipt carries
         the fees as felt from the moment its envelope is stored until the
         moment that envelope completes - in the same transaction that posts
         the legs. Each transaction balances on its own, and a hand whose
         second half has not run yet reads as fees still on the felt, never as
         chips that vanished. Scoped exactly like the seat: the cash chip felt. */
      k_old := 'table_stack'; k_new := 'table_stack';
      IF o IS NOT NULL AND (o ->> 'post_commit_payload') IS NOT NULL
         AND (o ->> 'post_commit_completed_at') IS NULL
         AND public.fn_ca_felt_counts_table((o ->> 'table_id')::uuid) THEN
        v_old := COALESCE((o -> 'stack_result' ->> 'rake')::numeric, 0)
               + COALESCE((o -> 'stack_result' ->> 'bbj')::numeric, 0)
               - COALESCE((o -> 'stack_result' ->> 'inflow')::numeric, 0);
      END IF;
      IF n IS NOT NULL AND (n ->> 'post_commit_payload') IS NOT NULL
         AND (n ->> 'post_commit_completed_at') IS NULL
         AND public.fn_ca_felt_counts_table((n ->> 'table_id')::uuid) THEN
        v_new := COALESCE((n -> 'stack_result' ->> 'rake')::numeric, 0)
               + COALESCE((n -> 'stack_result' ->> 'bbj')::numeric, 0)
               - COALESCE((n -> 'stack_result' ->> 'inflow')::numeric, 0);
      END IF;
$br$;
  v_src text; v_new text; v_n integer;
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position($p$WHEN 'hand_atomic_commits' THEN$p$ in v_src) > 0 THEN
    RAISE NOTICE 'fn_ca_tally_balance_move already carries the hand_atomic_commits branch; left as it is';
  ELSE
    v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
    IF v_n IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION '% carries the union_wallets anchor % time(s) rather than once; refusing to substitute blind', v_sig, v_n;
    END IF;
    v_new := replace(v_src, v_anchor, v_branch || v_anchor);
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position($p$WHEN 'hand_atomic_commits' THEN$p$ in v_src) = 0
     OR position($p$public.fn_ca_felt_counts_table((n ->> 'table_id')::uuid)$p$ in v_src) = 0
     OR position($p$- COALESCE((n -> 'stack_result' ->> 'inflow')::numeric, 0);$p$ in v_src) = 0 THEN
    RAISE EXCEPTION '% does not read back with the hand receipt counted as felt', v_sig;
  END IF;
  RAISE NOTICE 'fn_ca_tally_balance_move: md5 % (expected b7911a245d4bf33134a9a2f474c1f410 on the 2026-10-01 live body)', md5(v_src);
END
$sub$;

-- ---------------------------------------------------------------------------
-- 2. The two invariant triggers on the hand receipt
-- ---------------------------------------------------------------------------

DO $m$
DECLARE v_tries int := 0;
BEGIN
  PERFORM set_config('lock_timeout', '250ms', true);
  LOOP
    BEGIN
      LOCK TABLE public.hand_atomic_commits IN SHARE ROW EXCLUSIVE MODE;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      v_tries := v_tries + 1;
      IF v_tries >= 240 THEN
        RAISE EXCEPTION 'the ShareRowExclusive lock on hand_atomic_commits could not be taken in % tries (about 90 s); nothing was applied - apply once more when the felt is quieter, never in a loop', v_tries;
      END IF;
      PERFORM pg_sleep(0.1);
    END;
  END LOOP;
  PERFORM set_config('lock_timeout', '8s', true);
  RAISE NOTICE 'hand receipt: ShareRowExclusive lock taken after % failed tries', v_tries;
END $m$;

-- Nothing is dropped (see the header): refuse, by name, if either already exists.
DO $m$
DECLARE v_present text;
BEGIN
  SELECT string_agg(c.relname || '.' || tg.tgname, ', ' ORDER BY tg.tgname) INTO v_present
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname = 'hand_atomic_commits'
     AND tg.tgname IN ('zy_ca_tally_balance_move','zz_ca_balance_has_its_ledger_row');
  IF v_present IS NOT NULL THEN
    RAISE EXCEPTION 'the hand receipt is already partly covered (%); read the live catalog before re-applying, this file does not DROP TRIGGER', v_present;
  END IF;
END $m$;

CREATE TRIGGER zy_ca_tally_balance_move
  AFTER INSERT OR UPDATE OF post_commit_payload, post_commit_completed_at, stack_result, table_id OR DELETE
  ON public.hand_atomic_commits
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tally_balance_move();
CREATE CONSTRAINT TRIGGER zz_ca_balance_has_its_ledger_row
  AFTER INSERT OR UPDATE OF post_commit_payload, post_commit_completed_at, stack_result, table_id OR DELETE
  ON public.hand_atomic_commits
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_balance_has_its_ledger_row();

-- ---------------------------------------------------------------------------
-- 3. Declarations
-- ---------------------------------------------------------------------------

INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
SELECT x.t, x.g, x.n
  FROM (VALUES
    ('hand_atomic_commits', 'zy_ca_tally_balance_move',
     'the_fees_a_hand_takes_stay_on_the_felt_until_their_legs_are_posted: while a cash hand''s post-commit envelope is stored and not completed, its receipt counts rake + bbj - inflow as felt in the transaction tally, so the accepted-hand transaction and the obligations transaction each balance on their own. Reads tables and clubs by primary key; writes nothing; never refuses.'),
    ('hand_atomic_commits', 'zz_ca_balance_has_its_ledger_row',
     'the_fees_a_hand_takes_stay_on_the_felt_until_their_legs_are_posted: deferred to commit; refuses REFUSED: balance_moved_without_its_ledger_row when a hand envelope completes without its fee legs, or its fee legs are posted without completing it, in the same transaction.')
  ) AS x(t, g, n)
ON CONFLICT (table_name, trigger_name) DO UPDATE SET note = EXCLUDED.note;

SELECT public.fn_ca_declare_guard_redefinition('fn_ca_tally_balance_move', 'migration 20261001231409_the_fees_a_hand_takes_stay_on_the_felt_until_their_legs_are_posted');

-- ---------------------------------------------------------------------------
-- 4. Installed whole, or not at all
-- ---------------------------------------------------------------------------

DO $m$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(x.g, ', ') INTO v_missing
    FROM (VALUES ('zy_ca_tally_balance_move'), ('zz_ca_balance_has_its_ledger_row')) AS x(g)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
      WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'hand_atomic_commits' AND tg.tgname = x.g
        AND tg.tgenabled <> 'D'
        AND (x.g NOT LIKE 'zz_%' OR (tg.tgdeferrable AND tg.tginitdeferred)));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'the hand receipt is not covered whole: %', v_missing;
  END IF;
  RAISE NOTICE 'the fees a hand takes stay on the felt until their legs are posted: hand_atomic_commits is on the tally; mode = %',
    (SELECT mode FROM public.ca_ledger_invariant_mode);
END $m$;

COMMIT;

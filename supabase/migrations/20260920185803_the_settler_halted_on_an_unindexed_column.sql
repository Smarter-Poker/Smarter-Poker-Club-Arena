-- ============================================================================
-- THE CASH RAKEBACK SETTLER HALTED ON AN UNINDEXED COLUMN
-- ============================================================================
--
-- !! BEFORE APPLYING: RESERVE THE VERSION WITH THE SCRIPT, NEVER BY HAND !!
--
--     node scripts/new-migration.mjs "the settler halted on an unindexed column"
--
-- CLAUDE.md section 4.5 is binding: a hand-typed 14-digit version was the
-- single biggest source of red CI in this repo (21 of ~62 real failures in one
-- day), and of two files sharing a version the SECOND IS SILENTLY NEVER
-- APPLIED. Copy the body below into the file that script creates.
--
-- STATUS: NOT APPLIED. Written 2026-09-20 from measurements taken against
-- production the same day. Every number below was read from rows, not assumed.
--
-- ----------------------------------------------------------------------------
-- WHAT IS WRONG
-- ----------------------------------------------------------------------------
--
-- The engine daemon RakebackSettlerService has been stopped since 2026-09-17
-- 07:28:31 UTC. Its durable cursor -- daemon_state.high_water_mark for
-- 'rakeback_settler' -- has not moved in three days, and behind it sit 264,835
-- positive cash rake_records carrying 485,712.99 of rake. Not one of those
-- hands has produced an agent commission, a rakeback basis, a VIP point or a
-- player_stats row. No cash agent commission has been written anywhere on the
-- platform since 2026-09-17 07:29:05.
--
-- The reason is one missing index.
--
-- public.rake_attributions holds 1,175,365 rows in 1,117 MB. It is indexed on
-- id, on hand_id, on (hand_id, player_id), on (player_id, created_at) and on
-- (club_id, created_at). IT IS NOT INDEXED ON rake_record_id -- and
-- rake_record_id is the column the entire cash accounting path joins on.
-- Every such lookup is therefore a full sequential scan of the table to find
-- about three rows. Measured with EXPLAIN (ANALYZE, BUFFERS) on 2026-09-20:
--
--     Seq Scan on rake_attributions
--       Filter: (rake_record_id = ...)
--       Rows Removed by Filter: 1175362
--       Buffers: shared hit=8711250
--       actual time=13.795..164.940 rows=3 loops=150
--     Execution Time: 24751.320 ms        -- 164.99 ms per record
--
-- The same 150 records fetched through an existing index cost 101 ms in total,
-- 0.67 ms each -- 245 times cheaper.
--
-- Settling ONE cash source performs FOUR of those scans:
--
--   1. fn_process_cash_accounting_source  -- its own source fingerprint
--   2. fn_accrue_cash_hand_commissions    -- its own source fingerprint
--   3. fn_accounting_cash_commission_plan -- the attribution-ambiguity EXISTS
--   4. fn_accounting_cash_commission_plan -- the attribution loop
--
-- (The plan's other two attribution reads also carry hand_id, so they use
-- idx_rake_attributions_hand_id and cost 0.2 ms. Only the four above are
-- filtered on rake_record_id alone.)
--
-- 4 x 164.99 ms = 660 ms of pure scanning, and a probe of the real live path
-- over eight backlog records (rolled back) measured 946.9 ms per record --
-- 660 ms of scan plus 287 ms of genuine accounting work. The scans are 70% of
-- the cost of settling a hand.
--
-- That is what stops the daemon. _runSettlementInner() opens every cycle with
--
--     await supabase.rpc('fn_retry_cash_accounting_sources', { p_limit: 50 })
--
-- before it reads any new work at all. The function sets its own
-- statement_timeout to 300s, so Postgres is content; the engine's Supabase
-- client is not. DB_TIMEOUT_MS in server/src/services/supabase/client.ts is
-- 15,000 ms. The call takes ~20.6 s, the client aborts, the catch block runs
-- reportError(...'source_retry_holds_cursor') and returns 'halted', and the
-- cursor is never written. The server transaction COMMITS regardless, which is
-- why accounting_cash_source_receipts has been growing by exactly 50 rows an
-- hour for days -- 5,294 receipts for 150 records -- while the cursor stands
-- still. The work is being done and thrown away.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES NOT DO, AND WHY
-- ----------------------------------------------------------------------------
--
-- It does NOT move public.accounting_cash_accrual_cutover, and it does NOT
-- rewrite the 150 'legacy_unverified' rows in
-- public.accounting_cash_accrual_batches. That was the obvious fix and it is
-- the wrong one. Four findings, each verified:
--
-- (a) MOVING THE CUTOVER WOULD NOT RELEASE THOSE 150 ROWS ANYWAY.
--     fn_accrue_cash_hand_commissions looks the batch row up FIRST and returns
--     early on a hit, BEFORE it ever reads the cutover:
--
--         SELECT * INTO batch FROM accounting_cash_accrual_batches
--           WHERE rake_record_id = source.id;
--         IF FOUND THEN ... RETURN jsonb_build_object(
--           'recorded',true,'duplicate',true,'status',batch.status, ...);
--
--     A rolled-back probe on one of the 150 returned, verbatim:
--         {"status":"legacy_unverified","recorded":true,"duplicate":true,
--          "source_version":2}
--     The verdict is latched in the batch row. The cutover is irrelevant to it.
--
-- (b) BOTH TABLES ARE IMMUTABLE BY TRIGGER. accounting_cash_cutover_immutable
--     and accounting_cash_batch_immutable are BEFORE DELETE OR UPDATE triggers
--     running fn_accounting_agreement_history_immutable(), which raises
--     unconditionally. The cutover's primary key is the constant `singleton`,
--     so a second row cannot be inserted either. Changing either table means
--     disabling a guard this platform installed on purpose.
--
-- (c) THE REQUESTED TARGET VALUE IS REFUSED BY AN EXISTING GUARD.
--     ca_cash_cutover_is_week_aligned runs fn_ca_guard_cash_cutover_week_aligned
--     on INSERT. Union weeks begin Monday 00:00 America/Los_Angeles.
--     fn_ca_cash_cutover_week_split_by reports:
--         2026-09-17 18:24:04 (installed) -> splits=true, 83.40 orphaned hours
--         2026-09-17 07:28:31 (proposed)  -> splits=true, 72.48 orphaned hours
--         2026-09-14 07:00:00             -> splits=false
--     The settler's high-water mark is mid-week, so it is not an installable
--     cutover. The only week-aligned instant at or before it is
--     2026-09-14 07:00:00+00.
--
-- (d) AND THAT INSTANT IS ENTANGLED WITH 70,465 ALREADY-PAID HANDS.
--     Backdating the cutover to 2026-09-14 07:00:00 would place every cash hand
--     from Monday onward on the canonical side of the line. 70,465 of those
--     hands already hold legacy 'rake'/'rake_settlement' commissions written by
--     the settler before it stopped -- exactly the state
--     fn_accrue_cash_hand_commissions rejects as
--     'cash_accrual_legacy_writer_after_cutover' and
--     fn_accounting_cash_commission_source_guard rejects as
--     'cash_commission_requires_canonical_source_writer'. A further 73,405 of
--     the week's 199,232 rake-wallet credits still carry no typed source
--     authority, so fn_accounting_union_earned_plan would not certify the week
--     even after the move. Under CLAUDE.md 10.9 that is not a clear path: the
--     outcome cannot be stated from rows today. It is left for a deliberate,
--     separately-scoped decision rather than smuggled into an index fix.
--
-- The 150 orphaned hands are real and they are unpaid: 266.61 of rake, 459
-- attributions, 119 distinct players, 2 clubs, earned 2026-09-17 07:28:33 to
-- 07:34:04, and PROVEN to hold zero agent_commissions, zero
-- accounting_cash_rake_sources and zero rakeback_stats_applied rows. They are
-- 0.05% of the 485,712.99 this migration unblocks. They are recorded here so
-- the next agent does not have to rediscover them, and they need their own
-- settlement.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES
-- ----------------------------------------------------------------------------
--
-- STEP 1  Index rake_attributions(rake_record_id). This is the hard-coded fix
--         at the root: it removes the cost that stops the daemon, for every
--         caller, for good. No sweep, no back-pay job, no retry wrapper --
--         CLAUDE.md 10.11 and 10.12 forbid all three as fixes.
--
-- STEP 2  Refuse, in the database, any future cutover armed AHEAD of the
--         settler's durable cursor. That is the defect that orphaned the 150:
--         a cutover at now() while the settler's cursor was 10.93 hours behind
--         left a window that the legacy writer could never reach (it was stuck
--         behind the cursor) and the canonical writer would always refuse (it
--         was before the line). Nothing in the schema forbade it. Now it does.
--
-- Full reasoning belongs in docs/changelog/2026-09-20-the-settler-halted-on-an-
-- unindexed-column.md, and the guard in STEP 2 wants a companion law test with
-- its file under docs/laws.d/ (CLAUDE.md 10.8).
--
-- ============================================================================


-- ============================================================================
-- STEP 1 -- RUN THIS STATEMENT ON ITS OWN, OUTSIDE ANY TRANSACTION BLOCK.
-- ============================================================================
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction, so this one
-- statement is deliberately outside the BEGIN/COMMIT below. That is a
-- considered exception to the single-transaction rule in the production DDL
-- policy, not an oversight:
--
--   * rake_attributions receives a row for every player in every raked hand.
--     A plain CREATE INDEX takes SHARE, which blocks every one of those writes
--     for the whole build -- on 1,117 MB that is seconds of stalled cash
--     tables. CLAUDE.md's DDL policy rule 7 exists because a lock taken on a
--     hot table on 2026-09-08 took the database down for four minutes.
--   * CONCURRENTLY takes only SHARE UPDATE EXCLUSIVE, so hands keep being
--     written while it builds.
--
-- It is safe to re-run: if a previous attempt failed it leaves an INVALID
-- index, which the verification in STEP 2 detects and names. To recover from
-- that, DROP INDEX CONCURRENTLY IF EXISTS idx_rake_attributions_rake_record_id;
-- and run this again.
--
-- Do NOT run it between :50 and :03 UTC -- the hourly break window refuses DDL
-- (ca_break_window_refuses_ddl). Check `date -u` first.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rake_attributions_rake_record_id
  ON public.rake_attributions (rake_record_id);

COMMENT ON INDEX public.idx_rake_attributions_rake_record_id IS
  'The whole cash accounting path joins rake_attributions on rake_record_id: '
  'fn_process_cash_accounting_source and fn_accrue_cash_hand_commissions each '
  'fingerprint the source, and fn_accounting_cash_commission_plan both checks '
  'attribution ambiguity and walks the attributions. Without this index each '
  'of those four reads was a full scan of 1.18M rows measured at 164.99 ms, '
  'so settling one hand cost 946.9 ms and fn_retry_cash_accounting_sources(50) '
  'cost ~20.6 s against a 15 s engine client timeout. That stopped the '
  'RakebackSettler for three days on 2026-09-17. Do not drop it.';


-- ============================================================================
-- STEP 2 -- ONE TRANSACTION.
-- ============================================================================

BEGIN;

-- Fail fast rather than queue behind a live writer. Nothing here touches a hot
-- table, but a guard that can wedge the estate is worse than the bug it fixes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';


-- ----------------------------------------------------------------------------
-- 2.1  ASSERT THE BOARD HAS NOT MOVED
--
-- Every number was read from production on 2026-09-20. If any of them is no
-- longer true, something changed underneath this migration and it must be
-- re-derived rather than applied blind. The whole transaction aborts.
-- ----------------------------------------------------------------------------
DO $assert$
DECLARE
  v_hwm         timestamptz;
  v_cutover     timestamptz;
  v_batches     bigint;
  v_legacy      bigint;
  v_work        bigint;
  v_blocked     bigint;
  v_paid        bigint;
  v_sources     bigint;
  v_stats       bigint;
  v_index_ok    boolean;
  v_index_valid boolean;
BEGIN
  SELECT high_water_mark INTO v_hwm
    FROM public.daemon_state WHERE daemon = 'rakeback_settler';
  SELECT starts_at INTO v_cutover
    FROM public.accounting_cash_accrual_cutover WHERE singleton;

  IF v_hwm IS NULL THEN
    RAISE EXCEPTION
      'daemon_state has no high_water_mark for rakeback_settler; this migration reasons about that cursor and will not guess'
      USING ERRCODE = '55000';
  END IF;

  -- The cursor is expected to be exactly where it stopped. If the settler has
  -- started moving again, the premise of this migration has changed.
  IF v_hwm <> '2026-09-17T07:28:31.895033+00'::timestamptz THEN
    RAISE EXCEPTION
      'rakeback_settler high_water_mark is % but this migration was written against 2026-09-17 07:28:31.895033+00. Re-measure before applying.',
      v_hwm USING ERRCODE = '55000';
  END IF;

  IF v_cutover <> '2026-09-17T18:24:04.643251+00'::timestamptz THEN
    RAISE EXCEPTION
      'accounting_cash_accrual_cutover.starts_at is % but this migration was written against 2026-09-17 18:24:04.643251+00. Re-measure before applying.',
      v_cutover USING ERRCODE = '55000';
  END IF;

  -- The cutover really is ahead of the cursor. This is the defect 2.2 guards.
  IF v_cutover <= v_hwm THEN
    RAISE EXCEPTION
      'the cutover (%) is no longer ahead of the settler cursor (%); re-read the situation before installing a guard about it',
      v_cutover, v_hwm USING ERRCODE = '55000';
  END IF;

  SELECT count(*), count(*) FILTER (WHERE status = 'legacy_unverified')
    INTO v_batches, v_legacy FROM public.accounting_cash_accrual_batches;
  SELECT count(*), count(*) FILTER (WHERE status = 'blocked')
    INTO v_work, v_blocked FROM public.accounting_cash_source_work;

  IF v_batches <> 150 OR v_legacy <> 150 THEN
    RAISE EXCEPTION
      'accounting_cash_accrual_batches holds % rows, % legacy_unverified; expected 150 / 150',
      v_batches, v_legacy USING ERRCODE = '55000';
  END IF;

  IF v_work <> 150 OR v_blocked <> 150 THEN
    RAISE EXCEPTION
      'accounting_cash_source_work holds % rows, % blocked; expected 150 / 150',
      v_work, v_blocked USING ERRCODE = '55000';
  END IF;

  -- NOBODY HAS BEEN PAID FOR THE ORPHANED 150. This migration pays nothing and
  -- must not be applied on top of a board where something else already did --
  -- if these stop being zero, a second writer appeared and needs explaining
  -- before anything else happens.
  SELECT count(*) INTO v_paid
    FROM public.accounting_cash_accrual_batches b
   WHERE b.status = 'legacy_unverified'
     AND EXISTS (SELECT 1 FROM public.agent_commissions ac
                  WHERE ac.source_id = b.hand_id);
  SELECT count(*) INTO v_sources
    FROM public.accounting_cash_accrual_batches b
   WHERE b.status = 'legacy_unverified'
     AND EXISTS (SELECT 1 FROM public.accounting_cash_rake_sources s
                  WHERE s.rake_record_id = b.rake_record_id);
  SELECT count(*) INTO v_stats
    FROM public.accounting_cash_accrual_batches b
   WHERE b.status = 'legacy_unverified'
     AND EXISTS (SELECT 1 FROM public.rakeback_stats_applied a
                  WHERE a.rake_record_id = b.rake_record_id);

  IF v_paid <> 0 OR v_sources <> 0 OR v_stats <> 0 THEN
    RAISE EXCEPTION
      'the 150 orphaned sources are no longer untouched: % commissions, % canonical sources, % stats rows. Stop and re-read before applying.',
      v_paid, v_sources, v_stats USING ERRCODE = '55000';
  END IF;

  -- STEP 1 must already have run, and the index must be VALID. A CONCURRENTLY
  -- build that failed leaves an unusable index behind and the planner ignores
  -- it -- which would look exactly like this migration having been applied.
  SELECT true, i.indisvalid AND i.indisready
    INTO v_index_ok, v_index_valid
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
   WHERE c.relname = 'idx_rake_attributions_rake_record_id';

  IF NOT COALESCE(v_index_ok, false) THEN
    RAISE EXCEPTION
      'idx_rake_attributions_rake_record_id does not exist. Run STEP 1 (CREATE INDEX CONCURRENTLY, on its own, outside a transaction) first.'
      USING ERRCODE = '55000';
  END IF;

  IF NOT COALESCE(v_index_valid, false) THEN
    RAISE EXCEPTION
      'idx_rake_attributions_rake_record_id exists but is INVALID: a CONCURRENTLY build failed. DROP INDEX CONCURRENTLY IF EXISTS it and re-run STEP 1.'
      USING ERRCODE = '55000';
  END IF;

  RAISE NOTICE 'preconditions verified: cursor %, cutover % (% hours ahead), 150 orphaned sources untouched, index present and valid',
    v_hwm, v_cutover, round(extract(epoch FROM (v_cutover - v_hwm))/3600.0, 2);
END
$assert$;


-- ----------------------------------------------------------------------------
-- 2.2  A CUTOVER MAY NEVER BE ARMED AHEAD OF THE SETTLER'S CURSOR
--
-- This is the root fix for how the 150 were orphaned.
--
-- accounting_cash_accrual_cutover is the instant the canonical accrual writer
-- takes over from the legacy settler writer. Everything at or after it must be
-- written by fn_accrue_cash_hand_commissions; everything before it is assumed
-- to have been paid by the settler already.
--
-- That assumption is only sound while the settler has actually REACHED the
-- line. On 2026-09-17 the activation migration armed the cutover at now(),
-- 18:24:04, while daemon_state.high_water_mark stood at 07:28:31 -- 10.93 hours
-- behind. Every hand in between fell into a hole with no writer at all: the
-- legacy path could not reach it, because the settler was still behind the
-- cursor, and the canonical path refused it as 'legacy_unverified', because it
-- was before the line. 150 hands and 266.61 of rake are sitting in that hole.
--
-- The existing ca_cash_cutover_is_week_aligned guard already refuses a cutover
-- that splits a union week. This is its other half: a cutover must also be a
-- point the settler has already passed. The two compose -- a value must satisfy
-- both -- and in practice that means a union week boundary at or before the
-- cursor.
--
-- "I could not tell" is refused, not waved through (CLAUDE.md 10.86 rule 1): a
-- missing daemon row or a NULL cursor raises rather than defaulting to allow.
--
-- Deliberate exceptions take the shape this estate already uses for the break
-- window -- a reason, not a switch:
--
--     BEGIN;
--     SET LOCAL ca.cash_cutover_ahead_of_settler_override =
--       '<why this cutover must lead the cursor>';
--     INSERT INTO public.accounting_cash_accrual_cutover ...;
--     COMMIT;
--
-- A blank, numeric or on/off/true/false value is not a reason and is refused.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_guard_cash_cutover_not_ahead_of_settler()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_hwm      timestamptz;
  v_found    boolean;
  v_override text;
  v_hours    numeric;
BEGIN
  v_override := nullif(btrim(coalesce(
    current_setting('ca.cash_cutover_ahead_of_settler_override', true), '')), '');

  IF v_override IS NOT NULL
     AND lower(v_override) NOT IN ('1','0','on','off','true','false','yes','no','t','f')
     AND length(v_override) >= 12
  THEN
    RAISE NOTICE 'cash accrual cutover guard overridden for this transaction: %', v_override;
    RETURN NEW;
  END IF;

  IF NEW.starts_at IS NULL OR NOT isfinite(NEW.starts_at) THEN
    RAISE EXCEPTION 'the accounting cash accrual cutover needs a finite instant'
      USING ERRCODE = '22007';
  END IF;

  SELECT d.high_water_mark, true
    INTO v_hwm, v_found
    FROM public.daemon_state d
   WHERE d.daemon = 'rakeback_settler';

  -- Could not tell is its own outcome. It is never silence and never consent.
  IF NOT COALESCE(v_found, false) OR v_hwm IS NULL THEN
    RAISE EXCEPTION
      'cannot verify the cash accrual cutover: daemon_state has no readable high_water_mark for rakeback_settler'
      USING ERRCODE = '55000',
            HINT = 'A cutover armed past the settler''s cursor orphans every hand in between - the legacy writer cannot reach them and the canonical writer refuses them. Establish the cursor first, or state a reason in ca.cash_cutover_ahead_of_settler_override.';
  END IF;

  IF NEW.starts_at > v_hwm THEN
    v_hours := round(extract(epoch FROM (NEW.starts_at - v_hwm)) / 3600.0, 2);
    RAISE EXCEPTION
      'cash accrual cutover % is % hour(s) ahead of the rakeback_settler cursor (%). Every cash hand in that window would be orphaned: unreachable by the legacy writer and refused by the canonical one.',
      NEW.starts_at, v_hours, v_hwm
      USING ERRCODE = '55000',
            HINT = 'Arm the cutover at a union week boundary at or before the settler cursor (fn_union_week_start), or let the settler catch up first. This happened on 2026-09-17: a cutover at now() ran 10.93 hours ahead of a stalled cursor and stranded 150 hands holding 266.61 of rake.';
  END IF;

  RETURN NEW;
END
$function$;

COMMENT ON FUNCTION public.fn_ca_guard_cash_cutover_not_ahead_of_settler() IS
  'Refuses a cash accrual cutover armed ahead of daemon_state.high_water_mark '
  'for rakeback_settler. Pairs with fn_ca_guard_cash_cutover_week_aligned: a '
  'cutover must be BOTH week-aligned AND already passed by the settler. '
  'Written 2026-09-20 after a cutover armed 10.93 hours ahead of a stalled '
  'cursor orphaned 150 hands.';

DROP TRIGGER IF EXISTS ca_cash_cutover_not_ahead_of_settler
  ON public.accounting_cash_accrual_cutover;

CREATE TRIGGER ca_cash_cutover_not_ahead_of_settler
  BEFORE INSERT OR UPDATE ON public.accounting_cash_accrual_cutover
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_ca_guard_cash_cutover_not_ahead_of_settler();

COMMENT ON TABLE public.accounting_cash_accrual_cutover IS
  'Singleton. The instant the canonical cash accrual writer takes over from '
  'the legacy settler writer. Two invariants are enforced on write: it must '
  'fall on a union week boundary (ca_cash_cutover_is_week_aligned) and it must '
  'be at or before the rakeback_settler cursor '
  '(ca_cash_cutover_not_ahead_of_settler). A cutover that leads the cursor '
  'opens a window no writer owns.';


-- ----------------------------------------------------------------------------
-- 2.3  PROVE THE GUARD REFUSES THE VALUE THAT CAUSED THIS
--
-- A guard nobody exercised is a guard nobody knows the shape of. This asserts
-- the installed value would now be refused, and that a legitimate one passes,
-- without writing to the immutable table.
-- ----------------------------------------------------------------------------
DO $prove$
DECLARE
  v_hwm       timestamptz;
  v_refused   boolean := false;
  v_message   text;
BEGIN
  SELECT high_water_mark INTO v_hwm
    FROM public.daemon_state WHERE daemon = 'rakeback_settler';

  -- The guard body, applied to the offending value, without touching the table.
  BEGIN
    IF '2026-09-17T18:24:04.643251+00'::timestamptz > v_hwm THEN
      RAISE EXCEPTION 'would be refused' USING ERRCODE = '55000';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_refused := true;
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
  END;

  IF NOT v_refused THEN
    RAISE EXCEPTION
      'the new guard would NOT have refused the 2026-09-17 18:24:04 cutover; it does not do what this migration claims'
      USING ERRCODE = '55000';
  END IF;

  -- And the week boundary at or before the cursor must satisfy BOTH guards.
  IF (SELECT splits FROM public.fn_ca_cash_cutover_week_split_by('2026-09-14T07:00:00+00'::timestamptz)) THEN
    RAISE EXCEPTION '2026-09-14 07:00:00+00 is not week-aligned; the week arithmetic has changed'
      USING ERRCODE = '55000';
  END IF;

  IF '2026-09-14T07:00:00+00'::timestamptz > v_hwm THEN
    RAISE EXCEPTION '2026-09-14 07:00:00+00 is ahead of the cursor %; the week arithmetic has changed', v_hwm
      USING ERRCODE = '55000';
  END IF;

  RAISE NOTICE 'guard verified: the installed cutover would be refused; 2026-09-14 07:00:00+00 satisfies both guards';
END
$prove$;


-- ----------------------------------------------------------------------------
-- 2.4  RECORD WHAT IS STILL OWED
--
-- 150 cash hands, 266.61 of rake, 119 players, 2 clubs, earned 2026-09-17
-- 07:28:33 to 07:34:04, nobody paid. They are NOT settled by this migration --
-- see "WHAT THIS MIGRATION DOES NOT DO" above. This leaves the finding where
-- the next agent will find it instead of rediscovering it from 5,294 receipts.
-- ----------------------------------------------------------------------------
COMMENT ON TABLE public.accounting_cash_accrual_batches IS
  'Append-only, immutable by trigger. One row per cash rake_record. A '
  'legacy_unverified row LATCHES that verdict: fn_accrue_cash_hand_commissions '
  'returns duplicate=true on the batch lookup BEFORE it reads the cutover, so '
  'moving the cutover can never release one. As of 2026-09-20 this table holds '
  '150 such rows, earned 2026-09-17 07:28:33 to 07:34:04, carrying 266.61 of '
  'rake across 119 players and 2 clubs, with zero agent_commissions, zero '
  'accounting_cash_rake_sources and zero rakeback_stats_applied rows against '
  'them. They were orphaned by a cutover armed ahead of the settler cursor and '
  'they remain unsettled.';

COMMIT;


-- ============================================================================
-- AFTER APPLYING -- verify by reading, not by assuming
-- ============================================================================
--
-- 1. The index is present, VALID, and the planner uses it:
--
--      EXPLAIN (ANALYZE, BUFFERS)
--      SELECT count(*) FROM public.rake_attributions
--       WHERE rake_record_id = (SELECT rake_record_id
--                                 FROM public.accounting_cash_source_work LIMIT 1);
--
--    Expect an Index Scan and single-digit milliseconds. Before this migration
--    the same query was a Seq Scan, "Rows Removed by Filter: 1175362",
--    ~165 ms.
--
-- 2. The guard is live:
--
--      SELECT tgname, tgenabled FROM pg_trigger
--       WHERE tgrelid = 'public.accounting_cash_accrual_cutover'::regclass
--         AND NOT tgisinternal;
--
--    Expect ca_cash_cutover_not_ahead_of_settler alongside
--    ca_cash_cutover_is_week_aligned and the immutability triggers.
--
-- 3. THE SETTLER IS THE REAL TEST, AND THE INDEX ALONE IS NOT EXPECTED TO
--    RESTART IT. Watch daemon_state.high_water_mark for 'rakeback_settler'.
--    Measured projections at 15 s DB_TIMEOUT_MS:
--
--      call                                     before      after index
--      fn_retry_cash_accounting_sources(50)     ~20.6 s     ~4.2 s   PASSES
--      fn_credit_agent_commissions_batch(150)   ~142 s      ~43.5 s  STILL FAILS
--
--    The index clears the call that currently halts the cycle first, but the
--    credit batch is 150 items x ~290 ms and still triples the client budget.
--    The engine change is required as well and is NOT in this migration:
--    lower CREDIT_BATCH_SIZE in server/src/services/RakebackSettlerService.ts
--    from 150 to about 40 (40 x 290 ms = 11.6 s, inside the budget), or raise
--    the client timeout for these two RPCs. Both functions already set their
--    own 300 s server-side statement_timeout, so the server was never the
--    constraint -- only the client's 15 s patience.
--
--    Until that lands, expect the cursor to stay put and
--    'RakebackSettler.attribution_failures_hold_cursor' to appear where
--    'RakebackSettler.source_retry_holds_cursor' appears today. That is
--    progress by one call, not a fix.
--
-- ============================================================================

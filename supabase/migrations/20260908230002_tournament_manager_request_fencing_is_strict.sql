-- 20260908230002_tournament_manager_request_fencing_is_strict
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-08 15:50:43 UTC.
--
/*
 * 20260908230002 -- STAGE B strict activation of the tournament-manager
 * request fence.
 *
 * This is deliberately a separate, forward-only cutover from Stage A.  Apply
 * it only after the exact-seat expansion (20260908161534) is installed and
 * the exact Stage-A engine build is the sole running build and
 * every older process has drained.  There is no timer, watcher, repair sweep,
 * or runtime flag: generation-blind engine compatibility doors are removed
 * transactionally here without changing unrelated shared-estate traffic.
 *
 * The database can prove three things at this boundary:
 *
 *   1. every manager-exclusive or engine-authority Data API route identifies
 *      its actor, while unrelated shared-estate service traffic stays valid;
 *   2. a tournament-manager request holds one exact, fresh lease generation
 *      for the complete PostgREST transaction;
 *   3. a marked manager may mutate the four shared core row families only
 *      inside that tournament.
 *
 * Ordinary service work remains valid because Club Arena and World Hub share
 * this PostgREST database hook and credential. Scheduling, registration,
 * recovery and cash-table services also legitimately share manager relations.
 * It would be incorrect to infer "manager" from service_role or a table name.
 * The runtime's single-client/method-binding guards plus the private-route
 * boundary prove that manager work cannot silently shed its actor marker.
 */

BEGIN;

/* A busy relation aborts the whole cutover instead of making a live table
   wait behind DDL. Re-run only in the audited quiet window after inspecting
   the unchanged catalog; never hide a timeout behind an automatic retry. */
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

/* Supabase Realtime takes relation-catalog locks while rebuilding its
   subscription state. Acquire that global catalog boundary before this
   migration inspects or changes any public object, so the cutover cannot form
   the inverse public-relation -> realtime.subscription lock order. NOWAIT
   aborts an occupied window whole instead of pausing live tables behind DDL. */
LOCK TABLE realtime.subscription IN ACCESS EXCLUSIVE MODE NOWAIT;

/* Stage B is a contraction after the independently receipted seat-first
   retirement. Refuse to duplicate or bypass that boundary: the atomic creator
   must exist and both legacy repair doors must already be absent. */
DO $require_seat_first_retirement$
BEGIN
  IF to_regprocedure(
       'public.fn_create_seat_first_game_atomic(uuid,jsonb)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'Stage-B manager fencing requires the atomic seat-first creator';
  END IF;

  IF to_regprocedure('public.fn_repair_seat_first_games(integer)') IS NOT NULL
     OR to_regprocedure(
          'public.fn_repair_seat_first_games_before_maintenance_gate(integer)'
        ) IS NOT NULL THEN
    RAISE EXCEPTION
      'Stage-B manager fencing requires the receipted seat-first retirement first';
  END IF;
END;
$require_seat_first_retirement$;

/* Refuse an out-of-order cutover or an accidental replacement of an unrelated
   PostgREST hook.  Reapplying this exact migration is harmless. */
DO $require_stage_a_request_authority$
DECLARE
  v_source text;
  v_settlement_core text;
  v_settlement_door text;
BEGIN
  IF to_regprocedure(
       'smarter_private.fn_smarter_data_api_pre_request()'
     ) IS NULL THEN
    RAISE EXCEPTION
      'Stage-B manager request fencing requires the Stage-A request hook first';
  END IF;

  SELECT p.prosrc
    INTO STRICT v_source
    FROM pg_proc p
   WHERE p.oid =
         'smarter_private.fn_smarter_data_api_pre_request()'::regprocedure
     AND p.prosecdef;

  IF position('app.smarter_data_actor' IN v_source) = 0
     OR position('x-smarter-data-actor' IN v_source) = 0
     OR position('l.lease_generation = v_lease_generation' IN v_source) = 0
     OR position('FOR SHARE' IN v_source) = 0
     OR position('request.jwt.claims' IN v_source) = 0
     OR position('auth.role()' IN v_source) = 0
     OR position('verified JWT role disagrees with request claims' IN v_source) = 0 THEN
    RAISE EXCEPTION
      'Refusing Stage-B activation over an unknown or incomplete request hook';
  END IF;

  IF to_regprocedure(
       'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'
     ) IS NULL
     OR to_regprocedure(
          'public.heartbeat_tournament_leases_v4(text,jsonb,integer)'
        ) IS NULL
     OR to_regprocedure(
          'public.release_tournament_leases_v2(text,jsonb)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz,uuid)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid)'
        ) IS NULL
     OR to_regprocedure(
          'public.claim_table_lease_v2(uuid,text,text,uuid,integer)'
        ) IS NULL
     OR to_regprocedure(
          'public.heartbeat_table_leases_v4(text,jsonb,integer)'
        ) IS NULL
     OR to_regprocedure(
          'public.release_table_leases_v2(text,jsonb)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_ca_process_hand_post_commit_obligations(uuid)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'
        ) IS NULL THEN
    RAISE EXCEPTION
      'Stage-B manager request fencing requires every tournament and table protocol-2 authority door';
  END IF;

  /* This contraction deletes the rolling 11-argument hand door below. A later
     terminal-receipt migration (20260909014534) was applied after the original
     exact-seat expansion and replaced both settlement bodies from an older
     generation-blind snapshot. Permit only that byte-exact, receipt-aware live
     preimage here; the immediately following 20260908230003 boundary restores
     the strict exact-seat contract before the stopped engine may restart.
     Any other generation-blind body still aborts this transaction. */
  SELECT pg_get_functiondef(
           'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure
         )
    INTO STRICT v_settlement_door;

  SELECT pg_get_functiondef(
           'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure
         )
    INTO STRICT v_settlement_core;

  IF position('seat_joined_at' IN v_settlement_door) > 0
     AND position('time_bank_seat_generation_mismatch' IN v_settlement_door) > 0 THEN
    IF md5(v_settlement_core) <> '9be5d1da12d8f674a47a50ffb9a6df81'
       OR md5(v_settlement_door) <> 'f93a85ebe5a509ccb7dfedb9be1ed3fa'
       OR position('v_exact_seat_generation' IN v_settlement_core) = 0
       OR position('v_exact_seat_generation' IN v_settlement_door) = 0
       OR position('tournament_zero_stack_seat_generations' IN v_settlement_core) = 0
       OR position('post_commit_request_hash' IN v_settlement_door) = 0
       OR position('ca:tournament-terminal-settlement:v1' IN v_settlement_door) = 0 THEN
      RAISE EXCEPTION
        'Stage-B manager fencing found an unknown restored exact hand-settlement source';
    END IF;
  ELSE
    IF md5(v_settlement_core) <> '2e322bc7dfee3cf5cb6548ed3a587095'
       OR md5(v_settlement_door) <> '8ddb91f5f7bb5f27b609ec83cb69fa66'
       OR position('tournament_zero_stack_seat_generations' IN v_settlement_core) = 0
       OR position('post_commit_request_hash' IN v_settlement_door) = 0
       OR position('ca:tournament-terminal-settlement:v1' IN v_settlement_door) = 0 THEN
      RAISE EXCEPTION
        'Stage-B manager fencing found an unknown hand-settlement source';
    END IF;
  END IF;
END;
$require_stage_a_request_authority$;

/* Contract the Stage-A tournament-settlement compatibility door only after the
   exact atomic-batch engine is the sole running build. Stage A deliberately
   kept this public signature behavior-compatible with older engines and kept
   every format completion, certificate and pool-lifecycle trigger disabled.
   The payer and all seven guards contract in this one transaction, so no state can expose one
   strict boundary without the others. */
DO $require_stage_a_tournament_settlement_expand$
DECLARE
  v_source text;
  v_satellite_cash_source text;
  v_satellite_guard_enabled boolean;
  v_guard_enabled boolean;
  v_final_deal_guard_enabled boolean;
  v_finish_claim_guard_enabled boolean;
  v_finish_certificate_guard_enabled boolean;
  v_pool_window_guard_enabled boolean;
  v_pool_freeze_guard_enabled boolean;
BEGIN
  IF to_regprocedure(
       'public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)'
     ) IS NULL
     OR to_regprocedure(
          'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)'
        ) IS NULL
     OR to_regprocedure(
          'public.trg_tournament_atomic_place_completion_guard()'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_settle_satellite_cash_entitlement_exact(uuid,text,integer,uuid,numeric,text)'
        ) IS NULL
     OR to_regprocedure(
          'public.trg_guard_atomic_satellite_completion()'
        ) IS NULL
     OR to_regprocedure(
          'public.trg_atomic_final_table_deal_completion_guard()'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_guard_tournament_completing_claim()'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_guard_tournament_completed_certificate()'
        ) IS NULL
     OR to_regprocedure(
          'public.trg_tournament_pool_finalization_window_guard()'
        ) IS NULL
     OR to_regprocedure(
          'public.trg_freeze_finalized_tournament_prize_pool()'
        ) IS NULL THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A expand objects';
  END IF;

  SELECT pg_get_functiondef(
           'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)'::regprocedure
         )
    INTO v_source;
  IF position('fn_settle_tournament_obligation_before_atomic_batch_gate('
              IN v_source) = 0 THEN
    RAISE EXCEPTION
      'Refusing Stage-B contraction over an unknown single-obligation wrapper';
  END IF;

  SELECT pg_get_functiondef(
           'public.fn_settle_satellite_cash_entitlement_exact(uuid,text,integer,uuid,numeric,text)'::regprocedure
         )
    INTO v_satellite_cash_source;
  IF position('fn_settle_tournament_obligation_before_atomic_batch_gate('
              IN v_satellite_cash_source) = 0
     OR position('public.fn_settle_tournament_obligation('
                 IN v_satellite_cash_source) > 0 THEN
    RAISE EXCEPTION
      'Stage-B requires the atomic satellite helper to use the private obligation core';
  END IF;

  SELECT t.tgenabled <> 'D'
    INTO v_satellite_guard_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'aaa_guard_atomic_satellite_completion'
     AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A satellite completion guard';
  END IF;

  SELECT t.tgenabled <> 'D'
    INTO v_guard_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'zzzz_tournaments_atomic_place_completion_guard'
     AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A completion guard';
  END IF;

  SELECT t.tgenabled <> 'D'
    INTO v_final_deal_guard_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'zzzzz_tournaments_atomic_final_table_deal_completion_guard'
     AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A final-table-deal completion guard';
  END IF;

  SELECT t.tgenabled <> 'D'
    INTO v_finish_claim_guard_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'aa_guard_tournament_completing_claim'
     AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A finish-claim guard';
  END IF;

  SELECT t.tgenabled <> 'D'
    INTO v_finish_certificate_guard_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'zzzzzz_tournaments_financial_certificate'
     AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A financial-certificate guard';
  END IF;

  SELECT t.tgenabled <> 'D'
    INTO v_pool_window_guard_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'zzzz_tournament_pool_finalization_window_guard'
     AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A pool-window guard';
  END IF;

  SELECT t.tgenabled <> 'D'
    INTO v_pool_freeze_guard_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'zzzz_freeze_finalized_tournament_prize_pool'
     AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A finalized-pool guard';
  END IF;

  IF position('atomic_batch_required' IN v_source) = 0 THEN
    IF position('FOR UPDATE' IN v_source) > 0
       OR v_satellite_guard_enabled
       OR v_guard_enabled
       OR v_final_deal_guard_enabled
       OR v_finish_claim_guard_enabled
       OR v_finish_certificate_guard_enabled
       OR v_pool_window_guard_enabled
       OR v_pool_freeze_guard_enabled THEN
      RAISE EXCEPTION
        'Stage-A settlement expand objects are not in their compatible state';
    END IF;
  ELSIF position('v_kind' IN v_source) = 0
        OR position('v_atomic_kinds' IN v_source) = 0
        OR position('v_kind = ANY(v_atomic_kinds)' IN v_source) = 0
        OR position('satellite_remainder' IN v_source) = 0
        OR position($needle$'seat'$needle$ IN v_source) = 0
        OR position('FOR UPDATE' IN v_source) > 0
        OR position('v_is_satellite' IN v_source) > 0
        OR NOT v_satellite_guard_enabled
        OR NOT v_guard_enabled
        OR NOT v_final_deal_guard_enabled
        OR NOT v_finish_claim_guard_enabled
        OR NOT v_finish_certificate_guard_enabled
        OR NOT v_pool_window_guard_enabled
        OR NOT v_pool_freeze_guard_enabled THEN
    RAISE EXCEPTION
      'Existing Stage-B settlement contract is incomplete';
  END IF;
END;
$require_stage_a_tournament_settlement_expand$;

/* Retire the raw-table rolling bridge at one explicit writer boundary. Lock
   tables first because the old request obtains that relation before its
   deferred validator locks a protocol-1 lease. NOWAIT makes a concurrent
   legacy insert or wake/receipt writer abort this entire cutover without a
   partial catalog change. Holding the lease relation EXCLUSIVE then prevents
   a heartbeat or a bridge FOR SHARE lock from crossing the replacement. */
LOCK TABLE public.tables IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_table_origins IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_capacity_table_receipts
  IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_manager_wakes IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.engine_tournament_leases IN EXCLUSIVE MODE NOWAIT;

DO $refuse_live_protocol_one_tournament_manager$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.engine_tournament_leases l
     WHERE l.protocol_version = 1
       AND l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
  ) THEN
    RAISE EXCEPTION
      'Stage-B cutover refused: a fresh protocol-1 tournament manager still owns a lease';
  END IF;
END;
$refuse_live_protocol_one_tournament_manager$;

/* Stage B preserves every already-committed bridge table as an ordinary
   capacity origin with its canonical receipt. Only the transaction-time
   synthesis is removed; all future capacity paths are receipt-only. */
CREATE OR REPLACE FUNCTION public.trg_validate_tournament_table_origin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_parent_status text;
BEGIN
  SELECT t.status::text INTO v_parent_status
    FROM public.tournaments t
   WHERE t.id = NEW.tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament table origin lost parent tournament %', NEW.tournament_id
      USING ERRCODE = '23503';
  END IF;

  IF NEW.origin_kind = 'capacity' THEN
    IF upper(v_parent_status) <> 'RUNNING'
       OR NOT EXISTS (
         SELECT 1
           FROM public.tournament_capacity_table_receipts c
          WHERE c.table_id = NEW.table_id
            AND c.tournament_id = NEW.tournament_id
       ) THEN
      RAISE EXCEPTION
        'TOURNAMENT_CAPACITY_RECEIPT_REQUIRED: RUNNING table % must create its canonical capacity receipt in the same transaction',
        NEW.table_id
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.origin_kind = 'launch' THEN
    IF upper(v_parent_status) <> 'REGISTERING'
       OR NOT EXISTS (
         SELECT 1
           FROM public.tournament_launch_receipts r
          WHERE r.tournament_id = NEW.tournament_id
            AND r.launch_id = NEW.launch_id
            AND r.lease_generation = NEW.launch_lease_generation
            AND r.completed_at IS NULL
       ) THEN
      RAISE EXCEPTION
        'STALE_TOURNAMENT_LAUNCH_TABLE: table % does not belong to the exact incomplete launch receipt',
        NEW.table_id
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.origin_kind = 'prelaunch' THEN
    IF upper(v_parent_status) = 'RUNNING'
       OR EXISTS (
         SELECT 1
           FROM public.tournament_launch_receipts r
          WHERE r.tournament_id = NEW.tournament_id
       ) THEN
      RAISE EXCEPTION
        'TOURNAMENT_PRELAUNCH_ORIGIN_STALE: table % crossed a launch boundary in its birth transaction',
        NEW.table_id
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.origin_kind = 'legacy' THEN
    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'unknown tournament table origin %', NEW.origin_kind
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP FUNCTION IF EXISTS public.fn_stage_a_bridge_legacy_capacity_receipt(uuid,uuid)
  RESTRICT;

DO $assert_stage_a_legacy_capacity_bridge_retired$
DECLARE
  v_origin_source text;
BEGIN
  SELECT p.prosrc INTO STRICT v_origin_source
    FROM pg_proc p
   WHERE p.oid =
     'public.trg_validate_tournament_table_origin()'::regprocedure
     AND p.prosecdef;

  IF to_regprocedure(
       'public.fn_stage_a_bridge_legacy_capacity_receipt(uuid,uuid)'
     ) IS NOT NULL
     OR position('fn_stage_a_bridge_legacy_capacity_receipt'
                 IN v_origin_source) > 0
     OR position('tournament_capacity_table_receipts'
                 IN v_origin_source) = 0
     OR position('TOURNAMENT_CAPACITY_RECEIPT_REQUIRED'
                 IN v_origin_source) = 0 THEN
    RAISE EXCEPTION 'Stage-B capacity validation still has a legacy admission path';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournament_table_origins o
     WHERE o.origin_kind = 'capacity'
       AND NOT EXISTS (
         SELECT 1
           FROM public.tournament_capacity_table_receipts c
          WHERE c.table_id = o.table_id
            AND c.tournament_id = o.tournament_id
       )
  ) THEN
    RAISE EXCEPTION 'Stage-B found a capacity origin without durable receipt provenance';
  END IF;
END;
$assert_stage_a_legacy_capacity_bridge_retired$;

/* Freeze the five ledgers that can reveal an in-flight legacy final-table
   deal before inspecting them. A concurrent writer refuses this attempt;
   holding these locks through COMMIT prevents a new one from crossing between
   the proof and the strict payer/trigger activation. */
LOCK TABLE public.tournaments IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_obligations IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_payouts IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_final_table_deal_batches
  IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_final_table_deal_receipts
  IN SHARE ROW EXCLUSIVE MODE NOWAIT;

DO $refuse_inflight_legacy_final_table_deal$
BEGIN
  IF EXISTS (
    SELECT 1
     FROM public.tournaments t
     WHERE upper(COALESCE(t.status, '')) IN ('RUNNING', 'COMPLETING')
       AND (
         EXISTS (
           SELECT 1
             FROM public.tournament_final_table_deal_batches b
            WHERE b.tournament_id = t.id
         )
         OR EXISTS (
           SELECT 1
             FROM public.tournament_final_table_deal_receipts r
            WHERE r.tournament_id = t.id
         )
         OR EXISTS (
           SELECT 1
             FROM public.tournament_obligations o
            WHERE o.tournament_id = t.id
              AND o.kind = 'final_table_deal'
         )
         OR EXISTS (
           SELECT 1
             FROM public.tournament_payouts p
            WHERE p.tournament_id = t.id
              AND p.source = 'final_table_deal'
         )
       )
  ) THEN
    RAISE EXCEPTION
      'an active final-table deal has a batch or payment evidence that cannot replay; drain or resolve it before Stage B';
  END IF;
END;
$refuse_inflight_legacy_final_table_deal$;

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_obligation(
  p_tournament_id uuid,
  p_kind text,
  p_place integer,
  p_user_id uuid,
  p_amount numeric,
  p_source text,
  p_description text DEFAULT NULL,
  p_adjustment_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_kind text := lower(btrim(COALESCE(p_kind, '')));
  v_atomic_kinds CONSTANT text[] := ARRAY[
    'place', 'late_reg_adjustment', 'bubble_protection',
    'final_table_deal', 'satellite_remainder', 'seat'
  ];
BEGIN
  /* Preserve the private core's canonical validation responses for malformed
     calls and non-structure classes. Every valid structure class is private to
     its complete atomic transaction, regardless of tournament format. */
  IF p_tournament_id IS NULL OR p_user_id IS NULL
     OR round(COALESCE(p_amount, 0), 2) < 0
     OR v_kind NOT IN ('place','bounty','bounty_residual','mystery_bounty',
                       'refund','seat','satellite_remainder',
                       'bubble_protection','final_table_deal',
                       'late_reg_adjustment')
     OR (v_kind IN ('place', 'late_reg_adjustment') AND p_place IS NULL)
     OR NOT (v_kind = ANY(v_atomic_kinds)) THEN
    RETURN public.fn_settle_tournament_obligation_before_atomic_batch_gate(
      p_tournament_id, p_kind, p_place, p_user_id, p_amount, p_source,
      p_description, p_adjustment_id);
  END IF;

  RETURN jsonb_build_object(
    'ok', false, 'paid', 0, 'already_paid', 0,
    'refused_reason', 'atomic_batch_required', 'obligation_id', NULL,
    'idempotency_key', NULL,
    'detail', 'prize-pool money, including satellite seats and cash remainder, moves only inside its complete atomic batch');
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_settle_tournament_obligation(
  uuid, text, integer, uuid, numeric, text, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_obligation(
  uuid, text, integer, uuid, numeric, text, text, uuid
) TO service_role;

COMMENT ON FUNCTION public.fn_settle_tournament_obligation(
  uuid, text, integer, uuid, numeric, text, text, uuid
) IS
  'Strict Stage-B single-obligation payer for non-pool money. Every prize-pool kind, including satellite seats and cash remainder, is refused for every tournament format; only private cores inside complete atomic batch functions may move that money.';

ALTER TABLE public.tournaments
  ENABLE TRIGGER aaa_guard_atomic_satellite_completion;
ALTER TABLE public.tournaments
  ENABLE TRIGGER zzzz_tournaments_atomic_place_completion_guard;
ALTER TABLE public.tournaments
  ENABLE TRIGGER zzzzz_tournaments_atomic_final_table_deal_completion_guard;
ALTER TABLE public.tournaments
  ENABLE TRIGGER aa_guard_tournament_completing_claim;
ALTER TABLE public.tournaments
  ENABLE TRIGGER zzzzzz_tournaments_financial_certificate;
ALTER TABLE public.tournaments
  ENABLE TRIGGER zzzz_tournament_pool_finalization_window_guard;
ALTER TABLE public.tournaments
  ENABLE TRIGGER zzzz_freeze_finalized_tournament_prize_pool;

/* The stopped-engine precertification boundary immediately before Stage B owns
   the finite Stage-A cohort. This DDL transaction only proves that boundary is
   closed while its seven trigger-enabling locks are held. It never evaluates
   thousands of readiness functions or updates finish receipts under Stage B's
   30-second statement budget. Any candidate aborts the entire cutover. */
DO $require_stage_a_atomic_finishes_precertified$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.tournaments t
     WHERE t.status='COMPLETED'
       AND (
         EXISTS (SELECT 1 FROM public.tournament_place_settlement_batches b
                  WHERE b.tournament_id=t.id AND b.settled_at IS NOT NULL)
         OR EXISTS (SELECT 1 FROM public.tournament_final_table_deal_batches b
                     WHERE b.tournament_id=t.id AND b.settled_at IS NOT NULL)
         OR EXISTS (SELECT 1 FROM public.tournament_satellite_settlement_batches b
                     WHERE b.tournament_id=t.id AND b.settled_at IS NOT NULL)
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.tournament_finish_receipts f
          WHERE f.tournament_id=t.id
            AND f.certified_at IS NOT NULL
            AND f.completed_at IS NOT NULL
            AND jsonb_typeof(f.evidence)='object'
       )
  ) THEN
    RAISE EXCEPTION
      'Stage-B requires the stopped-engine atomic finish precertification boundary first'
      USING ERRCODE='check_violation';
  END IF;
END;
$require_stage_a_atomic_finishes_precertified$;

/* The atomic engines are now the only running builds, so retire the complete
   deferred payout-repair graph in this contraction transaction. Stage A left
   these exact RPCs and dispatch routes alive for rolling compatibility with
   older processes. RESTRICT makes an unknown database dependency abort the
   cutover instead of being cascade-dropped. */
DO $retire_applying_rpc_authority$
BEGIN
  IF to_regprocedure('public.fn_tournament_payout_sweep(integer,boolean,integer)')
     IS NOT NULL THEN
    EXECUTE
      'REVOKE ALL ON FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
  IF to_regprocedure('public.fn_ca_backpay_guarantee_shortfalls(boolean,integer)')
     IS NOT NULL THEN
    EXECUTE
      'REVOKE ALL ON FUNCTION public.fn_ca_backpay_guarantee_shortfalls(boolean, integer) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
  IF to_regprocedure('public.sp_ca_reconcile_backpaid_events(boolean)')
     IS NOT NULL THEN
    EXECUTE
      'REVOKE ALL ON PROCEDURE public.sp_ca_reconcile_backpaid_events(boolean) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
  IF to_regclass('public.ca_settle_sources') IS NOT NULL THEN
    EXECUTE
      'DELETE FROM public.ca_settle_sources WHERE lower(source) = ANY($1)'
      USING ARRAY[
        'reconcile',
        'fn_tournament_payout_reconcile',
        'fn_pay_backed_payout_shortfalls',
        'fn_ca_backpay_guarantee_shortfalls',
        'fn_tournament_payout_sweep',
        'sp_ca_reconcile_backpaid_events',
        'fn_backpay_hu_winner_shortfalls'
      ]::text[];
  END IF;
END;
$retire_applying_rpc_authority$;

/* A removed RPC must not remain discoverable as a dormant money path. The
   historical payout and alert rows stay intact; only executable and dispatch
   authority is retired. */
DELETE FROM public.ca_money_rpc_registry
 WHERE proname IN (
   'fn_tournament_payout_reconcile',
   'fn_pay_backed_payout_shortfalls',
   'fn_ca_backpay_guarantee_shortfalls',
   'fn_tournament_payout_sweep',
   'sp_ca_reconcile_backpaid_events',
   'fn_backpay_hu_winner_shortfalls'
 );

DO $retire_applying_sweep$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.unschedule(j.jobid)
      FROM cron.job j
     WHERE j.jobname = 'ca-payout-sweep-hourly'
        OR j.command ~* '(fn_tournament_payout_sweep|fn_tournament_payout_reconcile|fn_pay_backed_payout_shortfalls|fn_ca_backpay_guarantee_shortfalls|sp_ca_reconcile_backpaid_events|fn_backpay_hu_winner_shortfalls)';
  END IF;
END;
$retire_applying_sweep$;

DO $retire_legacy_roster$
BEGIN
  IF to_regclass('public.ca_expected_cron_jobs') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.ca_expected_cron_jobs WHERE jobname = $1'
      USING 'ca-payout-sweep-hourly';
  END IF;
END;
$retire_legacy_roster$;

DROP PROCEDURE IF EXISTS public.sp_ca_reconcile_backpaid_events(boolean) RESTRICT;
DROP FUNCTION IF EXISTS public.fn_tournament_payout_sweep(integer, boolean, integer) RESTRICT;
DROP FUNCTION IF EXISTS public.fn_pay_backed_payout_shortfalls(boolean, integer) RESTRICT;
DROP FUNCTION IF EXISTS public.fn_ca_backpay_guarantee_shortfalls(boolean, integer) RESTRICT;
DROP FUNCTION IF EXISTS public.fn_backpay_hu_winner_shortfalls(integer) RESTRICT;
DROP FUNCTION IF EXISTS public.fn_tournament_payout_reconcile(uuid, boolean) RESTRICT;

/* These two findings describe failures of the retired applying sweep itself,
   not proof that a player's shortfall was repaired. Every obligation and
   player-money finding stays open. */
UPDATE public.financial_alerts
   SET resolved = true,
       resolved_at = now(),
       resolution =
         'The applying payout repair cron was retired by the Stage-B atomic tournament settlement cutover. This closes only the retired sweep operation and does not close any player-money finding.'
 WHERE resolved IS NOT TRUE
   AND source IN ('fn_tournament_payout_sweep',
                  'fn_tournament_payout_sweep_truncated');

REVOKE ALL ON SCHEMA smarter_private
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT USAGE ON SCHEMA smarter_private TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION smarter_private.fn_smarter_data_api_pre_request()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_headers jsonb;
  v_claims jsonb;
  v_actor text;
  v_protocol text;
  v_request_role text;
  v_method text;
  v_path text;
  v_tournament_id uuid;
  v_lease_generation uuid;
  v_stale_seconds constant integer := 30;
  v_manager_exclusive_paths constant text[] := ARRAY[
    'rpc/fn_ack_tournament_capacity_tables',
    'rpc/fn_apply_prize_guarantee',
    'rpc/fn_assign_tournament_player_seat_atomic',
    'rpc/fn_begin_tournament_launch_atomic',
    'rpc/fn_bounty_obligation_has_complete_marker',
    'rpc/fn_ca_paid_spin_launch_entitlements',
    'rpc/fn_ca_tournament_launch_supply_version',
    'rpc/fn_claim_tournament_bounty_elimination',
    'rpc/fn_close_tournament_addon_period',
    'rpc/fn_close_empty_tournament_table',
    'rpc/fn_close_tournament_entry_window',
    'rpc/fn_collect_bounty',
    'rpc/fn_complete_tournament_entry_reprice',
    'rpc/fn_complete_tournament_launch_atomic',
    'rpc/fn_eliminate_tournament_player_atomic',
    'rpc/fn_ensure_late_registration_capacity',
    'rpc/fn_get_tournament_satellite_entitlement_depth',
    'rpc/fn_mystery_bounty_pay',
    'rpc/fn_mystery_bounty_reserve',
    'rpc/fn_mystery_bounty_seed',
    'rpc/fn_move_tournament_player',
    'rpc/fn_move_tournament_player_atomic',
    'rpc/fn_open_tournament_rebuy_decisions',
    'rpc/fn_prove_played_spin_launch_recovery',
    'rpc/fn_settle_final_table_deal_atomic',
    'rpc/fn_spin_draw_and_settle_atomic',
    'rpc/fn_spin_draw_multiplier',
    'rpc/fn_spin_settle_game',
    'rpc/fn_sync_tournament_live_seat_chips',
    'rpc/fn_tournament_has_unsettled_bounties'
  ]::text[];
  /* These three routines deliberately serve two identities. An authenticated
     player may reach the routine's existing user/award authorization, while
     a server caller must be one exact protocol-2 tournament manager. Keeping
     this as a disjoint class prevents either the browser exception or the
     manager lease requirement from being widened to generic service_role. */
  v_player_or_manager_paths constant text[] := ARRAY[
    'rpc/fn_decline_tournament_rebuy',
    'rpc/fn_mystery_bounty_reveal',
    'rpc/process_tournament_rebuy'
  ]::text[];
  v_engine_service_paths constant text[] := ARRAY[
    'rpc/claim_table_lease_v2',
    'rpc/claim_tournament_lease_v2',
    'rpc/fn_ack_tournament_manager_wakes',
    'rpc/fn_ca_commit_hand_settlement',
    'rpc/fn_ca_process_hand_post_commit_obligations',
    'rpc/fn_certify_tournament_finish',
    'rpc/fn_claim_tournament_finish',
    'rpc/fn_complete_tournament_terminal',
    'rpc/fn_finalize_bounty_pool',
    'rpc/fn_mystery_bounty_settle',
    'rpc/fn_normalize_tournament_final_standings',
    'rpc/fn_prepare_tournament_place_obligations',
    'rpc/fn_project_hand_side_effects',
    'rpc/fn_resolve_committed_tournament_seat_move',
    'rpc/fn_resolve_satellite_settlement_outcome',
    'rpc/fn_resolve_tournament_terminal_outcome',
    'rpc/fn_settle_satellite_finish_atomic',
    'rpc/fn_settle_satellite_tournament',
    'rpc/fn_settle_tournament_obligation',
    'rpc/fn_settle_tournament_places_atomic',
    'rpc/fn_settle_tournament_rake',
    'rpc/fn_sweep_pending_tournament_bounties',
    'rpc/fn_sync_seat_first_player_count',
    'rpc/heartbeat_table_leases_v4',
    'rpc/heartbeat_tournament_leases_v4',
    'rpc/release_table_leases_v2',
    'rpc/release_tournament_leases_v2'
  ]::text[];
BEGIN
  BEGIN
    v_headers := COALESCE(
      NULLIF(current_setting('request.headers', true), '')::jsonb,
      '{}'::jsonb
    );
    v_claims := COALESCE(
      NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
      '{}'::jsonb
    );
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: malformed PostgREST request context'
      USING ERRCODE = '22023';
  END;

  v_actor := lower(btrim(COALESCE(v_headers ->> 'x-smarter-data-actor', '')));
  v_protocol := btrim(COALESCE(v_headers ->> 'x-smarter-data-protocol', ''));
  /* SECURITY DEFINER makes current_user the function owner.  The JWT claims
     supplied and verified by PostgREST are the request identity here. */
  v_request_role := btrim(COALESCE(auth.role(), ''));
  IF v_actor <> ''
     AND v_request_role <> btrim(COALESCE(v_claims ->> 'role', '')) THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: verified JWT role disagrees with request claims'
      USING ERRCODE = '22023';
  END IF;
  v_method := upper(btrim(COALESCE(current_setting('request.method', true), '')));
  v_path := lower(btrim(COALESCE(current_setting('request.path', true), ''), '/'));
  /* Direct PostgREST reports `rpc/name`; Supabase gateways may retain the
     `rest/v1/` prefix. Normalize both shapes before applying the same exact
     route allowlist. Never use a suffix/substring match for authority. */
  IF left(v_path, 8) = 'rest/v1/' THEN
    v_path := substr(v_path, 9);
  END IF;

  /* Transaction-local settings are reset by PostgreSQL at transaction end,
     but clear the proof explicitly before evaluating this request as a
     fail-closed defence against an incorrectly pooled session. */
  PERFORM set_config('app.smarter_manager_request_fenced', '', true);
  PERFORM set_config('app.smarter_manager_deleted_table_ids', '', true);

  IF v_path = 'rpc/fn_smarter_data_api_pre_request' THEN
    RAISE EXCEPTION 'DATA_ACTOR_FORBIDDEN: request hook is not an RPC'
      USING ERRCODE = '42501';
  END IF;

  /* This hook is shared by the entire estate. Do not turn the shared
     service-role credential into a Club-Arena-only protocol. Restrict only
     the RPC routes whose authority belongs to the engine. Manager-exclusive
     routes fail when a callback loses its bound manager context; recovery and
     lease-coordination routes accept the explicitly marked service actor too.
     Old/headerless engine binaries can use none of these server paths after
     cutover. */
  IF v_path = ANY(v_player_or_manager_paths)
     AND NOT (
       (v_request_role = 'authenticated' AND v_actor = '')
       OR v_actor = 'tournament-manager'
     ) THEN
    RAISE EXCEPTION
      'PLAYER_OR_MANAGER_AUTHORITY_REQUIRED: RPC requires its authenticated player or exact lease manager'
      USING ERRCODE = '42501';
  END IF;
  IF v_path = ANY(v_manager_exclusive_paths)
     AND v_actor IS DISTINCT FROM 'tournament-manager' THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_AUTHORITY_REQUIRED: manager RPC requires exact lease authority'
      USING ERRCODE = '42501';
  END IF;
  IF v_path = ANY(v_engine_service_paths)
     AND v_actor NOT IN ('service', 'tournament-manager') THEN
    RAISE EXCEPTION
      'ENGINE_DATA_AUTHORITY_REQUIRED: engine RPC requires an identified service actor'
      USING ERRCODE = '42501';
  END IF;

  /* Unrelated World Hub/Club Arena service traffic deliberately remains
     compatible when unmarked. Browser traffic keeps its normal unmarked
     shape too. Only the engine-private paths above require identification. */
  IF v_actor = '' THEN
    IF v_request_role = 'service_role' THEN
      PERFORM set_config('app.smarter_data_actor', 'shared-estate-service', true);
    ELSE
      PERFORM set_config('app.smarter_data_actor', 'browser', true);
    END IF;
    PERFORM set_config('app.smarter_tournament_id', '', true);
    PERFORM set_config('app.smarter_tournament_lease_generation', '', true);
    RETURN;
  END IF;

  IF v_request_role <> 'service_role' THEN
    RAISE EXCEPTION 'DATA_ACTOR_FORBIDDEN: marked server actor requires service_role'
      USING ERRCODE = '42501';
  END IF;

  IF v_actor = 'service' THEN
    IF v_protocol <> '1'
       OR length(btrim(COALESCE(v_headers ->> 'x-smarter-tournament-id', ''))) > 0
       OR length(
            btrim(
              COALESCE(v_headers ->> 'x-smarter-tournament-lease-generation', '')
            )
          ) > 0 THEN
      RAISE EXCEPTION 'DATA_ACTOR_INVALID: service authority headers are inconsistent'
        USING ERRCODE = '22023';
    END IF;
    PERFORM set_config('app.smarter_data_actor', 'service', true);
    PERFORM set_config('app.smarter_tournament_id', '', true);
    PERFORM set_config('app.smarter_tournament_lease_generation', '', true);
    RETURN;
  END IF;

  IF v_actor <> 'tournament-manager' OR v_protocol <> '2' THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: unknown actor or protocol'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_tournament_id := (v_headers ->> 'x-smarter-tournament-id')::uuid;
    v_lease_generation :=
      (v_headers ->> 'x-smarter-tournament-lease-generation')::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: manager authority requires two UUIDs'
      USING ERRCODE = '22023';
  END;
  IF v_tournament_id IS NULL OR v_lease_generation IS NULL THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: manager authority requires two UUIDs'
      USING ERRCODE = '22023';
  END IF;

  IF v_method IN ('GET', 'HEAD', 'OPTIONS') THEN
    PERFORM 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
       AND l.protocol_version = 2
       AND l.lease_generation = v_lease_generation
       AND l.heartbeat_at >=
           clock_timestamp() - make_interval(secs => v_stale_seconds);
  ELSE
    PERFORM 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
       AND l.protocol_version = 2
       AND l.lease_generation = v_lease_generation
       AND l.heartbeat_at >=
           clock_timestamp() - make_interval(secs => v_stale_seconds)
     FOR SHARE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_FENCED: lease generation is no longer current'
      USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('app.smarter_data_actor', 'tournament-manager', true);
  PERFORM set_config('app.smarter_tournament_id', v_tournament_id::text, true);
  PERFORM set_config(
    'app.smarter_tournament_lease_generation',
    v_lease_generation::text,
    true
  );
  /* This marker is written last and only after the exact lease row is held
     FOR SHARE. Row triggers can consume this transaction proof without doing
     the same indexed lease read again for every affected row. */
  PERFORM set_config('app.smarter_manager_request_fenced', 'protocol-2', true);
END;
$function$;

REVOKE ALL ON FUNCTION smarter_private.fn_smarter_data_api_pre_request()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION smarter_private.fn_smarter_data_api_pre_request()
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION smarter_private.fn_smarter_data_api_pre_request() IS
  'Private, non-API Stage-B shared-estate Data API boundary. Unrelated unmarked service_role traffic remains valid; engine-private routes require an identified actor; protocol-2 tournament managers must hold and transaction-lock one exact fresh generation.';

DROP FUNCTION IF EXISTS public.fn_smarter_data_api_pre_request();

/* A marked manager is not merely "some manager".  Every direct row it touches
   must resolve to the same tournament named by the transaction-local request
   proof. The pre-request hook already holds the exact lease FOR SHARE for the
   complete PostgREST transaction. Re-reading that same row once per affected
   row would add hot-path work without strengthening the lock. */
CREATE OR REPLACE FUNCTION public.fn_assert_tournament_manager_write_scope(
  p_tournament_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_tournament_id uuid;
  v_lease_generation uuid;
BEGIN
  IF current_setting('app.smarter_data_actor', true)
       IS DISTINCT FROM 'tournament-manager' THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_REQUIRED: manager actor is absent'
      USING ERRCODE = '42501';
  END IF;

  IF current_setting('app.smarter_manager_request_fenced', true)
       IS DISTINCT FROM 'protocol-2' THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_SCOPE_REQUIRED: request lease proof is absent'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_tournament_id :=
      NULLIF(current_setting('app.smarter_tournament_id', true), '')::uuid;
    v_lease_generation :=
      NULLIF(
        current_setting('app.smarter_tournament_lease_generation', true),
        ''
      )::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_INVALID: malformed authority context'
      USING ERRCODE = '22023';
  END;

  IF p_tournament_id IS NULL
     OR v_tournament_id IS NULL
     OR v_lease_generation IS NULL
     OR p_tournament_id IS DISTINCT FROM v_tournament_id THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_SCOPE_VIOLATION: row belongs to another tournament'
      USING ERRCODE = '42501';
  END IF;

END;
$function$;

REVOKE ALL ON FUNCTION public.fn_assert_tournament_manager_write_scope(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trg_tournament_manager_write_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_deleted_table_ids uuid[];
BEGIN
  /* Shared tables have valid ordinary service writers.  Only the explicitly
     marked manager actor is scoped by this trigger; guessing from relation
     names would reject registration, scheduling, recovery, and cash games. */
  IF current_setting('app.smarter_data_actor', true)
       IS DISTINCT FROM 'tournament-manager' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'tournaments' THEN
    IF TG_OP <> 'INSERT' THEN v_old_tournament_id := OLD.id; END IF;
    IF TG_OP <> 'DELETE' THEN v_new_tournament_id := NEW.id; END IF;
  ELSIF TG_TABLE_NAME = 'tournament_players' THEN
    IF TG_OP <> 'INSERT' THEN v_old_tournament_id := OLD.tournament_id; END IF;
    IF TG_OP <> 'DELETE' THEN v_new_tournament_id := NEW.tournament_id; END IF;
  ELSIF TG_TABLE_NAME = 'tables' THEN
    IF TG_OP <> 'INSERT' THEN v_old_tournament_id := OLD.tournament_id; END IF;
    IF TG_OP <> 'DELETE' THEN v_new_tournament_id := NEW.tournament_id; END IF;
  ELSIF TG_TABLE_NAME = 'table_seats' THEN
    IF TG_OP <> 'INSERT' THEN
      SELECT t.tournament_id INTO v_old_tournament_id
        FROM public.tables t
       WHERE t.id = OLD.table_id;
      IF NOT FOUND THEN
        /* An ON DELETE CASCADE seat trigger runs after its parent table tuple
           has become invisible to this statement. The parent's own BEFORE
           DELETE scope trigger already proved the exact tournament. Consume
           that transaction proof only for a nested DELETE; a direct orphan
           mutation still fails closed. */
        BEGIN
          v_deleted_table_ids := COALESCE(
            NULLIF(
              current_setting('app.smarter_manager_deleted_table_ids', true),
              ''
            )::uuid[],
            '{}'::uuid[]
          );
        EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
          v_deleted_table_ids := '{}'::uuid[];
        END;
        IF TG_OP = 'DELETE'
           AND pg_trigger_depth() > 1
           AND OLD.table_id = ANY(v_deleted_table_ids) THEN
          BEGIN
            v_old_tournament_id :=
              NULLIF(current_setting('app.smarter_tournament_id', true), '')::uuid;
          EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
            v_old_tournament_id := NULL;
          END;
          IF v_old_tournament_id IS NULL THEN
            RAISE EXCEPTION
              'TOURNAMENT_MANAGER_SCOPE_VIOLATION: cascaded seat has no parent proof'
              USING ERRCODE = '42501';
          END IF;
        ELSE
          RAISE EXCEPTION
            'TOURNAMENT_MANAGER_SCOPE_VIOLATION: old seat table is missing'
            USING ERRCODE = '42501';
        END IF;
      END IF;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT t.tournament_id INTO v_new_tournament_id
        FROM public.tables t
       WHERE t.id = NEW.table_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION
          'TOURNAMENT_MANAGER_SCOPE_VIOLATION: new seat table is missing'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  ELSE
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_INVALID: unsupported trigger relation'
      USING ERRCODE = '55000';
  END IF;

  IF v_old_tournament_id IS NOT NULL THEN
    PERFORM public.fn_assert_tournament_manager_write_scope(v_old_tournament_id);
  END IF;
  IF v_new_tournament_id IS NOT NULL
     AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    PERFORM public.fn_assert_tournament_manager_write_scope(v_new_tournament_id);
  END IF;

  /* A manager must never touch a cash table/seat (NULL tournament_id), nor may
     it turn a tournament table into a cash table. */
  IF (TG_OP <> 'INSERT' AND v_old_tournament_id IS NULL)
     OR (TG_OP <> 'DELETE' AND v_new_tournament_id IS NULL) THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_SCOPE_VIOLATION: manager write has no tournament'
      USING ERRCODE = '42501';
  END IF;

  /* The exact parent row has now passed manager scope. Persist its id only
     for this transaction so the subsequent FK ON DELETE CASCADE can prove
     why its parent tuple is no longer visible. This is not a broad nested-
     trigger exemption: the child must name an id admitted here. */
  IF TG_TABLE_NAME = 'tables' AND TG_OP = 'DELETE' THEN
    BEGIN
      v_deleted_table_ids := COALESCE(
        NULLIF(
          current_setting('app.smarter_manager_deleted_table_ids', true),
          ''
        )::uuid[],
        '{}'::uuid[]
      );
    EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
      RAISE EXCEPTION
        'TOURNAMENT_MANAGER_SCOPE_INVALID: malformed deleted-table proof'
        USING ERRCODE = '22023';
    END;
    IF NOT OLD.id = ANY(v_deleted_table_ids) THEN
      v_deleted_table_ids := array_append(v_deleted_table_ids, OLD.id);
    END IF;
    PERFORM set_config(
      'app.smarter_manager_deleted_table_ids',
      v_deleted_table_ids::text,
      true
    );
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_tournament_manager_write_scope()
  FROM PUBLIC, anon, authenticated, service_role;

/* `a0_` is intentional. PostgreSQL runs same-kind triggers alphabetically;
   manager authority must lock the lease before the existing `aa_` launch
   triggers lock receipt/tournament parents. */
DROP TRIGGER IF EXISTS a0_tournament_manager_write_scope
  ON public.tournaments;
CREATE TRIGGER a0_tournament_manager_write_scope
  BEFORE INSERT OR UPDATE OR DELETE ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_manager_write_scope();

DROP TRIGGER IF EXISTS a0_tournament_manager_write_scope
  ON public.tournament_players;
CREATE TRIGGER a0_tournament_manager_write_scope
  BEFORE INSERT OR UPDATE OR DELETE ON public.tournament_players
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_manager_write_scope();

DROP TRIGGER IF EXISTS a0_tournament_manager_write_scope
  ON public.tables;
CREATE TRIGGER a0_tournament_manager_write_scope
  BEFORE INSERT OR UPDATE OR DELETE ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_manager_write_scope();

DROP TRIGGER IF EXISTS a0_tournament_manager_write_scope
  ON public.table_seats;
CREATE TRIGGER a0_tournament_manager_write_scope
  BEFORE INSERT OR UPDATE OR DELETE ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_manager_write_scope();

/* No application role may bypass the exact RPCs by editing lease rows. */
REVOKE ALL ON TABLE public.engine_tournament_leases
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.engine_table_leases
  FROM PUBLIC, anon, authenticated, service_role;

/* Remove every generation-blind or superseded engine door after the old
   process drain. No CASCADE: an unexpected dependency aborts this cutover. */
DROP FUNCTION IF EXISTS public.claim_tournament_lease(uuid, text, text, integer);
DROP FUNCTION IF EXISTS public.heartbeat_tournament_leases_v2(text, uuid[], integer);
DROP FUNCTION IF EXISTS public.heartbeat_tournament_leases(text, uuid[]);
DROP FUNCTION IF EXISTS public.heartbeat_tournament_leases_v3(text, jsonb, integer);
DROP FUNCTION IF EXISTS public.release_tournament_leases(text, uuid[]);
DROP FUNCTION IF EXISTS public.fn_begin_tournament_launch_atomic(
  uuid, uuid, timestamptz
);
DROP FUNCTION IF EXISTS public.fn_complete_tournament_launch_atomic(uuid, uuid);
DROP FUNCTION IF EXISTS public.claim_table_lease(uuid, text, text, integer);
DROP FUNCTION IF EXISTS public.heartbeat_table_leases_v2(text, uuid[], integer);
DROP FUNCTION IF EXISTS public.heartbeat_table_leases(text, uuid[]);
DROP FUNCTION IF EXISTS public.heartbeat_table_leases_v3(text, jsonb, integer);
DROP FUNCTION IF EXISTS public.release_table_leases(text, uuid[]);
DROP FUNCTION IF EXISTS public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb
);
DROP FUNCTION IF EXISTS public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid
);

/* Keep only the exact protocol-2 application doors. */
REVOKE ALL ON FUNCTION public.claim_tournament_lease_v2(
  uuid, text, text, uuid, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_tournament_lease_v2(
  uuid, text, text, uuid, integer
) TO service_role;
REVOKE ALL ON FUNCTION public.heartbeat_tournament_leases_v4(text, jsonb, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_tournament_leases_v4(text, jsonb, integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.release_tournament_leases_v2(text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_tournament_leases_v2(text, jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_begin_tournament_launch_atomic(
  uuid, uuid, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_begin_tournament_launch_atomic(
  uuid, uuid, timestamptz, uuid
) TO service_role;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid, uuid, uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.claim_table_lease_v2(
  uuid, text, text, uuid, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_table_lease_v2(
  uuid, text, text, uuid, integer
) TO service_role;
REVOKE ALL ON FUNCTION public.heartbeat_table_leases_v4(text, jsonb, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_table_leases_v4(text, jsonb, integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.release_table_leases_v2(text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_table_leases_v2(text, jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid,
  jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid,
  jsonb
) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_process_hand_post_commit_obligations(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_process_hand_post_commit_obligations(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement_exact_before_obligations(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid
) FROM PUBLIC, anon, authenticated, service_role;


DO $assert_strict_manager_request_fence$
DECLARE
  v_legacy_roster_has_job boolean := false;
  v_hook_source text;
  v_scope_source text;
  v_row_guard_source text;
  v_single_obligation_source text;
  v_satellite_cash_source text;
BEGIN
  SELECT p.prosrc INTO STRICT v_hook_source
    FROM pg_proc p
   WHERE p.oid =
         'smarter_private.fn_smarter_data_api_pre_request()'::regprocedure
     AND p.prosecdef;
  SELECT p.prosrc INTO STRICT v_scope_source
    FROM pg_proc p
   WHERE p.oid =
         'public.fn_assert_tournament_manager_write_scope(uuid)'::regprocedure
     AND p.prosecdef;
  SELECT p.prosrc INTO STRICT v_row_guard_source
    FROM pg_proc p
   WHERE p.oid =
         'public.trg_tournament_manager_write_scope()'::regprocedure
     AND p.prosecdef;
  SELECT pg_get_functiondef(
           'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)'::regprocedure
         )
    INTO STRICT v_single_obligation_source;
  SELECT pg_get_functiondef(
           'public.fn_settle_satellite_cash_entitlement_exact(uuid,text,integer,uuid,numeric,text)'::regprocedure
         )
    INTO STRICT v_satellite_cash_source;

  IF position('PLAYER_OR_MANAGER_AUTHORITY_REQUIRED' IN v_hook_source) = 0
     OR position('v_player_or_manager_paths' IN v_hook_source) = 0
     OR position('TOURNAMENT_MANAGER_AUTHORITY_REQUIRED' IN v_hook_source) = 0
     OR position('ENGINE_DATA_AUTHORITY_REQUIRED' IN v_hook_source) = 0
     OR position($needle$'shared-estate-service'$needle$ IN v_hook_source) = 0
     OR position($needle$'browser'$needle$ IN v_hook_source) = 0
     OR position('FOR SHARE' IN v_hook_source) = 0
     OR position('l.lease_generation = v_lease_generation' IN v_hook_source) = 0
     OR position('app.smarter_manager_request_fenced' IN v_hook_source) = 0
     OR position('auth.role()' IN v_hook_source) = 0
     OR position('verified JWT role disagrees with request claims' IN v_hook_source) = 0
     OR position($needle$'rpc/fn_project_hand_side_effects'$needle$ IN v_hook_source) = 0
     OR position($needle$'rpc/fn_move_tournament_player_atomic'$needle$ IN v_hook_source) = 0
     OR position($needle$left(v_path, 8) = 'rest/v1/'$needle$ IN v_hook_source) = 0
     OR position($needle$'protocol-2'$needle$ IN v_scope_source) = 0
     OR position('p_tournament_id IS DISTINCT FROM v_tournament_id' IN v_scope_source) = 0
     OR position('app.smarter_manager_deleted_table_ids' IN v_row_guard_source) = 0
     OR position('OLD.table_id = ANY(v_deleted_table_ids)' IN v_row_guard_source) = 0
     OR position('pg_trigger_depth() > 1' IN v_row_guard_source) = 0 THEN
    RAISE EXCEPTION 'Stage-B route authority or manager row scope is incomplete';
  END IF;

  IF position('v_kind' IN v_single_obligation_source) = 0
     OR position('v_atomic_kinds' IN v_single_obligation_source) = 0
     OR position('v_kind = ANY(v_atomic_kinds)'
                 IN v_single_obligation_source) = 0
     OR position('FOR UPDATE' IN v_single_obligation_source) > 0
     OR position('v_is_satellite' IN v_single_obligation_source) > 0
     OR position('late_reg_adjustment' IN v_single_obligation_source) = 0
     OR position('bubble_protection' IN v_single_obligation_source) = 0
     OR position('final_table_deal' IN v_single_obligation_source) = 0
     OR position('satellite_remainder' IN v_single_obligation_source) = 0
     OR position($needle$'seat'$needle$ IN v_single_obligation_source) = 0
     OR position('atomic_batch_required' IN v_single_obligation_source) = 0
     OR position('fn_settle_tournament_obligation_before_atomic_batch_gate('
                 IN v_single_obligation_source) = 0
     OR has_function_privilege(
          'anon',
          'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)',
          'EXECUTE'
        )
     OR has_function_privilege(
          'authenticated',
          'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)',
          'EXECUTE'
        )
     OR NOT has_function_privilege(
          'service_role',
          'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)',
          'EXECUTE'
        ) THEN
    RAISE EXCEPTION 'Stage-B single-obligation settlement boundary is not strict';
  END IF;

  IF position('fn_settle_tournament_obligation_before_atomic_batch_gate('
              IN v_satellite_cash_source) = 0
     OR position('public.fn_settle_tournament_obligation('
                 IN v_satellite_cash_source) > 0 THEN
    RAISE EXCEPTION 'Stage-B atomic satellite payer does not use its private core';
  END IF;

  IF (
    SELECT count(*)
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.tournaments'::regclass
       AND t.tgname IN (
         'aaa_guard_atomic_satellite_completion',
         'aa_guard_tournament_completing_claim',
         'zzzz_tournaments_atomic_place_completion_guard',
         'zzzzz_tournaments_atomic_final_table_deal_completion_guard',
         'zzzzzz_tournaments_financial_certificate',
         'zzzz_tournament_pool_finalization_window_guard',
         'zzzz_freeze_finalized_tournament_prize_pool'
       )
       AND NOT t.tgisinternal
       AND t.tgenabled <> 'D'
  ) <> 7 THEN
    RAISE EXCEPTION 'Stage-B finish, certificate or pool-lifecycle guard is not enabled';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'fn_tournament_payout_reconcile',
         'fn_pay_backed_payout_shortfalls',
         'fn_ca_backpay_guarantee_shortfalls',
         'fn_tournament_payout_sweep',
         'sp_ca_reconcile_backpaid_events',
         'fn_backpay_hu_winner_shortfalls'
       )
  ) THEN
    RAISE EXCEPTION 'a deferred tournament payout reconciliation routine remains installed';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.ca_money_rpc_registry
     WHERE proname IN (
       'fn_tournament_payout_reconcile',
       'fn_pay_backed_payout_shortfalls',
       'fn_ca_backpay_guarantee_shortfalls',
       'fn_tournament_payout_sweep',
       'sp_ca_reconcile_backpaid_events',
       'fn_backpay_hu_winner_shortfalls'
     )
  ) THEN
    RAISE EXCEPTION 'a retired tournament payout reconciliation route remains registered';
  END IF;

  /* Keep cron.job in a statement reached only when the cron extension exists. PostgreSQL
     resolves relations while preparing a statement, so a combined boolean
     expression still breaks a development database without that extension. */
  IF to_regnamespace('cron') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-payout-sweep-hourly') THEN
      RAISE EXCEPTION 'the applying payout repair cron is still scheduled';
    END IF;
    IF EXISTS (
      SELECT 1 FROM cron.job
       WHERE active
         AND command ~* '(fn_tournament_payout_sweep|fn_tournament_payout_reconcile|fn_pay_backed_payout_shortfalls|fn_ca_backpay_guarantee_shortfalls|sp_ca_reconcile_backpaid_events|fn_backpay_hu_winner_shortfalls)'
    ) THEN
      RAISE EXCEPTION 'a deferred tournament payout reconciliation command is still scheduled';
    END IF;
  END IF;
  IF to_regclass('public.ca_settle_sources') IS NOT NULL THEN
    EXECUTE
      'SELECT EXISTS (SELECT 1 FROM public.ca_settle_sources WHERE lower(source) = ANY($1))'
      INTO v_legacy_roster_has_job
      USING ARRAY[
        'reconcile',
        'fn_tournament_payout_reconcile',
        'fn_pay_backed_payout_shortfalls',
        'fn_ca_backpay_guarantee_shortfalls',
        'fn_tournament_payout_sweep',
        'sp_ca_reconcile_backpaid_events',
        'fn_backpay_hu_winner_shortfalls'
      ]::text[];
    IF v_legacy_roster_has_job THEN
      RAISE EXCEPTION 'retired reconcile sources can still settle obligations directly';
    END IF;
  END IF;
  IF to_regclass('public.ca_expected_cron_jobs') IS NOT NULL THEN
    EXECUTE
      'SELECT EXISTS (SELECT 1 FROM public.ca_expected_cron_jobs WHERE jobname = $1)'
      INTO v_legacy_roster_has_job
      USING 'ca-payout-sweep-hourly';
    IF v_legacy_roster_has_job THEN
      RAISE EXCEPTION 'the retired payout repair cron is still in the expected roster';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.financial_alerts
     WHERE resolved IS NOT TRUE
       AND source IN ('fn_tournament_payout_sweep',
                      'fn_tournament_payout_sweep_truncated')
  ) THEN
    RAISE EXCEPTION 'a retired applying payout sweep finding is still open';
  END IF;

  IF to_regprocedure('public.claim_tournament_lease(uuid,text,text,integer)')
       IS NOT NULL
     OR to_regprocedure('public.heartbeat_tournament_leases_v2(text,uuid[],integer)')
       IS NOT NULL
     OR to_regprocedure('public.heartbeat_tournament_leases(text,uuid[])')
       IS NOT NULL
     OR to_regprocedure('public.heartbeat_tournament_leases_v3(text,jsonb,integer)')
       IS NOT NULL
     OR to_regprocedure('public.release_tournament_leases(text,uuid[])')
       IS NOT NULL
     OR to_regprocedure(
          'public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz)'
        ) IS NOT NULL
     OR to_regprocedure(
          'public.fn_complete_tournament_launch_atomic(uuid,uuid)'
        ) IS NOT NULL
     OR to_regprocedure('public.claim_table_lease(uuid,text,text,integer)')
        IS NOT NULL
     OR to_regprocedure('public.heartbeat_table_leases_v2(text,uuid[],integer)')
        IS NOT NULL
     OR to_regprocedure('public.heartbeat_table_leases(text,uuid[])')
        IS NOT NULL
     OR to_regprocedure('public.heartbeat_table_leases_v3(text,jsonb,integer)')
        IS NOT NULL
     OR to_regprocedure('public.release_table_leases(text,uuid[])')
        IS NOT NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'
        ) IS NOT NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'
        ) IS NOT NULL THEN
    RAISE EXCEPTION 'A legacy or superseded tournament/table authority door survived Stage B';
  END IF;

  IF has_table_privilege('service_role', 'public.engine_tournament_leases', 'SELECT')
     OR has_table_privilege('service_role', 'public.engine_tournament_leases', 'INSERT')
     OR has_table_privilege('service_role', 'public.engine_tournament_leases', 'UPDATE')
     OR has_table_privilege('service_role', 'public.engine_tournament_leases', 'DELETE') THEN
    RAISE EXCEPTION 'service_role can still edit tournament leases outside exact RPCs';
  END IF;

  IF has_table_privilege('service_role', 'public.engine_table_leases', 'SELECT')
     OR has_table_privilege('service_role', 'public.engine_table_leases', 'INSERT')
     OR has_table_privilege('service_role', 'public.engine_table_leases', 'UPDATE')
     OR has_table_privilege('service_role', 'public.engine_table_leases', 'DELETE') THEN
    RAISE EXCEPTION 'service_role can still edit table leases outside exact RPCs';
  END IF;

  IF NOT has_function_privilege(
       'service_role',
       'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.claim_table_lease_v2(uuid,text,text,uuid,integer)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.heartbeat_tournament_leases_v4(text,jsonb,integer)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.heartbeat_table_leases_v4(text,jsonb,integer)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_ca_process_hand_post_commit_obligations(uuid)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.claim_table_lease_v2(uuid,text,text,uuid,integer)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.heartbeat_tournament_leases_v4(text,jsonb,integer)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.heartbeat_table_leases_v4(text,jsonb,integer)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_process_hand_post_commit_obligations(uuid)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'::regprocedure,
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Exact engine RPC grants or private settlement-core ACL are wrong';
  END IF;

  IF (SELECT count(*)
        FROM pg_trigger t
       WHERE t.tgname = 'a0_tournament_manager_write_scope'
         AND t.tgrelid IN (
           'public.tournaments'::regclass,
           'public.tournament_players'::regclass,
           'public.tables'::regclass,
           'public.table_seats'::regclass
         )
         AND NOT t.tgisinternal) <> 4 THEN
    RAISE EXCEPTION 'Every manager-owned row family is not scope guarded';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_db_role_setting s
      JOIN pg_roles r ON r.oid = s.setrole
      CROSS JOIN LATERAL unnest(COALESCE(s.setconfig, '{}'::text[])) setting(value)
     WHERE r.rolname = 'authenticator'
       AND setting.value =
           'pgrst.db_pre_request=smarter_private.fn_smarter_data_api_pre_request'
  ) THEN
    RAISE EXCEPTION 'PostgREST strict request hook setting is absent';
  END IF;

  IF to_regprocedure('public.fn_smarter_data_api_pre_request()') IS NOT NULL THEN
    RAISE EXCEPTION 'Strict request hook remains callable from the exposed public schema';
  END IF;

  IF NOT has_function_privilege(
       'service_role',
       'smarter_private.fn_smarter_data_api_pre_request()',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'anon',
       'smarter_private.fn_smarter_data_api_pre_request()',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'smarter_private.fn_smarter_data_api_pre_request()',
       'EXECUTE'
     )
     OR NOT has_schema_privilege('service_role', 'smarter_private', 'USAGE')
     OR NOT has_schema_privilege('anon', 'smarter_private', 'USAGE')
     OR NOT has_schema_privilege('authenticated', 'smarter_private', 'USAGE')
     OR has_schema_privilege('service_role', 'smarter_private', 'CREATE')
     OR has_schema_privilege('anon', 'smarter_private', 'CREATE')
     OR has_schema_privilege('authenticated', 'smarter_private', 'CREATE')
     OR has_function_privilege(
       'authenticator',
       'smarter_private.fn_smarter_data_api_pre_request()',
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
         FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(p.proacl) acl
        WHERE p.oid =
              'smarter_private.fn_smarter_data_api_pre_request()'::regprocedure
          AND acl.grantee = 0
          AND acl.privilege_type = 'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
         FROM pg_namespace n
         CROSS JOIN LATERAL aclexplode(n.nspacl) acl
        WHERE n.nspname = 'smarter_private'
          AND acl.grantee = 0
          AND acl.privilege_type IN ('USAGE', 'CREATE')
     ) THEN
    RAISE EXCEPTION 'Private strict request hook ACL is not exact';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_db_role_setting s
      JOIN pg_roles r ON r.oid = s.setrole
      CROSS JOIN LATERAL unnest(COALESCE(s.setconfig, '{}'::text[])) AS setting(value)
      CROSS JOIN LATERAL regexp_split_to_table(
        split_part(setting.value, '=', 2),
        '[[:space:]]*,[[:space:]]*'
      ) AS exposed(schema_name)
     WHERE r.rolname = 'authenticator'
       AND setting.value LIKE 'pgrst.db_schemas=%'
       AND exposed.schema_name = 'smarter_private'
  ) THEN
    RAISE EXCEPTION 'smarter_private must not be a PostgREST exposed schema';
  END IF;
END;
$assert_strict_manager_request_fence$;

COMMENT ON FUNCTION public.fn_assert_tournament_manager_write_scope(uuid) IS
  'Private Stage-B row-scope proof. A manager write must consume the transaction marker set only after the request hook locks its exact fresh protocol-2 lease, then name that same tournament and generation.';
COMMENT ON FUNCTION public.trg_tournament_manager_write_scope() IS
  'Scopes marked tournament-manager writes on tournaments, tournament_players, tables and table_seats to the transaction authority established by the Data API request hook.';

NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';

COMMIT;

/*
 * ROLLBACK ORDER (emergency forward migration, never an ad-hoc production
 * toggle): restore the Stage-A hook first; restore only the legacy tournament
 * overloads from the tournament-lease generation migration, table overloads
 * and superseded nine- and eleven-argument settlement from the table-lease
 * generation migration if an old engine is being deliberately reintroduced;
 * keep the obligations-aware twelve-argument core; then remove the four a0_
 * triggers and the two private scope functions.
 * Reopening any superseded engine door without also restoring Stage-A
 * compatibility is an invalid mixed protocol. Normal rollback is a new
 * audited migration.
 */

-- Prepared accounting Phase 3 strict tournament cutover. NOT APPLIED.
-- Final-deal v2 creation, testing and staged deployment were explicitly approved.
-- This whole cutover remains unverified and NOT APPLIED until its gates pass.
-- The exact-hand prerequisite is resolved. The remaining cutover blocker is
-- the absent, unverified final-deal v2 batch authority. Preserve every source
-- and engine-adoption gate; reserve a fresh migration only after the complete
-- approved rehearsal passes.
-- Player rebuy/decline route compatibility is covered by the focused PG probe.
-- Historical certificates and incident findings remain unchanged.

BEGIN;

-- Read-only fail-closed prerequisite before any table lock or DDL. Existence
-- alone is not deployment certification; every later source/adoption gate stays.
DO $require_final_deal_v2_contract$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE
    oid=to_regprocedure('public.fn_ca_verify_terminal_final_deal_batch(uuid,boolean)')
    AND md5(prosrc)='260c94b41d7f2bb021a88a546a1714ac' AND proowner='postgres'::regrole AND prosecdef
    AND proconfig=ARRAY['search_path=public, pg_temp']::text[])
    OR has_function_privilege('anon',
      to_regprocedure('public.fn_ca_verify_terminal_final_deal_batch(uuid,boolean)'),'EXECUTE')
    OR has_function_privilege('authenticated',
      to_regprocedure('public.fn_ca_verify_terminal_final_deal_batch(uuid,boolean)'),'EXECUTE')
    OR has_function_privilege('service_role',
      to_regprocedure('public.fn_ca_verify_terminal_final_deal_batch(uuid,boolean)'),'EXECUTE') THEN
    RAISE EXCEPTION 'Stage B requires the exact approved final-deal v2 verifier and owner-only access';
  END IF;
  IF EXISTS(SELECT 1 FROM (VALUES
    ('public.fn_complete_tournament_terminal(uuid,uuid,text)','96a61ea5e16560735bcb70b355aa79ab'),
    ('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)','f4275f9fa8cb2711f19ffdf7b16a04e6'),
    ('public.fn_settle_tournament_final_table_deal(uuid)','b1941b2e55dade307ecd74068ab3e500'),
    ('public.fn_guard_tournament_completing_claim()','82078938fd926c94a0ab778acd77dd61'),
    ('public.trg_lock_atomic_final_table_deal_status()','ddc5e3121ed9cc73d41525e6c1ba6c34'),
    ('public.fn_guard_tournament_completed_certificate()','d994347e1b76c936ce13361d73f94fd2'),
    ('public.trg_atomic_final_table_deal_completion_guard()','9f5f5fefa77ae93bfeffc9f414a63a0d'),
    ('public.trg_freeze_atomic_final_table_deal_obligation()','d338c5278ef1247ff0f4a7c4ba774cc5')
  ) e(identity,body_md5) WHERE NOT EXISTS(SELECT 1 FROM pg_proc p
    WHERE p.oid=to_regprocedure(e.identity) AND md5(p.prosrc)=e.body_md5
      AND p.proowner='postgres'::regrole AND p.prosecdef)) THEN
    RAISE EXCEPTION 'Stage B requires the complete approved final-deal v2 writer and completion guards';
  END IF;
END;
$require_final_deal_v2_contract$;

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

  -- Preserve the deployed busy-manager fix. A generic FOR SHARE substring
  -- also occurs in comments, so exact source identities guard this upgrade.
  IF md5(v_source) NOT IN ('ab227471f29f2944ebd64909622b6af7',
                          'd21a055b448febe83c1637371b150100')
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=to_regprocedure('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)')
          AND md5(p.prosrc)='d1b5100c2b9f92bec5fd1680b0b4f230'
          AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
          AND p.proconfig=ARRAY['search_path=public, pg_temp']
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=to_regprocedure('public.heartbeat_tournament_leases_v4(text,jsonb,integer)')
          AND md5(p.prosrc)='5e6c99545e07c21efcb50e5cb3441c14'
          AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
          AND p.proconfig=ARRAY['search_path=public, pg_temp']
     ) THEN
    RAISE EXCEPTION
      'Stage-B requires the exact KEY SHARE hook, UPDATE takeover and non-key heartbeat authorities';
  END IF;

  -- The browser reveal exception delegates only to the already hardened body.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
       WHERE p.oid=to_regprocedure('public.fn_mystery_bounty_reveal(uuid,uuid,boolean)')
         AND md5(p.prosrc)='5578ec53c8a531eeba47d448ae9af1b1'
         AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
         AND p.proconfig=ARRAY['search_path=public, pg_temp']
         AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'Stage-B shared player reveal requires the exact hardened identity authority';
  END IF;

  IF position('app.smarter_data_actor' IN v_source) = 0
     OR position('x-smarter-data-actor' IN v_source) = 0
     OR position('l.lease_generation = v_lease_generation' IN v_source) = 0
     OR position(E'     FOR KEY SHARE;\n  END IF;' IN v_source) = 0
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
          'public.heartbeat_tournament_leases_v3(text,jsonb,integer)'
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
          'public.heartbeat_table_leases_v3(text,jsonb,integer)'
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

  /* This contraction deletes the rolling 11-argument hand door below. The
     exact-seat expansion is intentionally versioned before Stage B and must
     already have hardened the surviving 12-argument door. Without this pin,
     an accidentally reordered migration set can destroy the compatibility
     door before the expansion has inspected it. */
  IF position(
       'seat_joined_at' IN pg_get_functiondef(
         'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure
       )
     ) = 0
     OR position(
       'time_bank_seat_generation_mismatch' IN pg_get_functiondef(
         'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure
       )
     ) = 0 THEN
    RAISE EXCEPTION
      'Stage-B manager fencing requires 20260908161534 exact-seat expansion first';
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

/* Cash batches retain their owner-only payment primitives when the public
   compatibility door contracts. Each primitive calls the existing private
   obligation core in the same outer transaction. Do not relax the public gate
   or introduce a caller-controlled bypass flag. */
-- BEGIN CANONICAL TERMINAL PLACE BATCH CONTRACT
-- Version is owned by this writer; legacy p_source cannot choose semantics.
ALTER TABLE public.tournament_place_settlement_batches
 ADD COLUMN IF NOT EXISTS contract_version integer NOT NULL DEFAULT 1;
DO $canonical_place_batch_version$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_attrdef d
   ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid='public.tournament_place_settlement_batches'::regclass
    AND a.attname='contract_version' AND a.atttypid='integer'::regtype
    AND a.attnotnull AND pg_get_expr(d.adbin,d.adrelid)='1') THEN
  RAISE EXCEPTION 'canonical place batch version column differs';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint
  WHERE conrelid='public.tournament_place_settlement_batches'::regclass
   AND conname='tournament_place_batch_contract_version') THEN
  ALTER TABLE public.tournament_place_settlement_batches
   ADD CONSTRAINT tournament_place_batch_contract_version CHECK(contract_version IN (1,2));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint
   WHERE conrelid='public.tournament_place_settlement_batches'::regclass
    AND conname='tournament_place_batch_contract_version' AND convalidated
    AND pg_get_constraintdef(oid)='CHECK ((contract_version = ANY (ARRAY[1, 2])))') THEN
  RAISE EXCEPTION 'canonical place batch version constraint differs';
 END IF;
END;
$canonical_place_batch_version$;

-- Verify the current cash authority's version 2 batch against its canonical
-- ladder, durable bust sequence, every paid obligation and wallet receipt.
CREATE OR REPLACE FUNCTION public.fn_ca_verify_terminal_place_batch(
 p_tournament_id uuid,p_require_terminal boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $verify_terminal_place_batch$
DECLARE
 v_t public.tournaments%ROWTYPE;
 v_b public.tournament_place_settlement_batches%ROWTYPE;
 v_e public.tournament_escrow%ROWTYPE;
 v_ladder jsonb; v_plan jsonb;
 v_field integer; v_positive integer; v_bubble_place integer;
 v_place_total numeric; v_bubble_amount numeric:=0;
 v_bubble_user uuid; v_ob public.tournament_obligations%ROWTYPE;
 v_bubble_count integer;
BEGIN
 SELECT * INTO STRICT v_t FROM public.tournaments WHERE id=p_tournament_id;
 SELECT * INTO STRICT v_b FROM public.tournament_place_settlement_batches
  WHERE tournament_id=p_tournament_id;
 IF v_b.contract_version<>2 OR v_b.mode<>'structure' OR v_b.settled_at IS NULL
  OR v_t.prize_pool_finalized IS DISTINCT FROM true
  OR v_t.prize_pool IS NULL OR v_t.prize_pool<0
  OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
  OR v_t.prize_pool<>round(v_t.prize_pool,2)
  OR v_t.prize_pool<COALESCE(v_t.guaranteed_prize,0)
 THEN RAISE EXCEPTION 'canonical terminal batch is not funded and settled'; END IF;
 SELECT count(*) INTO v_field FROM public.tournament_players
  WHERE tournament_id=p_tournament_id;
 IF v_field=0 OR
  (SELECT count(*) FROM public.tournament_players WHERE tournament_id=p_tournament_id
   AND status='winner' AND position=1)<>1
  OR (SELECT count(DISTINCT position) FROM public.tournament_players
   WHERE tournament_id=p_tournament_id)<>v_field
  OR EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id
    AND (position IS NULL OR position<1 OR position>v_field
     OR status NOT IN ('winner','eliminated')
     OR (status='winner' AND position<>1)
     OR (status='eliminated' AND (eliminated_at IS NULL OR elimination_sequence IS NULL))))
  OR (SELECT count(DISTINCT elimination_sequence) FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND status='eliminated')<>v_field-1
  OR EXISTS(SELECT 1 FROM (
   SELECT position,row_number() OVER(ORDER BY elimination_sequence DESC,id)+1 AS expected
    FROM public.tournament_players WHERE tournament_id=p_tournament_id AND status='eliminated'
   ) ranked WHERE position<>expected)
 THEN RAISE EXCEPTION 'canonical terminal batch has no exact durable standings'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('place',a.place,'amount',a.amount)
   ORDER BY a.place),'[]'::jsonb),COALESCE(sum(a.amount),0),
   count(*) FILTER(WHERE a.amount>0),max(a.place)+1
 INTO v_ladder,v_place_total,v_positive,v_bubble_place
 FROM public.fn_ca_tournament_place_amounts(p_tournament_id) a;
 IF jsonb_array_length(v_ladder)=0
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_ladder) a
   WHERE (a->>'amount')::numeric<0 OR (a->>'amount')::numeric<>round((a->>'amount')::numeric,2))
 THEN RAISE EXCEPTION 'canonical terminal batch ladder is invalid'; END IF;
 IF v_t.bubble_protection AND v_bubble_place<=v_field THEN
  v_bubble_amount:=v_t.buy_in_amount;
  IF v_bubble_amount IS NULL OR v_bubble_amount<=0
   OR v_bubble_amount::text IN ('NaN','Infinity','-Infinity')
   OR v_bubble_amount<>round(v_bubble_amount,2)
  THEN RAISE EXCEPTION 'canonical terminal batch Bubble amount is invalid'; END IF;
  SELECT user_id INTO STRICT v_bubble_user FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND position=v_bubble_place AND status='eliminated';
 END IF;
 IF v_place_total+v_bubble_amount IS DISTINCT FROM v_t.prize_pool
 THEN RAISE EXCEPTION 'canonical ladder and Bubble do not allocate one pool'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('place',(a->>'place')::integer,
  'user_id',tp.user_id,'club_id',tp.club_id,'cents',round((a->>'amount')::numeric*100)::bigint)
  ORDER BY (a->>'place')::integer),'[]'::jsonb) INTO v_plan
 FROM jsonb_array_elements(v_ladder) a JOIN public.tournament_players tp
  ON tp.tournament_id=p_tournament_id AND tp.position=(a->>'place')::integer
 WHERE (a->>'amount')::numeric>0;
 IF jsonb_array_length(v_plan)<>v_positive OR v_b.place_count<>v_positive
  OR v_b.amount_owed IS DISTINCT FROM v_place_total
  OR v_b.plan_fingerprint IS DISTINCT FROM md5(v_plan::text)
  OR v_b.escrow_required<0 OR v_b.escrow_available<v_b.escrow_required
  OR v_b.escrow_required>v_t.prize_pool
  OR v_b.escrow_required<>round(v_b.escrow_required,2)
  OR v_b.escrow_available<>round(v_b.escrow_available,2)
 THEN RAISE EXCEPTION 'canonical terminal batch header or funding proof differs'; END IF;
 IF EXISTS(SELECT 1 FROM public.tournament_players tp
  LEFT JOIN LATERAL (SELECT (a->>'amount')::numeric AS amount
   FROM jsonb_array_elements(v_ladder) a WHERE (a->>'place')::integer=tp.position) expected ON true
  WHERE tp.tournament_id=p_tournament_id
   AND tp.prize IS DISTINCT FROM COALESCE(expected.amount,
    CASE WHEN tp.user_id=v_bubble_user THEN v_bubble_amount ELSE 0 END))
 THEN RAISE EXCEPTION 'canonical terminal batch prize cache differs'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_plan) a
  LEFT JOIN public.tournament_obligations o ON o.tournament_id=p_tournament_id
   AND o.kind='place' AND o.place=(a->>'place')::integer
  WHERE o.id IS NULL OR o.user_id IS DISTINCT FROM (a->>'user_id')::uuid
   OR o.amount_owed IS DISTINCT FROM (a->>'cents')::numeric/100
   OR o.amount_paid IS DISTINCT FROM o.amount_owed OR o.settled_at IS NULL)
  OR EXISTS(SELECT 1 FROM public.tournament_obligations o
   WHERE o.tournament_id=p_tournament_id AND o.kind='place'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_plan) a
     WHERE o.place=(a->>'place')::integer AND o.user_id=(a->>'user_id')::uuid
      AND o.amount_owed=(a->>'cents')::numeric/100))
 THEN RAISE EXCEPTION 'canonical terminal batch obligations differ'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_plan) a WHERE
  (SELECT COALESCE(sum(p.amount),0) FROM public.tournament_payouts p
   WHERE p.tournament_id=p_tournament_id AND p.position=(a->>'place')::integer
    AND p.user_id=(a->>'user_id')::uuid) IS DISTINCT FROM (a->>'cents')::numeric/100)
  OR EXISTS(SELECT 1 FROM public.tournament_payouts p
   WHERE p.tournament_id=p_tournament_id AND p.position IS NOT NULL AND
    (NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_plan) a
      WHERE p.position=(a->>'place')::integer AND p.user_id=(a->>'user_id')::uuid)
     OR p.amount IS NULL OR p.amount<=0 OR p.amount<>round(p.amount,2)
     OR p.idempotency_key IS NULL OR NOT EXISTS(
      SELECT 1 FROM public.wallet_credit_idempotency k WHERE k.key=p.idempotency_key
       AND k.user_id=p.user_id AND k.amount=p.amount)))
 THEN RAISE EXCEPTION 'canonical terminal batch payout or wallet receipt differs'; END IF;
 SELECT count(*) INTO v_bubble_count FROM public.tournament_obligations
  WHERE tournament_id=p_tournament_id AND kind='bubble_protection';
 IF v_bubble_amount>0 THEN
  SELECT * INTO STRICT v_ob FROM public.tournament_obligations
   WHERE tournament_id=p_tournament_id AND kind='bubble_protection';
  IF v_bubble_count<>1 OR v_ob.place IS NOT NULL OR v_ob.user_id IS DISTINCT FROM v_bubble_user
   OR v_ob.amount_owed IS DISTINCT FROM v_bubble_amount OR v_ob.amount_paid IS DISTINCT FROM v_bubble_amount
   OR v_ob.settled_at IS NULL
   OR v_ob.source IS NULL
   OR v_ob.source NOT IN ('engine.eliminatePlayer','engine.atomicPlaceSettlement','engine.fn_settle_tournament_places','engine.fn_settle_tournament_bubble_protection')
   OR v_b.bubble_contract_required IS DISTINCT FROM true
   OR v_b.bubble_obligation_id IS DISTINCT FROM v_ob.id
   OR v_b.bubble_user_id IS DISTINCT FROM v_bubble_user
   OR v_b.bubble_source IS DISTINCT FROM v_ob.source
   OR v_b.bubble_amount_owed IS DISTINCT FROM v_bubble_amount
   OR v_b.bubble_amount_paid_before<0 OR v_b.bubble_amount_paid_before>v_bubble_amount
   OR (SELECT COALESCE(sum(amount),0) FROM public.tournament_payouts
    WHERE tournament_id=p_tournament_id AND source='bubble_protection')<>v_bubble_amount
   OR EXISTS(SELECT 1 FROM public.tournament_payouts p
    WHERE p.tournament_id=p_tournament_id AND p.source='bubble_protection'
     AND (p.position IS NOT NULL OR p.user_id IS DISTINCT FROM v_bubble_user OR p.amount<=0
      OR p.amount<>round(p.amount,2) OR p.idempotency_key IS NULL
      OR NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency k
       WHERE k.key=p.idempotency_key AND k.user_id=p.user_id AND k.amount=p.amount)))
  THEN RAISE EXCEPTION 'canonical terminal batch Bubble proof differs'; END IF;
 ELSIF v_bubble_count<>0 OR v_b.bubble_contract_required IS DISTINCT FROM false
  OR v_b.bubble_obligation_id IS NOT NULL OR v_b.bubble_user_id IS NOT NULL
  OR v_b.bubble_source IS NOT NULL OR v_b.bubble_amount_owed<>0
  OR v_b.bubble_amount_paid_before<>0
  OR EXISTS(SELECT 1 FROM public.tournament_payouts
   WHERE tournament_id=p_tournament_id AND source='bubble_protection')
 THEN RAISE EXCEPTION 'canonical terminal batch has uncontracted Bubble evidence'; END IF;
 SELECT * INTO STRICT v_e FROM public.tournament_escrow WHERE tournament_id=p_tournament_id;
 IF v_e.enforced IS DISTINCT FROM true OR v_e.prize_balance IS DISTINCT FROM 0::numeric
  OR (p_require_terminal AND (v_e.bounty_balance IS DISTINCT FROM 0::numeric
   OR v_e.fee_balance IS DISTINCT FROM 0::numeric OR v_e.closed_at IS NULL
   OR EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
    WHERE t.tournament_id=p_tournament_id AND (s.left_at IS NULL OR s.status IS DISTINCT FROM 'left'))))
 THEN RAISE EXCEPTION 'canonical terminal batch has open custody or seats'; END IF;
 RETURN jsonb_build_object('ok',true,'contract_version',2,'place_total',v_place_total,
  'bubble_amount',v_bubble_amount,'place_count',v_positive,'plan_fingerprint',v_b.plan_fingerprint);
END;
$verify_terminal_place_batch$;
REVOKE ALL ON FUNCTION public.fn_ca_verify_terminal_place_batch(uuid,boolean)
 FROM PUBLIC,anon,authenticated,service_role;

DO $contract_terminal_place_batch$
DECLARE
 v_oid oid; v_definition text; v_source text; v_before jsonb; v_after jsonb;
BEGIN
 v_oid:=to_regprocedure('public.fn_settle_tournament_places(uuid,uuid)');
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner='postgres'::regrole
  AND prosecdef AND proconfig=ARRAY['search_path=public','statement_timeout=30s']::text[]
  AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql'))
  OR has_function_privilege('anon',v_oid,'EXECUTE')
  OR has_function_privilege('authenticated',v_oid,'EXECUTE')
  OR NOT has_function_privilege('service_role',v_oid,'EXECUTE') THEN
  RAISE EXCEPTION 'canonical place batch prerequisite metadata differs: fn_settle_tournament_places';
 END IF;
 SELECT prosrc,pg_get_functiondef(oid),
  jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,
   'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_definition,v_before FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source) NOT IN ('d0262f4928b12eea1cc5e9175cbf2737','2fb9eb9761e248315f36df617e519512') THEN
  RAISE EXCEPTION 'canonical place batch prerequisite body differs: fn_settle_tournament_places';
 END IF;
 IF md5(v_source)='d0262f4928b12eea1cc5e9175cbf2737' THEN
  IF position($canonical_old_0_0$  v_rows integer;$canonical_old_0_0$ IN v_definition)=0 THEN RAISE EXCEPTION 'canonical batch source fragment 0/0 absent'; END IF;
  v_definition:=replace(v_definition,$canonical_old_0_0$  v_rows integer;$canonical_old_0_0$,$canonical_new_0_0$  v_rows integer;
  v_modern_batch public.tournament_place_settlement_batches%ROWTYPE;
  v_modern_replay boolean := false;
  v_modern_required numeric := 0;
  v_modern_escrow_before numeric := 0;
  v_modern_plan jsonb;
  v_modern_positive integer;
$canonical_new_0_0$);
  IF position($canonical_old_0_1$  IF lower(COALESCE(v_t.variant,'')) = 'satellite'$canonical_old_0_1$ IN v_definition)=0 THEN RAISE EXCEPTION 'canonical batch source fragment 0/1 absent'; END IF;
  v_definition:=replace(v_definition,$canonical_old_0_1$  IF lower(COALESCE(v_t.variant,'')) = 'satellite'$canonical_old_0_1$,$canonical_new_0_1$  -- A published batch is an immutable money plan. Replay it without even
  -- transiently clearing cached prizes or rewriting a frozen obligation.
  SELECT * INTO v_modern_batch FROM public.tournament_place_settlement_batches
   WHERE tournament_id=p_tournament_id FOR UPDATE;
  IF FOUND THEN
    IF v_modern_batch.contract_version<>2 OR v_modern_batch.settled_at IS NULL THEN
      RAISE EXCEPTION 'existing place batch requires its original settlement authority'
        USING ERRCODE='55000';
    END IF;
    v_modern_replay:=true;
  END IF;

  IF lower(COALESCE(v_t.variant,'')) = 'satellite'$canonical_new_0_1$);
  IF position($canonical_old_0_2$v_status = 'COMPLETED'$canonical_old_0_2$ IN v_definition)=0 THEN RAISE EXCEPTION 'canonical batch source fragment 0/2 absent'; END IF;
  v_definition:=replace(v_definition,$canonical_old_0_2$v_status = 'COMPLETED'$canonical_old_0_2$,$canonical_new_0_2$(v_status = 'COMPLETED' OR v_modern_replay)$canonical_new_0_2$);
  IF position($canonical_old_0_3$v_status <> 'COMPLETED'$canonical_old_0_3$ IN v_definition)=0 THEN RAISE EXCEPTION 'canonical batch source fragment 0/3 absent'; END IF;
  v_definition:=replace(v_definition,$canonical_old_0_3$v_status <> 'COMPLETED'$canonical_old_0_3$,$canonical_new_0_3$(v_status <> 'COMPLETED' AND NOT v_modern_replay)$canonical_new_0_3$);
  IF position($canonical_old_0_4$    IF v_bubble_amount > 0 THEN
      v_bubble_result :=$canonical_old_0_4$ IN v_definition)=0 THEN RAISE EXCEPTION 'canonical batch source fragment 0/4 absent'; END IF;
  v_definition:=replace(v_definition,$canonical_old_0_4$    IF v_bubble_amount > 0 THEN
      v_bubble_result :=$canonical_old_0_4$,$canonical_new_0_4$    SELECT e.prize_balance INTO STRICT v_modern_escrow_before
      FROM public.tournament_escrow e
     WHERE e.tournament_id=p_tournament_id AND e.enforced FOR UPDATE;
    SELECT COALESCE(sum(o.amount_owed-o.amount_paid),0)
      INTO v_modern_required FROM public.tournament_obligations o
     WHERE o.tournament_id=p_tournament_id AND o.kind IN ('place','bubble_protection');
    IF v_modern_required<0 OR v_modern_required<>round(v_modern_required,2)
       OR v_modern_escrow_before IS NULL
       OR v_modern_escrow_before<v_modern_required
       OR v_modern_escrow_before<>round(v_modern_escrow_before,2) THEN
      RAISE EXCEPTION 'canonical place batch lacks exact pre-credit funding'
        USING ERRCODE='23514';
    END IF;

    IF v_bubble_amount > 0 THEN
      v_bubble_result :=$canonical_new_0_4$);
  IF position($canonical_old_0_5$  RETURN jsonb_build_object(
    'ok',true,$canonical_old_0_5$ IN v_definition)=0 THEN RAISE EXCEPTION 'canonical batch source fragment 0/5 absent'; END IF;
  v_definition:=replace(v_definition,$canonical_old_0_5$  RETURN jsonb_build_object(
    'ok',true,$canonical_old_0_5$,$canonical_new_0_5$  -- This header certifies money the same authority just proved and paid.
  -- It never invents or seeds a payment, and its original funding snapshot is
  -- preserved unchanged on every retry.
  IF NOT v_modern_replay THEN
    IF v_status='COMPLETED' THEN
      RAISE EXCEPTION 'completed event has no current canonical place batch'
        USING ERRCODE='55000';
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'place',(a->>'place')::integer,'user_id',tp.user_id,'club_id',tp.club_id,
      'cents',round((a->>'amount')::numeric*100)::bigint)
      ORDER BY (a->>'place')::integer),'[]'::jsonb),count(*)
      INTO v_modern_plan,v_modern_positive
      FROM jsonb_array_elements(v_ladder) a JOIN public.tournament_players tp
       ON tp.tournament_id=p_tournament_id AND tp.position=(a->>'place')::integer
     WHERE (a->>'amount')::numeric>0;
    IF (SELECT e.prize_balance FROM public.tournament_escrow e
         WHERE e.tournament_id=p_tournament_id) IS DISTINCT FROM
         v_modern_escrow_before-v_modern_required THEN
      RAISE EXCEPTION 'canonical place batch lost its exact escrow delta'
        USING ERRCODE='23514';
    END IF;
    -- The real Bubble payer may normalize source while crediting. Record its
    -- settled identity, retaining v_bubble_paid as the pre-credit snapshot.
    IF v_bubble_amount>0 THEN
      SELECT * INTO STRICT v_bubble_ob FROM public.tournament_obligations
       WHERE tournament_id=p_tournament_id AND kind='bubble_protection';
    END IF;
    INSERT INTO public.tournament_place_settlement_batches(
      tournament_id,mode,plan_fingerprint,place_count,amount_owed,
      escrow_required,escrow_available,bubble_contract_required,
      bubble_obligation_id,bubble_user_id,bubble_source,
      bubble_amount_owed,bubble_amount_paid_before,source,settled_at,contract_version)
    VALUES(p_tournament_id,'structure',md5(v_modern_plan::text),
      v_modern_positive,v_total_expected,v_modern_required,v_modern_escrow_before,
      v_bubble_amount>0,
      CASE WHEN v_bubble_amount>0 THEN v_bubble_ob.id ELSE NULL END,
      CASE WHEN v_bubble_amount>0 THEN v_bubble_user_id ELSE NULL END,
      CASE WHEN v_bubble_amount>0 THEN v_bubble_ob.source ELSE NULL END,
      v_bubble_amount,CASE WHEN v_bubble_amount>0 THEN v_bubble_paid ELSE 0 END,
      'engine.fn_settle_tournament_places',transaction_timestamp(),2);
  END IF;
  PERFORM public.fn_ca_verify_terminal_place_batch(p_tournament_id,false);

  RETURN jsonb_build_object(
    'ok',true,$canonical_new_0_5$);
  EXECUTE v_definition;
 END IF;
 SELECT prosrc,
  jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,
   'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_after FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source)<>'2fb9eb9761e248315f36df617e519512' OR v_before IS DISTINCT FROM v_after THEN
  RAISE EXCEPTION 'canonical place batch postcondition differs: fn_settle_tournament_places';
 END IF;
 v_oid:=to_regprocedure('public.trg_tournament_atomic_place_completion_guard()');
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner='postgres'::regrole
  AND prosecdef AND proconfig=ARRAY['search_path=public']::text[]
  AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql'))
  OR has_function_privilege('anon',v_oid,'EXECUTE')
  OR has_function_privilege('authenticated',v_oid,'EXECUTE')
  OR NOT has_function_privilege('service_role',v_oid,'EXECUTE') THEN
  RAISE EXCEPTION 'canonical place batch prerequisite metadata differs: trg_tournament_atomic_place_completion_guard';
 END IF;
 SELECT prosrc,pg_get_functiondef(oid),
  jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,
   'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_definition,v_before FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source) NOT IN ('3e43d26ddd36a55e736a9a304a89ba9a','1bde80d6520fbc3a93409fe88651109e') THEN
  RAISE EXCEPTION 'canonical place batch prerequisite body differs: trg_tournament_atomic_place_completion_guard';
 END IF;
 IF md5(v_source)='3e43d26ddd36a55e736a9a304a89ba9a' THEN
  IF position($canonical_old_1_0$  IF v_batch.escrow_available + 0.005 < v_batch.escrow_required THEN$canonical_old_1_0$ IN v_definition)=0 THEN RAISE EXCEPTION 'canonical batch source fragment 1/0 absent'; END IF;
  v_definition:=replace(v_definition,$canonical_old_1_0$  IF v_batch.escrow_available + 0.005 < v_batch.escrow_required THEN$canonical_old_1_0$,$canonical_new_1_0$  IF v_batch.contract_version=2 THEN
    PERFORM public.fn_ca_verify_terminal_place_batch(NEW.id,true);
    RETURN NEW;
  END IF;

  IF v_batch.escrow_available + 0.005 < v_batch.escrow_required THEN$canonical_new_1_0$);
  EXECUTE v_definition;
 END IF;
 SELECT prosrc,
  jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,
   'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_after FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source)<>'1bde80d6520fbc3a93409fe88651109e' OR v_before IS DISTINCT FROM v_after THEN
  RAISE EXCEPTION 'canonical place batch postcondition differs: trg_tournament_atomic_place_completion_guard';
 END IF;
END;
$contract_terminal_place_batch$;
DO $canonical_batch_terminal_marker$
DECLARE v_oid oid:='public.trg_freeze_batched_tournament_place()'::regprocedure;
 v_source text; v_definition text; v_before jsonb; v_after jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner='postgres'::regrole
   AND prosecdef AND proconfig=ARRAY['search_path=public']::text[]) THEN
  RAISE EXCEPTION 'frozen batch trigger metadata differs';
 END IF;
 SELECT prosrc,pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,
  'config',proconfig,'definer',prosecdef,'language',prolang,'args',proargtypes::text,'returns',prorettype)
 INTO v_source,v_definition,v_before FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source) NOT IN ('da224a232366acc2443f0ec5428567e0','5c00f4babf2e07dd86e9f47e14588b07') THEN
  RAISE EXCEPTION 'frozen batch trigger source differs';
 END IF;
 IF md5(v_source)='da224a232366acc2443f0ec5428567e0' THEN
  IF position($marker_old$  IF v_gate <> OLD.tournament_id::text THEN$marker_old$ IN v_definition)=0 THEN
   RAISE EXCEPTION 'frozen batch trigger marker anchor absent';
  END IF;
  v_definition:=replace(v_definition,$marker_old$  IF v_gate <> OLD.tournament_id::text THEN$marker_old$,$marker_new$  -- Stamp only the exact lifecycle marker after completion. Frozen monetary
  -- columns and payment gates retain their original restrictions.
  IF OLD.terminal_closed_at IS NULL AND NEW.terminal_closed_at IS NOT NULL
     AND isfinite(NEW.terminal_closed_at)
     AND (to_jsonb(NEW)-'terminal_closed_at') IS NOT DISTINCT FROM
         (to_jsonb(OLD)-'terminal_closed_at')
     AND EXISTS(SELECT 1 FROM public.tournament_place_settlement_batches b
       WHERE b.tournament_id=OLD.tournament_id AND b.contract_version=2
        AND b.settled_at IS NOT NULL)
     AND EXISTS(SELECT 1 FROM public.tournaments t
       WHERE t.id=OLD.tournament_id AND upper(t.status::text)='COMPLETED'
        AND t.ended_at IS NOT DISTINCT FROM NEW.terminal_closed_at) THEN
    PERFORM public.fn_ca_verify_terminal_place_batch(OLD.tournament_id,true);
    RETURN NEW;
  END IF;
  IF v_gate <> OLD.tournament_id::text THEN$marker_new$);
  EXECUTE v_definition;
 END IF;
 SELECT prosrc,jsonb_build_object('owner',proowner,'acl',proacl,
  'config',proconfig,'definer',prosecdef,'language',prolang,'args',proargtypes::text,'returns',prorettype)
 INTO v_source,v_after FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source)<>'5c00f4babf2e07dd86e9f47e14588b07' OR v_before IS DISTINCT FROM v_after THEN
  RAISE EXCEPTION 'frozen batch marker postcondition differs';
 END IF;
END;
$canonical_batch_terminal_marker$;
-- END CANONICAL TERMINAL PLACE BATCH CONTRACT

-- BEGIN CANONICAL TERMINAL READINESS DISPATCH
-- Only the versioned format proof changes. Shared finish claim, winner,
-- obligation, custody, rake, bounty and mystery certification remain intact.
DO $contract_terminal_batch_readiness$
DECLARE v_oid oid:='public.fn_tournament_finish_readiness(uuid,uuid)'::regprocedure;
 v_source text; v_definition text; v_before jsonb; v_after jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner='postgres'::regrole
  AND prosecdef AND proconfig=ARRAY['search_path=public, pg_temp']::text[])
  OR has_function_privilege('anon',v_oid,'EXECUTE')
  OR has_function_privilege('authenticated',v_oid,'EXECUTE')
  OR has_function_privilege('service_role',v_oid,'EXECUTE') THEN
  RAISE EXCEPTION 'terminal readiness owner-only metadata differs';
 END IF;
 SELECT prosrc,pg_get_functiondef(oid),
  jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,
    'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_definition,v_before FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source) NOT IN ('ac4a33b4428ca68fb385b7de764a8590','993e6e1de9edba2fe235d86ff6c243c9') THEN RAISE EXCEPTION 'terminal readiness source differs'; END IF;
 IF md5(v_source)='ac4a33b4428ca68fb385b7de764a8590' THEN
  IF position($readiness_old_0$  v_bad_satellite_seats integer := 0;$readiness_old_0$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 0 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_0$  v_bad_satellite_seats integer := 0;$readiness_old_0$,$readiness_new_0$  v_modern_place boolean := false;
  v_modern_deal boolean := false;
  v_bad_satellite_seats integer := 0;$readiness_new_0$);
  IF position($readiness_old_1$  v_kind := public.fn_tournament_finish_kind(p_tournament_id);$readiness_old_1$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 1 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_1$  v_kind := public.fn_tournament_finish_kind(p_tournament_id);$readiness_old_1$,$readiness_new_1$  v_kind := public.fn_tournament_finish_kind(p_tournament_id);
  IF v_kind='normal' THEN
    SELECT COALESCE((to_jsonb(b)->>'contract_version')::integer,1)=2
      INTO v_modern_place FROM public.tournament_place_settlement_batches b
     WHERE b.tournament_id=p_tournament_id;
  ELSIF v_kind='final_table_deal' THEN
    SELECT COALESCE((to_jsonb(b)->>'contract_version')::integer,1)=2
      INTO v_modern_deal FROM public.tournament_final_table_deal_batches b
     WHERE b.tournament_id=p_tournament_id;
  END IF;
  v_modern_place:=COALESCE(v_modern_place,false);
  v_modern_deal:=COALESCE(v_modern_deal,false);
$readiness_new_1$);
  IF position($readiness_old_2$  IF v_kind <> 'satellite' THEN$readiness_old_2$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 2 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_2$  IF v_kind <> 'satellite' THEN$readiness_old_2$,$readiness_new_2$  IF v_kind <> 'satellite' AND NOT v_modern_place AND NOT v_modern_deal THEN$readiness_new_2$);
  IF position($readiness_old_3$    SELECT round(COALESCE(sum(o.amount_owed),0),2) INTO v_place_owed$readiness_old_3$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 3 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_3$    SELECT round(COALESCE(sum(o.amount_owed),0),2) INTO v_place_owed$readiness_old_3$,$readiness_new_3$    IF v_modern_place THEN
      BEGIN
        v_domain_check:=public.fn_ca_verify_terminal_place_batch(p_tournament_id,true);
        IF COALESCE((v_domain_check->>'ok')::boolean,false) IS NOT TRUE THEN
          RAISE EXCEPTION 'canonical place proof refused';
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_failures:=v_failures||jsonb_build_array(jsonb_build_object(
          'code','canonical_place_batch_not_proven','detail',SQLERRM));
      END;
    END IF;

    SELECT round(COALESCE(sum(o.amount_owed),0),2) INTO v_place_owed$readiness_new_3$);
  IF position($readiness_old_4$    IF abs(v_place_owed - round(COALESCE(v_t.prize_pool,0),2)) > 0.005 THEN$readiness_old_4$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 4 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_4$    IF abs(v_place_owed - round(COALESCE(v_t.prize_pool,0),2)) > 0.005 THEN$readiness_old_4$,$readiness_new_4$    IF NOT v_modern_place AND abs(v_place_owed - round(COALESCE(v_t.prize_pool,0),2)) > 0.005 THEN$readiness_new_4$);
  IF position($readiness_old_5$      v_domain_check := public.fn_check_atomic_final_table_deal(p_tournament_id);$readiness_old_5$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 5 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_5$      v_domain_check := public.fn_check_atomic_final_table_deal(p_tournament_id);$readiness_old_5$,$readiness_new_5$      IF v_modern_deal THEN
        BEGIN
          v_domain_check:=public.fn_ca_verify_terminal_final_deal_batch(p_tournament_id,true);
        EXCEPTION WHEN OTHERS THEN
          v_domain_check:=jsonb_build_object('ok',false,'reason',SQLERRM);
        END;
      ELSE
        v_domain_check := public.fn_check_atomic_final_table_deal(p_tournament_id);
      END IF;$readiness_new_5$);
  EXECUTE v_definition;
 END IF;
 SELECT prosrc,
  jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,
    'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_after FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source)<>'993e6e1de9edba2fe235d86ff6c243c9' OR v_before IS DISTINCT FROM v_after THEN RAISE EXCEPTION 'readiness source or metadata postcondition differs'; END IF;
END;
$contract_terminal_batch_readiness$;
-- END CANONICAL TERMINAL READINESS DISPATCH

DO $contract_cash_batch_payers$
DECLARE
  v_row record;
  v_source text;
  v_definition text;
  v_old CONSTANT text := 'public.fn_settle_tournament_obligation(';
  v_new CONSTANT text := 'public.fn_settle_tournament_obligation_before_atomic_batch_gate(';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
     WHERE p.oid=to_regprocedure(
       'public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)')
       AND md5(p.prosrc)='ebabbaf0456d80335aaa2e04471d0ab6'
       AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
       AND l.lanname='plpgsql'
       AND p.proconfig=ARRAY['search_path=public']::text[]
  ) THEN
    RAISE EXCEPTION 'Stage-B cash contraction requires the exact private obligation core';
  END IF;

  FOR v_row IN SELECT * FROM (VALUES
    ('public.fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric)',
     '329237bd65214e17d4ca3298f363f248', '3585ddbfdb0a197243d5e6eefb6b670f'),
    ('public.fn_ca_settle_tournament_bubble_raw(uuid,uuid,numeric)',
     '3a5a0f079b7884a5bd2e6bfe6a15ccb7', 'f1fc7a0bf480b1034f0f1d9cba3b4d0b'),
    ('public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric)',
     '58e2768644b692f23a9a071a8a5d1ee8', '852e35483b67c1fc59b6347b51c79cb8')
  ) expected(identity, before_md5, after_md5)
  LOOP
    SELECT p.prosrc, pg_get_functiondef(p.oid)
      INTO v_source, v_definition
      FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
     WHERE p.oid=to_regprocedure(v_row.identity)
       AND md5(p.prosrc) IN (v_row.before_md5,v_row.after_md5)
       AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
       AND l.lanname='plpgsql'
       AND p.proconfig=ARRAY['search_path=public']::text[];
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Stage-B cash payer source differs: %',v_row.identity;
    END IF;
    IF md5(v_source)=v_row.before_md5 AND (
       (length(v_source)-length(replace(v_source,v_old,''))) IS DISTINCT FROM length(v_old)
       OR position(v_new IN v_source)>0) THEN
      RAISE EXCEPTION 'Stage-B cash payer preimage differs: %',v_row.identity;
    END IF;
    IF md5(v_source)=v_row.after_md5 AND (
       position(v_old IN v_source)>0
       OR (length(v_source)-length(replace(v_source,v_new,''))) IS DISTINCT FROM length(v_new)) THEN
      RAISE EXCEPTION 'Stage-B cash payer postimage differs: %',v_row.identity;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(
        COALESCE(p.proacl,acldefault('f',p.proowner))) privilege
       WHERE p.oid=to_regprocedure(v_row.identity)
         AND privilege.privilege_type='EXECUTE'
         AND privilege.grantee<>p.proowner
    ) OR has_function_privilege('anon',v_row.identity,'EXECUTE')
      OR has_function_privilege('authenticated',v_row.identity,'EXECUTE')
      OR has_function_privilege('service_role',v_row.identity,'EXECUTE') THEN
      RAISE EXCEPTION 'Stage-B cash payer is not owner-only: %',v_row.identity;
    END IF;

    IF md5(v_source)=v_row.before_md5 THEN
      EXECUTE replace(v_definition,v_old,v_new);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
       WHERE p.oid=to_regprocedure(v_row.identity)
         AND md5(p.prosrc)=v_row.after_md5
         AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
         AND l.lanname='plpgsql'
         AND p.proconfig=ARRAY['search_path=public']::text[]
         AND position(v_old IN p.prosrc)=0
         AND (length(p.prosrc)-length(replace(p.prosrc,v_new,'')))=length(v_new)
    ) OR EXISTS (
      SELECT 1 FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(
        COALESCE(p.proacl,acldefault('f',p.proowner))) privilege
       WHERE p.oid=to_regprocedure(v_row.identity)
         AND privilege.privilege_type='EXECUTE'
         AND privilege.grantee<>p.proowner
    ) OR has_function_privilege('anon',v_row.identity,'EXECUTE')
      OR has_function_privilege('authenticated',v_row.identity,'EXECUTE')
      OR has_function_privilege('service_role',v_row.identity,'EXECUTE') THEN
      RAISE EXCEPTION 'Stage-B cash payer postcondition differs: %',v_row.identity;
    END IF;
  END LOOP;
END;
$contract_cash_batch_payers$;

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
  -- Keep the current exact-refund door authoritative for every input shape.
  IF v_kind='refund' THEN
    RETURN jsonb_build_object('ok',false,'paid',0,'already_paid',0,
      'refused_reason','exact_refund_authority_required','obligation_id',NULL,
      'idempotency_key',NULL);
  END IF;
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

/* Historical completion evidence remains unchanged. Enabling the guards
   constrains future writes; historical certificate review belongs to Phase 9. */

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

/* Retiring an executable repair path does not resolve its historical findings. */

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
    'rpc/fn_begin_tournament_launch_atomic',
    'rpc/fn_bounty_obligation_has_complete_marker',
    'rpc/fn_claim_tournament_bounty_elimination',
    'rpc/fn_close_tournament_addon_period',
    'rpc/fn_close_empty_tournament_table',
    'rpc/fn_close_tournament_entry_window',
    'rpc/fn_collect_bounty',
    'rpc/fn_complete_tournament_entry_reprice',
    'rpc/fn_complete_tournament_launch_atomic',
    'rpc/fn_complete_tournament_terminal_proposal',
    'rpc/fn_begin_tournament_deal_review',
    'rpc/fn_close_tournament_deal_review',
    'rpc/fn_decline_tournament_rebuy',
    'rpc/fn_eliminate_tournament_player_atomic',
    'rpc/fn_ensure_late_registration_capacity',
    'rpc/fn_get_tournament_satellite_entitlement_depth',
    'rpc/fn_mystery_bounty_pay',
    'rpc/fn_mystery_bounty_reserve',
    'rpc/fn_mystery_bounty_reveal',
    'rpc/fn_mystery_bounty_seed',
    'rpc/fn_move_tournament_player',
    'rpc/fn_move_tournament_player_atomic',
    'rpc/fn_open_tournament_rebuy_decisions',
    'rpc/fn_settle_final_table_deal_atomic',
    'rpc/fn_spin_draw_and_settle_atomic',
    'rpc/fn_spin_draw_multiplier',
    'rpc/fn_spin_settle_game',
    'rpc/fn_sync_tournament_live_seat_chips',
    'rpc/fn_tournament_has_unsettled_bounties',
    'rpc/process_tournament_rebuy'
  ]::text[];
  v_engine_service_paths constant text[] := ARRAY[
    'rpc/claim_table_lease_v2',
    'rpc/claim_tournament_lease_v2',
    'rpc/fn_ack_tournament_manager_wakes',
    'rpc/fn_apply_prize_guarantee',
    'rpc/fn_ca_commit_hand_settlement',
    'rpc/fn_ca_process_hand_post_commit_obligations',
    'rpc/fn_certify_tournament_finish',
    'rpc/fn_claim_tournament_finish',
    'rpc/fn_finalize_bounty_pool',
    'rpc/fn_mystery_bounty_settle',
    'rpc/fn_normalize_tournament_final_standings',
    'rpc/fn_prepare_tournament_place_obligations',
    'rpc/fn_project_hand_side_effects',
    'rpc/fn_settle_satellite_finish_atomic',
    'rpc/fn_settle_tournament_obligation',
    'rpc/fn_settle_tournament_places_atomic',
    'rpc/fn_settle_tournament_rake',
    'rpc/fn_sweep_pending_tournament_bounties',
    'rpc/fn_sync_seat_first_player_count',
    'rpc/heartbeat_table_leases_v3',
    'rpc/heartbeat_tournament_leases_v3',
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
     Old/headerless engine binaries can use neither family after cutover. */
  -- Rebuy, decline and mystery reveal are shared player/manager RPCs. Their
  -- authenticated callers retain each function's own player/session checks
  -- (reveal uses auth.uid(), never supplied actor/auto) and receive no manager
  -- proof. All server callers still require their exact manager lease.
  IF v_path = ANY(v_manager_exclusive_paths)
     AND v_actor IS DISTINCT FROM 'tournament-manager'
     AND NOT (
       v_request_role = 'authenticated'
       AND v_actor = ''
       AND v_path IN (
         'rpc/process_tournament_rebuy', 'rpc/fn_decline_tournament_rebuy',
         'rpc/fn_mystery_bounty_reveal'
       )
     ) THEN
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
     FOR KEY SHARE;
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
     FOR KEY SHARE. Row triggers can consume this transaction proof without doing
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
   proof. The pre-request hook already holds the exact lease FOR KEY SHARE for the
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
DROP FUNCTION IF EXISTS public.release_tournament_leases(text, uuid[]);
DROP FUNCTION IF EXISTS public.fn_begin_tournament_launch_atomic(
  uuid, uuid, timestamptz
);
DROP FUNCTION IF EXISTS public.fn_complete_tournament_launch_atomic(uuid, uuid);
DROP FUNCTION IF EXISTS public.claim_table_lease(uuid, text, text, integer);
DROP FUNCTION IF EXISTS public.heartbeat_table_leases_v2(text, uuid[], integer);
DROP FUNCTION IF EXISTS public.heartbeat_table_leases(text, uuid[]);
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
REVOKE ALL ON FUNCTION public.heartbeat_tournament_leases_v3(text, jsonb, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_tournament_leases_v3(text, jsonb, integer)
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
REVOKE ALL ON FUNCTION public.heartbeat_table_leases_v3(text, jsonb, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_table_leases_v3(text, jsonb, integer)
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

  IF position('TOURNAMENT_MANAGER_AUTHORITY_REQUIRED' IN v_hook_source) = 0
     OR position('ENGINE_DATA_AUTHORITY_REQUIRED' IN v_hook_source) = 0
     OR position($needle$'shared-estate-service'$needle$ IN v_hook_source) = 0
     OR position($needle$'browser'$needle$ IN v_hook_source) = 0
     OR position(E'     FOR KEY SHARE;\n  END IF;' IN v_hook_source) = 0
     OR md5((SELECT p.prosrc FROM pg_proc p WHERE p.oid='smarter_private.fn_smarter_data_api_pre_request()'::regprocedure)) <> 'd21a055b448febe83c1637371b150100'
     OR position('l.lease_generation = v_lease_generation' IN v_hook_source) = 0
     OR position('app.smarter_manager_request_fenced' IN v_hook_source) = 0
     OR position('auth.role()' IN v_hook_source) = 0
     OR position('verified JWT role disagrees with request claims' IN v_hook_source) = 0
     OR position($needle$'rpc/fn_project_hand_side_effects'$needle$ IN v_hook_source) = 0
     OR position($needle$'rpc/fn_move_tournament_player'$needle$ IN v_hook_source) = 0
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


  IF to_regprocedure('public.claim_tournament_lease(uuid,text,text,integer)')
       IS NOT NULL
     OR to_regprocedure('public.heartbeat_tournament_leases_v2(text,uuid[],integer)')
       IS NOT NULL
     OR to_regprocedure('public.heartbeat_tournament_leases(text,uuid[])')
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

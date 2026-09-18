-- 20260917194950_the_money_rows_keep_their_old_order.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE MONEY ROWS KEEP THEIR OLD ORDER.
-- Phase 2 of the horse programme, 2026-09-17. Reverses changes 6 and 7 of
-- 20260917191322_sweeps_and_satellites_take_their_own_lanes.sql and leaves
-- its lane changes (1-5, 7b) in place.
--
-- WHAT HAPPENED (production, 2026-09-17, 19:32-19:45 UTC)
--
-- 20260917191322 was applied at 19:32:01. Its changes 6 and 7 tried to give
-- the finish and the hand post-commit obligations one lock order for the
-- club wallet and the per-user table_cap keys: the finish took every
-- player's 'table_cap:<user>' key before touching money, and the
-- obligations took the club wallet row before deciding whether they had
-- anything to do. Between 19:32 and 19:45 the Postgres log recorded about
-- 1,350 deadlocks, against 22 in the 5.5 hours before; every one had the
-- finish, the obligations and fn_project_hand_side_effects in the cycle:
--
--   finish            holds table_cap(user) for all players, waits for the
--                     club_wallets tuple (pre_seat_guard line 132)
--   obligations       holds the club_wallets tuple (its new line 58), waits
--                     for a row held by the hand side effects
--   hand side effects hold their hand's rows and wait for
--                     table_cap(user), held by the finish
--
-- The premise was wrong in two ways. fn_project_hand_side_effects calls the
-- obligations inside the hand's own transaction, so the early wallet lock
-- was taken while the hand's rows were already held, by every hand at every
-- table of the club, whether or not it owed anything; and table_cap is not
-- taken before every money row: the side effects reach it after their rows.
-- A finish that holds one key per player for its whole duration crosses
-- those paths constantly. Both bodies were restored by hand at 19:42:27
-- (finish) and 19:45:24 (obligations), and no deadlock has been logged
-- since 19:45:30. This file is that restore, byte for byte, so the migration
-- ledger says what the database holds.
--
-- WHAT THIS CHANGES
--
-- 1. fn_complete_tournament_terminal(uuid,uuid,text) returns to the body
--    20260917113717 declared (prosrc md5 36384d5eaef31083e0ee5424d814138d):
--    the finish lane, the seat-exit authority, the guard, nothing else.
-- 2. fn_ca_process_hand_post_commit_obligations(uuid) returns to its body of
--    before 20260917191322 (prosrc md5 9672653f9e15a45072de3b60ce5b0b2f):
--    the already-completed return comes before any wallet lock.
--
-- The lane changes of 20260917191322 stand: the Spin sweep and the
-- satellite finish take their own lanes instead of the global lane, VIP
-- credits lock by user_id, and fn_ca_settlement_lane_doctrine() (rewritten
-- by 20260917193840) still answers ok on this schema, because neither body
-- restored here names a lane helper the doctrine forbids.
--
-- Idempotent on purpose: the precondition accepts either the 20260917191322
-- body or the pre-image, since the hand restore already ran.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS. Each body is the 20260917191322 version or the pre-image
--    this file restores. Anything else is a third change nobody has read.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_finish text;
  v_oblig text;
BEGIN
  SELECT md5(p.prosrc) INTO v_finish
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.oid::regprocedure::text = 'fn_complete_tournament_terminal(uuid,uuid,text)';
  IF v_finish IS NULL OR v_finish NOT IN ('1f942c086e5a127190b1bb96895dc478', '36384d5eaef31083e0ee5424d814138d') THEN
    RAISE EXCEPTION 'precondition: fn_complete_tournament_terminal is neither the 20260917191322 body nor its pre-image (md5 %)', v_finish;
  END IF;
  SELECT md5(p.prosrc) INTO v_oblig
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.oid::regprocedure::text = 'fn_ca_process_hand_post_commit_obligations(uuid)';
  IF v_oblig IS NULL OR v_oblig NOT IN ('75e5236e1d3e6c5aa8ba1caaaf16f999', '9672653f9e15a45072de3b60ce5b0b2f') THEN
    RAISE EXCEPTION 'precondition: fn_ca_process_hand_post_commit_obligations is neither the 20260917191322 body nor its pre-image (md5 %)', v_oblig;
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. THE FINISH, AS 20260917113717 LEFT IT.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_complete_tournament_terminal(p_tournament_id uuid, p_observed_winner_id uuid, p_settlement_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '45s'
AS $function$
DECLARE
  v_token uuid;
  v_result jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'terminal settlement requires service authority'
      USING ERRCODE='28000';
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_for_finish(p_tournament_id);
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'terminal_finish',NULL);
  BEGIN
    v_result:=public.fn_complete_tournament_terminal_pre_seat_guard(
      p_tournament_id,p_observed_winner_id,p_settlement_mode);
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_terminal(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_terminal(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. THE OBLIGATIONS, AS THEY WERE BEFORE 20260917191322.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_process_hand_post_commit_obligations(p_hand_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_table_id uuid;
  v_commit public.hand_atomic_commits%ROWTYPE;
  v_payload jsonb;
  v_hash text;
  v_rake jsonb;
  v_bbj jsonb;
  v_pending jsonb;
  v_item jsonb;
  v_rake_result record;
  v_promo_result jsonb;
  v_pool_id uuid;
  v_union_id uuid;
  v_contribution_id uuid;
  v_insurance_id uuid;
  v_addon_result record;
  v_addon public.table_pending_addons%ROWTYPE;
  v_time_bank_count integer := 0;
  v_promo_count integer := 0;
  v_insurance_count integer := 0;
  v_addon_count integer := 0;
  v_result jsonb;
BEGIN
  /* Read only the scope, then take the per-table mutex before the row lock.
     This gives every hand at one table the same lock order. */
  SELECT c.table_id INTO v_table_id
    FROM public.hand_atomic_commits c
   WHERE c.hand_id = p_hand_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found', 'hand_id', p_hand_id);
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('hand-post-commit:' || v_table_id::text, 0)
  );

  SELECT c.* INTO v_commit
    FROM public.hand_atomic_commits c
   WHERE c.hand_id = p_hand_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found', 'hand_id', p_hand_id);
  END IF;
  IF v_commit.post_commit_payload IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'legacy_no_obligations',
      'hand_id', p_hand_id
    );
  END IF;
  IF v_commit.post_commit_completed_at IS NOT NULL THEN
    RETURN COALESCE(v_commit.post_commit_result, '{}'::jsonb) || jsonb_build_object(
      'ok', true,
      'already_completed', true,
      'hand_id', p_hand_id,
      'completed_at', v_commit.post_commit_completed_at
    );
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.hand_atomic_commits earlier
     WHERE earlier.table_id = v_commit.table_id
       AND earlier.hand_number < v_commit.hand_number
       AND earlier.post_commit_payload IS NOT NULL
       AND earlier.post_commit_completed_at IS NULL
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'predecessor_pending',
      'hand_id', p_hand_id
    );
  END IF;

  v_payload := v_commit.post_commit_payload;
  v_hash := encode(
    extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'),
    'hex'
  );
  IF v_commit.post_commit_payload_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION 'post-commit obligation payload hash mismatch for hand %', p_hand_id;
  END IF;

  /* Time banks were stamped inside the accepted-hand transaction while the
     exact lease and seat locks were held. A delayed consumer must never apply
     those older values again after hand N+1, a table break, or a seat move. */
  IF jsonb_typeof(v_payload->'time_banks') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid time-bank audit payload for hand %', p_hand_id;
  END IF;
  v_time_bank_count := jsonb_array_length(v_payload->'time_banks');

  IF EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
      WHERE t.id=v_table_id AND c.asset='diamonds') AND (
    v_payload->'rake' IS DISTINCT FROM 'null'::jsonb
    OR v_payload->'bbj_contribution' IS DISTINCT FROM 'null'::jsonb
    OR v_payload->'pending_addons' IS DISTINCT FROM 'null'::jsonb
    OR v_payload->'promo_playthrough' IS DISTINCT FROM '[]'::jsonb
    OR v_payload->'insurance' IS DISTINCT FROM '[]'::jsonb
  ) THEN
    RAISE EXCEPTION 'diamond_hand_has_chip_obligations';
  END IF;
  v_rake := v_payload->'rake';
  IF v_rake IS NOT NULL AND jsonb_typeof(v_rake) <> 'null' THEN
    IF jsonb_typeof(v_rake) <> 'object'
       OR COALESCE((v_rake->>'amount')::numeric, 0) <= 0
       OR (v_rake->>'club_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid rake obligation for hand %', p_hand_id;
    END IF;
    IF v_commit.hand_number > 2147483647 THEN
      RAISE EXCEPTION 'rake hand number exceeds downstream integer contract: %',
        v_commit.hand_number;
    END IF;

    SELECT * INTO v_rake_result
      FROM public.atomic_distribute_rake(
        v_commit.table_id,
        (v_rake->>'club_id')::uuid,
        v_commit.hand_id,
        v_commit.hand_number::integer,
        (v_rake->>'amount')::numeric,
        COALESCE((v_rake->>'bbj')::numeric, 0),
        NULLIF(v_rake->>'pot', '')::numeric,
        NULLIF(v_rake->>'num_players', '')::integer,
        COALESCE(v_rake->'contributions', '{}'::jsonb),
        NULLIF(v_rake->>'tournament_id', '')::uuid,
        COALESCE(v_rake->'returned_uncalled', '{}'::jsonb),
        COALESCE(NULLIF(v_rake->>'method', ''), 'WEIGHTED_CONTRIBUTED')
      );
    IF NOT FOUND OR NOT (
      COALESCE(v_rake_result.applied, false)
      OR COALESCE(v_rake_result.already_processed, false)
      OR v_rake_result.rake_record_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'rake obligation did not produce a receipt for hand %', p_hand_id;
    END IF;
  END IF;

  v_bbj := v_payload->'bbj_contribution';
  IF v_bbj IS NOT NULL AND jsonb_typeof(v_bbj) <> 'null' THEN
    IF jsonb_typeof(v_bbj) <> 'object'
       OR COALESCE((v_bbj->>'amount')::numeric, 0) <= 0
       OR (v_bbj->>'club_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid BBJ contribution obligation for hand %', p_hand_id;
    END IF;

    SELECT c.union_id INTO v_union_id
      FROM public.clubs c
     WHERE c.id = (v_bbj->>'club_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'BBJ obligation club not found for hand %', p_hand_id;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(
      'bbj-pool:' || COALESCE(v_union_id::text, 'club:' || (v_bbj->>'club_id')),
      0
    ));
    IF v_union_id IS NULL THEN
      SELECT p.id INTO v_pool_id
        FROM public.bbj_pools p
       WHERE p.club_id = (v_bbj->>'club_id')::uuid
         AND p.status = 'active'
       ORDER BY p.created_at, p.id
       LIMIT 1
       FOR UPDATE;
    ELSE
      SELECT p.id INTO v_pool_id
        FROM public.bbj_pools p
       WHERE p.union_id = v_union_id
         AND p.status = 'active'
       ORDER BY p.created_at, p.id
       LIMIT 1
       FOR UPDATE;
    END IF;

    IF v_pool_id IS NULL THEN
      IF v_union_id IS NULL THEN
        INSERT INTO public.bbj_pools(
          club_id, main_balance, backup_balance, promo_balance, status
        ) VALUES (
          (v_bbj->>'club_id')::uuid, 0, 0, 0, 'active'
        ) RETURNING id INTO v_pool_id;
      ELSE
        INSERT INTO public.bbj_pools(
          union_id, main_balance, backup_balance, promo_balance, status
        ) VALUES (
          v_union_id, 0, 0, 0, 'active'
        ) RETURNING id INTO v_pool_id;
      END IF;
    END IF;

    SELECT r.id INTO v_contribution_id
      FROM public.bbj_record_contribution(
        v_pool_id,
        v_commit.hand_id,
        v_commit.table_id,
        (v_bbj->>'amount')::numeric,
        0, 0, 0,
        COALESCE((v_bbj->>'big_blind')::numeric, 2),
        v_commit.hand_number::integer,
        (v_bbj->>'club_id')::uuid
      ) r;
    IF v_contribution_id IS NULL THEN
      RAISE EXCEPTION 'BBJ contribution produced no receipt for hand %', p_hand_id;
    END IF;
  END IF;

  FOR v_item IN
    SELECT value
      FROM jsonb_array_elements(v_payload->'promo_playthrough')
     ORDER BY value->>'user_id'
  LOOP
    IF (v_item->>'club_id') !~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR (v_item->>'user_id') !~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR COALESCE((v_item->>'wagered')::numeric, 0) <= 0 THEN
      RAISE EXCEPTION 'invalid promo obligation for hand %', p_hand_id;
    END IF;
    v_promo_result := public.promo_apply_playthrough(
      (v_item->>'club_id')::uuid,
      (v_item->>'user_id')::uuid,
      (v_item->>'wagered')::numeric
    );
    IF v_promo_result->>'reason' IN ('engine_only', 'no_wager') THEN
      RAISE EXCEPTION 'promo obligation refused for hand %: %',
        p_hand_id, v_promo_result;
    END IF;
    v_promo_count := v_promo_count + 1;
  END LOOP;

  FOR v_item IN
    SELECT value
      FROM jsonb_array_elements(v_payload->'insurance')
     ORDER BY value->>'player_id', value->>'kind'
  LOOP
    IF (v_item->>'club_id') !~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR (v_item->>'player_id') !~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid insurance obligation for hand %', p_hand_id;
    END IF;
    SELECT r.id INTO v_insurance_id
      FROM public.record_insurance_transaction(
        v_commit.table_id,
        (v_item->>'club_id')::uuid,
        v_commit.hand_number::integer,
        (v_item->>'player_id')::uuid,
        COALESCE((v_item->>'equity_percent')::numeric, 0),
        COALESCE((v_item->>'premium')::numeric, 0),
        COALESCE((v_item->>'insured_amount')::numeric, 0),
        COALESCE((v_item->>'payout')::numeric, 0),
        COALESCE((v_item->>'player_won')::boolean, false),
        COALESCE(NULLIF(v_item->>'kind', ''), 'insurance')::varchar
      ) r;
    IF v_insurance_id IS NULL THEN
      RAISE EXCEPTION 'insurance obligation produced no receipt for hand %', p_hand_id;
    END IF;
    v_insurance_count := v_insurance_count + 1;
  END LOOP;

  v_pending := v_payload->'pending_addons';
  IF v_pending IS NOT NULL AND jsonb_typeof(v_pending) <> 'null' THEN
    IF jsonb_typeof(v_pending) <> 'object'
       OR COALESCE((v_pending->>'enabled')::boolean, false) IS NOT TRUE
       OR jsonb_typeof(v_pending->'ids') IS DISTINCT FROM 'array'
       OR NULLIF(v_pending->>'max_buy_in', '') IS NULL
       OR (v_pending->>'max_buy_in')::numeric <= 0 THEN
      RAISE EXCEPTION 'invalid pending-add-on obligation for hand %', p_hand_id;
    END IF;
    FOR v_item IN
      SELECT value
        FROM jsonb_array_elements(v_pending->'ids')
       ORDER BY value #>> '{}'
    LOOP
      IF (v_item #>> '{}') !~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN
        RAISE EXCEPTION 'pending add-on % is not frozen for table % (hand %)',
          v_item, v_commit.table_id, p_hand_id;
      END IF;
      -- Recovery can encounter an ID also frozen by an earlier accepted
      -- hand. The resolver owns exactly-once delivery and returns its stored
      -- result on replay. A resolved row is evidence, not a failed payment.
      SELECT a.* INTO v_addon
        FROM public.table_pending_addons a
       WHERE a.id = (v_item #>> '{}')::uuid
         AND a.table_id = v_commit.table_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'pending add-on % does not belong to table % (hand %)',
          v_item, v_commit.table_id, p_hand_id;
      END IF;
      SELECT * INTO v_addon_result
        FROM public.resolve_pending_addon(
          (v_item #>> '{}')::uuid,
          NULLIF(v_pending->>'max_buy_in', '')::numeric
        );
      IF NOT FOUND THEN
        RAISE EXCEPTION 'pending add-on % produced no receipt for hand %',
          v_item, p_hand_id;
      END IF;
      IF v_addon.amount IS NULL OR v_addon.amount <= 0
         OR v_addon.amount::text IN ('NaN', 'Infinity', '-Infinity')
         OR (v_addon.resolved_at IS NOT NULL AND
             (v_addon.applied_to_stack IS NULL OR v_addon.refunded IS NULL))
         OR v_addon_result.applied IS NULL OR v_addon_result.applied < 0
         OR v_addon_result.applied::text IN ('NaN', 'Infinity', '-Infinity')
         OR v_addon_result.applied <> round(v_addon_result.applied, 2)
         OR v_addon_result.refunded IS NULL OR v_addon_result.refunded < 0
         OR v_addon_result.refunded::text IN ('NaN', 'Infinity', '-Infinity')
         OR v_addon_result.refunded <> round(v_addon_result.refunded, 2)
         OR v_addon_result.applied + v_addon_result.refunded
              IS DISTINCT FROM round(v_addon.amount, 2)
      THEN
        RAISE EXCEPTION 'pending add-on % has an incomplete resolution receipt for hand %',
          v_item, p_hand_id;
      END IF;
      v_addon_count := v_addon_count + 1;
    END LOOP;
  END IF;

  v_result := jsonb_build_object(
    'ok', true,
    'already_completed', false,
    'hand_id', p_hand_id,
    'hand_number', v_commit.hand_number,
    'time_banks', v_time_bank_count,
    'rake', v_rake IS NOT NULL AND jsonb_typeof(v_rake) <> 'null',
    'bbj_contribution', v_bbj IS NOT NULL AND jsonb_typeof(v_bbj) <> 'null',
    'promo_playthrough', v_promo_count,
    'insurance', v_insurance_count,
    'pending_addons', v_addon_count
  );

  UPDATE public.hand_atomic_commits c
     SET post_commit_completed_at = clock_timestamp(),
         post_commit_result = v_result
   WHERE c.hand_id = p_hand_id
     AND c.post_commit_completed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post-commit completion receipt was lost for hand %', p_hand_id;
  END IF;

  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_process_hand_post_commit_obligations(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_process_hand_post_commit_obligations(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. POSTCONDITIONS. Both bodies are the pre-images, the finish still takes
--    its lane, the obligations no longer lock the wallet before deciding,
--    and the doctrine still holds.
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  v_md5 text;
  v_src text;
  v_answer jsonb;
BEGIN
  SELECT md5(p.prosrc), p.prosrc INTO v_md5, v_src
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.oid::regprocedure::text = 'fn_complete_tournament_terminal(uuid,uuid,text)';
  IF v_md5 IS DISTINCT FROM '36384d5eaef31083e0ee5424d814138d' THEN
    RAISE EXCEPTION 'postcondition: fn_complete_tournament_terminal is not the 20260917113717 body (md5 %)', v_md5;
  END IF;
  IF v_src NOT LIKE '%fn_ca_lock_settlement_lane_for_finish(p_tournament_id)%' OR v_src LIKE '%table_cap:%' THEN
    RAISE EXCEPTION 'postcondition: the finish body is not the expected shape';
  END IF;

  SELECT md5(p.prosrc), p.prosrc INTO v_md5, v_src
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.oid::regprocedure::text = 'fn_ca_process_hand_post_commit_obligations(uuid)';
  IF v_md5 IS DISTINCT FROM '9672653f9e15a45072de3b60ce5b0b2f' THEN
    RAISE EXCEPTION 'postcondition: fn_ca_process_hand_post_commit_obligations is not its pre-image (md5 %)', v_md5;
  END IF;
  IF position('FROM public.club_wallets w' IN v_src) > 0
     AND position('FROM public.club_wallets w' IN v_src) < position('already' IN v_src) THEN
    RAISE EXCEPTION 'postcondition: the obligations still lock the club wallet before the already-completed return';
  END IF;

  v_answer := public.fn_ca_settlement_lane_doctrine();
  IF COALESCE((v_answer ->> 'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'postcondition: the lane doctrine reports violations after the restore: %', v_answer;
  END IF;
END
$post$;

COMMIT;

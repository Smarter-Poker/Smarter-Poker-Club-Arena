SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
-- FIFO inbox 5 only. SOURCE-REVIEW CANDIDATE / NATIVE UNRUN / UNINSTALLED.
-- One new runtime call: current settlement G -> B before the first parent lock.
-- Existing predicates, cancellation calls, counter expressions and handler text
-- are unchanged. The new global acquisition is outside that handler: timeout
-- propagates and rolls back the sweep. Qualification contract R5 covers this.
-- No original alert or business row is repaired here.
-- Requires an independently verified owner serialization receipt excluding all
-- target/dependency DDL from preflight through commit and readback. A transaction
-- or read/replace/read alone does NOT prevent a concurrent definition overwrite.
-- This source supplies no serialization provider or self-issued permit. Without
-- that qualified owner boundary, DO NOT APPLY. See qualification plan.
DO $spin_expiry_lock_order$
DECLARE
  v_rollback constant boolean := false;
  v_oid oid := to_regprocedure('public.fn_spin_expire_unfilled(integer)');
  v_pre constant text := $preimage$CREATE OR REPLACE FUNCTION public.fn_spin_expire_unfilled(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_minutes integer;
  g record;
  v_current record;
  v_skipped integer := 0;
  res jsonb;
  v_expired integer := 0;
  v_failed integer := 0;
  v_refunded numeric := 0;
  v_ids jsonb := '[]'::jsonb;
BEGIN
  SELECT unfilled_timeout_minutes INTO v_minutes FROM public.spin_fill_policy LIMIT 1;
  v_minutes := COALESCE(v_minutes, 30);

  -- 0 (or a missing row) means the operator has switched the sweep off.
  IF v_minutes <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'disabled', true, 'expired', 0);
  END IF;

  FOR g IN
    SELECT t.id,
           t.buy_in_amount,
           (SELECT count(*) FROM public.table_seats s
              JOIN public.tables tb ON tb.id = s.table_id
             WHERE tb.tournament_id = t.id AND s.left_at IS NULL) AS live_seats
      FROM public.tournaments t
     WHERE t.variant = 'spin'
       AND t.status IN ('REGISTERING', 'ANNOUNCED')
       AND t.started_at IS NULL
       -- somebody has actually been waiting too long
       AND EXISTS (SELECT 1 FROM public.table_seats s
                     JOIN public.tables tb ON tb.id = s.table_id
                    WHERE tb.tournament_id = t.id
                      AND s.left_at IS NULL
                      AND s.joined_at < now() - make_interval(mins => v_minutes))
       -- and the game is NOT full: a full unstarted spin is about to deal.
       AND (SELECT count(*) FROM public.table_seats s
              JOIN public.tables tb ON tb.id = s.table_id
             WHERE tb.tournament_id = t.id AND s.left_at IS NULL)
           < COALESCE(t.max_players, 3)
     ORDER BY t.created_at
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    -- The scan is only a candidate list. A final join or launch may commit
    -- before cancellation reaches this parent. Busy parents belong to that
    -- work; the next sweep may reconsider them.
    PERFORM 1 FROM public.tournaments t WHERE t.id=g.id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    -- Read in a new statement AFTER acquiring the parent, so seat subqueries
    -- cannot retain the candidate scan's earlier snapshot.
    SELECT t.status,t.variant,t.started_at,t.spin_multiplier,t.buy_in_amount,
           COALESCE(t.max_players,3) AS max_players,
           (SELECT count(*) FROM public.table_seats s
              JOIN public.tables tb ON tb.id=s.table_id
             WHERE tb.tournament_id=t.id AND s.left_at IS NULL) AS live_seats,
           EXISTS(SELECT 1 FROM public.table_seats s
              JOIN public.tables tb ON tb.id=s.table_id
             WHERE tb.tournament_id=t.id AND s.left_at IS NULL
               AND s.joined_at < now()-make_interval(mins=>v_minutes)) AS has_expired_waiter,
           EXISTS(SELECT 1 FROM public.spin_reserve_ledger l
             WHERE l.tournament_id=t.id AND l.kind='jackpot_draw')
             OR EXISTS(SELECT 1 FROM public.spin_draw_receipts r
               WHERE r.tournament_id=t.id) AS has_booked_draw
      INTO v_current FROM public.tournaments t WHERE t.id=g.id;
    -- A drawn Spin is never expired. tournaments.spin_multiplier has DEFAULT 0
    -- and the seat-first creator omits the column, so `IS NOT NULL` read every
    -- undrawn Spin as drawn and this sweep expired nothing since 2026-09-08.
    -- Every other reader uses COALESCE(...,0) > 0 (2026-09-10, C-stuck-spins D3).
    IF v_current.variant IS DISTINCT FROM 'spin'
       OR v_current.status NOT IN ('REGISTERING','ANNOUNCED')
       OR v_current.status IS NULL OR v_current.started_at IS NOT NULL
       OR v_current.live_seats >= v_current.max_players
       OR NOT v_current.has_expired_waiter
       OR COALESCE(v_current.spin_multiplier, 0) > 0 OR v_current.has_booked_draw THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    BEGIN
      res := public.atomic_cancel_tournament(g.id, NULL);
      v_expired := v_expired + 1;
      v_refunded := v_refunded + (COALESCE(v_current.buy_in_amount, 0) * COALESCE(v_current.live_seats, 0));
      v_ids := v_ids || to_jsonb(g.id::text);
    EXCEPTION WHEN OTHERS THEN
      -- Loud, never fatal: one stuck game must not stop the rest being freed.
      v_failed := v_failed + 1;
      RAISE WARNING 'fn_spin_expire_unfilled: could not cancel %: %', g.id, SQLERRM;
    END;
    -- The counter derives from the seats either way (see 20260830110000).
    PERFORM public.fn_sync_seat_first_player_count(g.id);
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'expired', v_expired,
    'failed', v_failed,
    'skipped_raced', v_skipped,
    'chips_refunded_estimate', round(v_refunded, 2),
    'timeout_minutes', v_minutes,
    'tournament_ids', v_ids);
END;
$function$
$preimage$;
  v_post constant text := replace(v_pre,$old$  LOOP
    -- The scan is only a candidate list.$old$,$new$  LOOP
    -- Cancellation takes global settlement G -> B before the parent.
    -- Acquire the same lane here before any parent row lock; otherwise an
    -- expiry holding the parent can deadlock with a terminal lane owner.
    PERFORM public.fn_ca_lock_settlement_lane_global();
    -- The scan is only a candidate list.$new$);
  v_target text := CASE WHEN v_rollback THEN v_pre ELSE v_post END;
  v_actual text;
  v_metadata jsonb;
  v_dep jsonb;
  v_trigger jsonb;
  v_pass integer;
BEGIN
  IF v_oid IS NULL
     OR md5(v_pre) IS DISTINCT FROM 'cda7ea3e231248f1d2b597c74e04bb72'
     OR md5(v_post) IS DISTINCT FROM '84abf6526499efe148f770c5568ee26c'
     OR array_length(string_to_array(v_pre,$old$  LOOP
    -- The scan is only a candidate list.$old$),1) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'spin expiry lock order: exact image or target missing';
  END IF;
  v_actual:=pg_get_functiondef(v_oid);
  IF v_actual IS DISTINCT FROM v_pre AND v_actual IS DISTINCT FROM v_post THEN
    RAISE EXCEPTION 'spin expiry lock order: unsupported target drift';
  END IF;
  FOR v_pass IN 1..2 LOOP
    SELECT jsonb_build_object(
      'owner',pg_get_userbyid(p.proowner),'language',l.lanname,
      'prokind',p.prokind,'result_type',p.prorettype::regtype::text,
      'prosecdef',p.prosecdef,'proisstrict',p.proisstrict,'proretset',p.proretset,
      'proleakproof',p.proleakproof,'provolatile',p.provolatile,
      'proparallel',p.proparallel,'pronargs',p.pronargs,
      'pronargdefaults',p.pronargdefaults,'proconfig',p.proconfig,'proacl',p.proacl::text)
      INTO v_metadata FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=v_oid;
    IF v_metadata IS DISTINCT FROM $target_metadata${"owner":"postgres","language":"plpgsql","prokind":"f","result_type":"jsonb","prosecdef":true,"proisstrict":false,"proretset":false,"proleakproof":false,"provolatile":"v","proparallel":"u","pronargs":1,"pronargdefaults":1,"proconfig":["search_path=public, pg_temp"],"proacl":"{postgres=X/postgres,service_role=X/postgres}"}$target_metadata$::jsonb THEN
      RAISE EXCEPTION 'spin expiry lock order: target authority drift';
    END IF;
    FOR v_dep IN SELECT value FROM jsonb_array_elements($dependencies$[{"signature":"public.atomic_cancel_tournament(uuid,uuid)","md5":"6dac23baee41ff69ee0e1243f0a26c8e","metadata":{"owner":"postgres","language":"plpgsql","prokind":"f","result_type":"jsonb","prosecdef":true,"proisstrict":false,"proretset":false,"proleakproof":false,"provolatile":"v","proparallel":"u","pronargs":2,"pronargdefaults":0,"proconfig":["search_path=public, extensions, pg_temp","statement_timeout=120s"],"proacl":"{postgres=X/postgres,service_role=X/postgres}"}},{"signature":"public.fn_ca_lock_settlement_lane_global()","md5":"6b4cf15d9a7cd253e957e1571b300f40","metadata":{"owner":"postgres","language":"plpgsql","prokind":"f","result_type":"void","prosecdef":false,"proisstrict":false,"proretset":false,"proleakproof":false,"provolatile":"v","proparallel":"u","pronargs":0,"pronargdefaults":0,"proconfig":["search_path=public, pg_temp"],"proacl":"{postgres=X/postgres,service_role=X/postgres}"}},{"signature":"public.fn_sync_seat_first_player_count(uuid)","md5":"6ca19586d771591fb674d07e4b0c323c","metadata":{"owner":"postgres","language":"plpgsql","prokind":"f","result_type":"integer","prosecdef":true,"proisstrict":false,"proretset":false,"proleakproof":false,"provolatile":"v","proparallel":"u","pronargs":1,"pronargdefaults":0,"proconfig":["search_path=public, pg_temp"],"proacl":"{postgres=X/postgres}"}}]$dependencies$::jsonb) LOOP
      SELECT jsonb_build_object(
        'owner',pg_get_userbyid(p.proowner),'language',l.lanname,
        'prokind',p.prokind,'result_type',p.prorettype::regtype::text,
        'prosecdef',p.prosecdef,'proisstrict',p.proisstrict,'proretset',p.proretset,
        'proleakproof',p.proleakproof,'provolatile',p.provolatile,
        'proparallel',p.proparallel,'pronargs',p.pronargs,
        'pronargdefaults',p.pronargdefaults,'proconfig',p.proconfig,'proacl',p.proacl::text)
        INTO v_metadata FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
        WHERE p.oid=to_regprocedure(v_dep->>'signature')
          AND md5(pg_get_functiondef(p.oid))=v_dep->>'md5';
      IF v_metadata IS DISTINCT FROM v_dep->'metadata' THEN
        RAISE EXCEPTION 'spin expiry lock order: dependency drift %',v_dep->>'signature';
      END IF;
    END LOOP;
    IF NOT EXISTS(SELECT 1 FROM pg_proc p
      WHERE p.oid=to_regprocedure('public.fn_ca_guard_watchlist()')
        AND md5(pg_get_functiondef(p.oid))='92ee208d0887728444bda396d0b4d442'
        AND jsonb_build_object('owner',pg_get_userbyid(p.proowner),
          'prosecdef',p.prosecdef,'proisstrict',p.proisstrict,
          'provolatile',p.provolatile,'proparallel',p.proparallel,
          'proconfig',p.proconfig,'proacl',p.proacl::text)=$watch_metadata${"owner":"postgres","prosecdef":false,"proisstrict":false,"provolatile":"s","proparallel":"u","proconfig":["search_path=public"],"proacl":"{postgres=X/postgres,service_role=X/postgres}"}$watch_metadata$::jsonb)
      OR 'fn_spin_expire_unfilled'=ANY(public.fn_ca_guard_watchlist())
      OR EXISTS(SELECT 1 FROM public.ca_guard_defs WHERE proname IN (
        'fn_spin_expire_unfilled','atomic_cancel_tournament','fn_ca_lock_settlement_lane_global')) THEN
      RAISE EXCEPTION 'spin expiry lock order: explicit unwatchlisted baseline mode drift';
    END IF;
    -- Selected critical bindings only. Full transitive provider remains a
    -- separate admission prerequisite; this is not a whole-schema certificate.
    FOR v_trigger IN SELECT value FROM jsonb_array_elements($trigger_pins$[{"relation":"spin_draw_receipts","tgname":"spin_draw_receipt_is_immutable","tgenabled":"O","tgtype":27,"tgdeferrable":false,"tginitdeferred":false,"function":"trg_spin_draw_receipt_is_immutable()","function_md5":"b3e3935c8d7461f8116aedc11338a92d","definition":"CREATE TRIGGER spin_draw_receipt_is_immutable BEFORE DELETE OR UPDATE ON spin_draw_receipts FOR EACH ROW EXECUTE FUNCTION trg_spin_draw_receipt_is_immutable()"},{"relation":"table_seats","tgname":"aa_tournament_live_seat_proof_lock","tgenabled":"O","tgtype":31,"tgdeferrable":false,"tginitdeferred":false,"function":"trg_lock_and_validate_tournament_live_seat()","function_md5":"ddcd580bb32b2b953a5b45df5d29068e","definition":"CREATE TRIGGER aa_tournament_live_seat_proof_lock BEFORE INSERT OR DELETE OR UPDATE ON table_seats FOR EACH ROW EXECUTE FUNCTION trg_lock_and_validate_tournament_live_seat()"},{"relation":"table_seats","tgname":"cancelled_tournament_seat_is_immutable","tgenabled":"O","tgtype":31,"tgdeferrable":false,"tginitdeferred":false,"function":"fn_cancelled_tournament_seat_is_immutable()","function_md5":"97fd52cab28c046053764ece6e6a808a","definition":"CREATE TRIGGER cancelled_tournament_seat_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON table_seats FOR EACH ROW EXECUTE FUNCTION fn_cancelled_tournament_seat_is_immutable()"},{"relation":"tournament_cancellation_receipts","tgname":"tournament_cancellation_receipts_append_only","tgenabled":"O","tgtype":27,"tgdeferrable":false,"tginitdeferred":false,"function":"fn_tournament_cancellation_receipts_append_only()","function_md5":"fae27fa0a4d44ff04516e0bf069f6f9c","definition":"CREATE TRIGGER tournament_cancellation_receipts_append_only BEFORE DELETE OR UPDATE ON tournament_cancellation_receipts FOR EACH ROW EXECUTE FUNCTION fn_tournament_cancellation_receipts_append_only()"},{"relation":"tournament_players","tgname":"aa_tournament_player_launch_proof_lock","tgenabled":"O","tgtype":31,"tgdeferrable":false,"tginitdeferred":false,"function":"trg_lock_tournament_player_launch_proof()","function_md5":"74d26c6b61202e5f077c07379b58829e","definition":"CREATE TRIGGER aa_tournament_player_launch_proof_lock BEFORE INSERT OR DELETE OR UPDATE ON tournament_players FOR EACH ROW EXECUTE FUNCTION trg_lock_tournament_player_launch_proof()"},{"relation":"tournament_players","tgname":"cancelled_tournament_evidence_is_immutable","tgenabled":"O","tgtype":31,"tgdeferrable":false,"tginitdeferred":false,"function":"fn_cancelled_tournament_evidence_is_immutable()","function_md5":"55061034adb7416d401622572397c7d2","definition":"CREATE TRIGGER cancelled_tournament_evidence_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON tournament_players FOR EACH ROW EXECUTE FUNCTION fn_cancelled_tournament_evidence_is_immutable()"},{"relation":"tournaments","tgname":"cancelled_tournament_parent_is_immutable","tgenabled":"O","tgtype":27,"tgdeferrable":false,"tginitdeferred":false,"function":"fn_cancelled_tournament_parent_is_immutable()","function_md5":"45afe1986ef3e5a382aab017dcf3689c","definition":"CREATE TRIGGER cancelled_tournament_parent_is_immutable BEFORE DELETE OR UPDATE OF status, variant, tournament_type, satellite_target_id, satellite_target, satellite_seats, prize_pool, prize_pool_finalized, bounty_pool, bounty_pool_paid, is_bounty, is_pko, is_mystery_bounty, mystery_bounty_stage, mystery_bounty_pool_cents, club_id, ended_at, total_rake, current_players, on_break, break_started_at, break_ends_at ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_cancelled_tournament_parent_is_immutable()"},{"relation":"tournaments","tgname":"spin_tournament_contract_is_draw","tgenabled":"O","tgtype":19,"tgdeferrable":false,"tginitdeferred":false,"function":"fn_spin_tournament_contract_is_draw()","function_md5":"747fc99476b082256141d42003a6c478","definition":"CREATE TRIGGER spin_tournament_contract_is_draw BEFORE UPDATE OF spin_multiplier, prize_pool, spin_locked_tiers ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_spin_tournament_contract_is_draw()"},{"relation":"tournaments","tgname":"tournaments_cancel_must_refund","tgenabled":"O","tgtype":17,"tgdeferrable":true,"tginitdeferred":true,"function":"trg_tournaments_cancel_must_refund()","function_md5":"a4643c9ed980e3008369884e3ac2a96c","definition":"CREATE CONSTRAINT TRIGGER tournaments_cancel_must_refund AFTER UPDATE ON tournaments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((upper(COALESCE(new.status, ''::text)) = ANY (ARRAY['CANCELLED'::text, 'CANCELED'::text])) AND upper(COALESCE(old.status, ''::text)) IS DISTINCT FROM upper(COALESCE(new.status, ''::text))) EXECUTE FUNCTION trg_tournaments_cancel_must_refund()"},{"relation":"tournaments","tgname":"zzz_spin_ladder_is_the_drawn_one","tgenabled":"O","tgtype":23,"tgdeferrable":false,"tginitdeferred":false,"function":"fn_spin_ladder_is_the_drawn_one()","function_md5":"2a2786ee7663657383c4930c90842051","definition":"CREATE TRIGGER zzz_spin_ladder_is_the_drawn_one BEFORE INSERT OR UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_spin_ladder_is_the_drawn_one()"}]$trigger_pins$::jsonb) LOOP
      IF NOT EXISTS(SELECT 1 FROM pg_trigger t
        WHERE t.tgrelid=to_regclass('public.'||(v_trigger->>'relation'))
          AND t.tgname=v_trigger->>'tgname' AND NOT t.tgisinternal
          AND t.tgenabled::text=v_trigger->>'tgenabled'
          AND t.tgtype=(v_trigger->>'tgtype')::smallint
          AND t.tgdeferrable=(v_trigger->>'tgdeferrable')::boolean
          AND t.tginitdeferred=(v_trigger->>'tginitdeferred')::boolean
          AND t.tgfoid=to_regprocedure('public.'||(v_trigger->>'function'))
          AND md5(pg_get_functiondef(t.tgfoid))=v_trigger->>'function_md5'
          AND pg_get_triggerdef(t.oid,true)=v_trigger->>'definition') THEN
        RAISE EXCEPTION 'spin expiry lock order: critical binding drift %',v_trigger->>'tgname';
      END IF;
    END LOOP;
    IF v_pass=1 AND v_actual IS DISTINCT FROM v_target THEN EXECUTE v_target; END IF;
    IF pg_get_functiondef(v_oid) IS DISTINCT FROM v_target THEN
      RAISE EXCEPTION 'spin expiry lock order: exact target readback failed';
    END IF;
  END LOOP;
END;
$spin_expiry_lock_order$;

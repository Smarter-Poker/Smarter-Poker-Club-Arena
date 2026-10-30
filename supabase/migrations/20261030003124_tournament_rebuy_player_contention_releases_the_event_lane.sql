-- @live-proof: EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_horse_claim_due(integer)') AND md5(pg_get_functiondef(p.oid))='cc2313bee55c2149786824aae8d3b87e' AND p.proowner='postgres'::regrole AND NOT p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp'])
-- @live-proof: EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)') AND md5(pg_get_functiondef(p.oid))='2455d587b226b3a1f6c193c69f92b6de' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp','statement_timeout=30s'])
-- A reward claim must not convoy a whole tournament behind one player.
-- 2026-10-30 00:06: root log evidence tied a17.918-second existing horse claim
-- batch to profile FK wait, then rebuy exclusive-event wait and seven retained
-- hand timeouts. The event subsequently resumed; this is prevention, not a reset.
-- Preserve reward parity/selection/limits/financial authorities and canonical
-- event -> atomic-table -> global/admission -> table-cap -> mission -> profile order.
-- No cron, batch-size, deadline, financial amount, or receipt rule changes.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $dependencies$
BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)'::regprocedure)) IS DISTINCT FROM '687c04cf8d272256e48eac35135a95ba' THEN RAISE EXCEPTION 'lock dependency drift: fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)'; END IF;
 IF md5(pg_get_functiondef('public.fn_lock_daily_mission_user(uuid)'::regprocedure)) IS DISTINCT FROM '0e9d2905374930bda4529a8febc6eff6' THEN RAISE EXCEPTION 'lock dependency drift: fn_lock_daily_mission_user(uuid)'; END IF;
 IF md5(pg_get_functiondef('public.fn_ca_lock_mtt_admission_contract()'::regprocedure)) IS DISTINCT FROM '10644d522bb50245f76942ecce735cbc' THEN RAISE EXCEPTION 'lock dependency drift: fn_ca_lock_mtt_admission_contract()'; END IF;
 IF md5(pg_get_functiondef('public.fn_ca_tournament_unit_cents(uuid)'::regprocedure)) IS DISTINCT FROM '426ba550ff84f4210906a0071538803b' THEN RAISE EXCEPTION 'lock dependency drift: fn_ca_tournament_unit_cents(uuid)'; END IF;
 IF md5(pg_get_functiondef('public.fn_poker_diamond_tournament_custody_add(uuid,numeric,uuid)'::regprocedure)) IS DISTINCT FROM '25af87faee3db07b6dec956278eaa6bc' THEN RAISE EXCEPTION 'lock dependency drift: fn_poker_diamond_tournament_custody_add(uuid,numeric,uuid)'; END IF;
 IF md5(pg_get_functiondef('public.fn_poker_diamond_tournament_charge(uuid,uuid,text,numeric,numeric,numeric,numeric,uuid,text)'::regprocedure)) IS DISTINCT FROM '76d337b6b86734fb44db277d442afeb9' THEN RAISE EXCEPTION 'lock dependency drift: fn_poker_diamond_tournament_charge(uuid,uuid,text,numeric,numeric,numeric,numeric,uuid,text)'; END IF;
 IF md5(pg_get_functiondef('public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure)) IS DISTINCT FROM '30b96a6e6fe359d10e186c68a023c8fd' THEN RAISE EXCEPTION 'lock dependency drift: fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)'; END IF;
END $dependencies$;
DO $patch0$
DECLARE target oid := 'public.fn_ca_horse_claim_due(integer)'::regprocedure; before_def text; after_def text;
 before_owner oid; before_acl aclitem[]; before_config text[]; before_definer boolean;
 old_text text := $old0$    PERFORM 1 FROM public.profiles p WHERE p.id = r.user_id FOR UPDATE SKIP LOCKED;$old0$;
 new_text text := $new0$    PERFORM 1 FROM public.profiles p WHERE p.id = r.user_id FOR NO KEY UPDATE SKIP LOCKED;$new0$;
BEGIN
 SELECT pg_get_functiondef(oid),proowner,proacl,proconfig,prosecdef
 INTO before_def,before_owner,before_acl,before_config,before_definer FROM pg_proc WHERE oid=target;
 IF md5(before_def)<>'4207064ff1b6bd00f8fb9470e40e6c10' THEN RAISE EXCEPTION 'installed authority drift: public.fn_ca_horse_claim_due(integer)'; END IF;
 IF (length(before_def)-length(replace(before_def,old_text,'')))/length(old_text)<>1
 THEN RAISE EXCEPTION 'exact single change anchor unavailable'; END IF;
 EXECUTE replace(before_def,old_text,new_text);
 SELECT pg_get_functiondef(target) INTO after_def;
 IF replace(after_def,new_text,old_text)<>before_def OR EXISTS(
 SELECT 1 FROM pg_proc WHERE oid=target AND (proowner IS DISTINCT FROM before_owner
 OR proacl IS DISTINCT FROM before_acl OR proconfig IS DISTINCT FROM before_config
 OR prosecdef IS DISTINCT FROM before_definer))
 THEN RAISE EXCEPTION 'authority or unchanged source differs'; END IF;
END $patch0$;
DO $patch1$
DECLARE target oid := 'public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure; before_def text; after_def text;
 before_owner oid; before_acl aclitem[]; before_config text[]; before_definer boolean;
 old_text text := $old1$    v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
      p_tournament_id,NULL,p_user_id);$old1$;
 new_text text := $new1$    -- Preserve the complete acquisition order and refusal precedence before
    -- nonblocking player admission. The original helper reenters these locks.
    PERFORM pg_advisory_xact_lock_shared(530093);
    IF NOT EXISTS(SELECT 1 FROM public.ca_operator_floor_hold h JOIN public.ca_launch_operator_scopes m ON m.operation_id=h.operation_id JOIN public.tournaments t ON t.id=p_tournament_id WHERE h.mode='park' AND (t.club_id=ANY(m.club_ids) OR t.union_id=ANY(m.club_ids)) AND NOT EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=t.id AND tp.user_id=p_user_id)) THEN
      PERFORM pg_advisory_xact_lock_shared(530090,1);
      PERFORM public.fn_ca_lock_mtt_admission_contract();
      IF NOT public.fn_entry_purchases_frozen() THEN
        IF NOT pg_try_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0)) THEN
          RAISE EXCEPTION 'TOURNAMENT_PURCHASE_PLAYER_BUSY: retry this same purchase request'
            USING ERRCODE='55P03';
        END IF;
        IF NOT pg_try_advisory_xact_lock(hashtextextended('daily-missions-user:' || p_user_id::text, 0)) THEN
          RAISE EXCEPTION 'TOURNAMENT_PURCHASE_PLAYER_BUSY: retry this same purchase request'
            USING ERRCODE='55P03';
        END IF;
        IF public.fn_ca_tournament_unit_cents(p_tournament_id)=100 THEN
          -- Its existing custody-add later needs this strongest wallet mode.
          -- Admit it now or refuse before any held KEY SHARE can queue an upgrade.
          PERFORM 1 FROM public.profiles p WHERE p.id=p_user_id FOR UPDATE NOWAIT;
        ELSE
          PERFORM 1 FROM public.profiles p WHERE p.id=p_user_id FOR NO KEY UPDATE NOWAIT;
        END IF;
      END IF;
    END IF;
    v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
      p_tournament_id,NULL,p_user_id);$new1$;
 addon_old text := $addon_old$    v_response:=public.fn_ca_process_tournament_chip_purchase_money_v1(
      p_tournament_id,p_user_id,v_type,p_cost,p_chips,v_t.current_level,
      v_receipt_key);
    IF COALESCE((v_response->>'success')::boolean,false) IS NOT TRUE
       OR COALESCE((v_response->>'idempotent')::boolean,false) THEN
      RAISE EXCEPTION 'tournament add-on money core did not commit a new purchase'$addon_old$;
 addon_new text := $addon_new$    -- The Diamond charge's existing order is custody -> profile. Preserve it
    -- without holding the tournament lane behind an unrelated reward claim.
    -- Invalid/missing/closed custody and disabled arenas retain the original
    -- charge's exact refusal; this is only admission for its valid add-on path.
    IF public.fn_ca_tournament_unit_cents(p_tournament_id)=100
       AND v_t.union_id IS NULL
       AND EXISTS (SELECT 1 FROM public.ca_arena_settings a
         WHERE a.id=1 AND a.club_id=v_t.club_id AND a.tournaments_enabled)
       AND (SELECT count(*) FROM public.poker_diamond_custody c
         WHERE c.user_id=p_user_id AND c.purpose='tournament_entry'
           AND c.target_id=p_tournament_id AND c.state<>'released')=1
       AND EXISTS (SELECT 1 FROM public.poker_diamond_custody c
         WHERE c.user_id=p_user_id AND c.purpose='tournament_entry'
           AND c.target_id=p_tournament_id AND c.state='active') THEN
      PERFORM c.id FROM public.poker_diamond_custody c
       WHERE c.user_id=p_user_id AND c.purpose='tournament_entry'
         AND c.target_id=p_tournament_id AND c.state='active'
       FOR UPDATE NOWAIT;
      IF FOUND THEN
        PERFORM 1 FROM public.profiles p WHERE p.id=p_user_id FOR UPDATE NOWAIT;
      END IF;
    END IF;
    v_response:=public.fn_ca_process_tournament_chip_purchase_money_v1(
      p_tournament_id,p_user_id,v_type,p_cost,p_chips,v_t.current_level,
      v_receipt_key);
    IF COALESCE((v_response->>'success')::boolean,false) IS NOT TRUE
       OR COALESCE((v_response->>'idempotent')::boolean,false) THEN
      RAISE EXCEPTION 'tournament add-on money core did not commit a new purchase'$addon_new$;
BEGIN
 SELECT pg_get_functiondef(oid),proowner,proacl,proconfig,prosecdef
 INTO before_def,before_owner,before_acl,before_config,before_definer FROM pg_proc WHERE oid=target;
 IF md5(before_def)<>'64365f0f54dccb455d3c09ef09c234b9' THEN RAISE EXCEPTION 'installed authority drift: public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)'; END IF;
 IF (length(before_def)-length(replace(before_def,old_text,'')))/length(old_text)<>1
 THEN RAISE EXCEPTION 'exact single change anchor unavailable'; END IF;
 IF (length(before_def)-length(replace(before_def,addon_old,'')))/length(addon_old)<>1 THEN RAISE EXCEPTION 'exact addon change anchor unavailable'; END IF;
 EXECUTE replace(replace(before_def,old_text,new_text),addon_old,addon_new);
 SELECT pg_get_functiondef(target) INTO after_def;
 IF replace(replace(after_def,new_text,old_text),addon_new,addon_old)<>before_def OR EXISTS(
 SELECT 1 FROM pg_proc WHERE oid=target AND (proowner IS DISTINCT FROM before_owner
 OR proacl IS DISTINCT FROM before_acl OR proconfig IS DISTINCT FROM before_config
 OR prosecdef IS DISTINCT FROM before_definer))
 THEN RAISE EXCEPTION 'authority or unchanged source differs'; END IF;
END $patch1$;
COMMIT;

-- 20261002152207_new_clubs_open_complete_and_reset_to_zero
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-02 15:22:07 UTC.
--
-- A lifetime-first club was provisioned with cash/MTT/BBJ/Poker Spins, but
-- the generic club_wallets row was only backfilled in 2026-04 and was never
-- created for later clubs. Diamond games were also merely described as
-- acceptance-required: no enabled configurations existed for a new host.
-- Finally "Remove All Preloaded Games" retired cash/MTT rows while leaving
-- the funded Spin/SNG recurrence source and the two opening allocations live.
--
-- This prospective-only migration creates the canonical wallet at club
-- insertion, configures every Diamond game enabled for a welcome host while
-- preserving the independent immutable owner-consent gate, and supplies one
-- atomic pristine-package unwind used by both reset and club retirement. The
-- unwind transfers the exact BBJ and Spin principal back to the club treasury;
-- it never creates/destroys chips and never deletes financial or consent
-- history. Any play, registration, hand, contribution, payout, or changed
-- opening balance fails closed.

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

CREATE FUNCTION public.fn_create_canonical_club_wallet() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $function$
BEGIN
  INSERT INTO public.club_wallets(club_id) VALUES(NEW.id)
  ON CONFLICT(club_id) DO NOTHING;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_create_canonical_club_wallet() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_create_canonical_club_wallet() TO service_role;

DROP TRIGGER IF EXISTS trg_create_canonical_club_wallet ON public.clubs;
CREATE TRIGGER trg_create_canonical_club_wallet
AFTER INSERT ON public.clubs FOR EACH ROW
EXECUTE FUNCTION public.fn_create_canonical_club_wallet();

CREATE FUNCTION public.fn_configure_welcome_diamond_games() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $function$
DECLARE v_version integer; v_game text;
BEGIN
  -- Entitlement/receipt existence is the authority. This trigger cannot affect
  -- historical or ordinary clubs because it fires only for a welcome receipt.
  SELECT max(version) INTO v_version
    FROM public.wheel_segment_versions WHERE activated_at IS NOT NULL;
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'WELCOME_DIAMOND_WHEEL_HAS_NO_ACTIVE_SEGMENT_VERSION';
  END IF;

  INSERT INTO public.wheel_configs
    (host_id,host_kind,enabled,spin_price_diamonds,segment_version,
     purchased_only,allow_fixture_accounts,updated_by)
  VALUES(NEW.club_id,'club',true,100,v_version,false,false,NEW.actor_id)
  ON CONFLICT(host_id) DO UPDATE SET
    enabled=true, purchased_only=false, allow_fixture_accounts=false,
    updated_at=now(), updated_by=EXCLUDED.updated_by;
  INSERT INTO public.wheel_pools(host_id) VALUES(NEW.club_id)
  ON CONFLICT(host_id) DO NOTHING;

  FOREACH v_game IN ARRAY ARRAY['plinko','crash','crossing','mines'] LOOP
    INSERT INTO public.diamond_game_configs
      (host_id,game,host_kind,enabled,min_bet_diamonds,max_bet_diamonds,
       bet_options,purchased_only,allow_fixture_accounts,updated_by)
    VALUES(NEW.club_id,v_game,'club',true,25,5000,
      ARRAY[25,50,100,250,500,1000,2500,5000],false,false,NEW.actor_id)
    ON CONFLICT(host_id,game) DO UPDATE SET
      enabled=true,min_bet_diamonds=25,max_bet_diamonds=5000,
      bet_options=ARRAY[25,50,100,250,500,1000,2500,5000],
      purchased_only=false,allow_fixture_accounts=false,
      updated_at=now(),updated_by=EXCLUDED.updated_by;
    INSERT INTO public.diamond_game_pools(host_id,game)
    VALUES(NEW.club_id,v_game) ON CONFLICT(host_id,game) DO NOTHING;
  END LOOP;

  IF public.fn_diamond_spins_owner_agreed(NEW.club_id,'club') THEN
    RAISE EXCEPTION 'WELCOME_DIAMOND_CONSENT_MUST_BE_EXPLICIT_AND_POST_CREATE';
  END IF;

  -- Configuration is on by default; availability remains false until the
  -- owner creates the legally required receipt through owner_terms(...,true).
  -- Deliberately do not write diamond_spins_owner_consents here.
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_configure_welcome_diamond_games() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_configure_welcome_diamond_games() TO service_role;

DROP TRIGGER IF EXISTS trg_configure_welcome_diamond_games ON public.club_welcome_package_receipts;
CREATE TRIGGER trg_configure_welcome_diamond_games
AFTER INSERT ON public.club_welcome_package_receipts FOR EACH ROW
EXECUTE FUNCTION public.fn_configure_welcome_diamond_games();

-- Register the private conservation writer before the CREATE FUNCTION event
-- trigger examines it.
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES(
  'fn_unwind_unused_first_club_welcome_package','approved',
  'Private pristine welcome-package reversal. It returns the exact recorded BBJ and Spin opening principals to the club treasury under declared counterparties, retains every financial/consent receipt, and refuses after any use or economic drift.'
) ON CONFLICT(proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;

-- The existing tournament BEFORE INSERT trigger calls this function. Extend
-- its schedule fence to the Spin/SNG board source, so an engine insert and an
-- unwind serialize on the pool row and a board cannot appear after reset.
CREATE OR REPLACE FUNCTION public.fn_fence_welcome_package_schedule_spawn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $function$
DECLARE v_retired timestamptz; v_active boolean;
BEGIN
  IF NEW.schedule_id IS NOT NULL THEN
    SELECT i.retired_at INTO v_retired FROM public.club_welcome_package_items i
     WHERE i.entity_kind='tournament_schedule' AND i.entity_id=NEW.schedule_id
     FOR KEY SHARE;
    IF FOUND THEN
      SELECT s.active INTO v_active FROM public.tournament_schedules s
       WHERE s.id=NEW.schedule_id FOR KEY SHARE;
      IF NOT FOUND OR v_retired IS NOT NULL OR v_active IS NOT TRUE THEN
        RAISE EXCEPTION 'WELCOME_PACKAGE_SCHEDULE_RETIRED' USING ERRCODE='55000';
      END IF;
    END IF;
  END IF;
  IF NEW.club_id IS NOT NULL
     AND upper(COALESCE(NEW.tournament_type::text,'')) IN('SPIN','SNG')
     AND EXISTS(SELECT 1 FROM public.club_welcome_package_receipts r WHERE r.club_id=NEW.club_id) THEN
    SELECT p.is_active INTO v_active FROM public.spin_bonus_pools p
     WHERE p.club_id=NEW.club_id FOR KEY SHARE;
    IF NOT FOUND OR v_active IS NOT TRUE THEN
      RAISE EXCEPTION 'WELCOME_PACKAGE_SPIN_BOARD_RETIRED' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $function$;

CREATE FUNCTION public.fn_unwind_unused_first_club_welcome_package(
  p_club_id uuid,p_operation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $function$
DECLARE
  v_actor uuid:=COALESCE(auth.uid(),(SELECT actor_id FROM public.club_welcome_package_receipts WHERE club_id=p_club_id));
  v_prior public.club_welcome_reset_receipts%ROWTYPE;
  v_cash uuid[]:='{}'; v_schedules uuid[]:='{}'; v_tournaments uuid[]:='{}'; v_tables uuid[]:='{}';
  v_bbj public.bbj_pools%ROWTYPE; v_spin public.spin_bonus_pools%ROWTYPE;
  v_bbj_funding numeric; v_spin_funding numeric; v_after numeric; v_spin_result jsonb;
  v_saved jsonb; v_result jsonb;
BEGIN
  IF p_club_id IS NULL OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'WELCOME_UNWIND_REQUIRES_CLUB_AND_OPERATION';
  END IF;
  SELECT * INTO v_prior FROM public.club_welcome_reset_receipts
   WHERE operation_id=p_operation_id;
  IF FOUND THEN
    IF v_prior.club_id IS DISTINCT FROM p_club_id THEN
      RAISE EXCEPTION 'WELCOME_UNWIND_OPERATION_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_prior.result||jsonb_build_object('replayed',true);
  END IF;
  SELECT * INTO v_prior FROM public.club_welcome_reset_receipts
   WHERE club_id=p_club_id AND COALESCE((result->>'ok')::boolean,false) IS TRUE
   ORDER BY completed_at DESC LIMIT 1;
  IF FOUND THEN
    RETURN v_prior.result||jsonb_build_object('replayed',true,'requested_operation_id',p_operation_id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.club_welcome_package_receipts WHERE club_id=p_club_id) THEN
    RETURN jsonb_build_object('ok',true,'club_id',p_club_id,'reason','no_welcome_package','replayed',false);
  END IF;

  PERFORM public.fn_ca_lock_settlement_lane_global();
  PERFORM 1 FROM public.clubs WHERE id=p_club_id FOR UPDATE;
  PERFORM 1 FROM public.club_welcome_package_items
   WHERE club_id=p_club_id ORDER BY slot_key FOR UPDATE;
  SELECT amount INTO v_bbj_funding FROM public.club_welcome_package_funding
   WHERE club_id=p_club_id AND destination='bbj_main' FOR UPDATE;
  SELECT amount INTO v_spin_funding FROM public.club_welcome_package_funding
   WHERE club_id=p_club_id AND destination='spin_reserve' FOR UPDATE;
  SELECT * INTO v_bbj FROM public.bbj_pools WHERE club_id=p_club_id AND union_id IS NULL FOR UPDATE;
  SELECT * INTO v_spin FROM public.spin_bonus_pools WHERE club_id=p_club_id FOR UPDATE;
  SELECT COALESCE(array_agg(entity_id ORDER BY entity_id),'{}') INTO v_cash
    FROM public.club_welcome_package_items
   WHERE club_id=p_club_id AND entity_kind='cash_game' AND retired_at IS NULL;
  SELECT COALESCE(array_agg(entity_id ORDER BY entity_id),'{}') INTO v_schedules
    FROM public.club_welcome_package_items
   WHERE club_id=p_club_id AND entity_kind='tournament_schedule' AND retired_at IS NULL;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO v_tournaments
    FROM public.tournaments
   WHERE schedule_id=ANY(v_schedules)
      OR (club_id=p_club_id AND upper(COALESCE(tournament_type::text,'')) IN('SPIN','SNG'));
  SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO v_tables
    FROM public.tables WHERE cluster_id=ANY(v_cash) OR tournament_id=ANY(v_tournaments);

  PERFORM 1 FROM public.tournament_schedules WHERE id=ANY(v_schedules) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.cash_games WHERE id=ANY(v_cash) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.tournaments WHERE id=ANY(v_tournaments) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.tables WHERE id=ANY(v_tables) ORDER BY id FOR UPDATE;

  IF EXISTS(SELECT 1 FROM public.table_seats WHERE table_id=ANY(v_tables) AND left_at IS NULL)
     OR EXISTS(SELECT 1 FROM public.table_sessions WHERE table_id=ANY(v_tables) AND COALESCE(is_active,false) AND left_at IS NULL)
     OR EXISTS(SELECT 1 FROM public.table_waitlist WHERE table_id=ANY(v_tables) AND status IN('waiting','notified'))
     OR EXISTS(SELECT 1 FROM public.cash_game_waitlist WHERE game_id=ANY(v_cash) AND status IN('waiting','notified'))
     OR EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=ANY(v_tournaments))
     OR EXISTS(SELECT 1 FROM public.hand_history h LEFT JOIN public.tables t ON t.id=h.table_id
          WHERE h.tournament_id=ANY(v_tournaments) OR t.id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.cash_seat_moves WHERE game_id=ANY(v_cash))
     OR EXISTS(SELECT 1 FROM public.cash_seat_change_requests WHERE game_id=ANY(v_cash))
     OR EXISTS(SELECT 1 FROM public.managed_game_schedules WHERE status='executing' AND
          ((game_kind='tournament' AND game_id=ANY(v_tournaments)) OR
           (game_kind='table' AND game_id=ANY(v_tables)))) THEN
    RAISE EXCEPTION 'WELCOME_PACKAGE_HAS_PLAY_OR_REGISTRATION_HISTORY' USING ERRCODE='55000';
  END IF;

  IF v_bbj_funding IS DISTINCT FROM 100 OR v_spin_funding IS DISTINCT FROM 200
     OR v_bbj.id IS NULL OR v_bbj.main_balance IS DISTINCT FROM v_bbj_funding
     OR COALESCE(v_bbj.backup_balance,0)<>0 OR COALESCE(v_bbj.promo_balance,0)<>0
     OR COALESCE(v_bbj.total_contributed,0)<>0 OR COALESCE(v_bbj.total_paid_out,0)<>0
     OR COALESCE(v_bbj.hit_count,0)<>0
     OR EXISTS(SELECT 1 FROM public.bbj_contributions WHERE pool_id=v_bbj.id)
     OR EXISTS(SELECT 1 FROM public.bbj_payouts WHERE pool_id=v_bbj.id)
     OR EXISTS(SELECT 1 FROM public.bbj_promo_events WHERE pool_id=v_bbj.id)
     OR v_spin.id IS NULL OR v_spin.balance IS DISTINCT FROM v_spin_funding
     OR v_spin.seeded_amount IS DISTINCT FROM v_spin_funding THEN
    RAISE EXCEPTION 'WELCOME_PACKAGE_ECONOMICS_ARE_NOT_PRISTINE' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM public.wheel_pools WHERE host_id=p_club_id
      AND (spins<>0 OR intake_diamonds<>0 OR chips_minted<>0 OR chips_paid<>0 OR diamonds_paid<>0))
     OR EXISTS(SELECT 1 FROM public.diamond_game_pools WHERE host_id=p_club_id
      AND (rounds<>0 OR intake_diamonds<>0 OR chips_minted<>0 OR chips_paid<>0 OR reserved_chips<>0)) THEN
    RAISE EXCEPTION 'WELCOME_DIAMOND_GAMES_ARE_NOT_UNUSED' USING ERRCODE='55000';
  END IF;

  -- Stop every recurrence source before cancelling unused materializations.
  UPDATE public.spin_bonus_pools SET is_active=false,deactivated_at=now(),updated_at=now()
   WHERE club_id=p_club_id;
  UPDATE public.tournament_schedules SET active=false,updated_at=now() WHERE id=ANY(v_schedules);
  UPDATE public.wheel_configs SET enabled=false,updated_at=now(),updated_by=v_actor WHERE host_id=p_club_id;
  UPDATE public.diamond_game_configs SET enabled=false,updated_at=now(),updated_by=v_actor WHERE host_id=p_club_id;
  UPDATE public.clubs SET spins_enabled=false,bbj_enabled=false,bbj_rake_enabled=false,updated_at=now()
   WHERE id=p_club_id;

  PERFORM set_config('app.managed_game_lifecycle','on',true);
  UPDATE public.cash_games SET enabled=false,state='dormant',closed_at=COALESCE(closed_at,now()),
    closed_by=v_actor,updated_at=now() WHERE id=ANY(v_cash);
  UPDATE public.tournaments SET status='CANCELLED',ended_at=COALESCE(ended_at,now()),updated_at=now()
   WHERE id=ANY(v_tournaments) AND upper(COALESCE(status::text,'')) NOT IN('COMPLETED','CANCELLED','CANCELED');
  UPDATE public.tables SET status='closed',current_players=0,updated_at=now()
   WHERE id=ANY(v_tables) AND lower(COALESCE(status,'')) NOT IN('closed','completed','cancelled','finished');
  UPDATE public.managed_game_schedules SET status='cancelled',completed_at=now(),
    result=jsonb_build_object('ok',false,'reason','welcome_package_reset')
   WHERE status IN('scheduled','executing') AND
    ((game_kind='tournament' AND game_id=ANY(v_tournaments)) OR (game_kind='table' AND game_id=ANY(v_tables)));

  v_spin_result:=public.fn_spin_deactivate(p_club_id,v_actor);
  IF COALESCE((v_spin_result->>'seed_returned')::numeric,0) IS DISTINCT FROM v_spin_funding THEN
    RAISE EXCEPTION 'WELCOME_SPIN_SEED_RETURN_REFUSED';
  END IF;

  v_saved:=public.fn_ca_ledger_declaration_save(ARRAY['bbj_pools']);
  PERFORM public.fn_ca_declare_ledger('treasury_transfer','bbj_pool',v_bbj.id,
    NULL,NULL,ARRAY['bbj_pools']);
  v_after:=public.fn_spin_move_owner_wallet(p_club_id,'club','chip_treasury',v_bbj_funding);
  IF v_after IS NULL THEN RAISE EXCEPTION 'WELCOME_BBJ_RETURN_REFUSED'; END IF;
  INSERT INTO public.chip_transactions
    (id,club_id,amount,transaction_type,notes,balance_after,metadata)
  VALUES(gen_random_uuid(),p_club_id,v_bbj_funding,'bbj_promo_sweep',
    'Unused welcome-package BBJ principal returned to club treasury',v_after,
    jsonb_build_object('reason','welcome_package_reset','operation_id',p_operation_id,'pool_id',v_bbj.id));
  UPDATE public.bbj_pools SET main_balance=0,backup_balance=0,promo_balance=0,status='retired',updated_at=now()
   WHERE id=v_bbj.id;
  PERFORM public.fn_ca_ledger_declaration_restore(v_saved);

  UPDATE public.club_welcome_package_items SET retired_at=now(),reset_operation_id=p_operation_id
   WHERE club_id=p_club_id AND retired_at IS NULL;
  v_result:=jsonb_build_object('ok',true,'replayed',false,'club_id',p_club_id,
    'package_version','welcome-v1','operation_id',p_operation_id,'opening_grant_unwound',false,
    'returned_to_treasury',jsonb_build_object('bbj',v_bbj_funding,'spin',v_spin_funding),
    'removed',jsonb_build_object('cash_game_ids',to_jsonb(v_cash),'schedule_ids',to_jsonb(v_schedules),
      'tournament_ids',to_jsonb(v_tournaments),'table_ids',to_jsonb(v_tables)),
    'owner_acceptance_required',true,'owner_acceptance_receipts_preserved',true,
    'completed_at',transaction_timestamp());
  INSERT INTO public.club_welcome_reset_receipts(club_id,operation_id,actor_id,result)
  VALUES(p_club_id,p_operation_id,v_actor,v_result);
  RETURN v_result;
END $function$;
REVOKE ALL ON FUNCTION public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_unwind_unused_first_club_welcome_package(uuid,uuid) TO service_role;

DO $welcome_unwind_lane_review$
DECLARE
  v_oid oid:=to_regprocedure('public.fn_ca_settlement_lane_doctrine()');
  v_before text; v_after text; v_old text; v_new text; v_n integer; v_answer jsonb;
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'WELCOME_UNWIND_REQUIRES_SETTLEMENT_LANE_DOCTRINE'; END IF;
  v_before:=pg_get_functiondef(v_oid);
  v_old:=$x$'fn_remove_first_club_welcome_games'$x$;
  v_new:=$x$'fn_remove_first_club_welcome_games','fn_unwind_unused_first_club_welcome_package'$x$;
  v_n:=(length(v_before)-length(replace(v_before,v_old,'')))/length(v_old);
  IF v_n<>1 THEN RAISE EXCEPTION 'WELCOME_UNWIND_LANE_DOCTRINE_DRIFT: %',v_n; END IF;
  v_after:=replace(v_before,v_old,v_new);
  EXECUTE v_after;
  IF replace(pg_get_functiondef(v_oid),v_new,v_old) IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'WELCOME_UNWIND_LANE_DOCTRINE_REVERSE_SUBSTITUTION_FAILED';
  END IF;
  v_answer:=public.fn_ca_settlement_lane_doctrine();
  IF COALESCE((v_answer->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'WELCOME_UNWIND_SETTLEMENT_LANE_DOCTRINE_FAILED: %',v_answer->'violations';
  END IF;
END $welcome_unwind_lane_review$;

CREATE OR REPLACE FUNCTION public.fn_get_club_welcome_package_reset_impact(p_club_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $function$
DECLARE
  v_actor uuid:=auth.uid(); v_owner uuid; v_cash uuid[]:='{}'; v_schedules uuid[]:='{}';
  v_tournaments uuid[]:='{}'; v_tables uuid[]:='{}'; v_economics boolean:=false;
  v_seats integer:=0; v_sessions integer:=0; v_waiting integer:=0; v_moves integer:=0;
  v_registered integer:=0; v_running integer:=0; v_executing integer:=0; v_hands integer:=0;
BEGIN
  SELECT owner_id INTO v_owner FROM public.clubs WHERE id=p_club_id;
  IF v_actor IS NULL OR v_owner IS DISTINCT FROM v_actor THEN
    RETURN jsonb_build_object('ok',true,'club_id',p_club_id,'package_version','welcome-v1',
      'authorized',false,'can_reset',false,'reason','owner_only',
      'cash_game_ids','[]'::jsonb,'tournament_ids','[]'::jsonb,'schedule_ids','[]'::jsonb,
      'blocking',jsonb_build_object('active_seats',0,'open_sessions',0,'waiting_players',0,
        'pending_moves',0,'registered_players',0,'running_tournaments',0,'executing_commands',0,'hand_history',0),
      'removable',jsonb_build_object('cash_games',0,'tournaments',0,'tables',0,'schedules',0));
  END IF;
  SELECT COALESCE(array_agg(entity_id),'{}') INTO v_cash FROM public.club_welcome_package_items
   WHERE club_id=p_club_id AND entity_kind='cash_game' AND retired_at IS NULL;
  SELECT COALESCE(array_agg(entity_id),'{}') INTO v_schedules FROM public.club_welcome_package_items
   WHERE club_id=p_club_id AND entity_kind='tournament_schedule' AND retired_at IS NULL;
  SELECT COALESCE(array_agg(id),'{}') INTO v_tournaments FROM public.tournaments
   WHERE schedule_id=ANY(v_schedules) OR
    (club_id=p_club_id AND upper(COALESCE(tournament_type::text,'')) IN('SPIN','SNG'));
  SELECT COALESCE(array_agg(id),'{}') INTO v_tables FROM public.tables
   WHERE cluster_id=ANY(v_cash) OR tournament_id=ANY(v_tournaments);
  SELECT count(*) INTO v_seats FROM public.table_seats WHERE table_id=ANY(v_tables) AND left_at IS NULL;
  SELECT count(*) INTO v_sessions FROM public.table_sessions
   WHERE table_id=ANY(v_tables) AND COALESCE(is_active,false) AND left_at IS NULL;
  SELECT (SELECT count(*) FROM public.table_waitlist WHERE table_id=ANY(v_tables) AND status IN('waiting','notified'))+
         (SELECT count(*) FROM public.cash_game_waitlist WHERE game_id=ANY(v_cash) AND status IN('waiting','notified'))
    INTO v_waiting;
  SELECT (SELECT count(*) FROM public.cash_seat_moves WHERE game_id=ANY(v_cash))+
         (SELECT count(*) FROM public.cash_seat_change_requests WHERE game_id=ANY(v_cash)) INTO v_moves;
  SELECT count(*) INTO v_registered FROM public.tournament_players WHERE tournament_id=ANY(v_tournaments);
  SELECT count(*) INTO v_running FROM public.tournaments WHERE id=ANY(v_tournaments) AND
    (started_at IS NOT NULL OR upper(COALESCE(status::text,'')) IN('RUNNING','BREAK','COMPLETING'));
  SELECT count(*) INTO v_executing FROM public.managed_game_schedules WHERE status='executing' AND
    ((game_kind='tournament' AND game_id=ANY(v_tournaments)) OR (game_kind='table' AND game_id=ANY(v_tables)));
  SELECT count(*) INTO v_hands FROM public.hand_history h LEFT JOIN public.tables t ON t.id=h.table_id
   WHERE h.tournament_id=ANY(v_tournaments) OR t.id=ANY(v_tables);
  SELECT EXISTS(
    SELECT 1 FROM public.club_welcome_package_funding bf
    JOIN public.club_welcome_package_funding sf ON sf.club_id=bf.club_id AND sf.destination='spin_reserve'
    JOIN public.bbj_pools b ON b.club_id=bf.club_id AND b.union_id IS NULL
    JOIN public.spin_bonus_pools s ON s.club_id=bf.club_id
    WHERE bf.club_id=p_club_id AND bf.destination='bbj_main' AND bf.amount=100 AND sf.amount=200
      AND b.main_balance=100 AND COALESCE(b.backup_balance,0)=0 AND COALESCE(b.promo_balance,0)=0
      AND COALESCE(b.total_contributed,0)=0 AND COALESCE(b.total_paid_out,0)=0 AND COALESCE(b.hit_count,0)=0
      AND s.balance=200 AND s.seeded_amount=200
      AND NOT EXISTS(SELECT 1 FROM public.bbj_contributions WHERE pool_id=b.id)
      AND NOT EXISTS(SELECT 1 FROM public.bbj_payouts WHERE pool_id=b.id)
      AND NOT EXISTS(SELECT 1 FROM public.bbj_promo_events WHERE pool_id=b.id)
      AND NOT EXISTS(SELECT 1 FROM public.wheel_pools w WHERE w.host_id=p_club_id
        AND (w.spins<>0 OR w.intake_diamonds<>0 OR w.chips_minted<>0 OR w.chips_paid<>0 OR w.diamonds_paid<>0))
      AND NOT EXISTS(SELECT 1 FROM public.diamond_game_pools d WHERE d.host_id=p_club_id
        AND (d.rounds<>0 OR d.intake_diamonds<>0 OR d.chips_minted<>0 OR d.chips_paid<>0 OR d.reserved_chips<>0))
  ) INTO v_economics;
  RETURN jsonb_build_object('ok',true,'club_id',p_club_id,'package_version','welcome-v1',
    'authorized',true,'can_reset',(v_seats+v_sessions+v_waiting+v_moves+v_registered+v_running+v_executing+v_hands)=0 AND v_economics,
    'reason',CASE WHEN (v_seats+v_sessions+v_waiting+v_moves+v_registered+v_running+v_executing+v_hands)>0 THEN 'package_resources_in_use'
                  WHEN NOT v_economics THEN 'package_economics_not_pristine' END,
    'cash_game_ids',to_jsonb(v_cash),'schedule_ids',to_jsonb(v_schedules),
    'tournament_ids',to_jsonb(v_tournaments),
    'blocking',jsonb_build_object('active_seats',v_seats,'open_sessions',v_sessions,
      'waiting_players',v_waiting,'pending_moves',v_moves,'registered_players',v_registered,
      'running_tournaments',v_running,'executing_commands',v_executing,'hand_history',v_hands,
      'economics_pristine',v_economics),
    'removable',jsonb_build_object('cash_games',cardinality(v_cash),'schedules',cardinality(v_schedules),
      'tournaments',cardinality(v_tournaments),'tables',cardinality(v_tables),'bbj_seed',100,'spin_seed',200));
END $function$;
REVOKE ALL ON FUNCTION public.fn_get_club_welcome_package_reset_impact(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_get_club_welcome_package_reset_impact(uuid) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_remove_first_club_welcome_games(p_club_id uuid,p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $function$
DECLARE v_actor uuid:=auth.uid(); v_owner uuid;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok',false,'replayed',false,'club_id',p_club_id,'reason','authentication_required');
  END IF;
  SELECT owner_id INTO v_owner FROM public.clubs WHERE id=p_club_id;
  IF v_owner IS DISTINCT FROM v_actor THEN
    RETURN jsonb_build_object('ok',false,'replayed',false,'club_id',p_club_id,'reason','owner_only');
  END IF;
  RETURN public.fn_unwind_unused_first_club_welcome_package(p_club_id,p_operation_id);
EXCEPTION WHEN SQLSTATE '55000' THEN
  RETURN jsonb_build_object('ok',false,'replayed',false,'club_id',p_club_id,
    'reason',SQLERRM);
END $function$;
REVOKE ALL ON FUNCTION public.fn_remove_first_club_welcome_games(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_remove_first_club_welcome_games(uuid,uuid) TO authenticated,service_role;
COMMENT ON FUNCTION public.fn_unwind_unused_first_club_welcome_package(uuid,uuid) IS
  'Service-only idempotent pristine welcome-package reversal. Stops package recurrence and returns exact BBJ/Spin principal to treasury without deleting history or owner consent.';
COMMENT ON FUNCTION public.fn_remove_first_club_welcome_games(uuid,uuid) IS
  'Owner-only wrapper for the conserved pristine welcome-package zero-state reversal.';

COMMIT;

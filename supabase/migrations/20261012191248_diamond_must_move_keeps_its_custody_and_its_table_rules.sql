-- Compatible Diamond must-move writers. This file does not adopt live tables.
-- Install before the engine; adopt the existing ladder only after activation.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_plain_cash_table(p_t public.tables)
RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public','pg_temp'
AS $fn$
 SELECT NOT (
   NOT public.fn_poker_diamond_cash_variant(p_t.game_variant)
   OR p_t.tournament_id IS NOT NULL
   OR (p_t.cluster_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM public.cash_games g JOIN public.clubs c ON c.id=g.club_id
     WHERE g.id=p_t.cluster_id AND g.club_id=p_t.club_id
       AND c.asset='diamonds' AND c.is_platform AND c.union_id IS NULL
       AND g.union_id IS NULL AND p_t.union_id IS NULL AND g.must_move
       AND NOT g.lightning_enabled AND g.cluster_mode IN ('must_move','paused')
       AND g.variant=p_t.game_variant AND g.sb=p_t.small_blind AND g.bb=p_t.big_blind
       AND p_t.role IN ('main','feeder') AND p_t.lifecycle IN ('opening','live','breaking')
       AND (p_t.role='feeder' OR p_t.main_index>0)
   ))
   OR (p_t.cluster_id IS NULL AND p_t.lifecycle IS NOT NULL)
   OR coalesce(p_t.is_template,false)
   OR p_t.status NOT IN ('waiting','running','playing','active')
   OR p_t.rake_percent IS DISTINCT FROM 0 OR p_t.rake_cap_bb IS DISTINCT FROM 0
   OR p_t.bbj_percent IS DISTINCT FROM 0 OR coalesce(p_t.insurance_enabled,false)
   OR p_t.run_it_twice IS NULL OR p_t.allow_run_it_twice IS NULL
   OR coalesce(p_t.seven_deuce_enabled,false) OR coalesce(p_t.nit_game,false)
   OR coalesce(p_t.all_in_or_fold,false) OR coalesce(p_t.pineapple_holdem,false)
   OR coalesce(p_t.cap_enabled,false)
 );
$fn$;

-- Same settled-lot/debt policy as the authoritative reservation. No reservation,
-- wallet debit or purchase-lot mutation occurs while deciding whether to hold.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_wallet_covers(
 p_user_id uuid,p_table_id uuid,p_amount numeric)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $fn$
 SELECT coalesce((SELECT p_amount>0 AND p_amount=trunc(p_amount)
   AND p.diamonds IS NOT NULL AND p.diamonds-coalesce((
     SELECT sum(greatest(l.issued-l.consumed-l.refunded-l.arena_reserved,0))
     FROM public.diamond_purchase_lots l WHERE l.user_id=p.id
       AND (l.frozen_at IS NOT NULL OR l.created_at>now()-make_interval(days=>a.settlement_window_days))
   ),0)>=p_amount
   AND NOT EXISTS(SELECT 1 FROM public.diamond_debts d
     WHERE d.user_id=p.id AND d.settled_at IS NULL AND d.amount>0)
   FROM public.profiles p JOIN public.tables t ON t.id=p_table_id
   JOIN public.clubs c ON c.id=t.club_id
   JOIN public.ca_arena_settings a ON a.id=1 AND a.club_id=c.id
   WHERE p.id=p_user_id AND c.asset='diamonds' AND c.is_platform
     AND c.union_id IS NULL AND t.union_id IS NULL AND a.cash_games_enabled
     AND a.settlement_window_days IS NOT NULL),false);
$fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_wallet_covers(uuid,uuid,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_wallet_covers(uuid,uuid,numeric) TO service_role;

-- A game's declared Diamond table projection is the same source for its first
-- table, feeder spawning and subsequent ticks. The existing controller owns
-- when/where capacity changes. This helper owns no timer or second controller.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_project_cluster(
 p_game_id uuid,p_table_id uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $fn$
DECLARE g public.cash_games%ROWTYPE; cfg public.tables%ROWTYPE; n integer;
BEGIN
 SELECT cg.* INTO g FROM public.cash_games cg JOIN public.clubs c ON c.id=cg.club_id
 WHERE cg.id=p_game_id AND c.asset='diamonds' AND c.is_platform
   AND c.union_id IS NULL AND cg.union_id IS NULL AND cg.must_move
   AND NOT cg.lightning_enabled AND cg.cluster_mode IN ('must_move','paused') FOR UPDATE OF cg;
 IF NOT FOUND THEN RAISE EXCEPTION 'diamond_cluster_scope_required' USING ERRCODE='23514'; END IF;
 IF jsonb_typeof(g.ruleset_snapshot->'diamond_table') IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'diamond_cluster_projection_required' USING ERRCODE='23514';
 END IF;
 cfg:=jsonb_populate_record(NULL::public.tables,g.ruleset_snapshot->'diamond_table');
 IF cfg.min_buy_in IS NULL OR cfg.max_buy_in IS NULL
   OR cfg.min_buy_in<g.bb OR cfg.max_buy_in<cfg.min_buy_in
   OR cfg.min_buy_in<>trunc(cfg.min_buy_in) OR cfg.max_buy_in<>trunc(cfg.max_buy_in)
   OR cfg.max_buy_in>2147483647 OR g.sb<>trunc(g.sb) OR g.bb<>trunc(g.bb)
   OR g.sb<=0 OR g.bb<g.sb OR g.handedness NOT BETWEEN 2 AND 9
   OR cfg.rake_percent IS DISTINCT FROM 0 OR cfg.rake_cap_bb IS DISTINCT FROM 0
   OR cfg.bbj_percent IS DISTINCT FROM 0 OR cfg.run_it_twice IS NULL
   OR cfg.allow_run_it_twice IS NULL OR coalesce(cfg.insurance_enabled,false)
   OR coalesce(cfg.seven_deuce_enabled,false) OR coalesce(cfg.nit_game,false)
   OR coalesce(cfg.all_in_or_fold,false) OR coalesce(cfg.pineapple_holdem,false)
   OR coalesce(cfg.cap_enabled,false)
   OR NOT public.fn_poker_diamond_cash_variant(g.variant)
   OR coalesce(cfg.ante,0)<0 OR coalesce(cfg.ante,0)<>trunc(coalesce(cfg.ante,0))
   OR (coalesce(cfg.bomb_pot_enabled,false) AND (
      lower(coalesce(cfg.bomb_pot_variant,'')) NOT IN ('',g.variant)
      OR coalesce(cfg.bomb_pot_ante_fixed,g.bb*coalesce(cfg.bomb_pot_ante_multiplier,2))<=0
      OR coalesce(cfg.bomb_pot_ante_fixed,g.bb*coalesce(cfg.bomb_pot_ante_multiplier,2))<>
         trunc(coalesce(cfg.bomb_pot_ante_fixed,g.bb*coalesce(cfg.bomb_pot_ante_multiplier,2)))
   )) THEN
  RAISE EXCEPTION 'diamond_cluster_projection_invalid' USING ERRCODE='23514';
 END IF;
 UPDATE public.tables t SET
  small_blind=g.sb,big_blind=g.bb,game_variant=g.variant,
  min_buy_in=cfg.min_buy_in,max_buy_in=cfg.max_buy_in,
  max_players=greatest(g.handedness,coalesce((SELECT max(s.seat_number)
    FROM public.table_seats s WHERE s.table_id=t.id AND s.left_at IS NULL),0)),
  rake_percent=0,rake_cap_bb=0,bbj_percent=0,
  insurance_enabled=false,seven_deuce_enabled=false,nit_game=false,
  all_in_or_fold=false,pineapple_holdem=false,cap_enabled=false,
  run_it_twice=cfg.run_it_twice,allow_run_it_twice=cfg.allow_run_it_twice,
  run_it_twice_enabled=coalesce(cfg.run_it_twice_enabled,false),run_it_mode=cfg.run_it_mode,
  straddle_enabled=coalesce(cfg.straddle_enabled,false),
  auto_utg_straddle=coalesce(cfg.auto_utg_straddle,false),voluntary_straddle=coalesce(cfg.voluntary_straddle,false),
  ante=coalesce(cfg.ante,0),ante_enabled=coalesce(cfg.ante_enabled,false),
  big_blind_ante_enabled=coalesce(cfg.big_blind_ante_enabled,false),
  bomb_pot_enabled=coalesce(cfg.bomb_pot_enabled,false),bomb_pot_variant=cfg.bomb_pot_variant,
  bomb_pot_ante_fixed=cfg.bomb_pot_ante_fixed,bomb_pot_ante_multiplier=cfg.bomb_pot_ante_multiplier,
  bomb_pot_board_count=cfg.bomb_pot_board_count,bomb_pot_double_board=cfg.bomb_pot_double_board,
  bomb_pot_trigger_mode=cfg.bomb_pot_trigger_mode,bomb_pot_frequency=cfg.bomb_pot_frequency,
  bomb_pot_interval_seconds=cfg.bomb_pot_interval_seconds,
  action_time_seconds=coalesce(cfg.action_time_seconds,15),
  auto_extension=false,auto_restart=false,auto_create_table=false
 WHERE t.cluster_id=g.id AND t.lifecycle<>'closed' AND NOT coalesce(t.is_deleted,false)
   AND (p_table_id IS NULL OR t.id=p_table_id)
   AND (t.small_blind IS DISTINCT FROM g.sb OR t.big_blind IS DISTINCT FROM g.bb
     OR t.game_variant IS DISTINCT FROM g.variant
     OR t.max_players IS DISTINCT FROM greatest(g.handedness,coalesce((SELECT max(s.seat_number)
       FROM public.table_seats s WHERE s.table_id=t.id AND s.left_at IS NULL),0))
     OR EXISTS(SELECT 1 FROM jsonb_each(g.ruleset_snapshot->'diamond_table') setting
       WHERE to_jsonb(t)->setting.key IS DISTINCT FROM setting.value));
 GET DIAGNOSTICS n=ROW_COUNT;
 IF EXISTS(SELECT 1 FROM public.tables t WHERE t.cluster_id=g.id
   AND t.lifecycle<>'closed' AND NOT coalesce(t.is_deleted,false)
   AND NOT public.fn_poker_diamond_plain_cash_table(t)) THEN
  RAISE EXCEPTION 'diamond_cluster_table_not_admitted' USING ERRCODE='23514';
 END IF;
 RETURN n;
END;
$fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_project_cluster(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_project_cluster(uuid,uuid) TO service_role;

-- The existing staff creation door retains its validated prices and table ID;
-- attaching its freshly-created row is part of the SAME transaction. Future
-- staff-created ladder entries therefore receive the lifecycle too.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_attach_cash_game(p_table_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $fn$
DECLARE t public.tables%ROWTYPE; existing public.cash_games%ROWTYPE; g uuid; projection jsonb; snap jsonb;
 keys constant text[]:=ARRAY['min_buy_in','max_buy_in','rake_percent','rake_cap_bb','bbj_percent',
 'insurance_enabled','seven_deuce_enabled','nit_game','all_in_or_fold','pineapple_holdem','cap_enabled',
 'run_it_twice','allow_run_it_twice','run_it_twice_enabled','run_it_mode',
 'straddle_enabled','auto_utg_straddle','voluntary_straddle','ante','ante_enabled','big_blind_ante_enabled',
 'bomb_pot_enabled','bomb_pot_variant','bomb_pot_ante_fixed','bomb_pot_ante_multiplier',
 'bomb_pot_board_count','bomb_pot_double_board','bomb_pot_trigger_mode','bomb_pot_frequency',
 'bomb_pot_interval_seconds','action_time_seconds'];
BEGIN
 SELECT tb.* INTO t FROM public.tables tb JOIN public.ca_arena_settings a ON a.id=1 AND a.club_id=tb.club_id
   JOIN public.clubs c ON c.id=a.club_id WHERE tb.id=p_table_id AND c.asset='diamonds'
   AND c.is_platform AND c.union_id IS NULL AND tb.union_id IS NULL FOR UPDATE OF tb;
 IF NOT FOUND OR t.cluster_id IS NOT NULL OR NOT public.fn_poker_diamond_plain_cash_table(t) THEN
  RAISE EXCEPTION 'diamond_cluster_attach_scope' USING ERRCODE='23514';
 END IF;
 SELECT jsonb_object_agg(k,to_jsonb(t)->k) INTO projection FROM unnest(keys) k;
 snap:=public.fn_cash_template_defaults('classic',t.game_variant)
   ||jsonb_build_object('asset','diamonds','diamond_table',projection,
     'seats',t.max_players,'sb',t.small_blind,'bb',t.big_blind,'table_mode','must_move',
     'min_buyin_bb',ceil(t.min_buy_in/t.big_blind),'max_buyin_bb',floor(t.max_buy_in/t.big_blind),
     'resolved_at',to_jsonb(clock_timestamp()));
 SELECT * INTO existing FROM public.cash_games WHERE club_id=t.club_id
   AND variant=t.game_variant AND sb=t.small_blind AND bb=t.big_blind
   AND template_name='classic' AND must_move AND enabled FOR UPDATE;
 IF FOUND THEN
  IF existing.handedness IS DISTINCT FROM t.max_players
    OR existing.ruleset_snapshot->'diamond_table' IS DISTINCT FROM projection THEN
   RAISE EXCEPTION 'diamond_cluster_existing_projection_mismatch' USING ERRCODE='23514';
  END IF;
  g:=existing.id;
 ELSE
 INSERT INTO public.cash_games(club_id,union_id,name,template_name,variant,sb,bb,
   handedness,ruleset_snapshot,enabled,state,must_move,lightning_enabled,cluster_mode,created_by)
 VALUES(t.club_id,NULL,t.name,'classic',t.game_variant,t.small_blind,t.big_blind,
   t.max_players,snap,true,CASE WHEN t.current_players>0 THEN 'live' ELSE 'dormant' END,
   true,false,'must_move',auth.uid()) RETURNING id INTO g;
 END IF;
 UPDATE public.tables SET cluster_id=g,role=CASE WHEN existing.id IS NULL THEN 'main' ELSE 'feeder' END,
   main_index=CASE WHEN existing.id IS NULL THEN 1 END,lifecycle='live',
   opened_at=coalesce(opened_at,created_at),live_at=coalesce(live_at,created_at),
   auto_extension=false,auto_restart=false,auto_create_table=false WHERE id=t.id;
 INSERT INTO public.cash_game_roster(game_id,user_id,joined_at)
 SELECT g,user_id,min(joined_at) FROM public.table_seats WHERE table_id=t.id AND left_at IS NULL GROUP BY user_id
 ON CONFLICT(game_id,user_id) WHERE left_at IS NULL DO NOTHING;
 INSERT INTO public.cash_cluster_events(game_id,table_id,kind,payload)
 VALUES(g,t.id,'game_created',jsonb_build_object('asset','diamonds','adopted',true,'preserved_table_id',t.id));
 PERFORM public.fn_poker_diamond_project_cluster(g,t.id);
 RETURN g;
END;
$fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_attach_cash_game(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_attach_cash_game(uuid) TO service_role;

-- The existing executor owns both seat transition and receipt. Retargeting the
-- SAME custody row inside it preserves balance/entry identity/purchase lots.
-- Its deferred seat/custody constraint remains unchanged and verifies commit.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_move_custody(
 p_source public.table_seats,p_destination public.table_seats,p_game_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $fn$
DECLARE c public.poker_diamond_custody%ROWTYPE; n integer;
BEGIN
 IF NOT coalesce(public.fn_caller_is_engine(),false) THEN
  RAISE EXCEPTION 'Engine authority required' USING ERRCODE='42501';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs a ON a.id=t.club_id
   WHERE t.id=p_source.table_id AND a.asset='diamonds') THEN RETURN; END IF;
 IF p_source.user_id IS DISTINCT FROM p_destination.user_id
   OR p_source.stack IS DISTINCT FROM p_destination.stack
   OR p_source.occupancy_id=p_destination.occupancy_id
   OR NOT EXISTS(SELECT 1 FROM public.tables s JOIN public.tables d ON d.id=p_destination.table_id
      JOIN public.cash_games g ON g.id=p_game_id JOIN public.clubs a ON a.id=g.club_id
     WHERE s.id=p_source.table_id AND s.cluster_id=g.id AND d.cluster_id=g.id
       AND s.club_id=g.club_id AND d.club_id=g.club_id AND g.must_move
       AND a.asset='diamonds' AND a.is_platform AND a.union_id IS NULL
       AND s.union_id IS NULL AND d.union_id IS NULL AND g.union_id IS NULL
       AND s.tournament_id IS NULL AND d.tournament_id IS NULL)
 THEN RAISE EXCEPTION 'diamond_move_scope_mismatch' USING ERRCODE='23514'; END IF;
 SELECT * INTO c FROM public.poker_diamond_custody
 WHERE seat_id=p_source.id AND occupancy_id=p_source.occupancy_id
   AND seat_joined_at=p_source.joined_at AND user_id=p_source.user_id
   AND target_id=p_source.table_id AND arena_id=p_source.club_id
   AND purpose='cash_seat' AND state='active' AND balance=p_source.stack FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'diamond_move_custody_missing' USING ERRCODE='23514'; END IF;
 UPDATE public.poker_diamond_custody SET target_id=p_destination.table_id,
  seat_id=p_destination.id,seat_joined_at=p_destination.joined_at,
  occupancy_id=p_destination.occupancy_id WHERE id=c.id AND state='active';
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'diamond_move_custody_not_retargeted' USING ERRCODE='23514'; END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_move_custody(public.table_seats,public.table_seats,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_move_custody(public.table_seats,public.table_seats,uuid) TO service_role;

-- Surgical changes preserve the current protected implementations and refuse
-- a changed source shape. No replay, silent default, or alternate writer.
DO $patch$
DECLARE signature text; old text; replacement text; definition text; hits integer;
BEGIN
 FOR signature,old,replacement IN SELECT * FROM (VALUES
  ('public.fn_ca_cash_wallet_covers(uuid,uuid,uuid,numeric)',
   $sql$    RETURN true;
  END IF;

  v_club := public.fn_seat_club_for_user$sql$,
   $sql$    RETURN public.fn_poker_diamond_wallet_covers(p_user_id,p_table_id,p_amount);
  END IF;

  v_club := public.fn_seat_club_for_user$sql$),
  ('public.fn_cash_game_join(uuid)',
   '  -- Booted for low VPIP:',
   $sql$  IF EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=g.club_id AND c.asset='diamonds') THEN
    IF NOT public.fn_caller_session_is_live() THEN
      RAISE EXCEPTION 'SESSION_REVOKED: sign in again to join this game' USING ERRCODE='28000';
    END IF;
  END IF;
  -- Booted for low VPIP:$sql$),
  ('public.fn_cash_game_join(uuid)',
   $sql$      RAISE EXCEPTION 'INSUFFICIENT_CHIPS:%', v_need$sql$,
   $sql$      IF EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=g.club_id AND c.asset='diamonds') THEN
        IF EXISTS(SELECT 1 FROM public.diamond_debts d WHERE d.user_id=v_uid
           AND d.settled_at IS NULL AND d.amount>0) THEN
          RAISE EXCEPTION 'diamond_debt_requires_settlement' USING ERRCODE='55000';
        END IF;
        RAISE EXCEPTION 'INSUFFICIENT_SETTLED_DIAMONDS:%',v_need
          USING ERRCODE='check_violation',HINT='Settle or add Diamonds through the Diamond Wallet, then join the game.';
      END IF;
      RAISE EXCEPTION 'INSUFFICIENT_CHIPS:%', v_need$sql$),
  ('public.fn_cash_apply_ruleset(uuid)',
   '  s := g.ruleset_snapshot;',
   $sql$  IF EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=g.club_id AND c.asset='diamonds') THEN
    RETURN public.fn_poker_diamond_project_cluster(g.id,NULL);
  END IF;
  s := g.ruleset_snapshot;$sql$),
  ('public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)',
   '  -- BORN HALTED IN A CLUSTER THAT IS NOT DEALING CASH',
   $sql$  IF EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=g.club_id AND c.asset='diamonds') THEN
    PERFORM public.fn_poker_diamond_project_cluster(g.id,v_table_id);
  END IF;

  -- BORN HALTED IN A CLUSTER THAT IS NOT DEALING CASH$sql$),
  ('public.fn_cash_seat_move_execute(uuid)',
   ' IF pm.id IS NOT NULL THEN' || E'\n  SELECT * INTO partner_destination',
   $sql$ PERFORM public.fn_poker_diamond_move_custody(source_row,destination,m.game_id);
 IF pm.id IS NOT NULL THEN
  SELECT * INTO partner_destination$sql$),
  ('public.fn_cash_seat_move_execute(uuid)',
   '  INSERT INTO public.cash_seat_move_receipts(move_id,player_id,game_id,club_id,from_table_id,',
   $sql$  PERFORM public.fn_poker_diamond_move_custody(partner_source,partner_destination,pm.game_id);
  INSERT INTO public.cash_seat_move_receipts(move_id,player_id,game_id,club_id,from_table_id,$sql$),
  ('public.fn_poker_diamond_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)',
   $sql$coalesce(lower(v_t.bomb_pot_variant),'') NOT IN ('','nlh')$sql$,
   $sql$coalesce(lower(v_t.bomb_pot_variant),'') NOT IN ('',v_t.game_variant)$sql$),
  ('public.fn_poker_diamond_open_cash_table(text,integer,integer,integer,integer,integer,text)',
   '  RETURNING id INTO v_table;',
   $sql$  RETURNING id INTO v_table;
  -- The first ladder adoption is performed only after the engine is live.
  -- Until then the existing staff door retains its unclustered safe shape.
  IF EXISTS(SELECT 1 FROM public.cash_games WHERE club_id=v_arena AND must_move) THEN
    PERFORM public.fn_poker_diamond_attach_cash_game(v_table);
  END IF;$sql$)
 ) changes(signature,old,replacement)
 LOOP
  SELECT pg_get_functiondef(to_regprocedure(signature)) INTO definition;
  IF definition IS NULL THEN RAISE EXCEPTION 'diamond_must_move_missing: %',signature; END IF;
  hits:=(length(definition)-length(replace(definition,old,'')))/length(old);
  IF hits<>1 THEN RAISE EXCEPTION 'diamond_must_move_source_drift: %, % matches',signature,hits; END IF;
  EXECUTE replace(definition,old,replacement);
 END LOOP;
END;
$patch$;

-- A receipt's timestamp is the actual completed transfer time, after any lock
-- wait. Transaction-start now() can precede the final hand at the source.
DO $receipt_time$
DECLARE d text; needle text:='destination_occupancy_id,amount,receipt)';
BEGIN
 SELECT pg_get_functiondef('public.fn_cash_seat_move_execute(uuid)'::regprocedure) INTO d;
 IF (length(d)-length(replace(d,needle,'')))/length(needle)<>2
   OR d NOT LIKE '%partner_destination.occupancy_id,partner_source.stack,partner_outcome);%'
   OR d NOT LIKE '%destination.occupancy_id,source_row.stack,outcome);%' THEN
  RAISE EXCEPTION 'diamond_move_receipt_time_source_drift';
 END IF;
 d:=replace(d,needle,'destination_occupancy_id,amount,receipt,created_at)');
 d:=replace(d,'partner_destination.occupancy_id,partner_source.stack,partner_outcome);',
   'partner_destination.occupancy_id,partner_source.stack,partner_outcome,clock_timestamp());');
 d:=replace(d,'destination.occupancy_id,source_row.stack,outcome);',
   'destination.occupancy_id,source_row.stack,outcome,clock_timestamp());');
 EXECUTE d;
END;
$receipt_time$;

-- Existing Diamond staff doors keep their original authentication, live-session,
-- whole-value, custody and audit gates. Cluster policy changes take the game
-- lock before the table, and cannot edit/close a game with any player in it.
DO $staff$
DECLARE signature text; old text; replacement text; d text; hits integer;
BEGIN
 FOR signature,old,replacement IN SELECT * FROM (VALUES
  ('public.fn_poker_diamond_close_cash_table(uuid)',
   '  SELECT t.* INTO v_t FROM public.tables t',
   $sql$  PERFORM 1 FROM public.cash_games WHERE id=(SELECT cluster_id FROM public.tables WHERE id=p_table_id) FOR UPDATE;
  SELECT t.* INTO v_t FROM public.tables t$sql$),
  ('public.fn_poker_diamond_close_cash_table(uuid)',
   $sql$  UPDATE public.tables SET status='closed', current_players=0$sql$,
   $sql$  IF v_t.cluster_id IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
       WHERE t.cluster_id=v_t.cluster_id AND s.left_at IS NULL)
       OR EXISTS(SELECT 1 FROM public.poker_diamond_custody c JOIN public.tables t ON t.id=c.target_id
         WHERE t.cluster_id=v_t.cluster_id AND c.purpose='cash_seat' AND c.state<>'released') THEN
      RAISE EXCEPTION 'diamond_game_must_be_empty_to_close' USING ERRCODE='55000';
    END IF;
    UPDATE public.cash_games SET enabled=false,state='dormant',closed_at=clock_timestamp(),closed_by=v_actor
      WHERE id=v_t.cluster_id AND club_id=v_t.club_id;
    UPDATE public.tables SET status='closed',lifecycle='closed',current_players=0
      WHERE cluster_id=v_t.cluster_id;
  END IF;
  UPDATE public.tables SET status='closed', current_players=0$sql$),
  ('public.fn_poker_diamond_edit_cash_table(uuid,text,integer,integer,integer,integer,integer)',
   '  SELECT t.* INTO v_t FROM public.tables t',
   $sql$  PERFORM 1 FROM public.cash_games WHERE id=(SELECT cluster_id FROM public.tables WHERE id=p_table_id) FOR UPDATE;
  SELECT t.* INTO v_t FROM public.tables t$sql$),
  ('public.fn_poker_diamond_edit_cash_table(uuid,text,integer,integer,integer,integer,integer)',
   '  IF NOT public.fn_poker_diamond_plain_cash_table(v_after) THEN',
   $sql$  IF v_t.cluster_id IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
       WHERE t.cluster_id=v_t.cluster_id AND s.left_at IS NULL)
       OR EXISTS(SELECT 1 FROM public.poker_diamond_custody c JOIN public.tables t ON t.id=c.target_id
         WHERE t.cluster_id=v_t.cluster_id AND c.purpose='cash_seat' AND c.state<>'released') THEN
      RAISE EXCEPTION 'diamond_game_must_be_empty_to_edit' USING ERRCODE='55000';
    END IF;
    UPDATE public.cash_games SET name=v_after.name,sb=v_after.small_blind,bb=v_after.big_blind,
      handedness=v_after.max_players,ruleset_snapshot=ruleset_snapshot||jsonb_build_object(
        'sb',v_after.small_blind,'bb',v_after.big_blind,'seats',v_after.max_players,
        'min_buyin_bb',ceil(v_after.min_buy_in/v_after.big_blind),
        'max_buyin_bb',floor(v_after.max_buy_in/v_after.big_blind),
        'diamond_table',(ruleset_snapshot->'diamond_table')||jsonb_build_object(
          'min_buy_in',v_after.min_buy_in,'max_buy_in',v_after.max_buy_in))
      WHERE id=v_t.cluster_id AND club_id=v_t.club_id;
    PERFORM public.fn_poker_diamond_project_cluster(v_t.cluster_id,NULL);
  END IF;
  IF NOT public.fn_poker_diamond_plain_cash_table(v_after) THEN$sql$)
 ) changes(signature,old,replacement)
 LOOP
  SELECT pg_get_functiondef(to_regprocedure(signature)) INTO d;
  IF d IS NULL THEN RAISE EXCEPTION 'diamond_staff_cluster_missing: %',signature; END IF;
  hits:=(length(d)-length(replace(d,old,'')))/length(old);
  IF hits<>1 THEN RAISE EXCEPTION 'diamond_staff_cluster_source_drift: %, % matches',signature,hits; END IF;
  EXECUTE replace(d,old,replacement);
 END LOOP;
END;
$staff$;

COMMIT;

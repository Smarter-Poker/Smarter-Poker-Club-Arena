-- Both horse daily counts are projections of one accepted hand, once.
-- Function-only change; no locks on hot game tables and no historical rewrite.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
DO $preimage$
BEGIN
  IF md5(pg_get_functiondef('public.ca_project_hand_stats_facts(uuid)'::regprocedure))
      IS DISTINCT FROM 'a1cb10fc7d70197179861c09c6caa91c' THEN
    RAISE EXCEPTION 'horse daily counts: stats projector preimage changed';
  END IF;
END
$preimage$;

CREATE OR REPLACE FUNCTION public.ca_project_hand_stats_facts(p_hand_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_stats jsonb;
  v_hash text;
  v_existing_hash text;
  v_facts integer;
  v_transfers integer;
  v_table uuid;
  v_club uuid;
  v_tournament uuid;
  v_conflict jsonb;
  v_rollups jsonb;
  v_rollup_count integer;
  v_lightning boolean;
BEGIN
  IF current_user NOT IN ('postgres','service_role') THEN
    RAISE EXCEPTION 'ca_project_hand_stats_facts is engine/service only' USING ERRCODE='42501';
  END IF;

  -- A NULL hand is a service-only capability read, never a projection.
  -- Its marker is installed atomically with this owner body. The old owner
  -- returns stats_facts_unavailable without a marker, retaining old writers.
  IF p_hand_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','stats_facts_unavailable',
      'hand_id',NULL,'horse_daily_rollups_contract',1);
  END IF;

  SELECT c.post_commit_payload #> '{accepted_hand_facts,stats_facts}',
         c.table_id
    INTO v_stats, v_table
    FROM public.hand_atomic_commits c
   WHERE c.hand_id=p_hand_id
   FOR SHARE OF c;

  -- Rolling protocol-1 receipts predate the private payload. They remain
  -- explicitly unavailable; reconstruction is never invented.
  IF v_stats IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','stats_facts_unavailable','hand_id',p_hand_id);
  END IF;
  IF coalesce(v_stats->>'version','') NOT IN ('1','2')
     OR jsonb_typeof(v_stats->'facts') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_stats->'transfers') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'stats facts refused (invalid_payload_shape)';
  END IF;
  v_facts := jsonb_array_length(v_stats->'facts');
  v_transfers := jsonb_array_length(v_stats->'transfers');
  IF v_facts NOT BETWEEN 1 AND 10 OR v_transfers NOT BETWEEN 0 AND 90 THEN
    RAISE EXCEPTION 'stats facts refused (payload_bounds)';
  END IF;

  -- The accepted-hand receipt is the indefinite source. hand_history is a
  -- prunable replay surface and must not be required by reconciliation.
  -- Derive fact scope from the first validated nonempty payload row, then
  -- bind it to the immutable atomic table and its current owning club.
  SELECT (f->>'club_id')::uuid,
         nullif(f->>'tournament_id','')::uuid
    INTO v_club, v_tournament
    FROM jsonb_array_elements(v_stats->'facts') f
   LIMIT 1;
  IF v_table IS NULL OR v_club IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.tables t WHERE t.id=v_table AND t.club_id=v_club
  ) THEN
    RAISE EXCEPTION 'stats facts refused (atomic_table_scope)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_stats->'facts') f
     WHERE (f->>'hand_id')::uuid IS DISTINCT FROM p_hand_id
        OR (f->>'table_id')::uuid IS DISTINCT FROM v_table
        OR (f->>'club_id')::uuid IS DISTINCT FROM v_club
        OR COALESCE(f->>'tournament_id','') IS DISTINCT FROM COALESCE(v_tournament::text,'')
  ) OR (
    SELECT count(DISTINCT f->>'user_id') FROM jsonb_array_elements(v_stats->'facts') f
  ) IS DISTINCT FROM v_facts THEN
    RAISE EXCEPTION 'stats facts refused (scope_or_duplicate_player)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_stats->'transfers') x
     WHERE (x->>'hand_id')::uuid IS DISTINCT FROM p_hand_id
        OR (x->>'table_id')::uuid IS DISTINCT FROM v_table
        OR (x->>'club_id')::uuid IS DISTINCT FROM v_club
  ) THEN
    RAISE EXCEPTION 'stats facts refused (transfer_scope)';
  END IF;

  v_hash := encode(extensions.digest(convert_to(v_stats::text,'UTF8'),'sha256'),'hex');
  SELECT source_hash INTO v_existing_hash
    FROM public.ca_hand_fact_projection_receipts WHERE hand_id=p_hand_id FOR UPDATE;
  IF FOUND AND v_existing_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION 'stats facts refused (source_hash_conflict)';
  END IF;

  INSERT INTO public.ca_hand_facts (
    hand_id,user_id,club_id,table_id,tournament_id,played_at,game_variant,big_blind,
    seat,position,players_dealt,opponent_ids,hole_cards,hand_class,invested,returned,
    net,net_bb,rake_paid,vpip,pfr,three_bet,four_bet,faced_three_bet,
    folded_to_three_bet,had_cbet_flop_opp,cbet_flop,saw_flop,went_to_showdown,
    won_at_showdown,aggressive_actions,passive_actions,effective_stack_bb_at_deal,hero_in_position,aggressive_actions_preflop,passive_actions_preflop,aggressive_actions_flop,passive_actions_flop,aggressive_actions_turn,passive_actions_turn,aggressive_actions_river,passive_actions_river,three_bet_opportunity,four_bet_opportunity,steal_opportunity,stole,squeeze_opportunity,squeezed,blind_defense_opportunity,defended_blind,cbet_flop_opportunity,barrel_turn_opportunity,barreled_turn,barrel_river_opportunity,barreled_river,check_raise_opportunity,check_raised,donk_opportunity,donk_bet,probe_opportunity,probe_bet,was_all_in,all_in_street,
    all_in_at_risk,all_in_equity,ev_returned,ev_net,ev_net_bb,source_hash)
  SELECT f.hand_id,f.user_id,f.club_id,f.table_id,f.tournament_id,f.played_at,
         f.game_variant,f.big_blind,f.seat,f.position,f.players_dealt,f.opponent_ids,
         f.hole_cards,f.hand_class,f.invested,f.returned,f.net,f.net_bb,f.rake_paid,
         f.vpip,f.pfr,f.three_bet,f.four_bet,f.faced_three_bet,f.folded_to_three_bet,
         f.had_cbet_flop_opp,f.cbet_flop,f.saw_flop,f.went_to_showdown,
         f.won_at_showdown,f.aggressive_actions,f.passive_actions,f.effective_stack_bb_at_deal,f.hero_in_position,f.aggressive_actions_preflop,f.passive_actions_preflop,f.aggressive_actions_flop,f.passive_actions_flop,f.aggressive_actions_turn,f.passive_actions_turn,f.aggressive_actions_river,f.passive_actions_river,f.three_bet_opportunity,f.four_bet_opportunity,f.steal_opportunity,f.stole,f.squeeze_opportunity,f.squeezed,f.blind_defense_opportunity,f.defended_blind,f.cbet_flop_opportunity,f.barrel_turn_opportunity,f.barreled_turn,f.barrel_river_opportunity,f.barreled_river,f.check_raise_opportunity,f.check_raised,f.donk_opportunity,f.donk_bet,f.probe_opportunity,f.probe_bet,f.was_all_in,
         f.all_in_street,f.all_in_at_risk,f.all_in_equity,f.ev_returned,f.ev_net,
         f.ev_net_bb,v_hash
    FROM jsonb_populate_recordset(NULL::public.ca_hand_facts,v_stats->'facts') f
  ON CONFLICT (hand_id,user_id) DO UPDATE SET
    source_hash=EXCLUDED.source_hash,effective_stack_bb_at_deal=EXCLUDED.effective_stack_bb_at_deal,hero_in_position=EXCLUDED.hero_in_position,aggressive_actions_preflop=EXCLUDED.aggressive_actions_preflop,passive_actions_preflop=EXCLUDED.passive_actions_preflop,aggressive_actions_flop=EXCLUDED.aggressive_actions_flop,passive_actions_flop=EXCLUDED.passive_actions_flop,aggressive_actions_turn=EXCLUDED.aggressive_actions_turn,passive_actions_turn=EXCLUDED.passive_actions_turn,aggressive_actions_river=EXCLUDED.aggressive_actions_river,passive_actions_river=EXCLUDED.passive_actions_river,three_bet_opportunity=EXCLUDED.three_bet_opportunity,four_bet_opportunity=EXCLUDED.four_bet_opportunity,steal_opportunity=EXCLUDED.steal_opportunity,stole=EXCLUDED.stole,squeeze_opportunity=EXCLUDED.squeeze_opportunity,squeezed=EXCLUDED.squeezed,blind_defense_opportunity=EXCLUDED.blind_defense_opportunity,defended_blind=EXCLUDED.defended_blind,cbet_flop_opportunity=EXCLUDED.cbet_flop_opportunity,barrel_turn_opportunity=EXCLUDED.barrel_turn_opportunity,barreled_turn=EXCLUDED.barreled_turn,barrel_river_opportunity=EXCLUDED.barrel_river_opportunity,barreled_river=EXCLUDED.barreled_river,check_raise_opportunity=EXCLUDED.check_raise_opportunity,check_raised=EXCLUDED.check_raised,donk_opportunity=EXCLUDED.donk_opportunity,donk_bet=EXCLUDED.donk_bet,probe_opportunity=EXCLUDED.probe_opportunity,probe_bet=EXCLUDED.probe_bet
  WHERE ca_hand_facts.source_hash IS NULL
    AND ca_hand_facts.club_id IS NOT DISTINCT FROM EXCLUDED.club_id
    AND ca_hand_facts.table_id IS NOT DISTINCT FROM EXCLUDED.table_id
    AND ca_hand_facts.invested IS NOT DISTINCT FROM EXCLUDED.invested
    AND ca_hand_facts.returned IS NOT DISTINCT FROM EXCLUDED.returned
    AND ca_hand_facts.net IS NOT DISTINCT FROM EXCLUDED.net
    AND ca_hand_facts.rake_paid IS NOT DISTINCT FROM EXCLUDED.rake_paid;

  SELECT jsonb_build_object(
      'expected',expected-'created_at'-'source_hash'-'all_in_equity_owed',
      'actual',to_jsonb(actual)-'created_at'-'source_hash'-'all_in_equity_owed')
    INTO v_conflict
    FROM jsonb_array_elements(v_stats->'facts') expected
    LEFT JOIN public.ca_hand_facts actual
      ON actual.hand_id=(expected->>'hand_id')::uuid
     AND actual.user_id=(expected->>'user_id')::uuid
    WHERE actual.source_hash IS DISTINCT FROM v_hash
       OR actual.played_at IS DISTINCT FROM (expected->>'played_at')::timestamptz
       OR NOT (
         (to_jsonb(actual)-'created_at'-'source_hash'-'all_in_equity_owed'-'played_at')
         @>
         (expected-'created_at'-'source_hash'-'all_in_equity_owed'-'played_at')
       )
    LIMIT 1;
  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'stats facts refused (existing_fact_conflict)'
      USING DETAIL=v_conflict::text;
  END IF;

  INSERT INTO public.ca_hand_transfers
    (hand_id,winner_id,loser_id,amount,played_at,club_id,table_id)
  SELECT x.hand_id,x.winner_id,x.loser_id,x.amount,x.played_at,x.club_id,x.table_id
    FROM jsonb_populate_recordset(NULL::public.ca_hand_transfers,v_stats->'transfers') x
  ON CONFLICT (hand_id,winner_id,loser_id) DO NOTHING;

  v_conflict:=NULL;
  SELECT jsonb_build_object('expected',expected-'created_at',
      'actual',to_jsonb(actual)-'created_at')
    INTO v_conflict
    FROM jsonb_array_elements(v_stats->'transfers') expected
    LEFT JOIN public.ca_hand_transfers actual
      ON actual.hand_id=(expected->>'hand_id')::uuid
     AND actual.winner_id=(expected->>'winner_id')::uuid
     AND actual.loser_id=(expected->>'loser_id')::uuid
    WHERE actual.played_at IS DISTINCT FROM (expected->>'played_at')::timestamptz
       OR (to_jsonb(actual)-'created_at'-'played_at')
          IS DISTINCT FROM (expected-'created_at'-'played_at')
    LIMIT 1;
  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'stats facts refused (existing_transfer_conflict)'
      USING DETAIL=v_conflict::text;
  END IF;

  -- Optional on rolling engines; never reconstruct or replay the old buffers.
  v_rollups := v_stats->'horse_rollups';
  IF v_rollups IS NOT NULL THEN
    -- Durable hand identity, never a table's mutable current game scope.
    SELECT EXISTS(SELECT 1 FROM public.lightning_hand h
      WHERE h.hand_id=p_hand_id AND h.host_table_id=v_table) INTO v_lightning;
    IF v_rollups->>'version' IS DISTINCT FROM '1'
       OR jsonb_typeof(v_rollups->'nets') IS DISTINCT FROM 'array'
       OR jsonb_typeof(v_rollups->'play') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'horse rollups refused (payload_shape)';
    END IF;
    v_rollup_count := jsonb_array_length(v_rollups->'nets');
    IF v_rollup_count > v_facts OR jsonb_array_length(v_rollups->'play') <> v_rollup_count
       OR (SELECT count(DISTINCT n->>'horse_user_id') FROM jsonb_array_elements(v_rollups->'nets') n) <> v_rollup_count
       OR (SELECT count(DISTINCT p->>'horse_user_id') FROM jsonb_array_elements(v_rollups->'play') p) <> v_rollup_count THEN
      RAISE EXCEPTION 'horse rollups refused (population_bounds)';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_rollups->'nets') n
      LEFT JOIN LATERAL (SELECT p FROM jsonb_array_elements(v_rollups->'play') p
        WHERE p->>'horse_user_id'=n->>'horse_user_id') p ON true
      LEFT JOIN public.ca_hand_facts f ON f.hand_id=p_hand_id AND f.user_id=(n->>'horse_user_id')::uuid
      WHERE f.user_id IS NULL OR p.p IS NULL
        OR n->>'day' IS DISTINCT FROM p.p->>'day'
        OR (n->>'day')::date IS DISTINCT FROM (f.played_at AT TIME ZONE 'UTC')::date
        OR n->>'format' IS DISTINCT FROM p.p->>'format'
        OR n->>'format' IS DISTINCT FROM CASE WHEN v_lightning THEN
             'lightning_' || round(f.big_blind,2)::double precision::text || 'bb'
             WHEN f.tournament_id IS NOT NULL THEN 'tournament'
             WHEN f.players_dealt=2 THEN 'hu_cash' ELSE 'cash' END
        OR n->>'game_variant' IS DISTINCT FROM f.game_variant
        OR n->>'hands' IS DISTINCT FROM '1' OR p.p->>'hands' IS DISTINCT FROM '1'
        OR jsonb_typeof(p.p->'floored') IS DISTINCT FROM 'boolean'
        OR (n->>'net_bb')::numeric IS NULL OR NOT ((n->>'net_bb')::numeric BETWEEN -1e15 AND 1e15)
        OR abs((n->>'net_bb')::numeric - f.net / CASE WHEN f.big_blind>0 THEN f.big_blind ELSE 1 END)>0.0000001
        OR (n->>'rake_bb')::numeric IS NULL OR NOT ((n->>'rake_bb')::numeric BETWEEN 0 AND 1e15)
        OR abs((n->>'rake_bb')::numeric - f.rake_paid / CASE WHEN f.big_blind>0 THEN f.big_blind ELSE 1 END)>0.0000001
        OR (n->>'bbj_bb')::numeric IS NULL OR NOT ((n->>'bbj_bb')::numeric BETWEEN 0 AND 1e15)
    ) OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_rollups->'play') p,
        unnest(ARRAY['vpip','pfr','three_bets','three_bet_opps','open_raises',
          'faced_3bets','fold_to_3bets','saw_flop','won_when_saw_flop','post_aggr','post_passive']) k
      WHERE jsonb_typeof(p->k) IS DISTINCT FROM 'number'
         OR (p->>k)::integer NOT BETWEEN 0 AND 1000
    ) THEN
      RAISE EXCEPTION 'horse rollups refused (paired_fact_scope)';
    END IF;
  END IF;

  INSERT INTO public.ca_hand_fact_projection_receipts
    (hand_id,source_hash,fact_count,transfer_count)
  VALUES (p_hand_id,v_hash,v_facts,v_transfers)
  ON CONFLICT (hand_id) DO NOTHING;

  -- The existing source receipt arbitrates concurrent projections. Both
  -- aggregates and the claim commit together; a lost ACK or restart cannot
  -- add either one again. Any failure rolls back all three writes.
  IF FOUND AND v_rollups IS NOT NULL THEN
    PERFORM public.fn_horse_daily_nets_add(v_rollups->'nets');
    PERFORM public.fn_horse_daily_play_add(v_rollups->'play');
  END IF;

  RETURN jsonb_build_object('ok',true,'hand_id',p_hand_id,'source_hash',v_hash,
    'facts',v_facts,'transfers',v_transfers);
END
$function$
;

REVOKE ALL ON FUNCTION public.ca_project_hand_stats_facts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_project_hand_stats_facts(uuid) TO service_role;

COMMIT;

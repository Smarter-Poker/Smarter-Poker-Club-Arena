-- Version20261018163053 reserved by scripts/new-migration.mjs against main
-- and every remote branch. Union hosts are not player funding clubs.
-- Source facts, economic rules, caller authorization and ACLs are preserved.
-- @live-proof: position('funded_stats_scope' in pg_get_functiondef('public.ca_player_stats_overview_v2_by_club(uuid,integer,text,text,uuid)'::regprocedure))>0
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='45s';
DO $patch$
DECLARE r record; d text; original text; source text; selected_source text;
 return_at integer; changed integer:=0;
BEGIN
 -- This is the member-record witness contract, resolved in one joined read.
 -- Inline relational columns let PostgreSQL prune unused/retained-card fields;
 -- an opaque per-hand function or whole-row result made a busy history slow.
 source:=$source$
 WITH receipts AS MATERIALIZED (
  SELECT DISTINCT ON(table_id,account_entity_id,seat_joined_at)
   table_id,account_entity_id,seat_joined_at,funding_club_id
  FROM public.cash_participant_funding_receipts
  WHERE account_entity_id=__PLAYER__ AND operation_kind='buyin'
  ORDER BY table_id,account_entity_id,seat_joined_at,recorded_at DESC,id DESC
 ), funding AS MATERIALIZED (
  SELECT *,lead(seat_joined_at) OVER(PARTITION BY table_id,account_entity_id ORDER BY seat_joined_at) until_at
  FROM receipts
 )
 SELECT fact.*,coalesce(x.funding_club_id,tp.club_id,ra.club_id,fact.club_id) funded_club
 FROM public.ca_hand_facts fact
 LEFT JOIN funding x ON fact.tournament_id IS NULL AND x.table_id=fact.table_id
  AND fact.played_at>=x.seat_joined_at AND (x.until_at IS NULL OR fact.played_at<x.until_at)
 LEFT JOIN public.tournament_players tp ON tp.tournament_id=fact.tournament_id AND tp.user_id=fact.user_id
 LEFT JOIN public.rake_attributions ra ON x.funding_club_id IS NULL AND tp.club_id IS NULL
  AND ra.hand_id=fact.hand_id AND ra.player_id=fact.user_id
 WHERE fact.user_id=__PLAYER__
 $source$;
 FOR r IN SELECT p.oid,p.proname FROM pg_proc p
  WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY(ARRAY[
   'ca_player_stats_overview_v2_by_club','ca_player_ev_curve_by_club',
   'ca_player_hand_grid_by_club','ca_player_class_hands_by_club',
   'ca_player_rake_stats_by_club','ca_player_stats_pulse_by_club',
   'ca_player_nemesis_by_club','ca_player_hands_v2_by_club',
   'ca_player_stats_club_comparison','ca_player_stats_shared_overview_v1',
   'ca_player_stats_hand_evidence','ca_player_stats_hand_evidence_base'])
 LOOP
  original:=pg_get_functiondef(r.oid); d:=original;
  IF position('funded_stats_scope' in d)>0
  THEN RAISE EXCEPTION 'Funded Stats patch already present: %',r.proname; END IF;
  selected_source:=replace(source,'__PLAYER__',CASE
   WHEN r.proname='ca_player_stats_shared_overview_v1' THEN 'p_target_user'
   WHEN r.proname='ca_player_rake_stats_by_club' THEN 'v_uid' ELSE 'p_user' END);
  IF r.proname='ca_player_stats_overview_v2_by_club' THEN
   d:=regexp_replace(d,'  SELECT count\(\*\)::integer, min\(f.played_at\), max\(f.played_at\).*?WHERE f.user_id = p_user AND f.club_id = p_club_id;','', 's');
   d:=replace(d,'WITH filtered AS MATERIALIZED (',
    'WITH funded_stats_scope AS MATERIALIZED (SELECT user_id,played_at,tournament_id,game_variant,big_blind,position,invested,returned,net,net_bb,vpip,pfr,three_bet,faced_three_bet,folded_to_three_bet,had_cbet_flop_opp,cbet_flop,saw_flop,went_to_showdown,won_at_showdown,aggressive_actions,passive_actions,funded_club FROM ('||selected_source||') resolved), coverage_totals AS (SELECT count(*)::integer total,min(played_at) first_at,max(played_at) last_at FROM funded_stats_scope WHERE funded_club=p_club_id), filtered AS MATERIALIZED (');
   d:=regexp_replace(d,'FROM public\.ca_hand_facts f\M','FROM funded_stats_scope f','g');
   return_at:=position('  RETURN (' in d);
   IF return_at=0 THEN RAISE EXCEPTION 'Stats overview return anchor missing'; END IF;
   d:=left(d,return_at-1)||regexp_replace(regexp_replace(regexp_replace(substring(d from return_at), '\mv_lifetime\M','(SELECT total FROM coverage_totals)','g'),'\mv_first\M','(SELECT first_at FROM coverage_totals)','g'),'\mv_last\M','(SELECT last_at FROM coverage_totals)','g');
  ELSIF r.proname='ca_player_nemesis_by_club' THEN
   d:=replace(d,'WITH flows AS (','WITH funded_stats_scope AS MATERIALIZED (SELECT hand_id,user_id,played_at,opponent_ids,funded_club FROM ('||selected_source||') resolved), flows AS (');
   d:=regexp_replace(d,'FROM public\.ca_hand_facts f\M','FROM funded_stats_scope f','g');
   d:=replace(d,'FROM public.ca_hand_transfers','FROM public.ca_hand_transfers ht LEFT JOIN funded_stats_scope hf ON hf.hand_id=ht.hand_id');
   d:=replace(d,'AND club_id=p_club_id','AND coalesce(hf.funded_club,ht.club_id)=p_club_id');
   d:=replace(d,'OR played_at>=','OR ht.played_at>=');
  ELSE
   d:=regexp_replace(d,'FROM public\.ca_hand_facts f\M','FROM ('||selected_source||') f','g');
   IF r.proname IN ('ca_player_rake_stats_by_club','ca_player_stats_pulse_by_club') THEN
    d:=replace(d,'FROM public.ca_hand_facts WHERE','FROM ('||selected_source||') funded_stats_scope WHERE');
    d:=replace(d,'FROM public.ca_hand_facts'||chr(10),'FROM ('||selected_source||') funded_stats_scope'||chr(10));
    d:=regexp_replace(d,'AND club_id\s*=\s*p_club_id','AND funded_club=p_club_id','g');
    IF r.proname='ca_player_stats_pulse_by_club' THEN
     d:=replace(d,'SELECT max(played_at) INTO v_hand','SELECT played_at INTO v_hand');
     d:=replace(d,'WHERE user_id=p_user AND funded_club=p_club_id;',
      'WHERE user_id=p_user AND funded_club=p_club_id ORDER BY played_at DESC LIMIT 1;');
    END IF;
   END IF;
  END IF;
  -- Preserve column names in comparison and evidence records.
  d:=replace(d,'SELECT f.club_id,','SELECT f.funded_club AS club_id,');
  d:=replace(d,',f.club_id,',',f.funded_club AS club_id,');
  d:=regexp_replace(d,'\mf\.club_id\M','f.funded_club','g');
  d:=replace(d,'SELECT t.club_id,','SELECT coalesce(tp.club_id,t.club_id) AS club_id,');
  d:=regexp_replace(d,'\mt\.club_id\M','coalesce(tp.club_id,t.club_id)','g');
  d:=replace(d,'coalesce(tp.club_id,coalesce(tp.club_id,t.club_id))','coalesce(tp.club_id,t.club_id)');
  IF d=original THEN RAISE EXCEPTION 'Scoped Stats source anchor missing: %',r.proname; END IF;
  d:=replace(d,chr(10)||'BEGIN'||chr(10),chr(10)||'BEGIN'||chr(10)||'  -- funded_stats_scope: historical funding, original caller gates.'||chr(10));
  -- Full-history aggregates must not use a random position-index walk.
  -- The actual89k-hand overview measured13.76s after the joined repair,
  -- versus50.93s for the first broad joined plan. Give only these complete
  -- read aggregates a20s transaction budget; keyset/detail readers keep8s.
  IF r.proname IN ('ca_player_stats_overview_v2_by_club',
    'ca_player_stats_club_comparison','ca_player_stats_shared_overview_v1',
    'ca_player_nemesis_by_club') THEN
   d:=replace(d,' SET search_path TO ''public''',
    ' SET statement_timeout TO ''20s'''||chr(10)||' SET work_mem TO ''64MB'''||chr(10)||' SET enable_indexscan TO ''off'''||chr(10)||' SET search_path TO ''public''');
  END IF;
  EXECUTE d;
  changed:=changed+1;
 END LOOP;
 IF changed<11 THEN RAISE EXCEPTION 'Scoped Stats reader inventory incomplete: %',changed; END IF;
END $patch$;
COMMIT;

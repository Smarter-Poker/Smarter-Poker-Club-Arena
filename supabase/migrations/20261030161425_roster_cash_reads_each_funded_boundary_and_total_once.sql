-- Version reserved by scripts/new-migration.mjs.
-- 100-member roster cash reads timed out. Resolve the same two Chicago edge
-- ranges as one funded batch and compute each cash/MTT total exactly once.
-- Preserve all 100 input slots, roster ACLs, rounding, UTC bucket/Chicago DST,
-- latest buy-in seat/time/recorded/id ties, fallback club and launch cutoffs.
-- This writes no source/money/seat rows and changes no existing source helper.
-- The narrow RA cover avoids cold heap reads for the original hand/player
-- club fallback. Preserve the existing unique index and financial authority.
-- @live-proof: position('ca_club_members_cash_window' in pg_get_functiondef('public.ca_club_members_win_loss(uuid,uuid[],text)'::regprocedure))>0
-- @live-proof: (SELECT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid=to_regclass('public.rake_attributions_member_fact_club_cover'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS rake_attributions_member_fact_club_cover
 ON public.rake_attributions(hand_id,player_id) INCLUDE(club_id);
BEGIN;
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='1s';
SET LOCAL timezone='UTC';
CREATE TEMP TABLE roster_cash_install_before ON COMMIT DROP AS
SELECT to_jsonb(p)-'prosrc' metadata,smarter_private.original_inventory_basis_generation() generation,pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure) source_seal FROM pg_proc p
WHERE p.oid='public.ca_club_members_win_loss(uuid,uuid[],text)'::regprocedure;
DO $guard$DECLARE g text;seal text;BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres'
  OR nullif(current_setting('request.jwt.claims',true),'')IS NOT NULL
  OR nullif(current_setting('request.jwt.claim.role',true),'')IS NOT NULL
  OR nullif(current_setting('request.jwt.claim.sub',true),'')IS NOT NULL
 THEN RAISE EXCEPTION 'roster_cash_operator_refused';END IF;
 IF public.fn_ca_break_window_refuses_migrations(now())IS NOT NULL
  OR public.fn_platform_frozen()IS DISTINCT FROM false
  OR public.fn_active_maintenance_release_boundary()IS NOT NULL
 THEN RAISE EXCEPTION 'roster_cash_window_refused';END IF;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true
  OR smarter_private.original_inventory_basis_generation()IS NULL
 THEN RAISE EXCEPTION 'roster_cash_original_source_generation_required';END IF;
 IF to_regprocedure('public.ca_club_members_cash_window(uuid,uuid[],date,date)')IS NOT NULL
 THEN RAISE EXCEPTION 'roster_cash_helper_exists_or_replay';END IF;
 IF EXISTS(SELECT FROM(VALUES ('ca_club_member_chicago_cash(uuid,uuid,date,date)','82abafd6136f114a449c2aae9dc1dae6','{postgres=X/postgres}'),('ca_club_member_chicago_today_cash(uuid,uuid,timestamp with time zone)','06a865d12318b40786f3279090a5004e','{postgres=X/postgres}'),('ca_club_member_tournament_money(uuid,uuid,timestamp with time zone,timestamp with time zone)','cc6b93d3896cfbc643a9659401023d8e','{postgres=X/postgres,service_role=X/postgres}'),('ca_club_members_win_loss(uuid,uuid[],text)','7b540732a69268ec3ad64c7ab58c85c3','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),('ca_club_roster_access(uuid,uuid)','ddf66699cb1acfa08847428f64b51166','{postgres=X/postgres,service_role=X/postgres}'),('ca_member_record_daily_facts(uuid,uuid,date,date)','aaa18d36aa254de31a779741eea13861','{postgres=X/postgres}'),('fn_ca_launch_accounting_accepts(uuid,timestamp with time zone)','0f902b31908c9b6634635c1fab7363c4','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),('fn_ca_launch_accounting_cutoff(text,uuid)','cc3063873cf25be4b70e7cc893617c37','{postgres=X/postgres,service_role=X/postgres}'),('fn_member_record_fact_club(ca_hand_facts)','41f259351cb6f46ea7b6008c9f5aac32','{postgres=X/postgres}'))x(signature,body_md5,acl) LEFT JOIN pg_proc p ON p.oid=to_regprocedure(x.signature) WHERE p.oid IS NULL OR p.proowner<>'postgres'::regrole OR md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM x.body_md5 OR p.proacl::text IS DISTINCT FROM x.acl)THEN RAISE EXCEPTION 'roster_cash_source_preimage_changed';END IF;
 IF NOT EXISTS(SELECT FROM pg_class c WHERE c.oid='public.rake_attributions'::regclass AND c.relkind='r' AND c.relpersistence='p' AND c.relowner='postgres'::regrole AND c.relrowsecurity AND NOT c.relforcerowsecurity AND c.relacl::text='{postgres=arwdDxtm/postgres,anon=r/postgres,authenticated=r/postgres,service_role=arwdDxtm/postgres}')THEN RAISE EXCEPTION 'roster_cash_source_access_changed';END IF;
 IF(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid))ORDER BY a.attnum)FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.rake_attributions'::regclass AND a.attnum>0 AND NOT a.attisdropped)IS DISTINCT FROM '[{"name":"id","type":"uuid","default":"gen_random_uuid()","not_null":true},{"name":"hand_id","type":"uuid","default":null,"not_null":true},{"name":"player_id","type":"uuid","default":null,"not_null":true},{"name":"rake_amount","type":"numeric","default":null,"not_null":true},{"name":"agent_id","type":"uuid","default":null,"not_null":false},{"name":"created_at","type":"timestamp with time zone","default":"now()","not_null":true},{"name":"rake_record_id","type":"uuid","default":null,"not_null":false},{"name":"table_id","type":"uuid","default":null,"not_null":false},{"name":"club_id","type":"uuid","default":null,"not_null":false},{"name":"gross_contribution","type":"numeric","default":null,"not_null":false},{"name":"returned_uncalled","type":"numeric","default":"0","not_null":true},{"name":"eligible_contribution","type":"numeric","default":null,"not_null":false},{"name":"contribution_weight","type":"numeric","default":null,"not_null":false},{"name":"weighted_rake_credit","type":"numeric","default":null,"not_null":false},{"name":"bbj_attributed_contribution","type":"numeric","default":"0","not_null":true},{"name":"rake_method","type":"text","default":null,"not_null":false}]'::jsonb THEN RAISE EXCEPTION 'roster_cash_source_columns_changed';END IF;
 IF(SELECT jsonb_agg(jsonb_build_object('name',c.conname,'definition',pg_get_constraintdef(c.oid,true))ORDER BY c.conname)FROM pg_constraint c WHERE c.conrelid='public.rake_attributions'::regclass)IS DISTINCT FROM '[{"name":"chk_rake_amount_is_two_decimal_places","definition":"CHECK (rake_amount IS NULL OR rake_amount = round(rake_amount, 2))"},{"name":"ck_whole_cents","definition":"CHECK (created_at < ''2026-09-07 22:00:00+00''::timestamp with time zone OR rake_amount = round(rake_amount, 2) AND weighted_rake_credit = round(weighted_rake_credit, 2)) NOT VALID"},{"name":"rake_attributions_agent_id_fkey","definition":"FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL"},{"name":"rake_attributions_pkey","definition":"PRIMARY KEY (id)"},{"name":"rake_attributions_player_id_fkey","definition":"FOREIGN KEY (player_id) REFERENCES profiles(id) ON DELETE CASCADE"},{"name":"rake_attributions_rake_amount_check","definition":"CHECK (rake_amount >= 0::numeric)"}]'::jsonb THEN RAISE EXCEPTION 'roster_cash_source_constraints_changed';END IF;
 IF(SELECT jsonb_agg(pg_get_indexdef(i.indexrelid)ORDER BY pg_get_indexdef(i.indexrelid))FROM pg_index i WHERE i.indrelid='public.rake_attributions'::regclass AND i.indexrelid<>to_regclass('public.rake_attributions_member_fact_club_cover'))IS DISTINCT FROM '["CREATE INDEX idx_rake_attributions_agent_id_fk ON public.rake_attributions USING btree (agent_id) WHERE (agent_id IS NOT NULL)","CREATE INDEX idx_rake_attributions_club_created ON public.rake_attributions USING btree (club_id, created_at) INCLUDE (player_id, rake_amount)","CREATE INDEX idx_rake_attributions_hand_id ON public.rake_attributions USING btree (hand_id)","CREATE INDEX idx_rake_attributions_player_id ON public.rake_attributions USING btree (player_id, created_at DESC)","CREATE INDEX idx_rake_attributions_rake_record_id ON public.rake_attributions USING btree (rake_record_id)","CREATE INDEX idx_rake_attributions_union_gap_record_player ON public.rake_attributions USING btree (rake_record_id, player_id) INCLUDE (eligible_contribution) WHERE (eligible_contribution > (0)::numeric)","CREATE INDEX rake_attributions_club_record ON public.rake_attributions USING btree (club_id, rake_record_id) INCLUDE (player_id, weighted_rake_credit, hand_id)","CREATE INDEX rake_attributions_whole_hand_cover ON public.rake_attributions USING btree (rake_record_id) INCLUDE (id, hand_id, player_id, club_id, weighted_rake_credit)","CREATE UNIQUE INDEX rake_attributions_pkey ON public.rake_attributions USING btree (id)","CREATE UNIQUE INDEX uq_rake_attributions_hand_player ON public.rake_attributions USING btree (hand_id, player_id)"]'::jsonb OR EXISTS(SELECT FROM pg_index i WHERE i.indrelid='public.rake_attributions'::regclass AND(NOT i.indisvalid OR NOT i.indisready OR NOT i.indislive)) THEN RAISE EXCEPTION 'roster_cash_existing_indexes_changed';END IF;
 IF NOT EXISTS(SELECT FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am m ON m.oid=c.relam WHERE i.indexrelid=to_regclass('public.rake_attributions_member_fact_club_cover')AND i.indrelid='public.rake_attributions'::regclass AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion AND i.indnkeyatts=2 AND i.indnatts=3 AND i.indexprs IS NULL AND i.indpred IS NULL AND c.relowner='postgres'::regrole AND c.relkind='i'AND c.relpersistence='p' AND m.amname='btree'AND pg_get_indexdef(i.indexrelid)='CREATE INDEX rake_attributions_member_fact_club_cover ON public.rake_attributions USING btree (hand_id, player_id) INCLUDE (club_id)')THEN RAISE EXCEPTION 'roster_cash_exact_cover_required';END IF;
END$guard$;
CREATE FUNCTION public.ca_club_members_cash_window(
 p_club_id uuid,p_user_ids uuid[],p_from date,p_to date
) RETURNS TABLE(user_id uuid,cash_net numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public,pg_temp
AS $cash_window$
 WITH b AS MATERIALIZED (
  SELECT public.fn_ca_launch_accounting_cutoff('club',p_club_id) cutoff,
   (p_from IS NULL AND p_to IS NULL) overall,
   (p_from IS NULL AND p_to IS NULL) OR
    (p_from IS NOT NULL AND p_to IS NOT NULL AND p_to>p_from) valid,
   p_from::timestamp AT TIME ZONE 'UTC' us,
   p_from::timestamp AT TIME ZONE 'America/Chicago' cs,
   p_to::timestamp AT TIME ZONE 'America/Chicago' ce,
   (p_to+1)::timestamp AT TIME ZONE 'UTC' ue
 ), wanted AS MATERIALIZED (
  SELECT DISTINCT uid FROM unnest(coalesce(p_user_ids,ARRAY[]::uuid[])) uid WHERE uid IS NOT NULL
 ), daily AS MATERIALIZED (
  SELECT f.user_id uid,sum(f.net) net
  FROM wanted w JOIN public.member_record_daily_facts f ON f.user_id=w.uid CROSS JOIN b
  WHERE b.valid AND f.club_id=p_club_id AND NOT f.is_mtt
   AND f.accounting_cutoff IS NOT DISTINCT FROM b.cutoff
   AND (p_from IS NULL OR f.played_on>=p_from)
   AND (p_to IS NULL OR f.played_on<=p_to)
  GROUP BY f.user_id
 ), edges AS MATERIALIZED (
  SELECT f.user_id,f.table_id,f.hand_id,f.played_at,f.club_id,f.net
  FROM wanted w CROSS JOIN b
  CROSS JOIN LATERAL(VALUES(b.us,b.cs),(b.ce,b.ue)) edge(start_at,end_at)
  JOIN public.ca_hand_facts f ON f.user_id=w.uid
   AND f.played_at>=edge.start_at AND f.played_at<edge.end_at
  WHERE b.valid AND NOT b.overall AND f.tournament_id IS NULL
   AND CASE WHEN b.cutoff IS NULL THEN true ELSE
    f.played_at IS NOT NULL AND isfinite(f.played_at) AND f.played_at>=b.cutoff END
 ), occupancies AS MATERIALIZED (
  SELECT DISTINCT table_id,user_id FROM edges
 ), funding AS MATERIALIZED (
  SELECT DISTINCT ON(x.table_id,x.account_entity_id,x.seat_joined_at)
   x.table_id,x.account_entity_id,x.seat_joined_at,x.funding_club_id
  FROM public.cash_participant_funding_receipts x JOIN occupancies o
   ON o.table_id=x.table_id AND o.user_id=x.account_entity_id
  WHERE x.operation_kind='buyin'
  ORDER BY x.table_id,x.account_entity_id,x.seat_joined_at,x.recorded_at DESC,x.id DESC
 ), timeline AS MATERIALIZED (
  SELECT *,lead(seat_joined_at) OVER(
   PARTITION BY table_id,account_entity_id ORDER BY seat_joined_at) next_joined_at FROM funding
 ), resolved AS MATERIALIZED (
  SELECT f.*,x.funding_club_id FROM edges f
  LEFT JOIN timeline x ON x.table_id=f.table_id AND x.account_entity_id=f.user_id
   AND x.seat_joined_at<=f.played_at AND (x.next_joined_at IS NULL OR f.played_at<x.next_joined_at)
 ), unfunded AS MATERIALIZED (
  SELECT * FROM resolved WHERE funding_club_id IS NULL
 ), amounts AS (
  SELECT f.user_id uid,f.net FROM resolved f WHERE f.funding_club_id=p_club_id
  UNION ALL
  SELECT f.user_id uid,f.net FROM unfunded f
  LEFT JOIN public.rake_attributions ra ON ra.hand_id=f.hand_id AND ra.player_id=f.user_id
  WHERE coalesce(ra.club_id,f.club_id)=p_club_id
 ), removed AS MATERIALIZED (
  SELECT uid,sum(net) net FROM amounts GROUP BY uid
 )
 SELECT w.uid,coalesce(d.net,0)-coalesce(r.net,0)
 FROM wanted w LEFT JOIN daily d ON d.uid=w.uid LEFT JOIN removed r ON r.uid=w.uid;
$cash_window$;
REVOKE ALL ON FUNCTION public.ca_club_members_cash_window(uuid,uuid[],date,date)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.ca_club_members_win_loss(p_club_id uuid, p_user_ids uuid[], p_period text DEFAULT 'overall'::text)
 RETURNS TABLE(user_id uuid, cash numeric, mtt numeric, net numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_period text := lower(btrim(coalesce(p_period, 'overall')));
  v_chicago_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_from date;
  v_start timestamptz;
  v_end timestamptz := (v_chicago_today + 1)::timestamp AT TIME ZONE 'America/Chicago';
BEGIN
  IF v_period NOT IN ('today', 'week', 'month', 'overall') THEN
    RAISE EXCEPTION 'Invalid win loss period' USING ERRCODE = '22023';
  END IF;
  IF coalesce(cardinality(p_user_ids), 0) > 100 THEN
    RAISE EXCEPTION 'At most 100 members per call' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.club_member_daily_facts_state WHERE singleton AND initialized)
  THEN RAISE EXCEPTION 'Member daily facts are not initialized'; END IF;

  -- Every period except Overall begins at 12:00 AM Chicago.
  v_from := CASE v_period
    WHEN 'today' THEN v_chicago_today
    WHEN 'week' THEN date_trunc('week', v_chicago_today::timestamp)::date
    WHEN 'month' THEN date_trunc('month', v_chicago_today::timestamp)::date
    ELSE NULL END;
  v_start := v_from::timestamp AT TIME ZONE 'America/Chicago';

  RETURN QUERY
  WITH asked AS MATERIALIZED (
    SELECT DISTINCT u AS uid FROM unnest(coalesce(p_user_ids, ARRAY[]::uuid[])) u WHERE u IS NOT NULL
  ), allowed AS MATERIALIZED (
    SELECT a.uid FROM asked a
     WHERE public.ca_club_roster_access(p_club_id, a.uid) IN ('staff', 'downline', 'service')
  ), cash AS MATERIALIZED (
    SELECT c.user_id uid,c.cash_net FROM public.ca_club_members_cash_window(
      p_club_id,ARRAY(SELECT a.uid FROM allowed a),v_from,
      CASE WHEN v_from IS NULL THEN NULL ELSE v_chicago_today+1 END) c
  ), mtt AS MATERIALIZED (
    SELECT a.uid,public.ca_club_member_tournament_money(
      p_club_id,a.uid,CASE WHEN v_from IS NULL THEN NULL ELSE v_start END,
      CASE WHEN v_period='today' THEN v_end ELSE NULL END) mtt_net FROM allowed a
  )
  SELECT c.uid,round(c.cash_net,2),round(m.mtt_net,2),round(c.cash_net+m.mtt_net,2)
  FROM cash c JOIN mtt m ON m.uid=c.uid;
END;
$function$
;
DO $post$BEGIN
 IF(SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid='public.ca_club_members_win_loss(uuid,uuid[],text)'::regprocedure)
  IS DISTINCT FROM(SELECT metadata FROM roster_cash_install_before)
 THEN RAISE EXCEPTION 'roster_cash_reader_metadata_changed';END IF;
 IF md5(pg_get_functiondef('public.ca_club_members_win_loss(uuid,uuid[],text)'::regprocedure))IS DISTINCT FROM '2c02c3c5ab3cff998243a34de1cec02c' THEN RAISE EXCEPTION 'roster_cash_reader_postimage_changed';END IF;
 IF EXISTS(SELECT FROM(VALUES ('ca_club_member_chicago_cash(uuid,uuid,date,date)','82abafd6136f114a449c2aae9dc1dae6','{postgres=X/postgres}'),('ca_club_member_chicago_today_cash(uuid,uuid,timestamp with time zone)','06a865d12318b40786f3279090a5004e','{postgres=X/postgres}'),('ca_club_member_tournament_money(uuid,uuid,timestamp with time zone,timestamp with time zone)','cc6b93d3896cfbc643a9659401023d8e','{postgres=X/postgres,service_role=X/postgres}'),('ca_club_roster_access(uuid,uuid)','ddf66699cb1acfa08847428f64b51166','{postgres=X/postgres,service_role=X/postgres}'),('ca_member_record_daily_facts(uuid,uuid,date,date)','aaa18d36aa254de31a779741eea13861','{postgres=X/postgres}'),('fn_ca_launch_accounting_accepts(uuid,timestamp with time zone)','0f902b31908c9b6634635c1fab7363c4','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),('fn_ca_launch_accounting_cutoff(text,uuid)','cc3063873cf25be4b70e7cc893617c37','{postgres=X/postgres,service_role=X/postgres}'),('fn_member_record_fact_club(ca_hand_facts)','41f259351cb6f46ea7b6008c9f5aac32','{postgres=X/postgres}'))x(signature,body_md5,acl) LEFT JOIN pg_proc p ON p.oid=to_regprocedure(x.signature) WHERE p.oid IS NULL OR p.proowner<>'postgres'::regrole OR md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM x.body_md5 OR p.proacl::text IS DISTINCT FROM x.acl)THEN RAISE EXCEPTION 'roster_cash_original_helper_changed';END IF;
 IF has_function_privilege('anon','public.ca_club_members_cash_window(uuid,uuid[],date,date)','EXECUTE') OR has_function_privilege('authenticated','public.ca_club_members_cash_window(uuid,uuid[],date,date)','EXECUTE') OR has_function_privilege('service_role','public.ca_club_members_cash_window(uuid,uuid[],date,date)','EXECUTE')THEN RAISE EXCEPTION 'roster_cash_helper_exposed';END IF;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true OR smarter_private.original_inventory_basis_generation()IS DISTINCT FROM(SELECT generation FROM roster_cash_install_before) OR pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure)IS DISTINCT FROM(SELECT source_seal FROM roster_cash_install_before) THEN RAISE EXCEPTION 'roster_cash_original_source_changed';END IF;
END$post$;
COMMIT;

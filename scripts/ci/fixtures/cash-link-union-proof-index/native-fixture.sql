SET timezone='UTC';CREATE TABLE public.union_pnl_transaction_frames(transaction_id xid8 PRIMARY KEY);INSERT INTO public.union_pnl_transaction_frames VALUES('1');
CREATE TABLE public.union_pnl_cash_outcomes(table_id uuid NOT NULL,hand_number bigint NOT NULL,hand_id uuid NOT NULL,transaction_id xid8 NOT NULL,recognized_at timestamp with time zone NOT NULL,payload_hash text NOT NULL,game_scope jsonb NOT NULL,evidence jsonb NOT NULL,CONSTRAINT union_pnl_cash_outcomes_hand_id_key UNIQUE (hand_id),CONSTRAINT union_pnl_cash_outcomes_pkey PRIMARY KEY (table_id, hand_number),CONSTRAINT union_pnl_cash_outcomes_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES union_pnl_transaction_frames(transaction_id));
CREATE INDEX union_pnl_cash_outcomes_expr_recognized_at_idx ON public.union_pnl_cash_outcomes USING btree (((game_scope ->> 'game_union_id'::text)), recognized_at);
CREATE INDEX union_pnl_cash_outcomes_recognition_join_cover ON public.union_pnl_cash_outcomes USING btree (recognized_at) INCLUDE (table_id, hand_number);
CREATE INDEX union_pnl_cash_outcomes_unaccepted ON public.union_pnl_cash_outcomes USING btree (((game_scope ->> 'game_union_id'::text)), recognized_at) WHERE (((evidence ->> 'status'::text) IS DISTINCT FROM 'ready'::text) OR ((evidence -> 'basis_certified'::text) IS DISTINCT FROM 'true'::jsonb) OR ((evidence -> 'all_players_included'::text) IS DISTINCT FROM 'true'::jsonb) OR ((evidence -> 'game_scope'::text) IS DISTINCT FROM game_scope));
CREATE INDEX union_pnl_cash_outcomes_scope_missing ON public.union_pnl_cash_outcomes USING btree (recognized_at) WHERE (NOT (game_scope ?& ARRAY['game_union_id'::text, 'host_club_id'::text, 'tournament_id'::text, 'is_private'::text, 'asset'::text, 'unit_scale'::text]));
CREATE INDEX union_pnl_cash_outcomes_recognition_window ON public.union_pnl_cash_outcomes USING btree (recognized_at);
CREATE TABLE public.union_pnl_cash_outcome_link_resolutions(table_id uuid NOT NULL,hand_number bigint NOT NULL,hand_id uuid NOT NULL,outcome_payload_hash text NOT NULL,outcome_evidence_md5 text NOT NULL,roster_source text NOT NULL,manifest_id uuid,game_scope jsonb NOT NULL,evidence jsonb NOT NULL,proof jsonb NOT NULL,proof_md5 text NOT NULL,reason text NOT NULL,resolved_by text NOT NULL DEFAULT SESSION_USER,resolved_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),CONSTRAINT union_pnl_cash_outcome_link_resoluti_outcome_evidence_md5_check CHECK ((outcome_evidence_md5 ~ '^[0-9a-f]{32}$'::text)),CONSTRAINT union_pnl_cash_outcome_link_resolutions_check CHECK ((proof_md5 = md5((proof)::text))),CONSTRAINT union_pnl_cash_outcome_link_resolutions_check1 CHECK (((roster_source = 'manifest'::text) = (manifest_id IS NOT NULL))),CONSTRAINT union_pnl_cash_outcome_link_resolutions_check2 CHECK ((((proof ->> 'status'::text) = 'proven'::text) AND ((proof ->> 'resolution_kind'::text) = 'cash_outcome_provenance_link'::text) AND ((proof ->> 'table_id'::text) = (table_id)::text) AND (((proof ->> 'hand_number'::text))::bigint = hand_number) AND ((proof ->> 'hand_id'::text) = (hand_id)::text) AND ((proof ->> 'outcome_payload_hash'::text) = outcome_payload_hash) AND ((proof ->> 'outcome_evidence_md5'::text) = outcome_evidence_md5) AND ((proof ->> 'roster_source'::text) = roster_source) AND (NOT ((proof ->> 'manifest_id'::text) IS DISTINCT FROM (manifest_id)::text)) AND ((proof -> 'game_scope'::text) = game_scope) AND ((proof -> 'evidence'::text) = evidence) AND ((evidence -> 'game_scope'::text) = game_scope))),CONSTRAINT union_pnl_cash_outcome_link_resolutions_evidence_check CHECK (((jsonb_typeof(evidence) = 'object'::text) AND ((evidence ->> 'provenance_link'::text) = 'resolved'::text))),CONSTRAINT union_pnl_cash_outcome_link_resolutions_game_scope_check CHECK (((jsonb_typeof(game_scope) = 'object'::text) AND (game_scope ?& ARRAY['game_union_id'::text, 'host_club_id'::text, 'tournament_id'::text, 'is_private'::text, 'asset'::text, 'unit_scale'::text]))),CONSTRAINT union_pnl_cash_outcome_link_resolutions_hand_id_key UNIQUE (hand_id),CONSTRAINT union_pnl_cash_outcome_link_resolutions_pkey PRIMARY KEY (table_id, hand_number),CONSTRAINT union_pnl_cash_outcome_link_resolutions_reason_check CHECK ((length(btrim(reason)) >= 20)),CONSTRAINT union_pnl_cash_outcome_link_resolutions_roster_source_check CHECK ((roster_source = ANY (ARRAY['manifest'::text, 'seat_inventory'::text, 'lightning_pool'::text]))));
CREATE OR REPLACE FUNCTION public.fn_union_pnl_linked_cash_outcomes(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(table_id uuid, hand_number bigint, game_scope jsonb, evidence jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT r.table_id,r.hand_number,r.game_scope,r.evidence
 FROM public.union_pnl_cash_outcome_link_resolutions r
 JOIN public.union_pnl_cash_outcomes o ON o.table_id=r.table_id AND o.hand_number=r.hand_number
 WHERE r.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end
  AND r.hand_id=o.hand_id AND r.outcome_payload_hash=o.payload_hash AND r.outcome_evidence_md5=md5(o.evidence::text)
  AND r.proof_md5=md5(r.proof::text)
$function$
;
WITH a AS(SELECT n,md5(n::text)::uuid tid,md5(('hand'||n)::text)::uuid hid,jsonb_build_object('game_union_id',CASE WHEN n%100=0 THEN 'fade0000-0000-0000-0000-000000000001' ELSE 'other_union' END,'host_club_id',NULL,'tournament_id',NULL,'is_private',false,'asset','chips','unit_scale',100)scope FROM generate_series(1,6000)n)
INSERT INTO public.union_pnl_cash_outcomes SELECT tid,n,hid,'1','2026-10-20',md5(n::text),scope,jsonb_build_object('status','ready','basis_certified',true,'all_players_included',true,'game_scope',scope)FROM a;
WITH x AS(SELECT o.*,jsonb_build_object('provenance_link','resolved','status','ready','basis_certified',true,'all_players_included',true,'game_scope',game_scope)ev FROM public.union_pnl_cash_outcomes o),p AS(SELECT x.*,jsonb_build_object('status','proven','resolution_kind','cash_outcome_provenance_link','table_id',table_id,'hand_number',hand_number,'hand_id',hand_id,'outcome_payload_hash',payload_hash,'outcome_evidence_md5',md5(evidence::text),'roster_source','seat_inventory','manifest_id',NULL,'game_scope',game_scope,'evidence',ev,'large_financial_witness',repeat('retainedoriginal',4000))proof FROM x)
INSERT INTO public.union_pnl_cash_outcome_link_resolutions SELECT table_id,hand_number,hand_id,payload_hash,md5(evidence::text),'seat_inventory',NULL,game_scope,ev,proof,md5(proof::text),'original financial witness retained',session_user,clock_timestamp()FROM p;
VACUUM ANALYZE public.union_pnl_cash_outcomes;VACUUM ANALYZE public.union_pnl_cash_outcome_link_resolutions;
CREATE TEMP TABLE baseline AS SELECT md5(jsonb_agg(to_jsonb(x)ORDER BY to_jsonb(x)::text)::text)bag,count(*)n FROM public.fn_union_pnl_linked_cash_outcomes('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z')x;
CREATE ROLE service_role;CREATE ROLE authenticated;CREATE ROLE anon;CREATE SCHEMA smarter_private;
CREATE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT coalesce(current_setting('fixture.source65',true),'true')::boolean$$;
CREATE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE sql STABLE AS $$SELECT CASE WHEN current_setting('fixture.gen_null',true)='true'THEN NULL ELSE 'original-inventory-245-v1:72b51e4349fc9cd371bfb7f771b7ae20'END$$;
CREATE FUNCTION public.fn_ca_break_window_refuses_migrations(timestamptz)RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('fixture.break',true),'')$$;
CREATE FUNCTION public.fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('fixture.frozen',true),''),'false')::boolean$$;
CREATE FUNCTION public.fn_active_maintenance_release_boundary()RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('fixture.boundary',true),'')$$;
ALTER TABLE public.union_pnl_cash_outcomes ENABLE ROW LEVEL SECURITY;GRANT ALL ON public.union_pnl_cash_outcomes TO postgres;
ALTER TABLE public.union_pnl_cash_outcome_link_resolutions ENABLE ROW LEVEL SECURITY;GRANT ALL ON public.union_pnl_cash_outcome_link_resolutions TO postgres;GRANT SELECT ON public.union_pnl_cash_outcome_link_resolutions TO service_role;

CREATE INDEX union_pnl_cash_links_valid_proof_hand ON public.union_pnl_cash_outcome_link_resolutions(hand_id)INCLUDE(table_id,hand_number)WHERE proof_md5=md5(proof::text);
-- INSTALL_EXACT_CCI_AND_BODY
VACUUM ANALYZE public.union_pnl_cash_outcome_link_resolutions;
DO $parity$DECLARE b text;v_count int;BEGIN SELECT md5(jsonb_agg(to_jsonb(x)ORDER BY to_jsonb(x)::text)::text),count(*)INTO b,v_count FROM public.fn_union_pnl_linked_cash_outcomes('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z')x;IF (SELECT bag<>b OR baseline.n<>v_count FROM baseline)THEN RAISE EXCEPTION 'all4field_original_bag_changed';END IF;RAISE NOTICE 'full4field60rows_original_index_parityPASS';END$parity$;
EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)SELECT count(*)FROM public.union_pnl_cash_outcome_link_resolutions r WHERE r.game_scope->>'game_union_id'='fade0000-0000-0000-0000-000000000001'AND r.proof_md5=md5(r.proof::text);
EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT r.table_id,r.hand_number,r.game_scope,r.evidence
 FROM public.union_pnl_cash_outcome_link_resolutions r
 JOIN public.union_pnl_cash_outcomes o ON o.table_id=r.table_id AND o.hand_number=r.hand_number
 WHERE r.game_scope->>'game_union_id'='fade0000-0000-0000-0000-000000000001'::uuid::text AND o.recognized_at>='2026-10-19 07:00Z'::timestamptz AND o.recognized_at<'2026-10-26 07:00Z'::timestamptz
  AND r.hand_id=o.hand_id AND r.outcome_payload_hash=o.payload_hash AND r.outcome_evidence_md5=md5(o.evidence::text)
  AND r.proof_md5=md5(r.proof::text);
DO $wide$DECLARE x public.union_pnl_cash_outcome_link_resolutions;wide text;BEGIN SELECT string_agg(md5(n::text),'')INTO wide FROM generate_series(1,500)n;SELECT * INTO x FROM public.union_pnl_cash_outcome_link_resolutions LIMIT 1;x.table_id:=md5('wide')::uuid;x.hand_id:=md5('widehand')::uuid;x.hand_number:=99999;x.outcome_payload_hash:=wide;x.proof:=x.proof||jsonb_build_object('table_id',x.table_id,'hand_id',x.hand_id,'hand_number',x.hand_number,'outcome_payload_hash',wide);x.proof_md5:=md5(x.proof::text);
x.game_scope:=x.game_scope||jsonb_build_object('game_union_id',wide);x.evidence:=x.evidence||jsonb_build_object('game_scope',x.game_scope);x.proof:=x.proof||jsonb_build_object('game_scope',x.game_scope,'evidence',x.evidence);x.proof_md5:=md5(x.proof::text);INSERT INTO public.union_pnl_cash_outcome_link_resolutions SELECT(x).*;RAISE NOTICE 'FIXEDKEY_valid_long_payload_AND_foreign_union_ACCEPTED';
END$wide$;

EXPLAIN(GENERIC_PLAN TRUE,FORMAT JSON) SELECT r.table_id,r.hand_number,r.game_scope,r.evidence
 FROM public.union_pnl_cash_outcome_link_resolutions r
 JOIN public.union_pnl_cash_outcomes o ON o.table_id=r.table_id AND o.hand_number=r.hand_number
 WHERE r.game_scope->>'game_union_id'=$1::text AND o.recognized_at>=$2 AND o.recognized_at<$3
  AND r.hand_id=o.hand_id AND r.outcome_payload_hash=o.payload_hash AND r.outcome_evidence_md5=md5(o.evidence::text)
  AND r.proof_md5=md5(r.proof::text);

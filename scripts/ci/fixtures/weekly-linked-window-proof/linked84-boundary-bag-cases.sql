BEGIN;
-- Native boundary/additivity fixture. Only original function NAME adapted;
-- new reader definition is exact798e and admits real validated CHECK+NN.
CREATE TABLE public.union_pnl_cash_outcomes(table_id uuid,hand_number bigint,hand_id uuid,payload_hash text,evidence jsonb,recognized_at timestamptz,PRIMARY KEY(table_id,hand_number));
CREATE TABLE public.union_pnl_cash_outcome_link_resolutions(table_id uuid,hand_number bigint,hand_id uuid,outcome_payload_hash text,outcome_evidence_md5 text,game_scope jsonb,evidence jsonb,proof jsonb NOT NULL,proof_md5 text NOT NULL,CONSTRAINT union_pnl_cash_outcome_link_resolutions_check CHECK(proof_md5=md5(proof::text)));
CREATE OR REPLACE FUNCTION public.native_original_linked(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
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
;CREATE OR REPLACE FUNCTION public.fn_union_pnl_linked_cash_outcomes(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(table_id uuid, hand_number bigint, game_scope jsonb, evidence jsonb)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET enable_nestloop TO 'off'
AS $function$ BEGIN PERFORM 1 FROM public.union_pnl_cash_outcome_link_resolutions LIMIT 0; IF NOT EXISTS(SELECT FROM pg_catalog.pg_constraint c WHERE c.conrelid='public.union_pnl_cash_outcome_link_resolutions'::regclass AND c.conname='union_pnl_cash_outcome_link_resolutions_check' AND c.contype='c' AND c.convalidated AND pg_catalog.pg_get_constraintdef(c.oid)='CHECK ((proof_md5 = md5((proof)::text)))') OR (SELECT count(*)FROM pg_catalog.pg_attribute WHERE attrelid='public.union_pnl_cash_outcome_link_resolutions'::regclass AND attname IN('proof','proof_md5')AND attnotnull AND NOT attisdropped)<>2 THEN RAISE EXCEPTION 'linked_proof_contract_changed';END IF; RETURN QUERY EXECUTE $query$
 SELECT r.table_id,r.hand_number,r.game_scope,r.evidence
 FROM public.union_pnl_cash_outcome_link_resolutions r
 JOIN public.union_pnl_cash_outcomes o ON o.table_id=r.table_id AND o.hand_number=r.hand_number
 WHERE r.game_scope->>'game_union_id'=$1::text AND o.recognized_at>=$2 AND o.recognized_at<$3
  AND r.hand_id=o.hand_id AND r.outcome_payload_hash=o.payload_hash AND r.outcome_evidence_md5=md5(o.evidence::text)
  
$query$ USING p_union_id,p_start,p_end;END $function$
;
INSERT INTO public.union_pnl_cash_outcomes SELECT '00000000-0000-0000-0000-000000000001',i,'00000000-0000-0000-0000-000000000002','payload',jsonb_build_object('status','ready','basis_certified',true,'all_players_included',true),t FROM(VALUES(1,'2026-10-19 06:59:59.999999Z'::timestamptz),(2,'2026-10-19 07:00Z'),(3,'2026-10-19 08:59:59.999999Z'),(4,'2026-10-19 09:00Z'),(5,'2026-10-26 06:59:59.999999Z'),(6,'2026-10-26 07:00Z'),(7,NULL),(8,'2026-10-20 07:00Z'),(9,'2026-10-20 09:00Z'),(10,'2026-10-20 11:00Z'),(11,'2026-10-20 13:00Z'))x(i,t);
INSERT INTO public.union_pnl_cash_outcome_link_resolutions SELECT table_id,hand_number,CASE WHEN hand_number=8 THEN NULL ELSE hand_id END,CASE WHEN hand_number=9 THEN 'WRONG'ELSE payload_hash END,CASE WHEN hand_number=10 THEN 'WRONG'ELSE md5(evidence::text)END,jsonb_build_object('game_union_id',CASE WHEN hand_number=11 THEN 'OTHER'ELSE 'fade0000-0000-0000-0000-000000000001'END),CASE WHEN hand_number=4 THEN '{"status":"ready"}'::jsonb ELSE evidence END,'{}',md5('{}')FROM public.union_pnl_cash_outcomes;
DO $cases$DECLARE n bigint;BEGIN
 WITH windows AS(SELECT '2026-10-19 07:00Z'::timestamptz+i*interval '2h's,'2026-10-19 09:00Z'::timestamptz+i*interval '2h'e FROM generate_series(0,83)i),
 a AS MATERIALIZED(SELECT*FROM public.native_original_linked('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z')),
 b AS MATERIALIZED(SELECT*FROM public.fn_union_pnl_linked_cash_outcomes('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z')),
 aw AS MATERIALIZED(SELECT q.*FROM windows w CROSS JOIN LATERAL public.native_original_linked('fade0000-0000-0000-0000-000000000001',w.s,w.e)q),
 bw AS MATERIALIZED(SELECT q.*FROM windows w CROSS JOIN LATERAL public.fn_union_pnl_linked_cash_outcomes('fade0000-0000-0000-0000-000000000001',w.s,w.e)q),
 diffs AS((TABLE a EXCEPT ALL TABLE b)UNION ALL(TABLE b EXCEPT ALL TABLE a)UNION ALL(TABLE a EXCEPT ALL TABLE aw)UNION ALL(TABLE aw EXCEPT ALL TABLE a)UNION ALL(TABLE b EXCEPT ALL TABLE bw)UNION ALL(TABLE bw EXCEPT ALL TABLE b))SELECT count(*)INTO n FROM diffs;
 IF n<>0 THEN RAISE EXCEPTION '84window_unionall_bag_difference:%',n;END IF;
 SELECT count(*)INTO n FROM public.native_original_linked('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z');IF n<>4 THEN RAISE EXCEPTION 'independent_edge_count:%',n;END IF;
 RAISE NOTICE '84WINDOW_BOUNDARY_BAG_PASS:original_full=new_full=original84=new84;rows4;difference0';
END;$cases$;
ROLLBACK;

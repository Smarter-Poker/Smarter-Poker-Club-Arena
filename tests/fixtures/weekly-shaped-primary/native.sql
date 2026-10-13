CREATE INDEX union_pnl_cash_outcome_touches_week ON public.union_pnl_cash_outcome_touches(game_union_id,recognized_at);
CREATE INDEX union_pnl_cash_outcomes_unaccepted ON public.union_pnl_cash_outcomes((game_scope->>'game_union_id'),recognized_at)
 WHERE evidence->>'status' IS DISTINCT FROM 'ready' OR evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
 OR evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR evidence->'game_scope' IS DISTINCT FROM game_scope;
ALTER FUNCTION public.fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean) FROM PUBLIC,anon,authenticated,service_role;
DO $$DECLARE r union_pnl_cash_outcomes;v jsonb;BEGIN
 FOR r IN SELECT * FROM union_pnl_cash_outcomes WHERE hand_number IN(26114212,26114214,26114243) LOOP
  v:=fn_union_pnl_prove_original_unchanged_stack(r.table_id,r.hand_number);
  IF v->>'status' IS DISTINCT FROM 'proven' THEN RAISE EXCEPTION 'actual original stack unproven % %',r.hand_number,v;END IF;
  PERFORM fn_union_pnl_resolve_original_unchanged_stack(r.table_id,r.hand_number,'Exact native original stack candidate reader qualification');
 END LOOP;
 PERFORM fn_union_pnl_certify_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564,
 md5(fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)::text),
 encode(extensions.digest(convert_to(smarter_private.posthand_escrow_original_snapshot('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)::text,'UTF8'),'sha256'),'hex'));
 IF (SELECT count(*) FROM union_pnl_cash_outcomes o WHERE hand_number IN(26114212,26114214,26114243,31008564)
 AND fn_union_pnl_cash_outcome_accepted(o))<>4 THEN RAISE EXCEPTION 'actual four ordinary consumers refused';END IF;
 RAISE NOTICE 'PASS actual four original consumers retain their proof/economic equations';
END$$;
INSERT INTO union_pnl_cash_outcome_touches SELECT table_id,hand_number,recognized_at,game_scope->>'game_union_id',true,evidence->>'accepted_rake',evidence->'participants'
 FROM union_pnl_cash_outcomes WHERE hand_number IN(26114212,26114214,26114243) ON CONFLICT DO NOTHING;
-- Reader-only adversarial rows: financial acceptance is never fabricated.
INSERT INTO union_pnl_cash_outcomes(table_id,hand_number,hand_id,recognized_at,payload_hash,game_scope,evidence)
 SELECT md5(('matrix-table-'||n)::text)::uuid,80000000+n,md5(('matrix-hand-'||n)::text)::uuid,
 CASE n WHEN 16 THEN '2026-10-12 07:00Z'::timestamptz WHEN 17 THEN '2026-10-05 07:00Z'::timestamptz ELSE '2026-10-08 10:00Z'::timestamptz END,
 'matrix-reader-only',CASE WHEN n=18 THEN '{"game_union_id":"different"}'::jsonb ELSE '{"game_union_id":"fade0000-0000-0000-0000-000000000001"}'::jsonb END,
 jsonb_build_object('status','ready','basis_certified',true,'all_players_included',true,'game_scope','{"game_union_id":"fade0000-0000-0000-0000-000000000001"}'::jsonb)
 ||CASE n WHEN 1 THEN '{"status":"blocked"}'::jsonb WHEN 2 THEN '{"basis_certified":false}'::jsonb WHEN 3 THEN '{"all_players_included":false}'::jsonb WHEN 4 THEN '{"game_scope":null}'::jsonb
 WHEN 5 THEN '{"status":null}'::jsonb WHEN 6 THEN '{"basis_certified":null}'::jsonb WHEN 7 THEN '{"basis_certified":"true"}'::jsonb WHEN 8 THEN '{"all_players_included":"true"}'::jsonb
 WHEN 9 THEN '{"game_scope":{}}'::jsonb WHEN 10 THEN '{"status":"blocked"}'::jsonb WHEN 11 THEN '{"status":"blocked"}'::jsonb WHEN 12 THEN '{"status":"blocked"}'::jsonb
 WHEN 13 THEN '{"status":"blocked"}'::jsonb WHEN 14 THEN '{"status":"blocked"}'::jsonb WHEN 15 THEN '{"status":"blocked"}'::jsonb WHEN 16 THEN '{"status":"blocked"}'::jsonb WHEN 17 THEN '{"status":"blocked"}'::jsonb ELSE '{}'::jsonb END
 FROM generate_series(1,18)n;
INSERT INTO union_pnl_cash_outcome_touches SELECT table_id,hand_number,
 CASE hand_number WHEN 80000013 THEN '2026-10-12 07:00Z'::timestamptz WHEN 80000014 THEN NULL ELSE recognized_at END,
 CASE hand_number WHEN 80000012 THEN 'different' ELSE game_scope->>'game_union_id' END,
 hand_number<>80000011,'0','[]' FROM union_pnl_cash_outcomes WHERE hand_number BETWEEN 80000001 AND 80000018 AND hand_number<>80000010;
DO $$BEGIN
 IF (SELECT count(*) FROM fn_union_pnl_week_shaped_hands('fade0000-0000-0000-0000-000000000001','2026-10-05 07:00Z','2026-10-12 07:00Z',true)o WHERE hand_number BETWEEN 80000001 AND 80000018)<>11
 OR (SELECT count(*) FROM fn_union_pnl_week_shaped_hands('fade0000-0000-0000-0000-000000000001','2026-10-05 07:00Z','2026-10-12 07:00Z',false)o WHERE hand_number BETWEEN 80000001 AND 80000018)<>16 THEN RAISE EXCEPTION 'independent original shape matrix expectation changed';END IF;
END$$;
CREATE TEMP TABLE expected AS SELECT true projected,to_jsonb(o) original FROM fn_union_pnl_week_shaped_hands('fade0000-0000-0000-0000-000000000001','2026-10-05 07:00Z','2026-10-12 07:00Z',true)o
 UNION ALL SELECT false,to_jsonb(o) FROM fn_union_pnl_week_shaped_hands('fade0000-0000-0000-0000-000000000001','2026-10-05 07:00Z','2026-10-12 07:00Z',false)o;
CREATE TEMP TABLE source_hashes AS SELECT p.oid,md5(pg_get_functiondef(p.oid)) hash FROM pg_proc p
 WHERE p.oid IN('public.fn_union_pnl_cash_outcome_accepted(union_pnl_cash_outcomes)'::regprocedure,'public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure);
\i :rollback_migration
DO $$BEGIN IF md5(pg_get_functiondef('public.fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean)'::regprocedure))<>'393e98309bb57d2cb914d581e5da201a' THEN RAISE EXCEPTION 'rollback altered original source';END IF;END$$;
\i :migration
DO $$BEGIN
 IF EXISTS((SELECT * FROM expected) EXCEPT (SELECT true,to_jsonb(o) FROM fn_union_pnl_week_shaped_hands('fade0000-0000-0000-0000-000000000001','2026-10-05 07:00Z','2026-10-12 07:00Z',true)o UNION ALL SELECT false,to_jsonb(o) FROM fn_union_pnl_week_shaped_hands('fade0000-0000-0000-0000-000000000001','2026-10-05 07:00Z','2026-10-12 07:00Z',false)o)) THEN RAISE EXCEPTION 'original multiset lost';END IF;
 IF EXISTS(SELECT 1 FROM source_hashes s WHERE md5(pg_get_functiondef(s.oid))<>s.hash) THEN RAISE EXCEPTION 'accepted or report changed';END IF;
 RAISE NOTICE 'PASS actual four projected/raw rowsets and accepted/report sources unchanged';
END$$;

DO $$DECLARE old_set jsonb;new_set jsonb;BEGIN
 SELECT jsonb_agg(jsonb_build_array(projected,original) ORDER BY projected,original::text) INTO old_set FROM expected;
 SELECT jsonb_agg(jsonb_build_array(projected,original) ORDER BY projected,original::text) INTO new_set FROM (
 SELECT true projected,to_jsonb(o) original FROM fn_union_pnl_week_shaped_hands('fade0000-0000-0000-0000-000000000001','2026-10-05 07:00Z','2026-10-12 07:00Z',true)o
 UNION ALL SELECT false,to_jsonb(o) FROM fn_union_pnl_week_shaped_hands('fade0000-0000-0000-0000-000000000001','2026-10-05 07:00Z','2026-10-12 07:00Z',false)o)x;
 IF old_set IS DISTINCT FROM new_set THEN RAISE EXCEPTION 'semantic original multiset changed';END IF;
 IF has_function_privilege('service_role','public.fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean)','EXECUTE') THEN RAISE EXCEPTION 'private reader ACL weakened';END IF;
 RAISE NOTICE 'PASS eighteen shape/typed NULL/orphan/union/time/cardinality cases, rollback, raw branch and postgres-only ACL';
END$$;
DELETE FROM union_pnl_cash_outcome_touches WHERE hand_number BETWEEN 80000001 AND 80000018;
DELETE FROM union_pnl_cash_outcomes WHERE hand_number BETWEEN 80000001 AND 80000018;

DO $$DECLARE bad bigint;resolved bigint;BEGIN
 SELECT count(*) FILTER(WHERE NOT fn_union_pnl_cash_outcome_accepted(o)),
 count(*) FILTER(WHERE (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb) AND fn_union_pnl_cash_outcome_accepted(o))
 INTO bad,resolved FROM fn_union_pnl_week_shaped_hands('fade0000-0000-0000-0000-000000000001','2026-10-05 07:00Z','2026-10-12 07:00Z',true)o;
 IF bad<>0 OR resolved<>4 THEN RAISE EXCEPTION 'actual primary bad/resolved changed % %',bad,resolved;END IF;
 RAISE NOTICE 'PASS actual four original report aggregate: bad0 resolved4';
END$$;

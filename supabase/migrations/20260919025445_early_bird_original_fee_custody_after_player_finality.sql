-- Admit only the retained Early Bird original27 fees, total2.70, after canonical player finality.
-- Missing earning evidence stays held in its original escrow; this DDL pays nothing.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $guard$ DECLARE source text; BEGIN
IF md5(pg_get_functiondef('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)'::regprocedure)) IS DISTINCT FROM 'de4a79604fed8edcd5b94aea968516bc' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'Early Bird fee custody predecessor changed: fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)' USING ERRCODE='55000'; END IF;
IF md5(pg_get_functiondef('public.fn_ca_legacy_fee_custody_cohort(uuid)'::regprocedure)) IS DISTINCT FROM 'aefe9e28519b4c3f1573c6c6734a1cd2' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_ca_legacy_fee_custody_cohort(uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_ca_legacy_fee_custody_cohort(uuid)'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'Early Bird fee custody predecessor changed: fn_ca_legacy_fee_custody_cohort(uuid)' USING ERRCODE='55000'; END IF;
IF md5(pg_get_functiondef('public.fn_ca_hold_legacy_tournament_fee(uuid,text)'::regprocedure)) IS DISTINCT FROM 'fde5202722d449e3361102861edf46a1' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_ca_hold_legacy_tournament_fee(uuid,text)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_ca_hold_legacy_tournament_fee(uuid,text)'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'Early Bird fee custody predecessor changed: fn_ca_hold_legacy_tournament_fee(uuid,text)' USING ERRCODE='55000'; END IF;
SELECT pg_get_functiondef('public.fn_ca_legacy_fee_custody_cohort(uuid)'::regprocedure) INTO source;
source:=replace(source,$old$ ) c(tournament_id,amount,source_fingerprint,source_count)$old$,$new$,
 ('a5aa6984-6c1c-4b59-aeb7-9e7878853bdd'::uuid,2.70::numeric,'aab06c68bd63b23b2b7340bd55f43e44',27)
 ) c(tournament_id,amount,source_fingerprint,source_count)$new$);
EXECUTE source;
END $guard$;
COMMIT;

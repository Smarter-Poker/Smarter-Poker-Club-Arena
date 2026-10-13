-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean)'::regprocedure))='78b5d525a31a79ff1b13a5cfe0ddf739')
-- The original projected reader scanned the entire touch week before finding four
-- unaccepted primary outcomes. Anchor the same predicates on their existing
-- partial index, then check the exact unique original projection row.
-- No index, accepted-outcome rule, raw branch, report or financial deadline changes.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preimages$ BEGIN
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'SHAPED_PRIMARY_REQUIRES_THAW' USING ERRCODE='55000';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'SHAPED_PRIMARY_ORIGINAL_READER_OWNED' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean)'::regprocedure)) IS DISTINCT FROM '393e98309bb57d2cb914d581e5da201a' THEN RAISE EXCEPTION 'SHAPED_PRIMARY_PREIMAGE_OR_REPLAY_REFUSED' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean)'::regprocedure
  AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}' AND prosecdef AND provolatile='s'
  AND proconfig=ARRAY['search_path=public, pg_temp']) THEN RAISE EXCEPTION 'SHAPED_PRIMARY_SECURITY_PREIMAGE_CHANGED' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.union_pnl_cash_outcome_touches_pkey'::regclass AND indisprimary AND indisunique AND indisvalid
  AND pg_get_indexdef(indexrelid)='CREATE UNIQUE INDEX union_pnl_cash_outcome_touches_pkey ON public.union_pnl_cash_outcome_touches USING btree (table_id, hand_number)') THEN RAISE EXCEPTION 'SHAPED_PRIMARY_TOUCH_IDENTITY_CHANGED' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.union_pnl_cash_outcomes_unaccepted'::regclass AND indisvalid AND indisready
  AND md5(pg_get_indexdef(indexrelid))='6c9a356a9aeea3ef6aa4f66873220f54') THEN RAISE EXCEPTION 'SHAPED_PRIMARY_ORIGINAL_PARTIAL_INDEX_CHANGED' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_cash_outcome_accepted(public.union_pnl_cash_outcomes)'::regprocedure)) IS DISTINCT FROM 'f1d7fbfbe0bcebb63579b19bc3143a95' OR md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure)) IS DISTINCT FROM 'edecfc5273ee4c96b608baa0ea863578' THEN RAISE EXCEPTION 'SHAPED_PRIMARY_UNCHANGED_CONSUMER_CHANGED' USING ERRCODE='55000';END IF;
END $preimages$;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_week_shaped_hands(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_projected boolean)
 RETURNS SETOF union_pnl_cash_outcomes
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF p_projected THEN
  RETURN QUERY WITH candidates AS MATERIALIZED (
   SELECT q.* FROM public.union_pnl_cash_outcomes q
   WHERE q.game_scope->>'game_union_id'=p_union_id::text AND q.recognized_at>=p_start AND q.recognized_at<p_end
    AND (q.evidence->>'status' IS DISTINCT FROM 'ready' OR q.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
     OR q.evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR q.evidence->'game_scope' IS DISTINCT FROM q.game_scope)
  ) SELECT o.* FROM candidates o
   WHERE (SELECT CASE WHEN h.game_union_id=p_union_id::text AND h.recognized_at>=p_start AND h.recognized_at<p_end
    THEN h.shaped ELSE false END FROM public.union_pnl_cash_outcome_touches h
    WHERE h.table_id=o.table_id AND h.hand_number=o.hand_number) IS TRUE;
 ELSE
  RETURN QUERY SELECT o.* FROM public.union_pnl_cash_outcomes o WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end
   AND (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
    OR o.evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR o.evidence->'game_scope' IS DISTINCT FROM o.game_scope);
 END IF;
END $function$;

REVOKE ALL ON FUNCTION public.fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean) FROM PUBLIC,anon,authenticated,service_role;
DO $postimages$ BEGIN
 IF md5(pg_get_functiondef('public.fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean)'::regprocedure)) IS DISTINCT FROM '78b5d525a31a79ff1b13a5cfe0ddf739' THEN RAISE EXCEPTION 'SHAPED_PRIMARY_POSTIMAGE_CHANGED' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean)'::regprocedure
  AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}' AND prosecdef AND provolatile='s'
  AND proconfig=ARRAY['search_path=public, pg_temp']) THEN RAISE EXCEPTION 'SHAPED_PRIMARY_SECURITY_POSTIMAGE_CHANGED' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.union_pnl_cash_outcome_touches_pkey'::regclass AND indisprimary AND indisunique AND indisvalid
  AND pg_get_indexdef(indexrelid)='CREATE UNIQUE INDEX union_pnl_cash_outcome_touches_pkey ON public.union_pnl_cash_outcome_touches USING btree (table_id, hand_number)') THEN RAISE EXCEPTION 'SHAPED_PRIMARY_TOUCH_POSTIMAGE_CHANGED' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.union_pnl_cash_outcomes_unaccepted'::regclass AND indisvalid AND indisready
  AND md5(pg_get_indexdef(indexrelid))='6c9a356a9aeea3ef6aa4f66873220f54') THEN RAISE EXCEPTION 'SHAPED_PRIMARY_PARTIAL_INDEX_POSTIMAGE_CHANGED' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_cash_outcome_accepted(public.union_pnl_cash_outcomes)'::regprocedure)) IS DISTINCT FROM 'f1d7fbfbe0bcebb63579b19bc3143a95' OR md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure)) IS DISTINCT FROM 'edecfc5273ee4c96b608baa0ea863578' THEN RAISE EXCEPTION 'SHAPED_PRIMARY_UNCHANGED_CONSUMER_CHANGED' USING ERRCODE='55000';END IF;
END $postimages$;
COMMIT;

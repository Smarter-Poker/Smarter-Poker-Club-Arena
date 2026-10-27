CREATE OR REPLACE FUNCTION smarter_private.weekly_hand_parts_read(p_union uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_generation text, p_projected boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE w record;p record;groups jsonb:='[]';n bigint;expected bigint;
BEGIN
 IF current_setting('app.weekly_accounting_chunked',true) IS DISTINCT FROM 'on' OR current_setting('app.accounting_close_memo',true) IS DISTINCT FROM 'on' THEN RETURN NULL;END IF;
 IF p_generation IS NULL OR p_generation='original-inventory-245:unqualified' THEN RETURN NULL;END IF;
 SELECT count(*) INTO expected FROM public.fn_accounting_close_windows(p_start,p_end);
 SELECT count(*) INTO n FROM public.accounting_close_partials WHERE kind='pnl_hands_window' AND union_id=p_union AND period_start=p_start AND period_end=p_end;
 IF expected=0 OR n<>expected THEN RETURN NULL;END IF;
 FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_start,p_end) ORDER BY 1 LOOP
 SELECT * INTO p FROM public.accounting_close_partials WHERE kind='pnl_hands_window' AND union_id=p_union AND period_start=p_start AND period_end=p_end AND window_start=w.window_start;
 IF NOT FOUND OR p.window_end IS DISTINCT FROM w.window_end OR p.computed_at<p_end OR p.computed_at<=clock_timestamp()-public.fn_accounting_close_proof_lifetime()
 OR p.value->>'generation' IS DISTINCT FROM p_generation OR p.value->'projected' IS DISTINCT FROM to_jsonb(p_projected)
 OR p.computed_at>clock_timestamp() OR jsonb_typeof(p.value->'groups') IS DISTINCT FROM 'array' OR p.value->>'groups_md5' IS DISTINCT FROM md5((p.value->'groups')::text)
 OR p.value->>'contract' IS DISTINCT FROM 'd4665eb6e43425a93816c55ded55f644'
 OR p.value->'witness' IS DISTINCT FROM smarter_private.weekly_hand_parts_witness(p_union,w.window_start,w.window_end,p_projected)
 THEN RETURN NULL;END IF;
 groups:=groups||(p.value->'groups');
 END LOOP;
 RETURN(SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY kind,club_id,user_id),'[]'::jsonb) FROM(
 SELECT kind,club_id,user_id,sum(delta)delta,sum(hands)::bigint hands,sum(rake)rake
 FROM jsonb_to_recordset(groups)x(kind integer,club_id uuid,user_id uuid,delta numeric,hands bigint,rake numeric)GROUP BY kind,club_id,user_id)q);
END $function$

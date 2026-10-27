CREATE OR REPLACE FUNCTION smarter_private.weekly_hand_parts_reduce(p_union uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_projected boolean)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
 SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY kind,club_id,user_id),'[]'::jsonb) FROM(
 SELECT x.kind,x.club_id,x.user_id,sum(x.delta)delta,count(*)hands,sum(x.rake)rake
 FROM(SELECT h.hand_accepted_rake accepted_rake,h.hand_participants participants FROM public.fn_union_pnl_week_hand_lines(p_union,p_start,p_end,p_projected)h
 UNION ALL SELECT k.evidence->>'accepted_rake',k.evidence->'participants' FROM public.fn_union_pnl_linked_cash_outcomes(p_union,p_start,p_end)k)o
 CROSS JOIN LATERAL(SELECT 0 kind,NULL::uuid club_id,NULL::uuid user_id,NULL::numeric delta,o.accepted_rake::numeric rake
 UNION ALL SELECT 1,(p->>'earning_club_id')::uuid,(p->>'user_id')::uuid,(p->>'observed_stack_delta')::numeric,NULL::numeric FROM jsonb_array_elements(COALESCE(o.participants,'[]'))p)x
 GROUP BY x.kind,x.club_id,x.user_id)q
$function$

-- Before the migration: the #5551 boundary refuses every baseline tournament.
CREATE TABLE public.hx_before AS SELECT v.k,public.fn_union_pnl_boundary(v.id,'2026-09-21 07:00+00') b
 FROM (VALUES('U',public.u('U')),('O',public.u('O'))) v(k,id);
DO $$
DECLARE b jsonb:=(SELECT b FROM public.hx_before WHERE k='U');
BEGIN
 IF b->>'status' IS DISTINCT FROM 'blocked'
  OR (SELECT array_agg(e->>'tournament_id' ORDER BY e->>'tournament_id') FROM jsonb_array_elements(b->'issues') e
      WHERE e->>'reason'='open_tournament_precedes_original_population')
     IS DISTINCT FROM (SELECT array_agg(x::text ORDER BY x::text) FROM unnest(ARRAY[public.u('T_OK'),public.u('T_FREE'),public.u('T_BAD')]) x)
  OR NOT b->'issues' @> jsonb_build_array(jsonb_build_object('reason','open_tournament_original_instrument_or_earning_club_missing','registration_id',public.u('i2')))
  OR jsonb_array_length(b->'holdings')<>1 THEN
  RAISE EXCEPTION 'stage1: unexpected pre-migration boundary %',b;
 END IF;
 RAISE NOTICE 'PASS stage1: the 20260928211132 boundary refuses T_OK, T_FREE and T_BAD as preceding the original population';
END $$;

SET check_function_bodies = off;
-- Randomized original inventory histories (synthetic; no production data).
-- Every shape the reader distinguishes is drawn: baseline, INSERT, UPDATE and
-- DELETE (and re-INSERT of a deleted id), a first event that is not an origin,
-- corrupted chains, jsonb-equal rows printed differently (100.5 vs 100.50),
-- JSON-null statuses, tournaments that close and reopen, players of both, and
-- insertion order jittered against observed_at so event_id order interleaves
-- across week boundaries. p_clean draws only intact chains in observed order
-- (the reader's 'observed' status).
CREATE FUNCTION public.fixture_state(p_src text, p_id uuid, p_prev jsonb, p_tours uuid[]) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE ts jsonb := to_jsonb(timestamptz '2026-08-01' + random()*interval '40 days');
BEGIN
 RETURN CASE p_src
  WHEN 'union_clubs' THEN jsonb_build_object('id',p_id,'union_id','00000000-0000-0000-0000-00000000000a','club_id',md5(p_id::text||'c')::uuid,'joined_at',ts)
  WHEN 'tables' THEN jsonb_build_object('id',p_id,'club_id',md5(p_id::text||'c')::uuid,'union_id','00000000-0000-0000-0000-00000000000a',
    'tournament_id',CASE WHEN random()<0.5 OR cardinality(p_tours)=0 THEN NULL ELSE to_jsonb(p_tours[1+floor(random()*cardinality(p_tours))::int]) END,
    'is_private',random()<0.2)
  WHEN 'table_seats' THEN jsonb_build_object('id',p_id,'table_id',md5(p_id::text||'t')::uuid,'user_id',md5(p_id::text||'u')::uuid,'club_id',md5(p_id::text||'c')::uuid,
    'occupancy_id',md5(p_id::text||floor(random()*3)::text)::uuid,'joined_at',ts,
    'left_at',CASE WHEN random()<0.6 THEN NULL ELSE ts END,'stack',round((random()*1000)::numeric,1))
  WHEN 'tournaments' THEN jsonb_build_object('id',p_id,'club_id',md5(p_id::text||'c')::uuid,'union_id','00000000-0000-0000-0000-00000000000a','is_private',false,
    'status',(ARRAY['REGISTERING','RUNNING','COMPLETED','CANCELLED','RUNNING',NULL])[1+floor(random()*6)::int],
    'started_at',ts,'ended_at',NULL,'prize_pool',round((random()*500)::numeric,2),'bounty_pool',0,'bounty_pool_paid',0)
  ELSE jsonb_build_object('id',p_id,'tournament_id',p_tours[1+floor(random()*cardinality(p_tours))::int],'user_id',md5(p_id::text||'u')::uuid,
    'club_id',md5(p_id::text||'c')::uuid,'status',(ARRAY['registered','playing','eliminated'])[1+floor(random()*3)::int],'registered_at',ts,
    'eliminated_at',NULL,'prize',0,'bounty_winnings',0,'source_satellite_id',NULL)
 END;
END $$;

CREATE FUNCTION public.fixture_generate(p_seed double precision, p_rows integer, p_clean boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE cap timestamptz := '2026-08-05 12:00+00'; horizon timestamptz := '2026-09-02 00:00+00';
 i int; j int; n int; src text; rid uuid; cur jsonb; nxt jsonb; bef jsonb; t timestamptz; op text; tours uuid[] := '{}'; deleted boolean;
BEGIN
 PERFORM setseed(p_seed);
 INSERT INTO public.union_pnl_inventory_capture VALUES(true,cap,1,'{}');
 CREATE TEMP TABLE fixture_gen(g_src text, g_rid uuid, g_obs timestamptz, g_op text, g_b jsonb, g_a jsonb, g_ord double precision);
 FOR i IN 1..p_rows LOOP
  src := (ARRAY['union_clubs','tables','table_seats','table_seats','tournaments','tournaments','tournament_players','tournament_players'])[1+floor(random()*8)::int];
  IF src IN ('tournament_players','tables') AND cardinality(tours)=0 THEN src:='tournaments'; END IF;
  rid := md5(p_seed::text||':'||i)::uuid;
  IF src='tournaments' THEN tours := tours||rid; END IF;
  n := 1+floor(random()*10)::int;
  cur := public.fixture_state(src,rid,NULL,tours);
  IF random()<0.25 THEN t:=cap; op:='baseline'; bef:=NULL;
  ELSIF random()<0.3 THEN
   -- Straddle a week boundary in minutes, so jittered insertion order
   -- interleaves event_id across it.
   t:=(ARRAY['2026-08-10 07:00+00','2026-08-17 07:00+00','2026-08-24 07:00+00','2026-08-31 07:00+00']::timestamptz[])[1+floor(random()*4)::int]
      -random()*interval '90 minutes'; op:='INSERT'; bef:=NULL;
  ELSIF random()<0.9 THEN t:=cap+random()*(horizon-cap)*0.6; op:='INSERT'; bef:=NULL;
  ELSIF NOT p_clean THEN t:=cap+random()*(horizon-cap)*0.6; op:='UPDATE'; bef:=public.fixture_state(src,rid,NULL,tours);
  ELSE t:=cap+random()*(horizon-cap)*0.6; op:='INSERT'; bef:=NULL; END IF;
  INSERT INTO fixture_gen VALUES(src,rid,t,op,bef,cur,0);
  deleted := false;
  FOR j IN 2..n LOOP
   t := t + CASE WHEN random()<0.5 THEN random()*interval '40 minutes' WHEN random()<0.5 THEN random()*interval '3 hours' ELSE random()*interval '3 days' END;
   IF deleted THEN op:='INSERT'; bef:=NULL; nxt:=public.fixture_state(src,rid,cur,tours); deleted:=false;
   ELSIF random()<0.08 THEN op:='DELETE'; bef:=cur; nxt:=NULL; deleted:=true;
   ELSE op:='UPDATE'; bef:=cur; nxt:=public.fixture_state(src,rid,cur,tours);
    IF src='tournaments' AND random()<0.3 THEN nxt:=jsonb_set(nxt,'{status}',to_jsonb((ARRAY['COMPLETED','RUNNING'])[1+floor(random()*2)::int])); END IF;
   END IF;
   IF bef IS NOT NULL AND NOT p_clean AND random()<0.06 THEN bef:=jsonb_set(bef,'{id}',to_jsonb(rid)) || jsonb_build_object('club_id',md5(random()::text)::uuid); END IF;
   IF bef IS NOT NULL AND src='table_seats' AND random()<0.3 THEN bef:=jsonb_set(bef,'{stack}',to_jsonb((bef->>'stack')::numeric*1.00)); END IF;
   INSERT INTO fixture_gen VALUES(src,rid,t,op,bef,nxt,0);
   IF nxt IS NOT NULL THEN cur:=nxt; END IF;
  END LOOP;
 END LOOP;
 UPDATE fixture_gen SET g_ord=extract(epoch FROM g_obs)+CASE WHEN NOT p_clean AND random()<0.3 THEN (random()-0.5)*6*3600 ELSE 0 END;
 INSERT INTO public.union_pnl_inventory_events(source_name,row_id,observed_at,transaction_id,operation,before_row,after_row)
  SELECT g_src,g_rid,g_obs,pg_current_xact_id(),g_op,g_b,g_a FROM fixture_gen ORDER BY g_ord,g_rid;
 DROP TABLE fixture_gen;
 RETURN jsonb_build_object('events',(SELECT count(*) FROM public.union_pnl_inventory_events));
END $$;

CREATE FUNCTION public.fixture_boundaries() RETURNS SETOF timestamptz LANGUAGE sql AS $$
 VALUES ('2026-08-03 07:00+00'::timestamptz),('2026-08-10 07:00+00'),('2026-08-17 07:00+00'),('2026-08-24 07:00+00'),('2026-08-31 07:00+00') $$;

CREATE FUNCTION public.fixture_check(p_label text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_b timestamptz; v jsonb; l jsonb;
BEGIN
 FOR v_b IN SELECT * FROM public.fixture_boundaries() LOOP
  v := public.fn_union_pnl_inventory_as_of(v_b);
  SELECT r INTO l FROM fixture_legacy WHERE fixture_legacy.b=v_b;
  IF v IS DISTINCT FROM l THEN
   RAISE EXCEPTION 'MISMATCH [%] at %: new % vs legacy %',p_label,v_b,md5(v::text),md5(l::text);
  END IF;
 END LOOP;
 RETURN 'PASS '||p_label;
END $$;

-- Which shapes this history actually exercised (coverage, not correctness).
CREATE FUNCTION public.fixture_coverage() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object(
  'events',(SELECT count(*) FROM public.union_pnl_inventory_events),
  'chain_issues',(SELECT sum(jsonb_array_length(r->'issues')) FROM fixture_legacy),
  'active_rows',(SELECT sum((SELECT count(*) FROM jsonb_each(r->'population') p, jsonb_array_elements(p.value))) FROM fixture_legacy),
  'interleaved_rows',(SELECT count(DISTINCT (a.source_name,a.row_id)) FROM public.fixture_boundaries() bb
    JOIN public.union_pnl_inventory_events a ON a.observed_at>=bb
    JOIN public.union_pnl_inventory_events p ON p.source_name=a.source_name AND p.row_id=a.row_id AND p.observed_at<bb AND p.event_id>a.event_id),
  'reopened_tournaments',(SELECT count(*) FROM public.union_pnl_inventory_events WHERE source_name='tournaments'
    AND before_row->>'status' IN ('COMPLETED','CANCELLED') AND after_row->>'status' NOT IN ('COMPLETED','CANCELLED')),
  'equal_but_reprinted',(SELECT count(*) FROM public.union_pnl_inventory_events e JOIN LATERAL (
     SELECT p.after_row FROM public.union_pnl_inventory_events p WHERE p.source_name=e.source_name AND p.row_id=e.row_id AND p.event_id<e.event_id ORDER BY p.event_id DESC LIMIT 1) q ON true
    WHERE e.before_row=q.after_row AND e.before_row::text<>q.after_row::text));
$$;

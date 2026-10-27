-- @live-proof: (md5(pg_get_functiondef('public.fn_rakeback_recompute_split(uuid,date,date)'::regprocedure))='a4f76df2ab80d5b19ccbd923318658d4')
-- Group only the original source counts. Existing locks, freshness, partials,
-- tournament checks, check/write pages, source authorities and payers remain.
-- The entire84-window query is atomic: it MUST fit the remaining original
-- 240-second statement, admitted before the unchanged90-second soft stop.
-- Local parity/timing is NOT a production budget/capacity certificate.
-- No installation until current human payments and a bounded actual-query
-- timing proof have been completed by the incident owner.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $grouped_counts$
DECLARE d text;
BEGIN
 d:=pg_get_functiondef('public.fn_rakeback_recompute_split(uuid,date,date)'::regprocedure);
 IF md5(d)<>'2d8ab8647146824b837ee193b624834c' THEN
  RAISE EXCEPTION 'rakeback_grouped_counts_owner_changed';END IF;
 IF (length(d)-length(replace(d,$old$ -- 3. The source-evidence counts, two hours at a time.
 FOR w IN SELECT (row_number() OVER(ORDER BY g)-1)::int AS idx,g AS ws,LEAST(g+interval '2 hours',v_to) AS we
   FROM generate_series(v_from,v_to-interval '1 microsecond',interval '2 hours') g ORDER BY 1 LOOP
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='counts' AND part=w.idx);
  IF did AND clock_timestamp()>began+interval '90 seconds' THEN EXIT; END IF;
  INSERT INTO public.accounting_recompute_split_parts(club_id,period_start,period_end,kind,part,value)
  VALUES(p_club_id,p_period_start,p_period_end,'counts',w.idx,public.fn_rakeback_split_counts(p_club_id,v_from,v_to,w.ws,w.we));
  did:=true; PERFORM set_config('app.accounting_split_did','on',true);
 END LOOP;$old$,'')))/length($old$ -- 3. The source-evidence counts, two hours at a time.
 FOR w IN SELECT (row_number() OVER(ORDER BY g)-1)::int AS idx,g AS ws,LEAST(g+interval '2 hours',v_to) AS we
   FROM generate_series(v_from,v_to-interval '1 microsecond',interval '2 hours') g ORDER BY 1 LOOP
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='counts' AND part=w.idx);
  IF did AND clock_timestamp()>began+interval '90 seconds' THEN EXIT; END IF;
  INSERT INTO public.accounting_recompute_split_parts(club_id,period_start,period_end,kind,part,value)
  VALUES(p_club_id,p_period_start,p_period_end,'counts',w.idx,public.fn_rakeback_split_counts(p_club_id,v_from,v_to,w.ws,w.we));
  did:=true; PERFORM set_config('app.accounting_split_did','on',true);
 END LOOP;$old$)<>1 THEN
  RAISE EXCEPTION 'rakeback_grouped_counts_anchor_changed';END IF;
 d:=replace(d,$old$ -- 3. The source-evidence counts, two hours at a time.
 FOR w IN SELECT (row_number() OVER(ORDER BY g)-1)::int AS idx,g AS ws,LEAST(g+interval '2 hours',v_to) AS we
   FROM generate_series(v_from,v_to-interval '1 microsecond',interval '2 hours') g ORDER BY 1 LOOP
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='counts' AND part=w.idx);
  IF did AND clock_timestamp()>began+interval '90 seconds' THEN EXIT; END IF;
  INSERT INTO public.accounting_recompute_split_parts(club_id,period_start,period_end,kind,part,value)
  VALUES(p_club_id,p_period_start,p_period_end,'counts',w.idx,public.fn_rakeback_split_counts(p_club_id,v_from,v_to,w.ws,w.we));
  did:=true; PERFORM set_config('app.accounting_split_did','on',true);
 END LOOP;$old$,$new$ -- 3. The exact original evidence counts, grouped once for this club-week.
 -- Keep the original lock/freshness/90-second admission and original rows.
 -- Only missing canonical windows are inserted; an existing part is neither
 -- retagged nor qualified by the new body. The grouped kernel preserves the
 -- record-created/source-earned dimensions and full-week source matches.
 IF EXISTS(SELECT FROM generate_series(v_from,v_to-interval '1 microsecond',interval '2 hours') g
  WHERE NOT EXISTS(SELECT FROM public.accounting_recompute_split_parts p
   WHERE p.club_id=p_club_id AND p.period_start=p_period_start AND p.kind='counts'
    AND p.part=((extract(epoch FROM(g-v_from))/7200)::int))) THEN
  IF did AND clock_timestamp()>began+interval '90 seconds' THEN
   RETURN jsonb_build_object('status','in_progress','club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'stage','windows');
  END IF;
  FOR w IN
WITH scopes AS MATERIALIZED(
 SELECT DISTINCT p.id club_id,c.union_id scope_union,
 public.fn_ca_launch_accounting_start('club',p.id,v_from) v_start
 FROM unnest(ARRAY[p_club_id]::uuid[])p(id) LEFT JOIN public.clubs c ON c.id=p.id
), dimensions AS MATERIALIZED(
 SELECT s.*,g window_start,least(g+interval '2 hours',v_to) window_end,
 public.fn_ca_launch_accounting_start('club',s.club_id,g) w_start
 FROM scopes s CROSS JOIN generate_series(v_from,v_to-interval '1 microsecond',interval '2 hours')g
), records AS MATERIALIZED(
 SELECT r.id,r.hand_id,r.club_id,r.rake_amount,r.created_at FROM rake_records r
 WHERE r.created_at>=(SELECT min(w_start) FROM dimensions) AND r.created_at<v_to
 AND r.rake_amount>0 AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
 AND(r.hand_id IS NOT NULL OR NOT fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata))
), attrs AS MATERIALIZED(
 SELECT a.id,a.rake_record_id,a.hand_id,a.player_id,a.club_id,a.weighted_rake_credit
 FROM rake_attributions a WHERE a.rake_record_id=ANY((SELECT array_agg(id)FROM records)::uuid[])
), batches AS MATERIALIZED(
 SELECT b.rake_record_id,b.status FROM accounting_cash_accrual_batches b
 WHERE b.rake_record_id=ANY((SELECT array_agg(id)FROM records)::uuid[])
), sources AS MATERIALIZED(
 SELECT s.id,s.rake_record_id,s.player_id,s.club_id,s.earned_at,s.rake_credit,
 s.contract->>'attribution_id' c_attribution,s.contract->>'player_id' c_player,s.contract->>'club_id' c_club
 FROM accounting_cash_rake_sources s JOIN scopes x ON x.club_id=s.club_id
 WHERE s.earned_at>=x.v_start AND s.earned_at<v_to
 AND s.rake_record_id=ANY((SELECT array_agg(id)FROM records)::uuid[])
), house_proofs AS MATERIALIZED(
 SELECT DISTINCT hs.rake_record_id,hs.player_id,hs.club_id,hs.union_id,hs.earned_at,hs.rake_credit,
 hs.contract->>'attribution_id' c_attribution,hs.contract->>'club_id' c_club,hs.contract->>'player_id' c_player
 FROM accounting_cash_rake_sources hs JOIN batches hb ON hb.rake_record_id=hs.rake_record_id AND hb.status='accrued'
 JOIN clubs house ON house.id=hs.club_id AND house.is_union IS TRUE
 WHERE (house.id=hs.union_id OR house.union_id=hs.union_id)
 AND hs.contract->>'is_union_house'='true' AND hs.contract->>'union_id'=hs.union_id::text
), membership AS MATERIALIZED(
 SELECT s.club_id,r.id FROM scopes s JOIN records r ON r.club_id=s.club_id
 UNION SELECT s.club_id,a.rake_record_id FROM scopes s JOIN attrs a ON a.club_id=s.club_id
 UNION SELECT s.club_id,r.id FROM records r JOIN clubs house ON house.id=r.club_id AND house.is_union IS TRUE
 JOIN scopes s ON s.scope_union IS NOT NULL AND(house.union_id=s.scope_union OR house.id=s.scope_union)
), scoped AS MATERIALIZED(
 SELECT d.club_id,d.scope_union,d.window_start,d.window_end,r.id,r.hand_id,r.rake_amount,r.created_at
 FROM membership m JOIN dimensions d ON d.club_id=m.club_id JOIN records r ON r.id=m.id
 WHERE r.created_at>=d.w_start AND r.created_at<d.window_end
), checks AS(
 SELECT r.club_id target_club,r.window_start,r.id,r.hand_id,r.rake_amount,count(a.id) attribution_count,
 coalesce(sum(a.weighted_rake_credit),0) attributed,
 count(a.id) FILTER(WHERE a.hand_id IS DISTINCT FROM r.hand_id OR a.club_id IS NULL
      OR a.player_id IS NULL OR a.weighted_rake_credit IS NULL OR a.weighted_rake_credit<0
      OR a.weighted_rake_credit<>round(a.weighted_rake_credit,2)
      -- NOT EXISTS(c WHERE id=a.club_id AND (P OR Q))
      --   = NOT EXISTS(c WHERE id=a.club_id AND P) AND NOT EXISTS(c WHERE id=a.club_id AND Q)
      OR (a.club_id NOT IN(SELECT c.id FROM public.clubs c WHERE c.is_union IS NOT TRUE)
       AND hp.rake_record_id IS NULL)) AS invalid_count
 FROM scoped r LEFT JOIN attrs a ON a.rake_record_id=r.id
 LEFT JOIN house_proofs hp ON hp.rake_record_id=r.id AND hp.player_id=a.player_id AND hp.club_id=a.club_id
 AND hp.union_id=r.scope_union AND hp.earned_at=r.created_at AND hp.rake_credit=a.weighted_rake_credit
 AND hp.c_attribution=a.id::text AND hp.c_club=a.club_id::text AND hp.c_player=a.player_id::text
 GROUP BY r.club_id,r.window_start,r.id,r.hand_id,r.rake_amount
), evidence AS(
 SELECT target_club club_id,window_start,count(*) n FROM checks
 WHERE hand_id IS NULL OR attribution_count=0 OR invalid_count>0 OR attributed<>rake_amount OR rake_amount<>round(rake_amount,2)
 GROUP BY target_club,window_start
), incomplete_pairs AS MATERIALIZED(
 SELECT d.club_id target_club,d.window_start,a.id attribution_id,a.player_id attribution_player,
 a.club_id attribution_club,a.weighted_rake_credit attribution_credit,r.id record_id,r.created_at record_at,
 s.id source_id,s.club_id source_club,s.earned_at source_at,s.rake_credit source_credit,s.c_attribution,s.c_player,s.c_club
 FROM attrs a JOIN records r ON r.id=a.rake_record_id
 JOIN dimensions d ON d.club_id=a.club_id AND r.created_at>=d.w_start AND r.created_at<d.window_end
 LEFT JOIN sources s ON s.club_id=d.club_id AND s.rake_record_id=r.id AND s.player_id=a.player_id
), incomplete AS(
 SELECT j.target_club club_id,j.window_start,count(*) n FROM incomplete_pairs j
 LEFT JOIN batches b ON b.rake_record_id=j.record_id
 WHERE j.attribution_id IS NOT NULL AND (j.source_id IS NULL OR b.status IS DISTINCT FROM 'accrued' OR j.source_club IS DISTINCT FROM j.attribution_club
 OR j.source_at IS DISTINCT FROM j.record_at OR j.source_credit IS DISTINCT FROM j.attribution_credit
 OR j.c_attribution IS DISTINCT FROM j.attribution_id::text OR j.c_player IS DISTINCT FROM j.attribution_player::text
 OR j.c_club IS DISTINCT FROM j.attribution_club::text)
 GROUP BY j.target_club,j.window_start
), drifted AS(
 SELECT d.club_id,d.window_start,count(*) n FROM accounting_cash_rake_sources s
 JOIN dimensions d ON d.club_id=s.club_id AND s.earned_at>=d.w_start AND s.earned_at<d.window_end
 LEFT JOIN rake_records r ON r.id=s.rake_record_id
 LEFT JOIN rake_attributions a ON a.id=(s.contract->>'attribution_id')::uuid
 LEFT JOIN accounting_cash_accrual_batches b ON b.rake_record_id=s.rake_record_id
 WHERE true AND (r.id IS NULL OR a.id IS NULL OR b.status IS DISTINCT FROM 'accrued'
     OR a.rake_record_id IS DISTINCT FROM s.rake_record_id OR a.hand_id IS DISTINCT FROM r.hand_id
     OR a.player_id IS DISTINCT FROM s.player_id OR a.club_id IS DISTINCT FROM s.club_id
     OR a.weighted_rake_credit IS DISTINCT FROM s.rake_credit OR s.earned_at IS DISTINCT FROM r.created_at
     OR r.is_tournament IS TRUE OR r.tournament_id IS NOT NULL
     OR NULLIF(s.contract->'union_id','null'::jsonb) IS DISTINCT FROM to_jsonb(s.union_id)
     OR NULLIF(s.contract->'coordinator_union_id','null'::jsonb) IS DISTINCT FROM to_jsonb(s.coordinator_union_id))
 GROUP BY d.club_id,d.window_start
)
SELECT d.club_id,d.window_start,d.window_end,
 jsonb_build_object('evidence',coalesce(e.n,0),'incomplete',coalesce(i.n,0),'drifted',coalesce(f.n,0)) AS value
 FROM dimensions d LEFT JOIN evidence e USING(club_id,window_start)
 LEFT JOIN incomplete i USING(club_id,window_start) LEFT JOIN drifted f USING(club_id,window_start)
  LOOP
   INSERT INTO public.accounting_recompute_split_parts(club_id,period_start,period_end,kind,part,value)
   SELECT p_club_id,p_period_start,p_period_end,'counts',
    (extract(epoch FROM(w.window_start-v_from))/7200)::int,w.value
   WHERE NOT EXISTS(SELECT FROM public.accounting_recompute_split_parts p
    WHERE p.club_id=p_club_id AND p.period_start=p_period_start AND p.kind='counts'
     AND p.part=(extract(epoch FROM(w.window_start-v_from))/7200)::int);
   did:=true;PERFORM set_config('app.accounting_split_did','on',true);
  END LOOP;
 END IF;$new$);
 EXECUTE d;
 IF md5(pg_get_functiondef('public.fn_rakeback_recompute_split(uuid,date,date)'::regprocedure))<>'a4f76df2ab80d5b19ccbd923318658d4' THEN
  RAISE EXCEPTION 'rakeback_grouped_counts_postimage_changed';END IF;
END $grouped_counts$;
COMMIT;

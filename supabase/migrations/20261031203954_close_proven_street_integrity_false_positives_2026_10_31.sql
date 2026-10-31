DO $c$
DECLARE v_ids uuid[]; v_n int;
BEGIN
  WITH a AS (
    SELECT fa.id, (fa.context->>'tableId')::uuid tid, (fa.context->>'handNumber')::bigint hn, (fa.context->>'drift')::numeric drift, (fa.context->>'pot')::numeric pot
    FROM public.financial_alerts fa WHERE fa.source='ServerTableEngine.street_integrity_violation' AND NOT fa.resolved AND fa.context->>'stage'='showdown'
      AND fa.created_at <= '2026-10-31 19:30:00+00'),
  p AS (
    SELECT a.id FROM a JOIN public.hand_atomic_commits h ON h.table_id=a.tid AND h.hand_number=a.hn
    WHERE (h.stack_result->>'success')::boolean AND a.drift=a.pot
      AND abs((SELECT sum((s->>'stack_before')::numeric) FROM jsonb_array_elements(h.stack_result->'request'->'stacks') s)
            + coalesce((h.stack_result->'request'->>'inflow')::numeric,0)
            - (SELECT sum((s->>'stack')::numeric) FROM jsonb_array_elements(h.stack_result->'request'->'stacks') s)
            - coalesce((h.stack_result->'request'->>'rake')::numeric,0) - coalesce((h.stack_result->'request'->>'bbj')::numeric,0)) <= 0.02)
  SELECT array_agg(id ORDER BY id::text) INTO v_ids FROM p;
  IF cardinality(v_ids) <> 167 OR md5(array_to_string(v_ids, ',')) <> '89ef9fcb67026241a66e2606f3aa8074' THEN
    RAISE EXCEPTION 'preview drifted: % rows, md5 %', cardinality(v_ids), md5(array_to_string(v_ids, ','));
  END IF;
  UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
         resolution = 'False positive, proven per hand on 2026-10-31: the committed hand (hand_atomic_commits, success) conserves chips exactly and the reported drift equals the pot. The running engine (eed06fe5) re-read the paid showdown state and counted the pot twice; fixed in #8634 (3252cbaba), not yet deployed. No chips were created or lost.'
   WHERE id = ANY (v_ids) AND NOT resolved;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 167 THEN RAISE EXCEPTION 'expected 167 closed, got %', v_n; END IF;
END $c$;
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_week_quality(p_club_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE event record;scope_union uuid;actual_union uuid;related boolean;unknown_scope boolean;
 proof jsonb;active_ids uuid[];refunded_ids uuid[];checked int:=0;issue_count bigint;
BEGIN
 IF p_club_id IS NULL OR p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_from>=p_to
 THEN RAISE EXCEPTION 'invalid_accounting_tournament_week' USING ERRCODE='22023';END IF;
 SELECT union_id INTO scope_union FROM public.clubs WHERE id=p_club_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_club_not_found' USING ERRCODE='22023';END IF;
 FOR event IN
  WITH candidates AS (
   SELECT tournament_id FROM public.accounting_tournament_fee_recognitions WHERE recognized_at>=p_from AND recognized_at<p_to
   UNION SELECT tournament_id FROM public.tournament_rake_settlements WHERE settled_at>=p_from AND settled_at<p_to
   UNION SELECT tournament_id FROM public.tournament_terminal_settlements WHERE COALESCE(settled_at,completed_at)>=p_from AND COALESCE(settled_at,completed_at)<p_to
   UNION SELECT tournament_id FROM public.tournament_cancellation_receipts WHERE settled_at>=p_from AND settled_at<p_to
   UNION SELECT tournament_id FROM public.tournament_satellite_settlements WHERE settled_at>=p_from AND settled_at<p_to
  ), ev AS (
   SELECT c.tournament_id,r.recognized_at,r.status,r.net_rake,r.union_id,r.bank_club_id,r.source_fingerprint,
    b.settled_at AS bank_at,b.amount AS bank_amount,b.union_id AS bank_union,b.club_id AS fee_bank_club
    FROM candidates c LEFT JOIN public.accounting_tournament_fee_recognitions r USING(tournament_id)
     LEFT JOIN public.tournament_rake_settlements b USING(tournament_id)
  ), fee_scope AS (
   SELECT s.tournament_id,count(*) AS fee_source_count,
    count(DISTINCT COALESCE(s.union_id::text,'private')) AS scope_count,
    min(s.union_id::text)::uuid AS one_union
    FROM public.accounting_tournament_fee_sources s
    JOIN candidates c ON c.tournament_id=s.tournament_id GROUP BY s.tournament_id
  ), club_sourced AS (
   SELECT s.tournament_id FROM public.accounting_tournament_fee_sources s WHERE s.club_id=p_club_id
   UNION
   SELECT s.tournament_id FROM public.accounting_tournament_fee_sources s
    WHERE scope_union IS NOT NULL AND s.coordinator_union_id=scope_union
  ), club_refunded AS (
   SELECT e.tournament_id FROM public.tournament_refund_entitlements e WHERE e.refund_wallet_club_id=p_club_id
  ), scoped AS (
   SELECT e.*,COALESCE(f.fee_source_count,0) AS fee_source_count,COALESCE(f.scope_count,0) AS scope_count,
    CASE WHEN f.scope_count=1 THEN f.one_union END AS source_union,
    COALESCE(e.union_id,e.bank_union,CASE WHEN f.scope_count=1 THEN f.one_union END) AS actual_union
    FROM ev e LEFT JOIN fee_scope f ON f.tournament_id=e.tournament_id
    -- The original's first CONTINUE: an event whose banked/recognised instant
    -- sits outside the week, and whose recognition is outside it too, is not
    -- this week's business at all.
    WHERE COALESCE(e.bank_at,e.recognized_at) IS NULL
       OR (COALESCE(e.bank_at,e.recognized_at)>=p_from AND COALESCE(e.bank_at,e.recognized_at)<p_to)
       OR (e.recognized_at IS NOT NULL AND e.recognized_at>=p_from AND e.recognized_at<p_to)
  ), survivors AS (
   SELECT s.* FROM scoped s
    WHERE COALESCE(s.actual_union=scope_union,false)
       OR COALESCE(s.bank_club_id=p_club_id,false)
       OR COALESCE(s.fee_bank_club=p_club_id,false)
       OR EXISTS(SELECT 1 FROM club_sourced cs WHERE cs.tournament_id=s.tournament_id)
       OR EXISTS(SELECT 1 FROM club_refunded cr WHERE cr.tournament_id=s.tournament_id)
       OR (s.actual_union IS NULL AND (s.status IS NULL OR s.status='banked_accrual_deferred')
        AND (COALESCE(s.net_rake,s.bank_amount,0)>0
         OR EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=s.tournament_id AND r.is_tournament AND r.rake_amount<>0))
        AND (NOT EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=s.tournament_id AND r.is_tournament AND r.rake_amount>0)
         OR EXISTS(SELECT 1 FROM public.rake_records r LEFT JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=r.id
          WHERE r.tournament_id=s.tournament_id AND r.is_tournament AND r.rake_amount>0
           AND (b.status IS DISTINCT FROM 'captured' OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
            OR r.rake_amount IS DISTINCT FROM(SELECT sum(s2.rake_credit) FROM public.accounting_tournament_fee_sources s2 WHERE s2.rake_record_id=r.id)))
         OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s3 WHERE s3.tournament_id=s.tournament_id
          AND (NOT(s3.contract ? 'coordinator_union_id') OR s3.contract->'membership'->>'history_id' IS NULL
           OR s3.contract->>'club_id' IS DISTINCT FROM s3.club_id::text OR s3.contract->>'player_id' IS DISTINCT FROM s3.player_id::text))))
  ), survivor_ids AS MATERIALIZED (
   -- A CTE scan carries no index, so joining the aggregates below to
   -- `survivors` by tournament_id made the planner merge-join a FULL scan of
   -- idx_rake_records_tournament. Handing them one array instead turns every
   -- one of them into `tournament_id = ANY($1)` against the real index.
   SELECT array_agg(k.tournament_id) AS ids FROM survivors k
  ), rr AS MATERIALIZED (
   SELECT r.tournament_id,r.id,r.rake_amount,r.hand_id,public.fn_accounting_tournament_fee_fingerprint(r) AS fp
    FROM public.rake_records r
    WHERE r.is_tournament AND r.tournament_id=ANY((SELECT sid.ids FROM survivor_ids sid)::uuid[])
  ), src_sum AS (
   SELECT s.rake_record_id,sum(s.rake_credit) AS credited
    FROM public.accounting_tournament_fee_sources s JOIN rr ON rr.id=s.rake_record_id GROUP BY s.rake_record_id
  ), rr_agg AS (
   SELECT rr.tournament_id,
    count(*) FILTER(WHERE rr.rake_amount IS NULL OR rr.rake_amount<>round(rr.rake_amount,2)
      OR rr.rake_amount::text IN('NaN','Infinity','-Infinity') OR rr.hand_id IS NOT NULL) AS invalid_rows,
    count(*) FILTER(WHERE rr.rake_amount<0) AS negative_rows,
    COALESCE(sum(rr.rake_amount),0) AS raw_total,
    md5(COALESCE(string_agg(rr.fp,':' ORDER BY rr.id),'')) AS fingerprint
    FROM rr GROUP BY rr.tournament_id
  ), batch_bad AS (
   SELECT rr.tournament_id,count(*) AS bad
    FROM rr LEFT JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=rr.id
            LEFT JOIN src_sum ss ON ss.rake_record_id=rr.id
    WHERE rr.rake_amount>0
     AND ((b.status IS DISTINCT FROM 'captured' AND NOT public.fn_accounting_mixed_cutover_spin_proof_valid(rr.id))
      OR b.tournament_id IS DISTINCT FROM rr.tournament_id
      OR b.source_fingerprint IS DISTINCT FROM rr.fp
      OR b.rake_amount IS DISTINCT FROM rr.rake_amount
      OR b.rake_amount IS DISTINCT FROM ss.credited)
    GROUP BY rr.tournament_id
  ), scope_bad AS (
   SELECT s.tournament_id,count(*) AS bad
    FROM public.accounting_tournament_fee_sources s
    LEFT JOIN rr ON rr.id=s.rake_record_id AND rr.tournament_id=s.tournament_id AND rr.rake_amount>0
    WHERE s.tournament_id=ANY((SELECT sid.ids FROM survivor_ids sid)::uuid[]) AND rr.id IS NULL GROUP BY s.tournament_id
  ), receipt_bad AS (
   SELECT s.tournament_id,count(*) AS bad
    FROM public.accounting_tournament_fee_sources s JOIN survivors k ON k.tournament_id=s.tournament_id
    LEFT JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id
    WHERE s.tournament_id=ANY((SELECT sid.ids FROM survivor_ids sid)::uuid[]) AND (rs.source_id IS NULL OR rs.tournament_id IS DISTINCT FROM s.tournament_id
     OR rs.recognized_at IS DISTINCT FROM k.recognized_at
     OR rs.disposition IS DISTINCT FROM 'earned'
     OR rs.rake_credit IS DISTINCT FROM s.rake_credit
     OR s.contract->>'player_id' IS DISTINCT FROM s.player_id::text
     OR s.contract->>'club_id' IS DISTINCT FROM s.club_id::text
     OR (s.contract->>'rake_credit')::numeric IS DISTINCT FROM s.rake_credit
     OR (s.contract->>'terms_at')::timestamptz IS DISTINCT FROM s.charged_at
     OR s.charged_at>k.recognized_at
     OR NULLIF(s.contract->>'union_id','')::uuid IS DISTINCT FROM s.union_id
     OR NULLIF(s.contract->>'coordinator_union_id','')::uuid IS DISTINCT FROM s.coordinator_union_id)
    GROUP BY s.tournament_id
  ), orphan_bad AS (
   SELECT rs.tournament_id,count(*) AS bad
    FROM public.accounting_tournament_recognized_sources rs
    LEFT JOIN public.accounting_tournament_fee_sources s ON s.id=rs.source_id
    WHERE rs.tournament_id=ANY((SELECT sid.ids FROM survivor_ids sid)::uuid[])
     AND (s.id IS NULL OR s.tournament_id IS DISTINCT FROM rs.tournament_id) GROUP BY rs.tournament_id
  ), earned_sum AS (
   SELECT rs.tournament_id,COALESCE(sum(rs.rake_credit),0) AS earned
    FROM public.accounting_tournament_recognized_sources rs
    WHERE rs.tournament_id=ANY((SELECT sid.ids FROM survivor_ids sid)::uuid[])
     AND rs.disposition='earned' GROUP BY rs.tournament_id
  )
  SELECT k.tournament_id,k.recognized_at,k.status,k.net_rake,k.union_id,k.bank_club_id,k.source_fingerprint,
   k.bank_at,k.bank_amount,k.bank_union,k.fee_bank_club,k.actual_union,k.source_union,k.scope_count,
   COALESCE(a.invalid_rows,0) AS invalid_rows,COALESCE(a.negative_rows,0) AS negative_rows,
   COALESCE(a.raw_total,0) AS raw_total,COALESCE(a.fingerprint,md5('')) AS fingerprint,
   COALESCE(bb.bad,0) AS batch_bad,COALESCE(sb.bad,0) AS scope_bad,COALESCE(rb.bad,0) AS receipt_bad,
   COALESCE(ob.bad,0) AS orphan_bad,COALESCE(es.earned,0) AS earned_sum
   FROM survivors k
   LEFT JOIN rr_agg a ON a.tournament_id=k.tournament_id
   LEFT JOIN batch_bad bb ON bb.tournament_id=k.tournament_id
   LEFT JOIN scope_bad sb ON sb.tournament_id=k.tournament_id
   LEFT JOIN receipt_bad rb ON rb.tournament_id=k.tournament_id
   LEFT JOIN orphan_bad ob ON ob.tournament_id=k.tournament_id
   LEFT JOIN earned_sum es ON es.tournament_id=k.tournament_id
   ORDER BY k.tournament_id
 LOOP
  actual_union:=event.actual_union;
  checked:=checked+1;
  -- `unknown_scope` is REPORTED, not decided, here: `survivors` above already
  -- filters on the identical expression, so it chose the same events either
  -- way. It is still computed VERBATIM rather than abbreviated, because the two
  -- blocked responses below carry it to a reader, and a field that is true a
  -- little more often than it used to be is a wrong answer however cheap it is.
  -- It costs nothing: only an event that is about to be RETURNED reaches it,
  -- and a RETURN ends the loop.
  unknown_scope:=false;
  IF event.status IS NULL OR event.status='banked_accrual_deferred' THEN
   unknown_scope:=actual_union IS NULL
    AND (COALESCE(event.net_rake,event.bank_amount,0)>0
     OR EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=event.tournament_id AND r.is_tournament AND r.rake_amount<>0))
    AND (NOT EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=event.tournament_id AND r.is_tournament AND r.rake_amount>0)
     OR EXISTS(SELECT 1 FROM public.rake_records r LEFT JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=r.id
      WHERE r.tournament_id=event.tournament_id AND r.is_tournament AND r.rake_amount>0
       AND (b.status IS DISTINCT FROM 'captured' OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
        OR r.rake_amount IS DISTINCT FROM(SELECT sum(s.rake_credit) FROM public.accounting_tournament_fee_sources s WHERE s.rake_record_id=r.id)))
     OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s WHERE s.tournament_id=event.tournament_id
      AND (NOT(s.contract ? 'coordinator_union_id') OR s.contract->'membership'->>'history_id' IS NULL
       OR s.contract->>'club_id' IS DISTINCT FROM s.club_id::text OR s.contract->>'player_id' IS DISTINCT FROM s.player_id::text)));
  END IF;
  IF event.status IS NULL THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_terminal_recognition_missing','tournament_id',event.tournament_id,'unknown_scope',unknown_scope);
  END IF;
  IF event.status='banked_accrual_deferred' THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_deferred','tournament_id',event.tournament_id,'unknown_scope',unknown_scope);
  END IF;
  -- An eventual normal/satellite terminal receipt may follow a banked fee in
  -- another week. Only original fee-bank/recognition time chooses its liability.
  IF event.bank_at IS NOT NULL AND (event.bank_at IS DISTINCT FROM event.recognized_at
    OR event.bank_amount IS DISTINCT FROM event.net_rake OR event.bank_union IS DISTINCT FROM event.union_id) THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_bank_disagrees','tournament_id',event.tournament_id);
  END IF;
  IF event.negative_rows=0 AND event.invalid_rows=0 AND event.raw_total>=0
     AND event.scope_count<=1 AND event.batch_bad=0 AND event.scope_bad=0 THEN
   -- net_plan is determined for this event; see the note above 2.3.
   IF event.fingerprint IS DISTINCT FROM event.source_fingerprint
     OR event.raw_total IS DISTINCT FROM event.net_rake
     OR event.source_union IS DISTINCT FROM event.union_id
     OR (event.status='recognized') IS DISTINCT FROM(event.net_rake>0)
     OR (event.status='cancelled') IS DISTINCT FROM(event.net_rake=0) THEN
    RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_disagrees_with_sources','tournament_id',event.tournament_id);
   END IF;
   IF event.receipt_bad>0 OR event.orphan_bad>0 OR event.earned_sum IS DISTINCT FROM event.net_rake THEN
    RETURN jsonb_build_object('status','blocked','reason','tournament_recognized_source_receipts_incomplete','tournament_id',event.tournament_id);
   END IF;
   CONTINUE;
  END IF;
  -- SLOW PATH, unchanged: a refund reversal, or a cheap fact that already
  -- disagrees, still gets the full per-event proof and its exact detail.
  BEGIN proof:=public.fn_accounting_tournament_fee_net_plan(event.tournament_id);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '55000' THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_net_source_evidence_invalid','detail',SQLERRM,'tournament_id',event.tournament_id);
  END;
  IF proof->>'status' IS DISTINCT FROM 'proven' OR proof->>'source_fingerprint' IS DISTINCT FROM event.source_fingerprint
    OR (proof->>'net_fee')::numeric IS DISTINCT FROM event.net_rake OR NULLIF(proof->>'union_id','')::uuid IS DISTINCT FROM event.union_id
    OR (event.status='recognized') IS DISTINCT FROM(event.net_rake>0)
    OR (event.status='cancelled') IS DISTINCT FROM(event.net_rake=0) THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_disagrees_with_sources','tournament_id',event.tournament_id);
  END IF;
  SELECT COALESCE(array_agg(value::uuid),'{}') INTO active_ids FROM jsonb_array_elements_text(proof->'active_source_ids');
  SELECT COALESCE(array_agg(value::uuid),'{}') INTO refunded_ids FROM jsonb_array_elements_text(proof->'refunded_source_ids');
  SELECT count(*) INTO issue_count FROM public.accounting_tournament_fee_sources s
   LEFT JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id
   WHERE s.tournament_id=event.tournament_id AND (rs.source_id IS NULL OR rs.tournament_id IS DISTINCT FROM s.tournament_id
    OR rs.recognized_at IS DISTINCT FROM event.recognized_at
    OR NOT(s.id=ANY(active_ids||refunded_ids))
    OR rs.disposition IS DISTINCT FROM CASE WHEN s.id=ANY(active_ids) THEN 'earned' ELSE 'refunded' END
    OR rs.rake_credit IS DISTINCT FROM CASE WHEN s.id=ANY(active_ids) THEN s.rake_credit ELSE 0 END
    OR s.contract->>'player_id' IS DISTINCT FROM s.player_id::text OR s.contract->>'club_id' IS DISTINCT FROM s.club_id::text
    OR (s.contract->>'rake_credit')::numeric IS DISTINCT FROM s.rake_credit
    OR (s.contract->>'terms_at')::timestamptz IS DISTINCT FROM s.charged_at OR s.charged_at>event.recognized_at
    OR NULLIF(s.contract->>'union_id','')::uuid IS DISTINCT FROM s.union_id
    OR NULLIF(s.contract->>'coordinator_union_id','')::uuid IS DISTINCT FROM s.coordinator_union_id);
  IF issue_count>0 OR EXISTS(SELECT 1 FROM public.accounting_tournament_recognized_sources rs
   LEFT JOIN public.accounting_tournament_fee_sources s ON s.id=rs.source_id
   WHERE rs.tournament_id=event.tournament_id AND (s.id IS NULL OR s.tournament_id IS DISTINCT FROM event.tournament_id))
   OR (SELECT COALESCE(sum(rake_credit),0) FROM public.accounting_tournament_recognized_sources WHERE tournament_id=event.tournament_id AND disposition='earned') IS DISTINCT FROM event.net_rake THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognized_source_receipts_incomplete','tournament_id',event.tournament_id);
  END IF;
 END LOOP;
 RETURN jsonb_build_object('status','ready','checked',checked);
END $function$
;

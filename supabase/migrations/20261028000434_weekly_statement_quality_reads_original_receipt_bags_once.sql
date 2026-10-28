-- The original weekly statement quality retains every source, contract,
-- wrong-event/orphan and refund proof. Materialize the exact event/source-ID
-- bags once so receipt joins do not perform one heap PK probe per source.
-- No monetary rule, payer, function metadata, source65/GEN, cache, grant or
-- document contract changes. Only the original FOR query is replaced.
-- Actual same-snapshot134941 typed rows/full113897103 bytes/EXCEPT ALL0 match;
-- whole original-branch C2 function returned READY134941 in167911ms. Sequential
-- raw timings were cache-confounded and are not a claimed deployed speedup.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure))='5c8b31d9f75c4b3b84cfd17fefb666a0')
BEGIN;
SET LOCAL lock_timeout='1s';SET LOCAL statement_timeout='5s';
DO $original_quality_bags$
DECLARE d text;patched text;metadata jsonb;generation text;seal_definition text;refusal text;
 old_query constant text:=$old_query$  WITH candidates_all AS (
   SELECT tournament_id FROM public.accounting_tournament_fee_recognitions WHERE recognized_at>=p_from AND recognized_at<p_to
   UNION SELECT tournament_id FROM public.tournament_rake_settlements WHERE settled_at>=p_from AND settled_at<p_to
   UNION SELECT tournament_id FROM public.tournament_terminal_settlements WHERE COALESCE(settled_at,completed_at)>=p_from AND COALESCE(settled_at,completed_at)<p_to
   UNION SELECT tournament_id FROM public.tournament_cancellation_receipts WHERE settled_at>=p_from AND settled_at<p_to
   UNION SELECT tournament_id FROM public.tournament_satellite_settlements WHERE settled_at>=p_from AND settled_at<p_to
  ), candidates AS (
   -- A CHIP WEEK READS NO DIAMOND EVENT (2026-10-12): a Diamond Arena event's
   -- fee is settled in Diamonds to the Diamond house and owes no chip rakeback
   -- or commission, so it has no chip recognition and is no chip week's
   -- business (the definition of fn_poker_diamond_tournament).
   SELECT a.tournament_id FROM candidates_all a
    WHERE a.tournament_id NOT IN(SELECT t.id FROM public.tournaments t JOIN public.clubs c ON c.id=t.club_id
     WHERE c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL AND t.union_id IS NULL)
  ), ev AS (
   SELECT c.tournament_id,r.recognized_at,r.status,r.net_rake,r.union_id,r.bank_club_id,r.source_fingerprint,
    b.settled_at AS bank_at,b.amount AS bank_amount,b.union_id AS bank_union,b.club_id AS fee_bank_club
    FROM candidates c LEFT JOIN public.accounting_tournament_fee_recognitions r USING(tournament_id)
     LEFT JOIN public.tournament_rake_settlements b ON b.tournament_id=c.tournament_id
  ), fee_scope AS (
   SELECT s.tournament_id,count(*) AS fee_source_count,
    count(DISTINCT COALESCE(s.union_id::text,'private')) AS scope_count,
    min(s.union_id::text)::uuid AS one_union
    FROM public.accounting_tournament_fee_sources s
    WHERE s.tournament_id=ANY((SELECT array_agg(c.tournament_id) FROM candidates c)::uuid[]) GROUP BY s.tournament_id
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
       OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources cs WHERE cs.tournament_id=s.tournament_id
        AND (cs.club_id=p_club_id OR (scope_union IS NOT NULL AND cs.coordinator_union_id=scope_union)) OFFSET 0)
       OR EXISTS(SELECT 1 FROM public.tournament_refund_entitlements cr WHERE cr.tournament_id=s.tournament_id
        AND cr.refund_wallet_club_id=p_club_id OFFSET 0)
       OR (s.actual_union IS NULL AND (s.status IS NULL OR s.status='banked_accrual_deferred')
        AND (COALESCE(s.net_rake,s.bank_amount,0)>0
         OR EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=s.tournament_id AND r.is_tournament AND r.rake_amount<>0 OFFSET 0))
        AND (NOT EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=s.tournament_id AND r.is_tournament AND r.rake_amount>0 OFFSET 0)
         OR EXISTS(SELECT 1 FROM public.rake_records r LEFT JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=r.id
          WHERE r.tournament_id=s.tournament_id AND r.is_tournament AND r.rake_amount>0
           AND ((b.status IS DISTINCT FROM 'captured' AND NOT public.fn_accounting_owner_direct_fee_proof_valid(b.rake_record_id)) OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
            OR r.rake_amount IS DISTINCT FROM(SELECT sum(s2.rake_credit) FROM public.accounting_tournament_fee_sources s2 WHERE s2.rake_record_id=r.id)) OFFSET 0)
         OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s3 WHERE s3.tournament_id=s.tournament_id
          AND (NOT(s3.contract ? 'coordinator_union_id') OR s3.contract->'membership'->>'history_id' IS NULL
           OR s3.contract->>'club_id' IS DISTINCT FROM s3.club_id::text OR s3.contract->>'player_id' IS DISTINCT FROM s3.player_id::text) OFFSET 0)))
  ), survivor_ids AS MATERIALIZED (
   -- A CTE scan carries no index, so joining the aggregates below to
   -- `survivors` by tournament_id made the planner merge-join a FULL scan of
   -- idx_rake_records_tournament. Handing them one array instead turns every
   -- one of them into `tournament_id = ANY($1)` against the real index.
   SELECT array_agg(k.tournament_id) AS ids FROM survivors k
  ), rr AS MATERIALIZED (
   SELECT r.tournament_id,r.id,r.rake_amount,r.hand_id,md5(jsonb_build_object('id',r.id,'hand_id',r.hand_id,'table_id',r.table_id,'club_id',r.club_id,'rake_amount',r.rake_amount,'bbj_contribution',r.bbj_contribution,'pot_size',r.pot_size,'num_players',r.num_players,'created_at',r.created_at,'player_contributions',r.player_contributions,'global_hand_id',r.global_hand_id,'is_tournament',r.is_tournament,'tournament_id',r.tournament_id,'source',r.source,'metadata',r.metadata,'rake_method',r.rake_method,'returned_uncalled',r.returned_uncalled)::text) AS fp
    FROM public.rake_records r
    WHERE r.is_tournament AND r.tournament_id=ANY((SELECT sid.ids FROM survivor_ids sid)::uuid[])
  ), src_sum AS (
   SELECT s.rake_record_id,sum(s.rake_credit) AS credited
    FROM public.accounting_tournament_fee_sources s
    WHERE s.rake_record_id=ANY((SELECT array_agg(rr.id) FROM rr)::uuid[]) GROUP BY s.rake_record_id
  ), rr_agg AS (
   SELECT rr.tournament_id,
    count(*) FILTER(WHERE rr.rake_amount IS NULL OR rr.rake_amount<>round(rr.rake_amount,2)
      OR rr.rake_amount::text IN('NaN','Infinity','-Infinity') OR rr.hand_id IS NOT NULL) AS invalid_rows,
    count(*) FILTER(WHERE rr.rake_amount<0) AS negative_rows,
    COALESCE(sum(rr.rake_amount),0) AS raw_total,
    md5(COALESCE(string_agg(rr.fp,':' ORDER BY rr.id),'')) AS fingerprint
    FROM rr GROUP BY rr.tournament_id
  ), batch_rows AS MATERIALIZED (
   SELECT b.rake_record_id,b.status,b.tournament_id,b.source_fingerprint,b.rake_amount
    FROM public.accounting_tournament_fee_batches b
    WHERE b.rake_record_id=ANY((SELECT array_agg(rr.id) FROM rr)::uuid[])
  ), batch_bad AS (
   SELECT rr.tournament_id,count(*) AS bad
    FROM rr LEFT JOIN batch_rows b ON b.rake_record_id=rr.id
            LEFT JOIN src_sum ss ON ss.rake_record_id=rr.id
    WHERE rr.rake_amount>0
     AND (((b.status IS DISTINCT FROM 'captured' AND NOT public.fn_accounting_owner_direct_fee_proof_valid(b.rake_record_id)) AND NOT public.fn_accounting_mixed_cutover_spin_proof_valid(rr.id))
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
     OR (s.contract->>'terms_at')::timestamptz IS DISTINCT FROM public.fn_accounting_tournament_source_terms_at(s.tournament_id,s.charged_at,s.contract)
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
   ORDER BY k.tournament_id$old_query$;
 new_query constant text:=$new_query$  WITH candidates_all AS (
   SELECT tournament_id FROM public.accounting_tournament_fee_recognitions WHERE recognized_at>=p_from AND recognized_at<p_to
   UNION SELECT tournament_id FROM public.tournament_rake_settlements WHERE settled_at>=p_from AND settled_at<p_to
   UNION SELECT tournament_id FROM public.tournament_terminal_settlements WHERE COALESCE(settled_at,completed_at)>=p_from AND COALESCE(settled_at,completed_at)<p_to
   UNION SELECT tournament_id FROM public.tournament_cancellation_receipts WHERE settled_at>=p_from AND settled_at<p_to
   UNION SELECT tournament_id FROM public.tournament_satellite_settlements WHERE settled_at>=p_from AND settled_at<p_to
  ), candidates AS (
   -- A CHIP WEEK READS NO DIAMOND EVENT (2026-10-12): a Diamond Arena event's
   -- fee is settled in Diamonds to the Diamond house and owes no chip rakeback
   -- or commission, so it has no chip recognition and is no chip week's
   -- business (the definition of fn_poker_diamond_tournament).
   SELECT a.tournament_id FROM candidates_all a
    WHERE a.tournament_id NOT IN(SELECT t.id FROM public.tournaments t JOIN public.clubs c ON c.id=t.club_id
     WHERE c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL AND t.union_id IS NULL)
  ), ev AS (
   SELECT c.tournament_id,r.recognized_at,r.status,r.net_rake,r.union_id,r.bank_club_id,r.source_fingerprint,
    b.settled_at AS bank_at,b.amount AS bank_amount,b.union_id AS bank_union,b.club_id AS fee_bank_club
    FROM candidates c LEFT JOIN public.accounting_tournament_fee_recognitions r USING(tournament_id)
     LEFT JOIN public.tournament_rake_settlements b ON b.tournament_id=c.tournament_id
  ), fee_scope AS (
   SELECT s.tournament_id,count(*) AS fee_source_count,
    count(DISTINCT COALESCE(s.union_id::text,'private')) AS scope_count,
    min(s.union_id::text)::uuid AS one_union
    FROM public.accounting_tournament_fee_sources s
    WHERE s.tournament_id=ANY((SELECT array_agg(c.tournament_id) FROM candidates c)::uuid[]) GROUP BY s.tournament_id
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
       OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources cs WHERE cs.tournament_id=s.tournament_id
        AND (cs.club_id=p_club_id OR (scope_union IS NOT NULL AND cs.coordinator_union_id=scope_union)) OFFSET 0)
       OR EXISTS(SELECT 1 FROM public.tournament_refund_entitlements cr WHERE cr.tournament_id=s.tournament_id
        AND cr.refund_wallet_club_id=p_club_id OFFSET 0)
       OR (s.actual_union IS NULL AND (s.status IS NULL OR s.status='banked_accrual_deferred')
        AND (COALESCE(s.net_rake,s.bank_amount,0)>0
         OR EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=s.tournament_id AND r.is_tournament AND r.rake_amount<>0 OFFSET 0))
        AND (NOT EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=s.tournament_id AND r.is_tournament AND r.rake_amount>0 OFFSET 0)
         OR EXISTS(SELECT 1 FROM public.rake_records r LEFT JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=r.id
          WHERE r.tournament_id=s.tournament_id AND r.is_tournament AND r.rake_amount>0
           AND ((b.status IS DISTINCT FROM 'captured' AND NOT public.fn_accounting_owner_direct_fee_proof_valid(b.rake_record_id)) OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
            OR r.rake_amount IS DISTINCT FROM(SELECT sum(s2.rake_credit) FROM public.accounting_tournament_fee_sources s2 WHERE s2.rake_record_id=r.id)) OFFSET 0)
         OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s3 WHERE s3.tournament_id=s.tournament_id
          AND (NOT(s3.contract ? 'coordinator_union_id') OR s3.contract->'membership'->>'history_id' IS NULL
           OR s3.contract->>'club_id' IS DISTINCT FROM s3.club_id::text OR s3.contract->>'player_id' IS DISTINCT FROM s3.player_id::text) OFFSET 0)))
  ), survivor_ids AS MATERIALIZED (
   -- A CTE scan carries no index, so joining the aggregates below to
   -- `survivors` by tournament_id made the planner merge-join a FULL scan of
   -- idx_rake_records_tournament. Handing them one array instead turns every
   -- one of them into `tournament_id = ANY(p_club_id)` against the real index.
   SELECT array_agg(k.tournament_id) AS ids FROM survivors k
  ), rr AS MATERIALIZED (
   SELECT r.tournament_id,r.id,r.rake_amount,r.hand_id,md5(jsonb_build_object('id',r.id,'hand_id',r.hand_id,'table_id',r.table_id,'club_id',r.club_id,'rake_amount',r.rake_amount,'bbj_contribution',r.bbj_contribution,'pot_size',r.pot_size,'num_players',r.num_players,'created_at',r.created_at,'player_contributions',r.player_contributions,'global_hand_id',r.global_hand_id,'is_tournament',r.is_tournament,'tournament_id',r.tournament_id,'source',r.source,'metadata',r.metadata,'rake_method',r.rake_method,'returned_uncalled',r.returned_uncalled)::text) AS fp
    FROM public.rake_records r
    WHERE r.is_tournament AND r.tournament_id=ANY((SELECT sid.ids FROM survivor_ids sid)::uuid[])
  ), src_sum AS (
   SELECT s.rake_record_id,sum(s.rake_credit) AS credited
    FROM public.accounting_tournament_fee_sources s
    WHERE s.rake_record_id=ANY((SELECT array_agg(rr.id) FROM rr)::uuid[]) GROUP BY s.rake_record_id
  ), rr_agg AS (
   SELECT rr.tournament_id,
    count(*) FILTER(WHERE rr.rake_amount IS NULL OR rr.rake_amount<>round(rr.rake_amount,2)
      OR rr.rake_amount::text IN('NaN','Infinity','-Infinity') OR rr.hand_id IS NOT NULL) AS invalid_rows,
    count(*) FILTER(WHERE rr.rake_amount<0) AS negative_rows,
    COALESCE(sum(rr.rake_amount),0) AS raw_total,
    md5(COALESCE(string_agg(rr.fp,':' ORDER BY rr.id),'')) AS fingerprint
    FROM rr GROUP BY rr.tournament_id
  ), batch_rows AS MATERIALIZED (
   SELECT b.rake_record_id,b.status,b.tournament_id,b.source_fingerprint,b.rake_amount
    FROM public.accounting_tournament_fee_batches b
    WHERE b.rake_record_id=ANY((SELECT array_agg(rr.id) FROM rr)::uuid[])
  ), batch_bad AS (
   SELECT rr.tournament_id,count(*) AS bad
    FROM rr LEFT JOIN batch_rows b ON b.rake_record_id=rr.id
            LEFT JOIN src_sum ss ON ss.rake_record_id=rr.id
    WHERE rr.rake_amount>0
     AND (((b.status IS DISTINCT FROM 'captured' AND NOT public.fn_accounting_owner_direct_fee_proof_valid(b.rake_record_id)) AND NOT public.fn_accounting_mixed_cutover_spin_proof_valid(rr.id))
      OR b.tournament_id IS DISTINCT FROM rr.tournament_id
      OR b.source_fingerprint IS DISTINCT FROM rr.fp
      OR b.rake_amount IS DISTINCT FROM rr.rake_amount
      OR b.rake_amount IS DISTINCT FROM ss.credited)
    GROUP BY rr.tournament_id
  ), selected_event_sources AS MATERIALIZED (
   SELECT s.* FROM public.accounting_tournament_fee_sources s
    WHERE s.tournament_id=ANY((SELECT sid.ids FROM survivor_ids sid)::uuid[])
  ), selected_event_recognized AS MATERIALIZED (
   SELECT rs.* FROM public.accounting_tournament_recognized_sources rs
    WHERE rs.tournament_id=ANY((SELECT sid.ids FROM survivor_ids sid)::uuid[])
  ), selected_receipt_recognized AS MATERIALIZED (
   -- Receipt join is by source_id, including wrong-event receipts.
   SELECT rs.* FROM public.accounting_tournament_recognized_sources rs
    WHERE rs.source_id=ANY((SELECT array_agg(s.id) FROM selected_event_sources s)::uuid[])
  ), orphan_source_identities AS MATERIALIZED (
   -- Global source identities preserve wrong-event and missing-source semantics.
   SELECT s.id,s.tournament_id FROM public.accounting_tournament_fee_sources s
    WHERE s.id=ANY((SELECT array_agg(rs.source_id) FROM selected_event_recognized rs)::uuid[])
  ), scope_bad AS (
   SELECT s.tournament_id,count(*) AS bad
    FROM selected_event_sources s
    LEFT JOIN rr ON rr.id=s.rake_record_id AND rr.tournament_id=s.tournament_id AND rr.rake_amount>0
    WHERE rr.id IS NULL GROUP BY s.tournament_id
  ), receipt_bad AS (
   SELECT s.tournament_id,count(*) AS bad
    FROM selected_event_sources s JOIN survivors k ON k.tournament_id=s.tournament_id
    LEFT JOIN selected_receipt_recognized rs ON rs.source_id=s.id
    WHERE (rs.source_id IS NULL OR rs.tournament_id IS DISTINCT FROM s.tournament_id
     OR rs.recognized_at IS DISTINCT FROM k.recognized_at
     OR rs.disposition IS DISTINCT FROM 'earned'
     OR rs.rake_credit IS DISTINCT FROM s.rake_credit
     OR s.contract->>'player_id' IS DISTINCT FROM s.player_id::text
     OR s.contract->>'club_id' IS DISTINCT FROM s.club_id::text
     OR (s.contract->>'rake_credit')::numeric IS DISTINCT FROM s.rake_credit
     OR (s.contract->>'terms_at')::timestamptz IS DISTINCT FROM public.fn_accounting_tournament_source_terms_at(s.tournament_id,s.charged_at,s.contract)
     OR s.charged_at>k.recognized_at
     OR NULLIF(s.contract->>'union_id','')::uuid IS DISTINCT FROM s.union_id
     OR NULLIF(s.contract->>'coordinator_union_id','')::uuid IS DISTINCT FROM s.coordinator_union_id)
    GROUP BY s.tournament_id
  ), orphan_bad AS (
   SELECT rs.tournament_id,count(*) AS bad
    FROM selected_event_recognized rs
    LEFT JOIN orphan_source_identities s ON s.id=rs.source_id
    WHERE (s.id IS NULL OR s.tournament_id IS DISTINCT FROM rs.tournament_id) GROUP BY rs.tournament_id
  ), earned_sum AS (
   SELECT rs.tournament_id,COALESCE(sum(rs.rake_credit),0) AS earned
    FROM selected_event_recognized rs
    WHERE rs.disposition='earned' GROUP BY rs.tournament_id
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
   ORDER BY k.tournament_id$new_query$;
BEGIN
 IF current_user<>'postgres'OR session_user<>'postgres'OR auth.uid()IS NOT NULL
  OR NULLIF(current_setting('request.jwt.claims',true),'')IS NOT NULL
  OR NULLIF(current_setting('request.jwt.claim.role',true),'')IS NOT NULL
  OR NULLIF(current_setting('ca.break_window_migration_override',true),'')IS NOT NULL
 THEN RAISE EXCEPTION 'weekly_quality_bags_operator_refused';END IF;
 refusal:=public.fn_ca_break_window_refuses_migrations(now());
 IF refusal IS NOT NULL OR public.fn_platform_frozen()IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary()IS NOT NULL
 THEN RAISE EXCEPTION 'weekly_quality_bags_window_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0))THEN RAISE EXCEPTION 'weekly_quality_bags_scheduler_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261028000434')THEN RAISE EXCEPTION 'weekly_quality_bags_history_replay';END IF;
 SELECT pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc' INTO STRICT d,metadata FROM pg_proc p WHERE p.oid='public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure;
 IF md5(d)<>'f0d1ca9dace0da884c6b7e77f250604f'OR metadata->>'proowner'IS DISTINCT FROM'postgres'::regrole::oid::text
  OR metadata->'prosecdef'IS DISTINCT FROM'true'::jsonb OR metadata->>'provolatile'IS DISTINCT FROM's'
  OR metadata->'proconfig'IS DISTINCT FROM'["search_path=public"]'::jsonb
  OR(SELECT proacl::text FROM pg_proc WHERE oid='public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure)IS DISTINCT FROM'{postgres=X/postgres}'
  OR(length(d)-length(replace(d,old_query,'')))/length(old_query)<>1
 THEN RAISE EXCEPTION 'weekly_quality_bags_exact_preimage_required';END IF;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true THEN RAISE EXCEPTION 'weekly_quality_bags_source65_required';END IF;
 generation:=smarter_private.original_inventory_basis_generation();seal_definition:=pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure);
 IF generation IS NULL THEN RAISE EXCEPTION 'weekly_quality_bags_generation_required';END IF;
 patched:=replace(d,old_query,new_query);
 IF md5(patched)<>'5c8b31d9f75c4b3b84cfd17fefb666a0'THEN RAISE EXCEPTION 'weekly_quality_bags_exact_patch_required';END IF;
 EXECUTE patched;
 IF md5(pg_get_functiondef('public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure))<>'5c8b31d9f75c4b3b84cfd17fefb666a0'
  OR(SELECT md5(prosrc)FROM pg_proc WHERE oid='public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure)<>'16890f9457d269c8b0d2bb5bba7bf0f1'
  OR(SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE p.oid='public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure)IS DISTINCT FROM metadata
  OR pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure)IS DISTINCT FROM seal_definition
  OR smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true OR smarter_private.original_inventory_basis_generation()IS DISTINCT FROM generation
 THEN RAISE EXCEPTION 'weekly_quality_bags_postimage_required';END IF;
END$original_quality_bags$;
COMMIT;

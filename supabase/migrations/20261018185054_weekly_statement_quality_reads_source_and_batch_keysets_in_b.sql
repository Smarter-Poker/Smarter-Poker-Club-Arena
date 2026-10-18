-- The installed per-event query passed literal aggregation but its actual full
-- quality FOR cursor exceeded240s on the original183871-event week (rolled back).
-- Read original rake/source/batch keysets in bulk, preserving every23-field
-- result, NULL/multiplicity predicate, slow-path refusal and whole-function rule.
-- Exact parameterized FOR/full-readset READ ONLY measurement completed183871
-- rows/155206578 bytes in112548.079ms within unchanged180s; not a READY claim.
-- Source40/generation, owner/ACL, certificates, budgets and all money stay owned
-- by their original paths. A rake PK proves the source-credit semijoin is exact.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure))='506dc1f10ee2c9a6cfdef17db555de43')
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $statement_bank_join$
DECLARE
 d text;patched text;metadata jsonb;generation text;refusal text;
 old_join constant text:=$old_query$  WITH candidates_all AS (
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
           AND (b.status IS DISTINCT FROM 'captured' OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
            OR r.rake_amount IS DISTINCT FROM(SELECT sum(s2.rake_credit) FROM public.accounting_tournament_fee_sources s2 WHERE s2.rake_record_id=r.id)) OFFSET 0)
         OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s3 WHERE s3.tournament_id=s.tournament_id
          AND (NOT(s3.contract ? 'coordinator_union_id') OR s3.contract->'membership'->>'history_id' IS NULL
           OR s3.contract->>'club_id' IS DISTINCT FROM s3.club_id::text OR s3.contract->>'player_id' IS DISTINCT FROM s3.player_id::text) OFFSET 0)))
  )
  SELECT k.tournament_id,k.recognized_at,k.status,k.net_rake,k.union_id,k.bank_club_id,k.source_fingerprint,
   k.bank_at,k.bank_amount,k.bank_union,k.fee_bank_club,k.actual_union,k.source_union,k.scope_count,
   a.invalid_rows,a.negative_rows,a.raw_total,a.fingerprint,a.batch_bad,
   s.scope_bad,s.receipt_bad,o.orphan_bad,o.earned_sum
  FROM survivors k
  LEFT JOIN LATERAL (
   SELECT count(*) FILTER(WHERE rr.rake_amount IS NULL OR rr.rake_amount<>round(rr.rake_amount,2)
    OR rr.rake_amount::text IN('NaN','Infinity','-Infinity') OR rr.hand_id IS NOT NULL) AS invalid_rows,
    count(*) FILTER(WHERE rr.rake_amount<0) AS negative_rows,
    COALESCE(sum(rr.rake_amount),0) AS raw_total,
    md5(COALESCE(string_agg(rr.fp,':' ORDER BY rr.id),'')) AS fingerprint,
    count(*) FILTER(WHERE rr.rake_amount>0 AND (
     (b.status IS DISTINCT FROM 'captured' AND NOT public.fn_accounting_mixed_cutover_spin_proof_valid(rr.id))
     OR b.tournament_id IS DISTINCT FROM rr.tournament_id OR b.source_fingerprint IS DISTINCT FROM rr.fp
     OR b.rake_amount IS DISTINCT FROM rr.rake_amount OR b.rake_amount IS DISTINCT FROM ss.credited)) AS batch_bad
   FROM (SELECT r.id,r.tournament_id,r.rake_amount,r.hand_id,md5(jsonb_build_object('id',r.id,'hand_id',r.hand_id,'table_id',r.table_id,'club_id',r.club_id,'rake_amount',r.rake_amount,'bbj_contribution',r.bbj_contribution,'pot_size',r.pot_size,'num_players',r.num_players,'created_at',r.created_at,'player_contributions',r.player_contributions,'global_hand_id',r.global_hand_id,'is_tournament',r.is_tournament,'tournament_id',r.tournament_id,'source',r.source,'metadata',r.metadata,'rake_method',r.rake_method,'returned_uncalled',r.returned_uncalled)::text) AS fp
    FROM public.rake_records r WHERE r.is_tournament AND r.tournament_id=k.tournament_id OFFSET 0) rr
   LEFT JOIN LATERAL (SELECT b0.status,b0.tournament_id,b0.source_fingerprint,b0.rake_amount
    FROM public.accounting_tournament_fee_batches b0 WHERE b0.rake_record_id=rr.id OFFSET 0) b ON true
   LEFT JOIN LATERAL (SELECT sum(s0.rake_credit) AS credited FROM public.accounting_tournament_fee_sources s0
    WHERE s0.rake_record_id=rr.id AND rr.rake_amount>0 OFFSET 0) ss ON true
  ) a ON true
  LEFT JOIN LATERAL (
   SELECT count(*) FILTER(WHERE rr.id IS NULL) AS scope_bad,
    count(*) FILTER(WHERE rs.source_id IS NULL OR rs.tournament_id IS DISTINCT FROM x.tournament_id
     OR rs.recognized_at IS DISTINCT FROM k.recognized_at OR rs.disposition IS DISTINCT FROM 'earned'
     OR rs.rake_credit IS DISTINCT FROM x.rake_credit
     OR x.contract->>'player_id' IS DISTINCT FROM x.player_id::text
     OR x.contract->>'club_id' IS DISTINCT FROM x.club_id::text
     OR (x.contract->>'rake_credit')::numeric IS DISTINCT FROM x.rake_credit
     OR (x.contract->>'terms_at')::timestamptz IS DISTINCT FROM public.fn_accounting_tournament_source_terms_at(x.tournament_id,x.charged_at,x.contract)
     OR x.charged_at>k.recognized_at
     OR NULLIF(x.contract->>'union_id','')::uuid IS DISTINCT FROM x.union_id
     OR NULLIF(x.contract->>'coordinator_union_id','')::uuid IS DISTINCT FROM x.coordinator_union_id) AS receipt_bad
   FROM public.accounting_tournament_fee_sources x
   LEFT JOIN public.rake_records rr ON rr.id=x.rake_record_id AND rr.tournament_id=x.tournament_id AND rr.is_tournament AND rr.rake_amount>0
   LEFT JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=x.id
   WHERE x.tournament_id=k.tournament_id
  ) s ON true
  LEFT JOIN LATERAL (
   SELECT count(*) FILTER(WHERE x.id IS NULL OR x.tournament_id IS DISTINCT FROM rs.tournament_id) AS orphan_bad,
    COALESCE(sum(rs.rake_credit) FILTER(WHERE rs.disposition='earned'),0) AS earned_sum
   FROM public.accounting_tournament_recognized_sources rs
   LEFT JOIN public.accounting_tournament_fee_sources x ON x.id=rs.source_id
   WHERE rs.tournament_id=k.tournament_id
  ) o ON true
  ORDER BY k.tournament_id$old_query$;
 new_join constant text:=$new_query$  WITH candidates_all AS (
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
           AND (b.status IS DISTINCT FROM 'captured' OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
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
   ORDER BY k.tournament_id$new_query$;
 writer_md5 text;reader_md5 text;seed_md5 text;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR auth.uid() IS NOT NULL
  OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL
  OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL
  OR NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL
 THEN RAISE EXCEPTION 'weekly_statement_indexed_quality_operator_refused';END IF;
 refusal:=public.fn_ca_break_window_refuses_migrations(now());
 IF refusal IS NOT NULL OR public.fn_platform_frozen() IS DISTINCT FROM false
  OR public.fn_active_maintenance_release_boundary() IS NOT NULL
 THEN RAISE EXCEPTION 'weekly_statement_indexed_quality_window_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0))
 THEN RAISE EXCEPTION 'weekly_statement_indexed_quality_scheduler_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261018185054')
 THEN RAISE EXCEPTION 'weekly_statement_indexed_quality_history_replay';END IF;
 IF NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations
  WHERE version='20261017223358' AND cardinality(statements)=1
   AND octet_length(statements[1])=28291 AND md5(statements[1])='88e709123e442ba60696eabbc9522666')
  OR NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations
  WHERE version='20261018142435' AND cardinality(statements)=1
   AND octet_length(statements[1])=4243 AND md5(statements[1])='997086f386079fc582e0565e38f2918c')
  OR NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations
  WHERE version='20261018172204' AND cardinality(statements)=1
   AND octet_length(statements[1])=25345 AND md5(statements[1])='19f8dd8aecd7a93861aaebbb180df595')
 THEN RAISE EXCEPTION 'weekly_statement_indexed_quality_installed_producers_required';END IF;
 IF NOT EXISTS(SELECT FROM pg_constraint c JOIN pg_attribute a
  ON a.attrelid=c.conrelid AND a.attname='tournament_id' AND NOT a.attisdropped
  WHERE c.conrelid='public.tournament_rake_settlements'::regclass AND c.contype='p'
   AND c.convalidated AND c.conkey=ARRAY[a.attnum])
 THEN RAISE EXCEPTION 'weekly_statement_indexed_quality_unique_bank_key_required';END IF;
 IF NOT EXISTS(SELECT FROM pg_constraint c JOIN pg_attribute a
  ON a.attrelid=c.conrelid AND a.attname='id' AND NOT a.attisdropped
  WHERE c.conrelid='public.rake_records'::regclass AND c.contype='p'
   AND c.convalidated AND c.conkey=ARRAY[a.attnum])
 THEN RAISE EXCEPTION 'weekly_statement_indexed_quality_unique_rake_key_required';END IF;
 SELECT pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc' INTO STRICT d,metadata
 FROM pg_proc p WHERE p.oid='public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure;
 IF md5(d)<>'446549add594a547005b78935e0895bf'
  OR metadata->>'proowner' IS DISTINCT FROM 'postgres'::regrole::oid::text
  OR metadata->'prosecdef' IS DISTINCT FROM 'true'::jsonb
  OR metadata->>'provolatile' IS DISTINCT FROM 's'
  OR metadata->'proconfig' IS DISTINCT FROM '["search_path=public"]'::jsonb
  OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}'
  OR (length(d)-length(replace(d,old_join,'')))/length(old_join)<>1
 THEN RAISE EXCEPTION 'weekly_statement_indexed_quality_exact_preimage_required';END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'weekly_statement_indexed_quality_current_seal_required';END IF;
 generation:=smarter_private.original_inventory_basis_generation();
 IF generation IS NULL THEN RAISE EXCEPTION 'weekly_statement_indexed_quality_generation_required';END IF;
 writer_md5:=md5(pg_get_functiondef('public.fn_accounting_close_certify(text,uuid,timestamptz,timestamptz,jsonb)'::regprocedure));
 reader_md5:=md5(pg_get_functiondef('public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)'::regprocedure));
 seed_md5:=md5(pg_get_functiondef('public.fn_accounting_close_report_seed(uuid,timestamptz,timestamptz)'::regprocedure));
 IF writer_md5<>'58501728a93f9f4534dbf26d26aba63f' OR reader_md5<>'7b4a5f4572a45db069b6058899614021'
 THEN RAISE EXCEPTION 'weekly_statement_indexed_quality_certificate_authority_required';END IF;
 patched:=replace(d,old_join,new_join);
 IF md5(patched)<>'506dc1f10ee2c9a6cfdef17db555de43'
 THEN RAISE EXCEPTION 'weekly_statement_indexed_quality_patch_required';END IF;
 EXECUTE patched;
 IF md5(pg_get_functiondef('public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure))<>'506dc1f10ee2c9a6cfdef17db555de43'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure)<>'00db0359d0b7f3510412def3b80cd6da'
  OR (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid='public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure) IS DISTINCT FROM metadata
  OR smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true
  OR smarter_private.original_inventory_basis_generation() IS DISTINCT FROM generation
  OR md5(pg_get_functiondef('public.fn_accounting_close_certify(text,uuid,timestamptz,timestamptz,jsonb)'::regprocedure)) IS DISTINCT FROM writer_md5
  OR md5(pg_get_functiondef('public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)'::regprocedure)) IS DISTINCT FROM reader_md5
  OR md5(pg_get_functiondef('public.fn_accounting_close_report_seed(uuid,timestamptz,timestamptz)'::regprocedure)) IS DISTINCT FROM seed_md5
 THEN RAISE EXCEPTION 'weekly_statement_indexed_quality_postimage_required';END IF;
END $statement_bank_join$;
COMMIT;

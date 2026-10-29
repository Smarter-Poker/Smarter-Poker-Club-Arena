-- Read source-credit and receipt membership by each original selected key.
-- DISTINCT member keys preserve the original semijoin bags and every quality check.
-- Read each event fee scope from its original sources; retain selected raw and receipt bags.
-- Decode six grouped result maps by tournament instead of multiplying join estimates.
-- Every original count, sum, fingerprint, refusal, full event row and caller snapshot is retained.
-- No source65/generation owner, grant, raw financial record or money changes.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure))='609720cb15b98f0a9c156ea2aa01eca2')
BEGIN;
SET LOCAL lock_timeout='1s';SET LOCAL statement_timeout='15s';
-- Original financial-source witnesses are read-only qualification. They do not
-- execute under the five-second CREATE FUNCTION statement or widen its budget.
DO $quality_sources_before$
DECLARE generation text;
BEGIN
 IF current_user<>'postgres'OR session_user<>'postgres'OR auth.uid()IS NOT NULL
  OR NULLIF(current_setting('request.jwt.claims',true),'')IS NOT NULL
  OR NULLIF(current_setting('request.jwt.claim.role',true),'')IS NOT NULL
  OR NULLIF(current_setting('ca.break_window_migration_override',true),'')IS NOT NULL
 THEN RAISE EXCEPTION 'weekly_quality_bags_operator_refused';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261028235752')THEN RAISE EXCEPTION 'weekly_quality_bags_history_replay';END IF;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true THEN RAISE EXCEPTION 'weekly_quality_bags_source65_required';END IF;
 generation:=smarter_private.original_inventory_basis_generation();
 IF generation IS NULL THEN RAISE EXCEPTION 'weekly_quality_bags_generation_required';END IF;
 PERFORM set_config('ca.weekly_quality_source_qualification',jsonb_build_object(
  'generation',generation,
  'seal_definition',pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure),
  'generation_definition',pg_get_functiondef('smarter_private.original_inventory_basis_generation()'::regprocedure))::text,true);
END $quality_sources_before$;
SET LOCAL statement_timeout='5s';
DO $original_quality_bags$
DECLARE d text;patched text;metadata jsonb;refusal text;
 expected_metadata jsonb:=$actual_metadata${"oid":"34785647","proacl":["postgres=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"fn_accounting_tournament_week_quality","prorows":0,"pronargs":3,"proowner":"16384","proconfig":["search_path=public"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_club_id","p_from","p_to"],"proargtypes":["2950","1184","1184"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}$actual_metadata$::jsonb;
 old_query constant text:=$old_query$CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_week_quality(p_club_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
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
  WITH candidates_all AS (
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
  ), scoped AS (
   SELECT e.*,COALESCE(f.fee_source_count,0) AS fee_source_count,COALESCE(f.scope_count,0) AS scope_count,
    CASE WHEN f.scope_count=1 THEN f.one_union END AS source_union,
    COALESCE(e.union_id,e.bank_union,CASE WHEN f.scope_count=1 THEN f.one_union END) AS actual_union
    FROM ev e LEFT JOIN LATERAL (
     SELECT count(*) AS fee_source_count,
      count(DISTINCT COALESCE(s.union_id::text,'private')) AS scope_count,
      min(s.union_id::text)::uuid AS one_union
      FROM public.accounting_tournament_fee_sources s
      WHERE s.tournament_id=e.tournament_id GROUP BY s.tournament_id OFFSET 0
    ) f ON true
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
           AND ((b.status IS DISTINCT FROM 'captured' AND NOT (CASE WHEN EXISTS(SELECT 1 FROM public.accounting_owner_direct_fee_proofs original_owner_proof WHERE original_owner_proof.rake_record_id=b.rake_record_id) THEN public.fn_accounting_owner_direct_fee_proof_valid(b.rake_record_id) ELSE false END)) OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
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
    WHERE r.is_tournament AND EXISTS(SELECT 1 FROM survivors original_member WHERE original_member.tournament_id=r.tournament_id)
  ), src_sum AS (
   SELECT s.rake_record_id,sum(s.rake_credit) AS credited
    FROM public.accounting_tournament_fee_sources s
    WHERE EXISTS(SELECT 1 FROM rr original_member WHERE original_member.id=s.rake_record_id) GROUP BY s.rake_record_id
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
    FROM (SELECT DISTINCT original_member.id FROM rr original_member) original_keys CROSS JOIN LATERAL (SELECT original_batch.* FROM public.accounting_tournament_fee_batches original_batch WHERE original_batch.rake_record_id=original_keys.id OFFSET 0) b
  ), batch_bad AS (
   SELECT rr.tournament_id,count(*) AS bad
    FROM rr LEFT JOIN batch_rows b ON b.rake_record_id=rr.id
            LEFT JOIN src_sum ss ON ss.rake_record_id=rr.id
    WHERE rr.rake_amount>0
     AND (((b.status IS DISTINCT FROM 'captured' AND NOT (CASE WHEN EXISTS(SELECT 1 FROM public.accounting_owner_direct_fee_proofs original_owner_proof WHERE original_owner_proof.rake_record_id=b.rake_record_id) THEN public.fn_accounting_owner_direct_fee_proof_valid(b.rake_record_id) ELSE false END)) AND NOT public.fn_accounting_mixed_cutover_spin_proof_valid(rr.id))
      OR b.tournament_id IS DISTINCT FROM rr.tournament_id
      OR b.source_fingerprint IS DISTINCT FROM rr.fp
      OR b.rake_amount IS DISTINCT FROM rr.rake_amount
      OR b.rake_amount IS DISTINCT FROM ss.credited)
    GROUP BY rr.tournament_id
  ), selected_event_sources AS MATERIALIZED (
   SELECT s.* FROM public.accounting_tournament_fee_sources s
    WHERE EXISTS(SELECT 1 FROM survivors original_member WHERE original_member.tournament_id=s.tournament_id)
  ), selected_event_recognized AS MATERIALIZED (
   SELECT rs.* FROM public.accounting_tournament_recognized_sources rs
    WHERE EXISTS(SELECT 1 FROM survivors original_member WHERE original_member.tournament_id=rs.tournament_id)
  ), selected_receipt_recognized AS MATERIALIZED (
   -- Receipt join is by source_id, including wrong-event receipts.
   SELECT rs.* FROM public.accounting_tournament_recognized_sources rs
    WHERE EXISTS(SELECT 1 FROM selected_event_sources original_member WHERE original_member.id=rs.source_id)
  ), orphan_source_identities AS MATERIALIZED (
   -- Global source identities preserve wrong-event and missing-source semantics.
   SELECT s.id,s.tournament_id FROM public.accounting_tournament_fee_sources s
    WHERE EXISTS(SELECT 1 FROM selected_event_recognized original_member WHERE original_member.source_id=s.id)
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
  ), aggregate_maps AS MATERIALIZED (
   SELECT
    (SELECT jsonb_object_agg(x.tournament_id::text,to_jsonb(x)-'tournament_id') FROM rr_agg x) AS rr_agg_map,
    (SELECT jsonb_object_agg(x.tournament_id::text,to_jsonb(x)-'tournament_id') FROM batch_bad x) AS batch_bad_map,
    (SELECT jsonb_object_agg(x.tournament_id::text,to_jsonb(x)-'tournament_id') FROM scope_bad x) AS scope_bad_map,
    (SELECT jsonb_object_agg(x.tournament_id::text,to_jsonb(x)-'tournament_id') FROM receipt_bad x) AS receipt_bad_map,
    (SELECT jsonb_object_agg(x.tournament_id::text,to_jsonb(x)-'tournament_id') FROM orphan_bad x) AS orphan_bad_map,
    (SELECT jsonb_object_agg(x.tournament_id::text,to_jsonb(x)-'tournament_id') FROM earned_sum x) AS earned_sum_map
  )
  SELECT k.tournament_id,k.recognized_at,k.status,k.net_rake,k.union_id,k.bank_club_id,k.source_fingerprint,
   k.bank_at,k.bank_amount,k.bank_union,k.fee_bank_club,k.actual_union,k.source_union,k.scope_count,
   COALESCE(a.invalid_rows,0) AS invalid_rows,COALESCE(a.negative_rows,0) AS negative_rows,
   COALESCE(a.raw_total,0) AS raw_total,COALESCE(a.fingerprint,md5('')) AS fingerprint,
   COALESCE(bb.bad,0) AS batch_bad,COALESCE(sb.bad,0) AS scope_bad,COALESCE(rb.bad,0) AS receipt_bad,
   COALESCE(ob.bad,0) AS orphan_bad,COALESCE(es.earned,0) AS earned_sum
   FROM survivors k CROSS JOIN aggregate_maps m
   LEFT JOIN LATERAL jsonb_to_record(m.rr_agg_map->k.tournament_id::text) AS a(invalid_rows bigint,negative_rows bigint,raw_total numeric,fingerprint text) ON true
   LEFT JOIN LATERAL jsonb_to_record(m.batch_bad_map->k.tournament_id::text) AS bb(bad bigint) ON true
   LEFT JOIN LATERAL jsonb_to_record(m.scope_bad_map->k.tournament_id::text) AS sb(bad bigint) ON true
   LEFT JOIN LATERAL jsonb_to_record(m.receipt_bad_map->k.tournament_id::text) AS rb(bad bigint) ON true
   LEFT JOIN LATERAL jsonb_to_record(m.orphan_bad_map->k.tournament_id::text) AS ob(bad bigint) ON true
   LEFT JOIN LATERAL jsonb_to_record(m.earned_sum_map->k.tournament_id::text) AS es(earned numeric) ON true
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
       AND ((b.status IS DISTINCT FROM 'captured' AND NOT (CASE WHEN EXISTS(SELECT 1 FROM public.accounting_owner_direct_fee_proofs original_owner_proof WHERE original_owner_proof.rake_record_id=b.rake_record_id) THEN public.fn_accounting_owner_direct_fee_proof_valid(b.rake_record_id) ELSE false END)) OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
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
    OR (s.contract->>'terms_at')::timestamptz IS DISTINCT FROM public.fn_accounting_tournament_source_terms_at(s.tournament_id,s.charged_at,s.contract) OR s.charged_at>event.recognized_at
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
$old_query$;
 new_query constant text:=$new_query$CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_week_quality(p_club_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
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
  WITH candidates_all AS (
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
  ), scoped AS (
   SELECT e.*,COALESCE(f.fee_source_count,0) AS fee_source_count,COALESCE(f.scope_count,0) AS scope_count,
    CASE WHEN f.scope_count=1 THEN f.one_union END AS source_union,
    COALESCE(e.union_id,e.bank_union,CASE WHEN f.scope_count=1 THEN f.one_union END) AS actual_union
    FROM ev e LEFT JOIN LATERAL (
     SELECT count(*) AS fee_source_count,
      count(DISTINCT COALESCE(s.union_id::text,'private')) AS scope_count,
      min(s.union_id::text)::uuid AS one_union
      FROM public.accounting_tournament_fee_sources s
      WHERE s.tournament_id=e.tournament_id GROUP BY s.tournament_id OFFSET 0
    ) f ON true
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
           AND ((b.status IS DISTINCT FROM 'captured' AND NOT (CASE WHEN EXISTS(SELECT 1 FROM public.accounting_owner_direct_fee_proofs original_owner_proof WHERE original_owner_proof.rake_record_id=b.rake_record_id) THEN public.fn_accounting_owner_direct_fee_proof_valid(b.rake_record_id) ELSE false END)) OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
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
    WHERE r.is_tournament AND EXISTS(SELECT 1 FROM survivors original_member WHERE original_member.tournament_id=r.tournament_id)
  ), src_sum AS (
   SELECT s.rake_record_id,sum(s.rake_credit) AS credited
    FROM (SELECT DISTINCT original_member.id FROM rr original_member) original_keys
    CROSS JOIN LATERAL (SELECT original_source.rake_record_id,original_source.rake_credit
     FROM public.accounting_tournament_fee_sources original_source
     WHERE original_source.rake_record_id=original_keys.id OFFSET 0) s
    GROUP BY s.rake_record_id
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
    FROM (SELECT DISTINCT original_member.id FROM rr original_member) original_keys CROSS JOIN LATERAL (SELECT original_batch.* FROM public.accounting_tournament_fee_batches original_batch WHERE original_batch.rake_record_id=original_keys.id OFFSET 0) b
  ), batch_bad AS (
   SELECT rr.tournament_id,count(*) AS bad
    FROM rr LEFT JOIN batch_rows b ON b.rake_record_id=rr.id
            LEFT JOIN src_sum ss ON ss.rake_record_id=rr.id
    WHERE rr.rake_amount>0
     AND (((b.status IS DISTINCT FROM 'captured' AND NOT (CASE WHEN EXISTS(SELECT 1 FROM public.accounting_owner_direct_fee_proofs original_owner_proof WHERE original_owner_proof.rake_record_id=b.rake_record_id) THEN public.fn_accounting_owner_direct_fee_proof_valid(b.rake_record_id) ELSE false END)) AND NOT public.fn_accounting_mixed_cutover_spin_proof_valid(rr.id))
      OR b.tournament_id IS DISTINCT FROM rr.tournament_id
      OR b.source_fingerprint IS DISTINCT FROM rr.fp
      OR b.rake_amount IS DISTINCT FROM rr.rake_amount
      OR b.rake_amount IS DISTINCT FROM ss.credited)
    GROUP BY rr.tournament_id
  ), selected_event_sources AS MATERIALIZED (
   SELECT s.* FROM public.accounting_tournament_fee_sources s
    WHERE EXISTS(SELECT 1 FROM survivors original_member WHERE original_member.tournament_id=s.tournament_id)
  ), selected_event_recognized AS MATERIALIZED (
   SELECT rs.* FROM public.accounting_tournament_recognized_sources rs
    WHERE EXISTS(SELECT 1 FROM survivors original_member WHERE original_member.tournament_id=rs.tournament_id)
  ), selected_receipt_recognized AS MATERIALIZED (
   -- Receipt join is by source_id, including wrong-event receipts.
   SELECT rs.* FROM (SELECT DISTINCT original_member.id FROM selected_event_sources original_member) original_keys
    CROSS JOIN LATERAL (SELECT original_receipt.* FROM public.accounting_tournament_recognized_sources original_receipt
     WHERE original_receipt.source_id=original_keys.id OFFSET 0) rs
  ), orphan_source_identities AS MATERIALIZED (
   -- Global source identities preserve wrong-event and missing-source semantics.
   SELECT s.id,s.tournament_id FROM public.accounting_tournament_fee_sources s
    WHERE EXISTS(SELECT 1 FROM selected_event_recognized original_member WHERE original_member.source_id=s.id)
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
  ), aggregate_maps AS MATERIALIZED (
   SELECT
    (SELECT jsonb_object_agg(x.tournament_id::text,to_jsonb(x)-'tournament_id') FROM rr_agg x) AS rr_agg_map,
    (SELECT jsonb_object_agg(x.tournament_id::text,to_jsonb(x)-'tournament_id') FROM batch_bad x) AS batch_bad_map,
    (SELECT jsonb_object_agg(x.tournament_id::text,to_jsonb(x)-'tournament_id') FROM scope_bad x) AS scope_bad_map,
    (SELECT jsonb_object_agg(x.tournament_id::text,to_jsonb(x)-'tournament_id') FROM receipt_bad x) AS receipt_bad_map,
    (SELECT jsonb_object_agg(x.tournament_id::text,to_jsonb(x)-'tournament_id') FROM orphan_bad x) AS orphan_bad_map,
    (SELECT jsonb_object_agg(x.tournament_id::text,to_jsonb(x)-'tournament_id') FROM earned_sum x) AS earned_sum_map
  )
  SELECT k.tournament_id,k.recognized_at,k.status,k.net_rake,k.union_id,k.bank_club_id,k.source_fingerprint,
   k.bank_at,k.bank_amount,k.bank_union,k.fee_bank_club,k.actual_union,k.source_union,k.scope_count,
   COALESCE(a.invalid_rows,0) AS invalid_rows,COALESCE(a.negative_rows,0) AS negative_rows,
   COALESCE(a.raw_total,0) AS raw_total,COALESCE(a.fingerprint,md5('')) AS fingerprint,
   COALESCE(bb.bad,0) AS batch_bad,COALESCE(sb.bad,0) AS scope_bad,COALESCE(rb.bad,0) AS receipt_bad,
   COALESCE(ob.bad,0) AS orphan_bad,COALESCE(es.earned,0) AS earned_sum
   FROM survivors k CROSS JOIN aggregate_maps m
   LEFT JOIN LATERAL jsonb_to_record(m.rr_agg_map->k.tournament_id::text) AS a(invalid_rows bigint,negative_rows bigint,raw_total numeric,fingerprint text) ON true
   LEFT JOIN LATERAL jsonb_to_record(m.batch_bad_map->k.tournament_id::text) AS bb(bad bigint) ON true
   LEFT JOIN LATERAL jsonb_to_record(m.scope_bad_map->k.tournament_id::text) AS sb(bad bigint) ON true
   LEFT JOIN LATERAL jsonb_to_record(m.receipt_bad_map->k.tournament_id::text) AS rb(bad bigint) ON true
   LEFT JOIN LATERAL jsonb_to_record(m.orphan_bad_map->k.tournament_id::text) AS ob(bad bigint) ON true
   LEFT JOIN LATERAL jsonb_to_record(m.earned_sum_map->k.tournament_id::text) AS es(earned numeric) ON true
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
       AND ((b.status IS DISTINCT FROM 'captured' AND NOT (CASE WHEN EXISTS(SELECT 1 FROM public.accounting_owner_direct_fee_proofs original_owner_proof WHERE original_owner_proof.rake_record_id=b.rake_record_id) THEN public.fn_accounting_owner_direct_fee_proof_valid(b.rake_record_id) ELSE false END)) OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
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
    OR (s.contract->>'terms_at')::timestamptz IS DISTINCT FROM public.fn_accounting_tournament_source_terms_at(s.tournament_id,s.charged_at,s.contract) OR s.charged_at>event.recognized_at
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
$new_query$;
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
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261028235752')THEN RAISE EXCEPTION 'weekly_quality_bags_history_replay';END IF;
 SELECT pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc' INTO STRICT d,metadata FROM pg_proc p WHERE p.oid='public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure;
 IF metadata IS DISTINCT FROM expected_metadata OR md5(d)<>'28a130f35342357a4dfa61043f1ce2a2'OR metadata->>'proowner'IS DISTINCT FROM'postgres'::regrole::oid::text
  OR metadata->'prosecdef'IS DISTINCT FROM'true'::jsonb OR metadata->>'provolatile'IS DISTINCT FROM's'
  OR metadata->'proconfig'IS DISTINCT FROM'["search_path=public"]'::jsonb
  OR(SELECT proacl::text FROM pg_proc WHERE oid='public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure)IS DISTINCT FROM'{postgres=X/postgres}'
  OR(length(d)-length(replace(d,old_query,'')))/length(old_query)<>1
 THEN RAISE EXCEPTION 'weekly_quality_bags_exact_preimage_required';END IF;
 IF NULLIF(current_setting('ca.weekly_quality_source_qualification',true),'')IS NULL THEN RAISE EXCEPTION 'weekly_quality_bags_source_qualification_required';END IF;
 patched:=replace(d,old_query,new_query);
 IF md5(patched)<>'609720cb15b98f0a9c156ea2aa01eca2'THEN RAISE EXCEPTION 'weekly_quality_bags_exact_patch_required';END IF;
 EXECUTE patched;
 IF md5(pg_get_functiondef('public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure))<>'609720cb15b98f0a9c156ea2aa01eca2'
  OR(SELECT md5(prosrc)FROM pg_proc WHERE oid='public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure)<>'d83edaf7a00daf70d13167e5d493628d'
  OR(SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE p.oid='public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure)IS DISTINCT FROM metadata
 THEN RAISE EXCEPTION 'weekly_quality_bags_postimage_required';END IF;
END$original_quality_bags$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_week_quality(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
SET LOCAL statement_timeout='15s';
-- A failed or timed-out post-witness aborts the same transaction, including DDL.
DO $quality_sources_after$
DECLARE qualified jsonb;
BEGIN
 qualified:=NULLIF(current_setting('ca.weekly_quality_source_qualification',true),'')::jsonb;
 IF qualified IS NULL
  OR pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure)IS DISTINCT FROM qualified->>'seal_definition'
  OR pg_get_functiondef('smarter_private.original_inventory_basis_generation()'::regprocedure)IS DISTINCT FROM qualified->>'generation_definition'
  OR smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true
  OR smarter_private.original_inventory_basis_generation()IS DISTINCT FROM qualified->>'generation'
 THEN RAISE EXCEPTION 'weekly_quality_bags_postimage_required';END IF;
END $quality_sources_after$;
SET LOCAL statement_timeout='5s';
COMMIT;

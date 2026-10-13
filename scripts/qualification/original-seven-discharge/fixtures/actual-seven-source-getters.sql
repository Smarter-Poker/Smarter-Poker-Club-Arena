SET check_function_bodies=off;
-- Closed source allowlist. This reader performs no dynamic SQL and no writes.
-- Closed source allowlist. This reader performs no dynamic SQL and no writes.
CREATE OR REPLACE FUNCTION smarter_private.original_inventory_source_ref_md5(ref jsonb)
RETURNS text LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $refs$
DECLARE n integer;digest text;k text;v_ref_id uuid;v_ref_other uuid;sid bigint;economic jsonb;s record;d record;a record;
BEGIN
 IF ref IS NULL OR jsonb_typeof(ref) IS DISTINCT FROM 'object' OR ref->>'kind' IS NULL THEN RETURN NULL;END IF;
 k:=ref->>'kind';
 IF k='inventory_event' THEN
  sid:=(ref->>'id')::bigint;SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM public.union_pnl_inventory_events t WHERE t.event_id=sid;
 ELSIF k='migration_source' THEN
  SELECT count(*),min(md5(array_to_string(t.statements,E'\n'))) INTO n,digest FROM supabase_migrations.schema_migrations t
  WHERE t.version=ref->>'id' AND cardinality(t.statements)=1;
 ELSIF k='mint_ledger' THEN
  SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM public.ca_mint_ledger t WHERE t.op_id=ref->>'id';
 ELSIF k='wallet_credit_idempotency' THEN
  SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM public.wallet_credit_idempotency t WHERE t.key=ref->>'id';
 ELSE
  v_ref_id:=(ref->>'id')::uuid;
  CASE k
  WHEN 'chip_ledger' THEN SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM public.chip_ledger t WHERE t.id=v_ref_id;
  WHEN 'chip_transaction' THEN SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM public.chip_transactions t WHERE t.id=v_ref_id;
  WHEN 'cash_move' THEN SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM public.cash_participant_moves t WHERE t.id=v_ref_id;
  WHEN 'wallet_transaction' THEN SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM public.wallet_transactions t WHERE t.id=v_ref_id;
  WHEN 'cash_manifest' THEN SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM public.cash_hand_participant_manifests t WHERE t.id=v_ref_id;
  WHEN 'cash_funding' THEN SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM public.cash_participant_funding_receipts t WHERE t.id=v_ref_id;
  WHEN 'tournament_funding' THEN SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM public.tournament_participant_funding_receipts t WHERE t.id=v_ref_id;
  WHEN 'original_hand_qualification' THEN SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM smarter_private.retirement_original_hand_qualification t WHERE t.submission_id=v_ref_id;
  WHEN 'original_hand_restoration' THEN SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM smarter_private.retirement_original_hand_restorations t WHERE t.submission_id=v_ref_id;
  WHEN 'cash_qualification' THEN SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM smarter_private.retired_cash_hand_qualification t WHERE t.submission_id=v_ref_id;
  WHEN 'cash_custody' THEN
   v_ref_other:=(ref->>'other_id')::uuid;
   SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM smarter_private.retired_cash_hand_custody t WHERE t.submission_id=v_ref_id AND t.user_id=v_ref_other;
  WHEN 'undealt_qualification' THEN SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM smarter_private.retirement_undealt_paid_entry_qualification t WHERE t.tournament_id=v_ref_id;
  WHEN 'undealt_restoration' THEN SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM smarter_private.retirement_undealt_paid_entry_restorations t WHERE t.tournament_id=v_ref_id;
  WHEN 'terminal_settlement' THEN SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM public.tournament_terminal_settlements t WHERE t.tournament_id=v_ref_id;
  WHEN 'cancellation_receipt' THEN SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM public.tournament_cancellation_receipts t WHERE t.tournament_id=v_ref_id;
  WHEN 'tournament_payout' THEN SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM public.tournament_payouts t WHERE t.id=v_ref_id;
  WHEN 'tournament_credit' THEN SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM public.tournament_accounting_credit_receipts t WHERE t.id=v_ref_id;
  WHEN 'satellite_settlement' THEN SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM public.tournament_satellite_settlements t WHERE t.tournament_id=v_ref_id;
  WHEN 'satellite_award' THEN
   v_ref_other:=(ref->>'other_id')::uuid;
   SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM public.tournament_satellite_awards t WHERE t.tournament_id=v_ref_id AND t.user_id=v_ref_other;
  WHEN 'tournament_ticket' THEN SELECT count(*),min(md5(to_jsonb(t)::text)) INTO n,digest FROM public.tournament_tickets t WHERE t.id=v_ref_id;
  WHEN 'atomic_economics' THEN
   SELECT count(*),min(md5(jsonb_build_object('hand_id',t.hand_id,'table_id',t.table_id,'hand_number',t.hand_number,
    'payload_hash',t.payload_hash,'stack_result',t.stack_result,'committed_at',t.committed_at,
    'post_commit_completed_at',t.post_commit_completed_at,'post_commit_result',t.post_commit_result)::text)) INTO n,digest
   FROM public.hand_atomic_commits t WHERE t.hand_id=v_ref_id;
  WHEN 'signed_economics' THEN
   SELECT count(*) INTO n FROM smarter_private.hand_submissions t WHERE t.submission_id=v_ref_id;
   IF n IS DISTINCT FROM 1 THEN RETURN NULL;END IF;
   SELECT * INTO s FROM smarter_private.hand_submissions t WHERE t.submission_id=v_ref_id;
   IF NOT FOUND THEN RETURN NULL;END IF;
   IF s.request<>'{}'::jsonb THEN
    economic:=jsonb_build_object('submission_id',s.submission_id,'request_hash',s.request_hash,'table_id',s.table_id,
     'hand_number',s.hand_number,'lease_generation',s.lease_generation,'stacks',s.request->'p_stacks','started_at',s.request#>>'{p_hand_row,started_at}');
   ELSE
    -- Reconstruct only the captured card-free economic DTO under the existing
    -- qualified retention disposal. Missing payload alone is never authority.
    SELECT count(*) INTO n FROM smarter_private.hand_submission_disposals t WHERE t.submission_id=v_ref_id AND t.table_id=s.table_id AND t.hand_number=s.hand_number;
    IF n IS DISTINCT FROM 1 THEN RETURN NULL;END IF;
    SELECT * INTO d FROM smarter_private.hand_submission_disposals t WHERE t.submission_id=v_ref_id AND t.table_id=s.table_id AND t.hand_number=s.hand_number;
    IF NOT FOUND THEN RETURN NULL;END IF;
    SELECT * INTO a FROM public.hand_atomic_commits t WHERE t.hand_id=v_ref_id AND t.table_id=s.table_id AND t.hand_number=s.hand_number;
    IF NOT FOUND OR s.retained_at IS NULL OR NOT isfinite(s.retained_at)
    OR a.post_commit_completed_at IS NULL OR NOT isfinite(a.post_commit_completed_at) OR a.post_commit_result->>'ok' IS DISTINCT FROM 'true'
    OR d.expected->>'kind' IS DISTINCT FROM 'retention_pruned_settled_hand'
    OR d.expected->>'settled' IS DISTINCT FROM 'true' OR d.expected->>'settlement_completed' IS DISTINCT FROM 'true'
    OR d.expected->>'submission_id' IS DISTINCT FROM v_ref_id::text OR d.expected->>'pruned_hand_id' IS DISTINCT FROM v_ref_id::text
    OR d.expected->>'table_id' IS DISTINCT FROM s.table_id::text OR d.expected->>'hand_number' IS DISTINCT FROM s.hand_number::text
    OR d.expected->>'request_hash' IS DISTINCT FROM s.request_hash
    OR (d.expected->>'settlement_completed_at')::timestamptz IS DISTINCT FROM a.post_commit_completed_at
    OR (d.expected->>'disposed_at')::timestamptz IS NULL OR NOT isfinite((d.expected->>'disposed_at')::timestamptz)
    OR (d.expected->>'disposed_at')::timestamptz>clock_timestamp()
    OR (d.expected->>'hand_created_at')::timestamptz IS NULL OR NOT isfinite((d.expected->>'hand_created_at')::timestamptz)
    OR (d.expected->>'disposed_at')::timestamptz < (d.expected->>'hand_created_at')::timestamptz+interval '8 days'
    OR (d.expected->>'disposed_at')::timestamptz < a.post_commit_completed_at+interval '8 days'
    OR (d.expected->>'disposed_at')::timestamptz < s.retained_at+interval '8 days'
    OR (SELECT horse_retention_days FROM public.hand_history_retention_policy LIMIT 1) IS DISTINCT FROM 8
    THEN RETURN NULL;END IF;
    economic:=ref->'economic';
    IF jsonb_typeof(economic) IS DISTINCT FROM 'object' OR economic->>'submission_id' IS DISTINCT FROM v_ref_id::text
    OR economic->>'request_hash' IS DISTINCT FROM s.request_hash OR economic->>'table_id' IS DISTINCT FROM s.table_id::text
    OR economic->>'hand_number' IS DISTINCT FROM s.hand_number::text OR economic->>'lease_generation' IS DISTINCT FROM s.lease_generation::text
    OR jsonb_typeof(economic->'stacks') IS DISTINCT FROM 'array' OR jsonb_array_length(economic->'stacks')=0
    OR economic->>'started_at' IS NULL OR NOT isfinite((economic->>'started_at')::timestamptz)
    OR (economic->>'started_at')::timestamptz>a.committed_at THEN RETURN NULL;END IF;
   END IF;
   n:=1;digest:=md5(economic::text);
  ELSE RETURN NULL;
  END CASE;
 END IF;
 IF n IS DISTINCT FROM 1 OR digest IS NULL THEN RETURN NULL;END IF;
 RETURN digest;
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN RETURN NULL;
END $refs$;
ALTER FUNCTION smarter_private.original_inventory_source_ref_md5(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.original_inventory_source_ref_md5(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION smarter_private.original_inventory_finite_witness(p_event_id bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,smarter_private AS $body$
DECLARE c record;r jsonb;n integer;distinct_n integer;
BEGIN
 SELECT * INTO c FROM smarter_private.original_inventory_restoration_cases WHERE event_id=p_event_id;
 IF NOT FOUND OR c.original_witness IS NULL OR c.witness_md5 IS DISTINCT FROM md5(c.original_witness::text)
 OR jsonb_typeof(c.source_refs) IS DISTINCT FROM 'array' OR jsonb_array_length(c.source_refs)=0 THEN RETURN NULL;END IF;
 SELECT count(*),count(DISTINCT jsonb_build_array(x->>'kind',x->>'id',x->>'other_id')) INTO n,distinct_n FROM jsonb_array_elements(c.source_refs) x;
 IF n IS DISTINCT FROM distinct_n THEN RETURN NULL;END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(c.source_refs) LOOP
 IF r->>'md5' IS NULL OR r->>'md5' !~ '^[0-9a-f]{32}$'
 OR smarter_private.original_inventory_source_ref_md5(r) IS DISTINCT FROM r->>'md5' THEN RETURN NULL;END IF;
 END LOOP;
 RETURN c.original_witness;
END $body$;
ALTER FUNCTION smarter_private.original_inventory_finite_witness(bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.original_inventory_finite_witness(bigint) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION smarter_private.original_erased_cash_base_request(p_event_id bigint,p_expected_hash text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $body$
DECLARE f jsonb;p jsonb;c record;
BEGIN
 SELECT * INTO c FROM smarter_private.original_inventory_restoration_cases WHERE event_id=p_event_id;
 IF NOT FOUND OR c.family IS DISTINCT FROM 'erased_cash_receivable'
 OR p_expected_hash IS NULL THEN
 RETURN jsonb_build_object('status','blocked','reason','unknown_or_changed_original_cash_request');END IF;
 f:=smarter_private.original_inventory_finite_witness(p_event_id);
 IF f IS NULL THEN
 RETURN jsonb_build_object('status','blocked','reason','original_cash_source_refused');END IF;
 f:=f-'original_table_scope'-'original_manifest_scope';
 IF md5(f::text) IS DISTINCT FROM p_expected_hash THEN
 RETURN jsonb_build_object('status','blocked','reason','original_cash_source_refused');END IF;
 p:=smarter_private.original_erased_cash_base_proof(f,'2026-10-12 07:00:00Z');
 IF p->>'status' IS DISTINCT FROM 'ready' OR p->'financial_admission' IS DISTINCT FROM 'false'::jsonb THEN RETURN p;END IF;
 RETURN jsonb_build_object('status','ready','financial_admission',false,'event_id',p_event_id,
 'case_witness_md5',c.witness_md5,'witness_md5',p_expected_hash,'witness',f,'proof',p,'proof_md5',md5(p::text));
END $body$;
ALTER FUNCTION smarter_private.original_erased_cash_base_request(bigint,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.original_erased_cash_base_request(bigint,text) FROM PUBLIC,anon,authenticated,service_role;

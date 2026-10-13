-- Additive original restitution flow. It never rewrites the captured flow ledger.
-- The finite case must have an original table-scope witness, exact immutable
-- certificate, source-ref reproof and actual original transaction table link.
CREATE OR REPLACE FUNCTION smarter_private.original_restoration_cash_returns(p_union_id uuid,p_start timestamptz,p_end timestamptz)
RETURNS TABLE(ledger_id uuid,club_id uuid,user_id uuid,buyins numeric,cashouts numeric,kind text,valid boolean)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $body$
DECLARE c record;f jsonb;p jsonb;t jsonb;l jsonb;scope jsonb;
BEGIN
 IF p_union_id IS DISTINCT FROM 'fade0000-0000-0000-0000-000000000001'::uuid THEN RETURN;END IF;
 IF p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_end<=p_start THEN RETURN;END IF;
 FOR c IN SELECT k.* FROM smarter_private.original_inventory_restoration_cases k
 JOIN smarter_private.original_inventory_restoration_certificates z USING(event_id)
 WHERE k.family='returned_cash' AND z.boundary='2026-10-12 07:00:00Z'
 AND z.witness_md5=k.witness_md5 AND z.proof_md5=md5(z.proof::text)
 AND z.original_witness=k.original_witness LOOP
  IF (c.original_witness#>>'{original_chip_transaction,created_at}')::timestamptz<p_start OR (c.original_witness#>>'{original_chip_transaction,created_at}')::timestamptz>=p_end THEN CONTINUE;END IF;
  f:=smarter_private.original_inventory_finite_witness(c.event_id);
  IF f IS NULL THEN RAISE EXCEPTION 'original_restoration_cash_flow_source_refused' USING ERRCODE='55000';END IF;
  p:=smarter_private.original_returned_cash_base_proof(f,'2026-10-05 07:00:00Z','2026-10-12 07:00:00Z');
  t:=f->'original_chip_transaction';l:=f->'base_ledger';scope:=f->'original_table_scope';
  IF p->>'status' IS DISTINCT FROM 'ready' OR p->'financial_admission' IS DISTINCT FROM 'false'::jsonb
  OR scope->>'union_id' IS DISTINCT FROM p_union_id::text OR scope->>'id' IS DISTINCT FROM f#>>'{event,before_row,table_id}'
  OR scope->'is_private' IS DISTINCT FROM 'false'::jsonb OR scope->'tournament_id' IS DISTINCT FROM 'null'::jsonb
  OR f#>>'{original_manifest_scope,asset}' IS DISTINCT FROM 'chips'
  OR f#>'{original_manifest_scope,unit_scale}' IS DISTINCT FROM '2'::jsonb
  OR f#>>'{original_manifest_scope,game_union_id}' IS DISTINCT FROM p_union_id::text
  OR f#>'{original_manifest_scope,tournament_id}' IS DISTINCT FROM 'null'::jsonb
  OR t->>'transaction_type' IS DISTINCT FROM 'seat_credit_restored'
  OR t#>>'{metadata,restore_key}' IS DISTINCT FROM f->>'restore_key'
  OR t->>'table_id' IS DISTINCT FROM scope->>'id' OR t->>'to_user_id' IS DISTINCT FROM p->>'original_user'
  OR t->>'club_id' IS DISTINCT FROM p->>'original_owner'
  OR t->'is_reversed' IS DISTINCT FROM 'false'::jsonb OR t->'clawed_back' IS DISTINCT FROM 'false'::jsonb
  OR (t->>'amount')::numeric IS DISTINCT FROM (p->>'original_base_returned')::numeric
  OR (t->>'created_at')::timestamptz IS DISTINCT FROM (f#>>'{base_mint,created_at}')::timestamptz
  OR (t->>'created_at')::timestamptz<p_start OR (t->>'created_at')::timestamptz>=p_end
  OR EXISTS(SELECT 1 FROM public.union_pnl_original_flows old WHERE old.ledger_id=(l->>'id')::uuid)
  THEN RAISE EXCEPTION 'original_restoration_cash_flow_proof_refused' USING ERRCODE='55000';END IF;
  ledger_id:=(l->>'id')::uuid;club_id:=(p->>'original_owner')::uuid;user_id:=(p->>'original_user')::uuid;
  buyins:=0;cashouts:=(p->>'original_base_returned')::numeric;kind:='cash_return';valid:=true;RETURN NEXT;
 END LOOP;
END $body$;
ALTER FUNCTION smarter_private.original_restoration_cash_returns(uuid,timestamptz,timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.original_restoration_cash_returns(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

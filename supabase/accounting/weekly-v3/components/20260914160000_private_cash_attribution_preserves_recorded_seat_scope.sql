-- Forward source correction only. Bank destination, rates, historical rows,
-- accepted-hand writers and the one downstream accounting authority are unchanged.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p
   WHERE p.oid=to_regprocedure('public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)')
    AND md5(p.prosrc)='9ac29f1d313dbc33f862efd3ee11e3a1'
    AND p.prosecdef AND p.provolatile='s') THEN
  RAISE EXCEPTION 'cash earning club source changed before private-seat correction';
 END IF;
 IF to_regprocedure('public.fn_process_cash_accounting_source(uuid)') IS NULL
  OR to_regprocedure('public.fn_accounting_cash_commission_plan(uuid)') IS NULL
  OR to_regclass('public.accounting_cash_source_receipts') IS NULL THEN
  RAISE EXCEPTION 'durable cash-source refusal authority required before private-seat correction';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_attribute a
  WHERE a.attrelid='public.rake_attributions'::regclass AND a.attname='club_id'
   AND NOT a.attnotnull AND NOT a.atthasdef AND NOT a.attisdropped) THEN
  RAISE EXCEPTION 'unknown earning club must remain nullable without a default';
 END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fn_cash_earning_club(p_hand_id uuid,p_table_id uuid,p_player_id uuid,p_source_club uuid,p_union_id uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE started timestamptz;clubs uuid[];
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_hand_id IS NULL OR p_table_id IS NULL OR p_player_id IS NULL OR p_source_club IS NULL THEN
  RAISE EXCEPTION 'cash_earning_identity_missing' USING ERRCODE='23514'; END IF;
 SELECT h.started_at INTO started FROM public.hand_history h WHERE h.id=p_hand_id AND h.table_id=p_table_id;
 IF p_union_id IS NULL THEN
  -- Private games may admit a seat funded by another club. Preserve the
  -- actual club at the hand's start; the host only identifies the bank route.
  -- This reader runs before banking an already accepted hand. Unknown seat
  -- evidence must therefore stay NULL, not abort its bank obligation or invent
  -- host ownership. The existing source worker durably refuses that NULL or
  -- an unsupported cross-club liability after the exact bank receipt exists.
  IF started IS NULL OR NOT isfinite(started) OR started>transaction_timestamp() THEN RETURN NULL; END IF;
  SELECT array_agg(DISTINCT s.club_id) INTO clubs FROM public.table_seats s
   WHERE s.table_id=p_table_id AND s.user_id=p_player_id
    AND s.joined_at<=started AND (s.left_at IS NULL OR s.left_at>started);
  -- An overlapping unknown-club seat also makes the evidence ambiguous.
  IF cardinality(clubs) IS DISTINCT FROM 1 OR clubs[1] IS NULL
   OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=clubs[1] AND c.is_union IS NOT TRUE)
  THEN RETURN NULL; END IF;
  RETURN clubs[1];
 END IF;
 -- Preserve the existing shared-union validation and failure contract.
 IF started IS NULL OR started>transaction_timestamp() THEN RAISE EXCEPTION 'cash_hand_start_not_recorded' USING ERRCODE='23514'; END IF;
 SELECT array_agg(DISTINCT s.club_id) INTO clubs FROM public.table_seats s
  WHERE s.table_id=p_table_id AND s.user_id=p_player_id AND s.club_id IS NOT NULL
   AND s.joined_at<=started AND (s.left_at IS NULL OR s.left_at>started);
 IF cardinality(clubs) IS DISTINCT FROM 1
  OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=clubs[1]
   AND (c.is_union IS NOT TRUE OR c.id=p_union_id OR c.union_id=p_union_id))
 THEN RAISE EXCEPTION 'cash_earning_seat_provenance_missing_or_ambiguous' USING ERRCODE='23514'; END IF;
 RETURN clubs[1];
END $function$;
REVOKE ALL ON FUNCTION public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid) TO service_role;
COMMIT;

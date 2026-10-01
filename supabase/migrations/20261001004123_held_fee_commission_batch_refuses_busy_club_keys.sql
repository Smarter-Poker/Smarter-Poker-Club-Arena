-- PR5676 made cash commission batches acquire per-club advisory keys before
-- their commission relation locks. The historical fee owner already holds
-- a strong relation lock when recognition reaches the commission trigger.
-- Waiting for the cash writer's key here would invert that order. Acquire
-- only keys for the exact positive commission rows with a nonblocking try:
-- a busy key aborts the existing atomic transaction instead of forming a cycle.
-- Ordinary recognition, rewards, amounts, source identity and all real row and
-- statement guards remain unchanged. No retry, timeout increase or bypass.
BEGIN;
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='1s';
DO $patch$
DECLARE original text; anchor text; replacement text;
BEGIN
 original:=pg_get_functiondef('public.fn_recognize_accounting_tournament_fees(uuid,timestamptz,uuid,uuid,uuid)'::regprocedure);
 IF md5(original)<>'47f6df5dd04a1a8610e432381f50fe98'
  OR md5(pg_get_functiondef('public.trg_agent_commission_rollup_insert()'::regprocedure))<>'c7e84377219a39d955783d0feae6642b'
  OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}'
   FROM pg_proc WHERE oid='public.fn_recognize_accounting_tournament_fees(uuid,timestamptz,uuid,uuid,uuid)'::regprocedure)
 THEN RAISE EXCEPTION 'held_fee_commission_key_predecessor_changed'; END IF;
 anchor:='  INSERT INTO public.agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,notes,created_at)';
 IF (length(original)-length(replace(original,anchor,'')))/length(anchor)<>1 THEN
  RAISE EXCEPTION 'held_fee_commission_key_boundary_changed'; END IF;
 replacement:=$body$  -- Cash writers may hold a club key while waiting for our relation lock.
  -- Never wait back on them: refuse and roll back this whole owner operation.
  FOR source IN SELECT DISTINCT (s.contract->>'club_id')::uuid club_id
   FROM public.accounting_tournament_fee_sources s
   CROSS JOIN LATERAL jsonb_array_elements(s.contract->'tiers') tier(value)
   WHERE s.id=ANY(active_ids) AND (tier.value->>'amount')::numeric>0
   ORDER BY 1 LOOP
   IF NOT pg_try_advisory_xact_lock(hashtextextended('agent-commission:'||source.club_id::text,0)) THEN
    -- The payer retries 55P03 while retaining its outer locks. This admission
    -- refusal must propagate instead, releasing the complete owner transaction.
    RAISE EXCEPTION 'held_fee_commission_club_busy' USING ERRCODE='55000';
   END IF;
  END LOOP;
$body$||anchor;
 EXECUTE replace(original,anchor,replacement);
END $patch$;
REVOKE ALL ON FUNCTION public.fn_recognize_accounting_tournament_fees(uuid,timestamptz,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;

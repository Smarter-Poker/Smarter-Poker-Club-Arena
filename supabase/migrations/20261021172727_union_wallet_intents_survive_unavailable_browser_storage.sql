-- 20261021172727_union_wallet_intents_survive_unavailable_browser_storage
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-21 17:27:27 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- UnionWalletModal refused the owner's 4,900,000-chip pull before its RPC
-- because localStorage could not retain the retry key. Reserve that key in
-- PostgreSQL instead. This table moves no funds; existing exact-operation
-- money RPCs retain authority. An unknown outcome never expires or rotates.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
CREATE TABLE public.union_wallet_browser_intents (
  actor_id uuid NOT NULL,
  union_id uuid NOT NULL,
  wallet_key text NOT NULL CHECK (wallet_key IN ('chips','rake','bbj','promo','spin_reserve')),
  signature text NOT NULL CHECK (length(signature) BETWEEN 1 AND 512),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_id, union_id, wallet_key, signature)
);
ALTER TABLE public.union_wallet_browser_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.union_wallet_browser_intents FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.fn_union_wallet_reserve_intent(
  p_union_id uuid, p_wallet_key text, p_signature text, p_legacy_operation_id uuid DEFAULT NULL, p_actor_id uuid DEFAULT auth.uid()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_actor uuid := auth.uid(); v_op uuid;
BEGIN
  IF v_actor IS NULL OR v_actor IS DISTINCT FROM p_actor_id OR NOT coalesce(public.fn_union_can_manage_wallets(p_union_id, v_actor),false) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Union Wallet Access Is Required';
  END IF;
  -- The unique key serializes concurrent tabs. ON CONFLICT returns the
  -- original operation, including when the first reservation response was lost.
  INSERT INTO public.union_wallet_browser_intents AS i
    (actor_id,union_id,wallet_key,signature,operation_id)
  VALUES(v_actor,p_union_id,p_wallet_key,p_signature,coalesce(p_legacy_operation_id,gen_random_uuid()))
  ON CONFLICT(actor_id,union_id,wallet_key,signature)
  DO UPDATE SET operation_id=i.operation_id
  RETURNING operation_id INTO v_op;
  RETURN v_op;
END $fn$;

CREATE FUNCTION public.fn_union_wallet_acknowledge_intent(
  p_union_id uuid, p_wallet_key text, p_signature text, p_operation_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Authentication Is Required';
  END IF;
  -- Compare-and-delete: a delayed acknowledgement cannot retire a later tap.
  DELETE FROM public.union_wallet_browser_intents
  WHERE actor_id=auth.uid() AND union_id=p_union_id AND wallet_key=p_wallet_key
    AND signature=p_signature AND operation_id=p_operation_id;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_union_wallet_reserve_intent(uuid,text,text,uuid,uuid),
  public.fn_union_wallet_acknowledge_intent(uuid,text,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_wallet_reserve_intent(uuid,text,text,uuid,uuid),
  public.fn_union_wallet_acknowledge_intent(uuid,text,text,uuid) TO authenticated;
COMMIT;

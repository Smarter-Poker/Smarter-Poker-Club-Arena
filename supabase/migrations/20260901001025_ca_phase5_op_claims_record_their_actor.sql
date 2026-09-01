-- Byte-exact mirror of the applied production migration.

-- The op-id claim wrappers on the two browser-reachable movers now record
-- WHO claimed the operation (auth.uid()) on the claim row - an audit trail
-- the claims table was missing, and the wrapper itself now consults the
-- request identity the way every browser-reachable definer writer must.
ALTER TABLE public.ca_op_claims ADD COLUMN IF NOT EXISTS claimed_by uuid;

CREATE OR REPLACE FUNCTION public.fn_mint_club_chips(
  p_club_id uuid, p_amount numeric,
  p_reason text DEFAULT 'beta top-up'::text,
  p_op_id text DEFAULT NULL)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_prior jsonb;
  v_res numeric;
begin
  /* ZERO-DRIFT phase 3/5: durable op-id claim with actor audit. Callers that
     pass a p_op_id get exactly-once semantics across retries; the claim row
     records who asked. Authorization itself lives in the core. */
  if p_op_id is null then
    return public.fn_mint_club_chips_zd3core(p_club_id, p_amount, p_reason);
  end if;

  select result into v_prior
    from public.ca_op_claims
   where op_id = p_op_id and fn_name = 'fn_mint_club_chips';
  if found and v_prior is not null then
    return (v_prior->>'value')::numeric;  -- replay: treasury after the original mint
  elsif found then
    delete from public.ca_op_claims
     where op_id = p_op_id and fn_name = 'fn_mint_club_chips';
  end if;

  insert into public.ca_op_claims (op_id, fn_name, claimed_by)
  values (p_op_id, 'fn_mint_club_chips', v_actor);

  v_res := public.fn_mint_club_chips_zd3core(p_club_id, p_amount, p_reason);

  update public.ca_op_claims
     set result = jsonb_build_object('value', v_res), finalized_at = now()
   where op_id = p_op_id and fn_name = 'fn_mint_club_chips';

  return v_res;
end $function$;

CREATE OR REPLACE FUNCTION public.fn_union_send_to_member(
  p_union_id uuid, p_target_user_id uuid, p_kind text, p_amount numeric,
  p_source_wallet text DEFAULT NULL::text,
  p_note text DEFAULT NULL::text,
  p_op_id text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_prior jsonb;
  v_res jsonb;
begin
  /* ZERO-DRIFT phase 3/5: durable op-id claim with actor audit (see
     ca_op_claims). Authorization itself lives in the core. */
  if p_op_id is null then
    return public.fn_union_send_to_member_zd3core(
      p_union_id, p_target_user_id, p_kind, p_amount, p_source_wallet, p_note);
  end if;

  select result into v_prior
    from public.ca_op_claims
   where op_id = p_op_id and fn_name = 'fn_union_send_to_member';
  if found and v_prior is not null then
    return v_prior || jsonb_build_object('replayed', true, 'op_id', p_op_id);
  elsif found then
    delete from public.ca_op_claims
     where op_id = p_op_id and fn_name = 'fn_union_send_to_member';
  end if;

  insert into public.ca_op_claims (op_id, fn_name, claimed_by)
  values (p_op_id, 'fn_union_send_to_member', v_actor);

  v_res := public.fn_union_send_to_member_zd3core(
    p_union_id, p_target_user_id, p_kind, p_amount, p_source_wallet, p_note);

  if coalesce(v_res->>'success', '') = 'true' then
    update public.ca_op_claims
       set result = v_res, finalized_at = now()
     where op_id = p_op_id and fn_name = 'fn_union_send_to_member';
  else
    delete from public.ca_op_claims
     where op_id = p_op_id and fn_name = 'fn_union_send_to_member';
  end if;

  return v_res;
end $function$;

REVOKE ALL ON FUNCTION public.fn_mint_club_chips(uuid, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_mint_club_chips(uuid, numeric, text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_send_to_member(uuid, uuid, text, numeric, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_send_to_member(uuid, uuid, text, numeric, text, text, text) TO authenticated, service_role;;

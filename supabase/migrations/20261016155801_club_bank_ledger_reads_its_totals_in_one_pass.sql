-- Club Bank history timed out at the browser's existing database deadline.
-- Replace three full receipt scans with one grouped scan. This is a read-only
-- function change: no money, receipt, balance, history or accounting row moves.
-- Authorization, every row projection, privacy mapping, filters, pagination,
-- reversal eligibility and the existing bank-total predicates remain intact.
-- Version reserved by scripts/new-migration.mjs.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_club_bank_ledger(uuid,integer,integer,text[])'::regprocedure)) = 'cb7edf507b92e7c22535d6fed10a416b')

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.fn_club_bank_ledger(uuid,integer,integer,text[])'::regprocedure)) IS DISTINCT FROM 'f17eb94522c177856683617945d9f371' THEN
    RAISE EXCEPTION 'Club Bank ledger preimage does not match the qualified source; refuse drift or replay' USING ERRCODE = '55000';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.fn_club_bank_ledger(p_club_id uuid, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_types text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
  v_rows jsonb;
  v_types jsonb;
  v_in numeric;
  v_out numeric;
begin
  if not public.fn_can_use_club_bank(p_club_id) then
    return jsonb_build_object('authorized', false,
      'error', 'The Club Bank Ledger Is Restricted To Owners, Co Owners, Admins And Super Agents');
  end if;

  -- One grouped scan supplies the count, complete filter directory and bank
  -- figures. Keep raw kinds in the money predicates and normalize only the
  -- displayed/filter kind, exactly as the existing ledger does.
  with per_type as (
    select CASE WHEN t.transaction_type = 'horse_treasury_funding' THEN 'club_bank_send'
                ELSE t.transaction_type END as transaction_type,
           count(*) as entries,
           sum(t.amount) filter (
             where t.transaction_type in ('mint', 'club_bank_reversal', 'treasury_credit', 'club_bank_claim')) as incoming,
           sum(t.amount) filter (
             where t.transaction_type in ('club_bank_send', 'treasury_debit')
               and coalesce(t.is_reversed, false) = false) as outgoing
      from chip_transactions t
     where t.club_id = p_club_id
     group by 1
  )
  select coalesce(sum(entries) filter (
           where p_types is null or transaction_type = any (p_types)), 0)::bigint,
         coalesce(jsonb_agg(transaction_type order by transaction_type), '[]'::jsonb),
         coalesce(sum(incoming), 0), coalesce(sum(outgoing), 0)
    into v_total, v_types, v_in, v_out
    from per_type;

  select coalesce(jsonb_agg(r order by r->>'created_at' desc), '[]'::jsonb) into v_rows
  from (
    select jsonb_build_object(
             'id', t.id,
             'created_at', t.created_at,
             'amount', round(coalesce(t.amount, 0), 2),
             'transaction_type', CASE WHEN t.transaction_type = 'horse_treasury_funding' THEN 'club_bank_send' ELSE t.transaction_type END,
             'notes', CASE WHEN t.transaction_type = 'horse_treasury_funding' OR t.notes ~* 'horse'
                             OR (t.transaction_type = 'club_bank_send' AND t.notes = 'Club Bank Send') THEN NULL
                           ELSE t.notes END,
             'balance_after', t.balance_after,
             'metadata', CASE WHEN t.transaction_type IN ('club_bank_send', 'horse_treasury_funding')
                              THEN jsonb_build_object('destination', coalesce(t.metadata ->> 'destination', 'player_wallet'))
                              ELSE coalesce(t.metadata, '{}'::jsonb) END,
             'is_reversed', coalesce(t.is_reversed, false),
             'reversible',
               t.transaction_type = 'club_bank_send'
               and coalesce(t.is_reversed, false) = false
               and (t.reversible_until is null or now() <= t.reversible_until),
             'from_user_id', CASE WHEN t.transaction_type = 'horse_treasury_funding' OR (t.transaction_type = 'club_bank_send' AND auth.uid() IS DISTINCT FROM t.from_user_id AND auth.uid() IS DISTINCT FROM t.to_user_id)
                                  THEN NULL ELSE t.from_user_id END,
             'to_user_id', t.to_user_id,
             'from_name', CASE WHEN t.transaction_type = 'horse_treasury_funding' OR (t.transaction_type = 'club_bank_send' AND auth.uid() IS DISTINCT FROM t.from_user_id AND auth.uid() IS DISTINCT FROM t.to_user_id) THEN NULL
                               ELSE coalesce(public.fn_arena_name(pf.alias, pf.username, pf.display_name, pf.first_name, pf.last_name, pf.full_name), pf.username) END,
             'to_name', coalesce(public.fn_arena_name(pt.alias, pt.username, pt.display_name, pt.first_name, pt.last_name, pt.full_name), pt.username)
           ) as r
      from chip_transactions t
      left join profiles pf on pf.id = t.from_user_id
      left join profiles pt on pt.id = t.to_user_id
     where t.club_id = p_club_id
       and (p_types is null or (CASE WHEN t.transaction_type = 'horse_treasury_funding' THEN 'club_bank_send' ELSE t.transaction_type END) = any (p_types))
     order by t.created_at desc
     limit v_limit offset v_offset
  ) s;

  return jsonb_build_object(
    'authorized', true,
    'total', v_total,
    'limit', v_limit,
    'offset', v_offset,
    'types', v_types,
    'totals', jsonb_build_object('into_bank', round(v_in, 2), 'out_of_bank', round(v_out, 2),
                                 'net', round(v_in - v_out, 2)),
    'rows', v_rows);
end
$function$;

DO $proof$
BEGIN
  IF md5(pg_get_functiondef('public.fn_club_bank_ledger(uuid,integer,integer,text[])'::regprocedure)) IS DISTINCT FROM 'cb7edf507b92e7c22535d6fed10a416b' THEN
    RAISE EXCEPTION 'Club Bank ledger postimage does not match the qualified source' USING ERRCODE = '55000';
  END IF;
END
$proof$;
COMMIT;

-- Production's fn_club_bank_ledger (pg_get_functiondef, read 2026-10-09,
-- md5 39ff91f5cc60c6300942f51e4ab2c3bb). Its live body was rewritten in place
-- by a later migration's DO block, so no CREATE in supabase/migrations
-- reproduces it; scripts/ci/test-horse-reads-db-postgres.py installs this text
-- and checks the md5 before it runs anything.
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

  select count(*) into v_total
    from chip_transactions t
   where t.club_id = p_club_id
     and (p_types is null or t.transaction_type = any (p_types));

  -- Every type this club has ever recorded, so the filter offers real options
  -- rather than a hard-coded list that goes stale.
  select coalesce(jsonb_agg(x.transaction_type order by x.transaction_type), '[]'::jsonb)
    into v_types
    from (select distinct transaction_type from chip_transactions where club_id = p_club_id) x;

  -- What went INTO the bank and what came OUT of it. Scoped to the movements
  -- the bank itself makes; a peer transfer between two members never touches
  -- clubs.chip_treasury and would make this figure a lie.
  select
    coalesce(sum(t.amount) filter (
      where t.transaction_type in ('mint', 'club_bank_reversal', 'treasury_credit', 'club_bank_claim')), 0),
    coalesce(sum(t.amount) filter (
      where t.transaction_type in ('club_bank_send', 'treasury_debit')
        and coalesce(t.is_reversed, false) = false), 0)
    into v_in, v_out
    from chip_transactions t
   where t.club_id = p_club_id;

  select coalesce(jsonb_agg(r order by r->>'created_at' desc), '[]'::jsonb) into v_rows
  from (
    select jsonb_build_object(
             'id', t.id,
             'created_at', t.created_at,
             'amount', round(coalesce(t.amount, 0), 2),
             'transaction_type', t.transaction_type,
             'notes', t.notes,
             'balance_after', t.balance_after,
             'metadata', coalesce(t.metadata, '{}'::jsonb),
             'is_reversed', coalesce(t.is_reversed, false),
             'reversible',
               t.transaction_type = 'club_bank_send'
               and coalesce(t.is_reversed, false) = false
               and (t.reversible_until is null or now() <= t.reversible_until),
             'from_user_id', t.from_user_id,
             'to_user_id', t.to_user_id,
             'from_name', coalesce(public.fn_arena_name(pf.alias, pf.username, pf.display_name, pf.first_name, pf.last_name, pf.full_name), pf.username),
             'to_name', coalesce(public.fn_arena_name(pt.alias, pt.username, pt.display_name, pt.first_name, pt.last_name, pt.full_name), pt.username)
           ) as r
      from chip_transactions t
      left join profiles pf on pf.id = t.from_user_id
      left join profiles pt on pt.id = t.to_user_id
     where t.club_id = p_club_id
       and (p_types is null or t.transaction_type = any (p_types))
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

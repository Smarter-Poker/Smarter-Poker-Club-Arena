-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826050050; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The one staff money path with no idempotency key. Every sibling takes
-- p_op_id and settles a replay on a unique index; this one did not, so a
-- response lost on the way back was indistinguishable from a pull that never
-- happened, and the natural retry took the chips a second time.
--
-- The old four-argument version is dropped rather than left beside the new
-- one: an overload would have kept the unguarded body live for every caller
-- that did not know to pass the key. p_op_id defaults to null, so an existing
-- client passing four named arguments still resolves here - it simply gets a
-- generated key and no replay protection, exactly what it has today.
drop function if exists public.fn_admin_remove_player_chips(uuid, uuid, numeric, text);

create or replace function public.fn_admin_remove_player_chips(
  p_club_id uuid,
  p_player_id uuid,
  p_amount numeric,
  p_reason text default null::text,
  p_op_id uuid default null::uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor      uuid := auth.uid();
  v_op_id      uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior      record;
  v_actor_role text;
  v_before     numeric;
  v_after      numeric;
  v_bank_after numeric;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;

  -- The same rounding trap the send functions carry: club_members.chip_balance
  -- is numeric(20,2) and clubs.chip_treasury is not, so an amount finer than a
  -- hundredth is debited and credited at different scales.
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('success', false, 'error', 'Chips Move In Hundredths At Most');
  end if;

  select id, amount, metadata into v_prior
    from chip_transactions
   where transaction_type = 'admin_removal'
     and club_id = p_club_id
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object('success', true, 'replayed', true,
      'removed', v_prior.amount,
      'balance_after', (v_prior.metadata ->> 'holder_balance_after')::numeric,
      'bank_after', (v_prior.metadata ->> 'bank_after')::numeric);
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null or v_actor_role not in ('owner', 'co_owner', 'admin') then
    return jsonb_build_object('success', false,
      'error', 'Only An Owner, Co Owner Or Admin May Pull Chips From A Member. '
               || 'An Agent Must Wait For A Cash Out Request');
  end if;

  select chip_balance into v_before
    from club_members
   where club_id = p_club_id and user_id = p_player_id
   for update;
  if v_before is null then
    return jsonb_build_object('success', false,
      'error', 'That Person Is Not A Member Of This Club');
  end if;
  if v_before < p_amount then
    return jsonb_build_object('success', false,
      'error', 'That Wallet Only Holds ' || trim(to_char(v_before, 'FM999,999,999,990.00')) || ' Chips',
      'balance', v_before, 'requested', p_amount);
  end if;

  update club_members
     set chip_balance = coalesce(chip_balance, 0) - p_amount,
         updated_at = now()
   where club_id = p_club_id and user_id = p_player_id
   returning chip_balance into v_after;

  update clubs
     set chip_treasury = coalesce(chip_treasury, 0) + p_amount,
         updated_at = now()
   where id = p_club_id
   returning chip_treasury into v_bank_after;

  begin
    insert into chip_transactions
      (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
    values
      (p_club_id, p_player_id, v_actor, p_amount, 'admin_removal',
       coalesce(nullif(btrim(p_reason), ''), 'Chips Pulled By Club Staff'),
       jsonb_build_object(
         'op_id', v_op_id,
         'source', 'player_wallet',
         'direction', 'into_bank',
         'actor_role', v_actor_role,
         'holder_balance_after', v_after,
         'bank_after', v_bank_after),
       v_bank_after);
  exception when unique_violation then
    select id, amount, metadata into v_prior
      from chip_transactions
     where transaction_type = 'admin_removal'
       and club_id = p_club_id
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    return jsonb_build_object('success', true, 'replayed', true,
      'removed', v_prior.amount,
      'balance_after', (v_prior.metadata ->> 'holder_balance_after')::numeric,
      'bank_after', (v_prior.metadata ->> 'bank_after')::numeric);
  end;

  -- The member is told. Staff pulling chips is the one movement that happens
  -- to a player without them asking for it.
  insert into notifications (user_id, type, title, message, metadata, actor_id)
  values (p_player_id, 'settlement', 'Chips Removed By Club Staff',
          trim(to_char(p_amount, 'FM999,999,999,990')) || ' Chips Were Removed From Your Wallet',
          jsonb_build_object('clubId', p_club_id, 'amount', p_amount,
                             'balanceAfter', v_after),
          v_actor);

  return jsonb_build_object('success', true, 'replayed', false, 'removed', p_amount,
    'balance_before', v_before, 'balance_after', v_after, 'bank_after', v_bank_after);
end
$function$;

grant execute on function public.fn_admin_remove_player_chips(uuid, uuid, numeric, text, uuid) to authenticated;

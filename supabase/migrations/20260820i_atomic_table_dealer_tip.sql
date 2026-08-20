-- Applied to prod 2026-08-20 as migration 20260820170741.
-- ═══════════════════════════════════════════════════════════════════════════
-- DEALER TIP — atomic, audited, engine-owned
--
-- The client used to call `deduct_table_chip_lock` directly and then write a
-- separate wallet_transactions row from the browser. Three problems:
--
--   1. It wrote table_seats.stack behind the authoritative engine's back. The
--      engine holds seat stacks in memory and overwrites table_seats at
--      settlement, so the player's stack came back on the next hand while
--      clubs.chip_treasury kept the chips — the tip minted chips.
--   2. The audit row was a second, non-atomic step. A failure between the two
--      left chips moved with no ledger entry.
--   3. The audit row claimed a PLAYER *wallet* debit that never happened.
--
-- This function does the seat debit, the treasury credit and the audit row in
-- ONE transaction, with the seat row locked. The engine (never the browser)
-- calls it, and only between hands, so the in-memory stack and table_seats stay
-- in agreement.
--
-- Verified 2026-08-20: `select count(*) from wallet_transactions where category
-- ilike '%tip%'` was 0, i.e. the old path had never successfully run in prod,
-- so there is no historical data to reconcile.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.atomic_table_dealer_tip(
  p_user_id  uuid,
  p_table_id uuid,
  p_amount   numeric
)
returns numeric
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_amount    numeric;
  v_seat_id   uuid;
  v_stack     numeric;
  v_new_stack numeric;
  v_club_id   uuid;
  v_recent    int;
begin
  -- Snap to whole cents up front. Every chip amount in this system is
  -- cent-granular; letting a float through here is how sub-cent dust gets
  -- permanently stranded in a seat stack.
  v_amount := round(coalesce(p_amount, 0)::numeric, 2);

  if v_amount <= 0 then
    raise exception 'Tip amount must be positive';
  end if;

  -- Lock the seat. Without FOR UPDATE two concurrent tips can both read the
  -- same stack and both pass the sufficiency check.
  select id, coalesce(stack, 0)
    into v_seat_id, v_stack
    from table_seats
   where table_id = p_table_id
     and user_id  = p_user_id
     and left_at is null
   for update;

  if v_seat_id is null then
    raise exception 'You are not seated at this table';
  end if;

  if v_stack < v_amount then
    raise exception 'Insufficient table chips for this tip';
  end if;

  -- Double-submit guard. The engine and the modal both hold in-flight locks,
  -- but a retried HTTP request can still arrive twice; an identical tip from
  -- the same player at the same table inside 3 seconds is treated as a repeat
  -- of the first, not a second tip.
  select count(*)
    into v_recent
    from wallet_transactions
   where user_id     = p_user_id
     and table_id    = p_table_id
     and category    = 'TIP'
     and amount      = v_amount
     and created_at > now() - interval '3 seconds';

  if v_recent > 0 then
    raise exception 'Duplicate tip ignored — that tip was already placed';
  end if;

  update table_seats
     set stack = stack - v_amount
   where id = v_seat_id
  returning stack into v_new_stack;

  select club_id into v_club_id from tables where id = p_table_id;
  if v_club_id is not null then
    update clubs
       set chip_treasury = coalesce(chip_treasury, 0) + v_amount
     where id = v_club_id;
  end if;

  -- Audit. balance_after stays NULL on purpose: no wallet balance changed,
  -- the chips moved from the seat stack straight to the club treasury.
  insert into wallet_transactions (
    user_id, wallet_type, amount, type, category, description, table_id, balance_after
  ) values (
    p_user_id, 'PLAYER', v_amount, 'debit', 'TIP',
    'Dealer tip from table stack', p_table_id, null
  );

  return v_new_stack;
end;
$function$;

revoke all on function public.atomic_table_dealer_tip(uuid, uuid, numeric) from public;
revoke all on function public.atomic_table_dealer_tip(uuid, uuid, numeric) from anon;
revoke all on function public.atomic_table_dealer_tip(uuid, uuid, numeric) from authenticated;
grant execute on function public.atomic_table_dealer_tip(uuid, uuid, numeric) to service_role;

comment on function public.atomic_table_dealer_tip(uuid, uuid, numeric) is
  'Engine-only. Moves chips from a seated player''s table stack to the club chip treasury, atomically, with an audit row. Not callable by anon/authenticated: the browser must go through the game server so the engine''s in-memory stack stays in sync.';

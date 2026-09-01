-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826045514; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

create or replace function public.fn_expire_stale_cashouts(p_ttl_hours integer default 72)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_expired integer := 0;
  r         record;
  v_escrow  record;
  v_after   numeric;
begin
  for r in
    select id, club_id, player_id, amount
      from public.cashout_requests
     where status = 'pending'
       and created_at < now() - make_interval(hours => p_ttl_hours)
     for update
  loop
    select * into v_escrow
      from public.chip_escrow
     where cashout_request_id = r.id
     for update;

    if not found or v_escrow.released_at is not null then
      update public.cashout_requests
         set status = 'expired', updated_at = now()
       where id = r.id;
      continue;
    end if;

    update public.club_members
       set chip_balance = coalesce(chip_balance, 0) + v_escrow.amount,
           updated_at   = now()
     where club_id = r.club_id and user_id = r.player_id
     returning chip_balance into v_after;

    update public.chip_escrow
       set released_at  = now(),
           release_type = 'expired'
     where id = v_escrow.id;

    update public.cashout_requests
       set status     = 'expired',
           updated_at = now(),
           agent_note = coalesce(agent_note, '')
                        || ' [Auto Expired After ' || p_ttl_hours::text || 'h. Escrow Refunded]'
     where id = r.id;

    insert into public.chip_transactions (
      id, club_id, from_user_id, to_user_id, amount,
      transaction_type, notes, related_cashout_id, metadata, balance_after, created_at
    ) values (
      gen_random_uuid(), r.club_id, null, r.player_id, v_escrow.amount,
      'cashout_expired_refund',
      'Cash Out Expired After ' || p_ttl_hours::text || 'h. Escrowed Chips Returned To Player',
      r.id,
      jsonb_build_object('op_id', v_escrow.id, 'expired_after_hours', p_ttl_hours),
      v_after,
      now()
    );

    insert into public.notifications (user_id, type, title, message, metadata)
    values (r.player_id, 'settlement', 'Cash Out Expired',
            'Your Cash Out Request Expired And '
              || trim(to_char(v_escrow.amount, 'FM999,999,999,990'))
              || ' Chips Are Back In Your Wallet',
            jsonb_build_object('clubId', r.club_id, 'cashoutId', r.id,
                               'amount', v_escrow.amount));

    v_expired := v_expired + 1;
  end loop;

  return v_expired;
end;
$function$;

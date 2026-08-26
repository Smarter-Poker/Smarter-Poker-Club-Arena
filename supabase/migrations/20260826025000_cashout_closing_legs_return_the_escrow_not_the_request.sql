-- ═══════════════════════════════════════════════════════════════════════════
--  THE TWO CASH OUT CLOSING LEGS COULD RETURN THE WRONG NUMBER
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan's rule, binding: "when a player requests a cash out, those chips should
-- be removed from the player account and held in escrow, until the agent
-- approves the cash out, or denies it... if canceled returns to player wallet."
--
-- Both closing legs had defects that only bite once the feature carries real
-- traffic. cashout_requests is empty in production today, so this lands before
-- the first player uses it rather than after.
--
-- WHAT WAS WRONG
--
-- 1. fn_cashout_release REFUNDED THE REQUEST, NOT THE ESCROW. It credited
--    v_req.amount. The chips actually being held are v_escrow.amount.
--    fn_cashout_approve already treats a disagreement between those two as
--    fatal and refuses; release trusted the request row and would have paid
--    out the wrong number in silence.
--
-- 2. fn_cashout_release HAD NO unique_violation HANDLER. fn_agent_wallet_send
--    catches a duplicate op id on its ledger insert and reports the original
--    as a replay. Release did not, so a genuine retry after a dropped
--    response surfaced as a raw 23505 rather than the calm "you already did
--    this" every other money path gives. The partial unique index spans
--    cashout_denied and cashout_cancelled together.
--
-- 3. A PLAYER'S OWN CANCEL TOLD THE AGENT NOTHING. The decline branch writes
--    a notification; the cancel branch wrote none, and the return payload
--    carried no agent_id, so the client could not push either. An agent
--    working a queue learned about a withdrawal only if their realtime
--    subscription happened to be alive.
--
-- 4. fn_expire_stale_cashouts TRUNCATED MONEY AND ORPHANED THE ESCROW:
--      chip_balance + r.amount::integer
--    against numeric. A 40.50 hold refunded 40 and destroyed the difference.
--    It never set chip_escrow.released_at, so every expiry left an open hold
--    that reads as outstanding to anything that reconciles. No idempotency,
--    and its search_path omitted pg_temp unlike every sibling.
--
--    The repo copy at supabase/migrations/20260311_cashout_expiry.sql
--    describes a DIFFERENT function - it credits `wallets` with wallet_type
--    PLAYER, returns a TABLE and takes p_max_hours. Re-applying that file
--    would credit the wrong account. This migration supersedes it.
--
-- Both bodies below are the live ones as of this migration, repaired. The
-- changed lines are marked; everything else is byte-for-byte what was running.

-- ── The escrow vocabulary had no word for what the expiry does ────────────
-- release_type could only be completed / cancelled / rejected, so even a
-- corrected expiry would have failed the CHECK. Widen first.
alter table public.chip_escrow
  drop constraint if exists chip_escrow_release_type_check;

alter table public.chip_escrow
  add constraint chip_escrow_release_type_check
  check (release_type = any (array['completed', 'cancelled', 'rejected', 'expired']));

-- ── 1-3 ───────────────────────────────────────────────────────────────────
create or replace function public.fn_cashout_release(
  p_cashout_id uuid,
  p_note text default null::text,
  p_op_id uuid default null::uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor     uuid := auth.uid();
  v_op_id     uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior     record;
  v_req       record;
  v_escrow    record;
  v_is_player boolean;
  v_type      text;
  v_status    text;
  v_after     numeric;
  v_name      text;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  select id, amount, related_cashout_id into v_prior
    from chip_transactions
   where transaction_type in ('cashout_denied', 'cashout_cancelled')
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object('success', true, 'replayed', true,
      'cashout_id', v_prior.related_cashout_id, 'amount', v_prior.amount);
  end if;

  select * into v_req from cashout_requests where id = p_cashout_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'That Cash Out Could Not Be Found');
  end if;
  if v_req.status <> 'pending' then
    return jsonb_build_object('success', false,
      'error', 'That Cash Out Has Already Been Dealt With',
      'current_status', v_req.status);
  end if;

  v_is_player := (v_req.player_id = v_actor);
  if not v_is_player
     and v_req.agent_id <> v_actor
     and not public.fn_club_cashier_can_transact(v_req.club_id, v_actor, v_req.player_id) then
    return jsonb_build_object('success', false,
      'error', 'That Cash Out Belongs To A Different Agent');
  end if;

  select * into v_escrow from chip_escrow where cashout_request_id = p_cashout_id for update;
  if not found or v_escrow.released_at is not null then
    return jsonb_build_object('success', false,
      'error', 'Those Chips Are Not Held In Escrow, So Nothing Can Be Returned');
  end if;

  -- CHANGED. The escrow row is what fn_cashout_request actually debited. If
  -- the request disagrees with it, something has edited one of the two behind
  -- our backs and neither number can be trusted. fn_cashout_approve already
  -- refuses on exactly this; release used to pay out the request in silence.
  if v_escrow.amount is distinct from v_req.amount then
    return jsonb_build_object('success', false,
      'error', 'That Cash Out Does Not Match The Chips Held For It');
  end if;

  v_type   := case when v_is_player then 'cashout_cancelled' else 'cashout_denied' end;
  v_status := case when v_is_player then 'cancelled' else 'rejected' end;

  -- CHANGED: v_escrow.amount, not v_req.amount. With the guard above these are
  -- equal; if the guard is ever removed, this still returns what was held.
  update club_members
     set chip_balance = coalesce(chip_balance, 0) + v_escrow.amount,
         updated_at = now()
   where club_id = v_req.club_id and user_id = v_req.player_id
   returning chip_balance into v_after;
  if v_after is null then
    insert into club_members (club_id, user_id, role, chip_balance, status, is_active)
    values (v_req.club_id, v_req.player_id, 'player', v_escrow.amount, 'active', true)
    on conflict (club_id, user_id) do update
      set chip_balance = coalesce(club_members.chip_balance, 0) + excluded.chip_balance,
          updated_at = now()
    returning chip_balance into v_after;
  end if;

  update chip_escrow
     set released_at = now(),
         release_type = case when v_is_player then 'cancelled' else 'rejected' end
   where id = v_escrow.id;

  update cashout_requests
     set status = v_status,
         agent_note  = case when v_is_player then agent_note
                            else coalesce(nullif(btrim(p_note), ''), agent_note) end,
         player_note = case when v_is_player
                            then coalesce(nullif(btrim(p_note), ''), player_note)
                            else player_note end,
         cancelled_at = now(),
         updated_at = now()
   where id = p_cashout_id;

  -- CHANGED: wrapped so a duplicate op id reads as a replay rather than a raw
  -- 23505. Somebody can land between our replay check at the top and here.
  begin
    insert into chip_transactions
      (club_id, from_user_id, to_user_id, amount, transaction_type, notes,
       related_cashout_id, metadata, balance_after)
    values
      (v_req.club_id, v_actor, v_req.player_id, v_escrow.amount, v_type,
       coalesce(nullif(btrim(p_note), ''), 'Cash Out Closed. Chips Returned From Escrow'),
       p_cashout_id,
       jsonb_build_object('op_id', v_op_id, 'closed_by', v_actor,
                          'player_balance_after', v_after),
       v_after);
  exception when unique_violation then
    select id, amount, related_cashout_id into v_prior
      from chip_transactions
     where transaction_type in ('cashout_denied', 'cashout_cancelled')
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    return jsonb_build_object('success', true, 'replayed', true,
      'cashout_id', v_prior.related_cashout_id, 'amount', v_prior.amount);
  end;

  if not v_is_player then
    select coalesce(nullif(btrim(pr.display_name), ''),
                    nullif(btrim(pr.alias), ''),
                    nullif(btrim(pr.username), ''), 'Your Agent')
      into v_name
      from profiles pr where pr.id = v_actor;

    insert into notifications (user_id, type, title, message, metadata, actor_id)
    values (v_req.player_id, 'settlement', 'Cash Out Declined',
            coalesce(v_name, 'Your Agent') || ' Declined Your Cash Out. '
              || trim(to_char(v_escrow.amount, 'FM999,999,999,990')) || ' Chips Are Back In Your Wallet',
            jsonb_build_object('clubId', v_req.club_id, 'cashoutId', p_cashout_id,
                               'amount', v_escrow.amount),
            v_actor);

  -- CHANGED. A player withdrawing their own request is news to the agent
  -- holding the queue. The decline branch already notifies; this is its
  -- mirror, and it was missing.
  elsif v_req.agent_id is not null then
    select coalesce(nullif(btrim(pr.display_name), ''),
                    nullif(btrim(pr.alias), ''),
                    nullif(btrim(pr.username), ''), 'A Player')
      into v_name
      from profiles pr where pr.id = v_req.player_id;

    insert into notifications (user_id, type, title, message, metadata, actor_id)
    values (v_req.agent_id, 'settlement', 'Cash Out Withdrawn',
            coalesce(v_name, 'A Player') || ' Withdrew A Cash Out Request For '
              || trim(to_char(v_escrow.amount, 'FM999,999,999,990')) || ' Chips',
            jsonb_build_object('clubId', v_req.club_id, 'cashoutId', p_cashout_id,
                               'amount', v_escrow.amount),
            v_req.player_id);
  end if;

  return jsonb_build_object('success', true, 'replayed', false,
    'cashout_id', p_cashout_id, 'amount', v_escrow.amount,
    'club_id', v_req.club_id,
    'player_id', v_req.player_id,
    -- CHANGED: the client could not push the agent without this.
    'agent_id', v_req.agent_id,
    'cancelled_by_player', v_is_player,
    'player_balance_after', v_after);
end
$function$;

-- ── 4 ─────────────────────────────────────────────────────────────────────
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
    -- CHANGED. The escrow row is what was actually debited, and skipping an
    -- already-released one is what stops a second run of the job refunding
    -- the same hold twice.
    select * into v_escrow
      from public.chip_escrow
     where cashout_request_id = r.id
     for update;

    if not found or v_escrow.released_at is not null then
      -- Nothing is being held, so there is nothing to give back. Close the
      -- request so it stops appearing in queues, and move on.
      update public.cashout_requests
         set status = 'expired', updated_at = now()
       where id = r.id;
      continue;
    end if;

    -- CHANGED: no ::integer. chip_balance is numeric(20,2) and the escrow
    -- amount is numeric; the cast refunded 40 against a 40.50 hold.
    update public.club_members
       set chip_balance = coalesce(chip_balance, 0) + v_escrow.amount,
           updated_at   = now()
     where club_id = r.club_id and user_id = r.player_id
     returning chip_balance into v_after;

    -- CHANGED: the hold is now actually released. It never was.
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
      -- CHANGED: keyed on the escrow row, which exists once per request, so
      -- the ledger cannot carry two refunds for one hold.
      jsonb_build_object('op_id', v_escrow.id, 'expired_after_hours', p_ttl_hours),
      v_after,
      now()
    );

    -- CHANGED: tell the player. Their chips moved without them asking.
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

-- ── Proof, in the same transaction as the change ──────────────────────────
-- A migration that silently no-ops is worse than one that fails loudly: the
-- rule would then be documented everywhere and enforced nowhere.
do $verify$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_cashout_release';

  if position('v_escrow.amount is distinct from v_req.amount' in v_def) = 0 then
    raise exception 'the escrow mismatch guard did not take';
  end if;
  if position('coalesce(chip_balance, 0) + v_escrow.amount' in v_def) = 0 then
    raise exception 'release still refunds the request rather than the escrow';
  end if;
  if position('exception when unique_violation' in v_def) = 0 then
    raise exception 'release still raises on a duplicate op id instead of replaying';
  end if;
  if position('Cash Out Withdrawn' in v_def) = 0 then
    raise exception 'a player cancel still tells the agent nothing';
  end if;

  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_expire_stale_cashouts';

  if position('::integer' in v_def) > 0 then
    raise exception 'the expiry still truncates the refund';
  end if;
  if position('release_type = ''expired''' in v_def) = 0 then
    raise exception 'the expiry still orphans the escrow row';
  end if;
end
$verify$;

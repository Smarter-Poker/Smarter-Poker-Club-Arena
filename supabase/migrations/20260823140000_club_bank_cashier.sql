-- ═══════════════════════════════════════════════════════════════════════════
--  CLUB BANK CASHIER (Dan 2026-08-23, BINDING)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- "INSIDE THE CLUB ARENA FOR CLUB OWNERS, IF THEY CLICK ON CLUB BANK, THAT
--  SHOULD OPEN THE CLUB BANK CASHIER. THATS WHERE OWNERS, CO OWNERS, ADMINS
--  AND SUPER AGENTS SHOULD BE SENDING INITIAL CHIPS FROM TO FUND AGENT
--  WALLETS. THERE MUST BE A FULL TRANSACTION LEDGER FOR EVERY SINGLE CHIP
--  MOVEMENT. ONLY THOSE ROLES HAVE ACCESS TO THE CLUB BANK OR SHOULD EVEN SEE
--  IT... IF IT IS A STAND ALONE CLUB, CHIP MINTING EXISTS INSIDE THEIR CLUB
--  BANK."
--
-- THE CLUB BANK IS `clubs.chip_treasury`. That is the figure DynamicWallet has
-- always rendered as "Club Bank" (fn_club_money_panel -> club_treasury), so the
-- cashier moves the money the panel actually shows. `clubs.chip_pool` is the
-- older mint-and-distribute account; this migration stops NEW money landing
-- there (see part 2) but does not move or delete a single existing chip.
--
-- Four parts:
--   1. fn_club_bank_send      — Club Bank -> agent / promo / player wallet
--   2. fn_mint_chips_from_diamonds — standalone branch now credits the BANK
--   3. fn_club_bank_ledger    — every chip movement, role-gated
--   4. fn_club_money_panel    — returns club_rake_treasury for standalone clubs
--
-- ROLLBACK is recorded at the foot of each part.

-- ───────────────────────────────────────────────────────────────────────────
-- 0. WHO MAY STAND AT THE CLUB BANK
-- ───────────────────────────────────────────────────────────────────────────
-- Owner, co-owner, admin, super agent. Nobody else — an agent, a sub agent and
-- a player must never see the Club Bank, let alone spend from it. The club's
-- own owner_id counts even if the club_members row is missing, which is how
-- the very first owner of a brand new club reaches their own money.
--
-- fn_actor_can_manage_club_treasury already exists but is WIDER than this
-- (it also admits 'manager', 'treasurer' and the agents table, and it returns
-- TRUE for a null auth.uid() so backend jobs pass). It is left alone — a
-- server job is not a person standing at a cashier — and this narrower
-- predicate governs the human surface.

create or replace function public.fn_club_bank_role(p_club_id uuid, p_user_id uuid default null)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_club_id is null then null
    when exists (select 1 from public.clubs c
                  where c.id = p_club_id
                    and c.owner_id = coalesce(p_user_id, auth.uid())) then 'owner'
    else (select cm.role from public.club_members cm
           where cm.club_id = p_club_id
             and cm.user_id = coalesce(p_user_id, auth.uid())
             and coalesce(cm.status, 'active') = 'active'
           limit 1)
  end;
$$;

comment on function public.fn_club_bank_role(uuid, uuid) is
  'The caller''s role in a club, owner_id taking precedence over club_members.';

create or replace function public.fn_can_use_club_bank(p_club_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
     and public.fn_club_bank_role(p_club_id)
           in ('owner', 'co_owner', 'admin', 'super_agent');
$$;

comment on function public.fn_can_use_club_bank(uuid) is
  'Club Bank access law (Dan 2026-08-23): owner, co_owner, admin, super_agent only.';

revoke all on function public.fn_club_bank_role(uuid, uuid) from public, anon;
revoke all on function public.fn_can_use_club_bank(uuid) from public, anon;
grant execute on function public.fn_club_bank_role(uuid, uuid) to authenticated, service_role;
grant execute on function public.fn_can_use_club_bank(uuid) to authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. fn_club_bank_send — the only way chips leave the Club Bank by hand
-- ───────────────────────────────────────────────────────────────────────────
-- Destinations, all within the SAME club:
--   'agent_wallet'  -> agents.agent_wallet_balance   (the stated purpose)
--   'promo_wallet'  -> agents.promo_wallet_balance
--   'player_wallet' -> club_members.chip_balance
--
-- Every send writes ONE chip_transactions row. `balance_after` records the
-- BANK's balance after the debit, because that is the account this ledger is
-- for; the recipient's new balance rides in metadata so nothing is lost.
--
-- An agents row is created on demand for an agent-role member who has never
-- been funded, rather than refusing the first ever send to a new agent.

create or replace function public.fn_club_bank_send(
  p_club_id uuid,
  p_to_user_id uuid,
  p_amount numeric,
  p_destination text default 'agent_wallet',
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_dest         text := lower(coalesce(p_destination, 'agent_wallet'));
  v_bank_before  numeric;
  v_bank_after   numeric;
  v_to_role      text;
  v_to_after     numeric;
  v_agent_id     uuid;
  v_tx_id        uuid;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null or v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only An Owner, Co Owner, Admin Or Super Agent May Send From The Club Bank');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'Amount Exceeds The Single Send Limit');
  end if;
  if v_dest not in ('agent_wallet', 'promo_wallet', 'player_wallet') then
    return jsonb_build_object('success', false, 'error', 'Unknown Destination Wallet');
  end if;
  if p_to_user_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose A Recipient');
  end if;

  -- Recipient must be an active member of THIS club.
  select cm.role into v_to_role
    from club_members cm
   where cm.club_id = p_club_id
     and cm.user_id = p_to_user_id
     and coalesce(cm.status, 'active') = 'active'
   for update;
  if v_to_role is null then
    return jsonb_build_object('success', false, 'error', 'Recipient Is Not An Active Member Of This Club');
  end if;
  if v_dest in ('agent_wallet', 'promo_wallet')
     and v_to_role not in ('super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only An Agent, Sub Agent Or Super Agent Holds An Agent Wallet');
  end if;

  -- Lock and debit the bank.
  select coalesce(c.chip_treasury, 0) into v_bank_before
    from clubs c where c.id = p_club_id for update;
  if v_bank_before is null then
    return jsonb_build_object('success', false, 'error', 'Club Not Found');
  end if;
  if v_bank_before < p_amount then
    return jsonb_build_object('success', false, 'error', 'Insufficient Club Bank Balance',
      'balance', v_bank_before, 'requested', p_amount);
  end if;

  update clubs
     set chip_treasury = coalesce(chip_treasury, 0) - p_amount,
         updated_at = now()
   where id = p_club_id
   returning chip_treasury into v_bank_after;

  -- Credit the destination.
  if v_dest = 'player_wallet' then
    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount,
           updated_at = now()
     where club_id = p_club_id and user_id = p_to_user_id
     returning chip_balance into v_to_after;
  else
    select a.id into v_agent_id
      from agents a
     where a.club_id = p_club_id and a.user_id = p_to_user_id
     for update;

    if v_agent_id is null then
      insert into agents (user_id, club_id, role, status, agent_wallet_balance, promo_wallet_balance)
      values (p_to_user_id, p_club_id, v_to_role, 'active', 0, 0)
      returning id into v_agent_id;
    end if;

    if v_dest = 'agent_wallet' then
      update agents
         set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + p_amount,
             updated_at = now()
       where id = v_agent_id
       returning agent_wallet_balance into v_to_after;
    else
      update agents
         set promo_wallet_balance = coalesce(promo_wallet_balance, 0) + p_amount,
             updated_at = now()
       where id = v_agent_id
       returning promo_wallet_balance into v_to_after;
    end if;
  end if;

  -- THE LEDGER. One row, every time, no exceptions.
  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (p_club_id, v_actor, p_to_user_id, p_amount, 'club_bank_send',
     coalesce(nullif(btrim(p_reason), ''), 'Club Bank Send'),
     jsonb_build_object(
       'destination', v_dest,
       'actor_role', v_actor_role,
       'recipient_role', v_to_role,
       'bank_before', v_bank_before,
       'bank_after', v_bank_after,
       'recipient_balance_after', v_to_after),
     v_bank_after)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true,
    'transaction_id', v_tx_id,
    'amount', p_amount,
    'destination', v_dest,
    'bank_before', v_bank_before,
    'bank_after', v_bank_after,
    'recipient_balance_after', v_to_after);
end
$$;

revoke all on function public.fn_club_bank_send(uuid, uuid, numeric, text, text) from public, anon;
grant execute on function public.fn_club_bank_send(uuid, uuid, numeric, text, text) to authenticated, service_role;

-- ROLLBACK: drop function public.fn_club_bank_send(uuid, uuid, numeric, text, text);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. THE STANDALONE MINT NOW CREDITS THE CLUB BANK
-- ───────────────────────────────────────────────────────────────────────────
-- "IF IT IS A STAND ALONE CLUB, CHIP MINTING EXISTS INSIDE THEIR CLUB BANK."
-- The mint credited clubs.chip_pool while the Club Bank reads
-- clubs.chip_treasury, so minting inside the Club Bank would have moved a
-- number nobody can see and left the bank unchanged. Same function, same
-- authorisation, same rate — one account name.
--
-- Nothing in the client reads chip_pool for display (verified by grep across
-- src/), so this changes no screen except by making the mint land where it is
-- spent from. Existing chip_pool balances are LEFT WHERE THEY ARE; the older
-- distribute_chips path still spends them.
--
-- ROLLBACK: re-apply 20260821_fn_mint_chips_from_diamonds.sql verbatim.

do $mig$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_mint_chips_from_diamonds';
  if v_def is null then
    raise exception 'fn_mint_chips_from_diamonds not found';
  end if;

  v_old := 'update clubs set chip_pool = coalesce(chip_pool, 0) + v_chips, updated_at = now()
     where id = p_club_id
     returning chip_pool into v_pool_after;';

  v_new := 'update clubs set chip_treasury = coalesce(chip_treasury, 0) + v_chips, updated_at = now()
     where id = p_club_id
     returning chip_treasury into v_pool_after;';

  if position(v_old in v_def) = 0 then
    -- Already migrated, or the source drifted. Either way, do not guess.
    if position('returning chip_treasury into v_pool_after' in v_def) > 0 then
      raise notice 'standalone mint already credits chip_treasury - nothing to do';
      return;
    end if;
    raise exception 'standalone mint UPDATE not found - refusing to patch';
  end if;

  v_def := replace(v_def, v_old, v_new);
  v_def := replace(v_def, 'chips minted to club pool', 'chips minted to club bank');
  execute v_def;
end $mig$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. fn_club_bank_ledger — every single chip movement
-- ───────────────────────────────────────────────────────────────────────────
-- "THERE MUST BE A FULL TRANSACTION LEDGER FOR EVERY SINGLE CHIP MOVEMENT."
-- Every chip_transactions row for the club, newest first, with both parties
-- resolved to a name so the ledger reads as a statement rather than as UUIDs.
-- Role-gated by fn_can_use_club_bank: an agent calling this gets a refusal,
-- not a filtered list, so there is nothing to leak.
--
-- p_types filters by transaction_type when supplied; null means everything.

create or replace function public.fn_club_bank_ledger(
  p_club_id uuid,
  p_limit int default 50,
  p_offset int default 0,
  p_types text[] default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
  v_rows jsonb;
begin
  if not public.fn_can_use_club_bank(p_club_id) then
    return jsonb_build_object('authorized', false,
      'error', 'The Club Bank Ledger Is Restricted To Owners, Co Owners, Admins And Super Agents');
  end if;

  select count(*) into v_total
    from chip_transactions t
   where t.club_id = p_club_id
     and (p_types is null or t.transaction_type = any (p_types));

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
             'from_user_id', t.from_user_id,
             'to_user_id', t.to_user_id,
             'from_name', coalesce(pf.display_name, pf.username, pf.full_name),
             'to_name', coalesce(pt.display_name, pt.username, pt.full_name)
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
    'rows', v_rows);
end
$$;

revoke all on function public.fn_club_bank_ledger(uuid, int, int, text[]) from public, anon;
grant execute on function public.fn_club_bank_ledger(uuid, int, int, text[]) to authenticated, service_role;

-- ROLLBACK: drop function public.fn_club_bank_ledger(uuid, int, int, text[]);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. fn_club_money_panel returns the STANDALONE club's rake treasury
-- ───────────────────────────────────────────────────────────────────────────
-- "...AND CLUB BANK (RAKE TREASURY IF THEY ARE A STAND ALONE CLUB)."
-- A club inside a union sends its rake to the union's Rake Treasury; a
-- standalone club keeps its own, and had no way to see it. The panel returned
-- early for standalone clubs (IF v_union_id IS NULL THEN RETURN v_out) so
-- nothing club-scoped could be added after that line — the addition goes
-- BEFORE it, and only for club staff.
--
-- Source: club_wallets.period_rake_collected, the rake this club has banked
-- since period_started_at. Emitted only when a club_wallets row exists, so a
-- club without one renders "-" rather than a fabricated 0.00.
--
-- ROLLBACK: re-apply 20260823120000_money_panel_reads_the_rollup.sql.

do $mig$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_club_money_panel';
  if v_def is null then
    raise exception 'fn_club_money_panel not found';
  end if;

  if position('club_rake_treasury' in v_def) > 0 then
    raise notice 'panel already returns club_rake_treasury - nothing to do';
    return;
  end if;

  v_old := '  IF v_union_id IS NULL THEN RETURN v_out; END IF;';

  v_new :=
'  IF v_union_id IS NULL THEN
    -- Standalone club: it keeps its own rake, so name the account and show it.
    IF v_is_club_staff THEN
      SELECT round(COALESCE(w.period_rake_collected, 0), 2) INTO v_club_rake
        FROM club_wallets w WHERE w.club_id = p_club_id;
      IF FOUND THEN
        v_out := v_out || jsonb_build_object(''club_rake_treasury'', v_club_rake);
      END IF;
    END IF;
    RETURN v_out;
  END IF;';

  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'standalone early-return not found exactly once - refusing to patch';
  end if;

  v_def := replace(v_def, v_old, v_new);
  execute v_def;
end $mig$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Guard allowlist
-- ───────────────────────────────────────────────────────────────────────────
-- guard_wallet_balance_write currently fires only on wallets.* and
-- clubs.chip_pool, so fn_club_bank_send is not blocked today. It is added to
-- the allowlist anyway: the day chip_treasury gets its own guard trigger — and
-- it should — the cashier must not be the thing that breaks.

do $mig$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'guard_wallet_balance_write';
  if v_def is null then
    raise notice 'guard_wallet_balance_write not found - skipping allowlist update';
    return;
  end if;
  if position('fn_club_bank_send' in v_def) > 0 then
    raise notice 'already allowlisted';
    return;
  end if;
  v_def := replace(v_def,
    '''fn_mint_chips_from_diamonds''',
    '''fn_mint_chips_from_diamonds'',
    -- added 2026-08-23 with the Club Bank Cashier (Dan directive)
    ''fn_club_bank_send''');
  execute v_def;
end $mig$;

-- ───────────────────────────────────────────────────────────────────────────
-- POST-APPLY ASSERTIONS
-- ───────────────────────────────────────────────────────────────────────────
do $assert$
declare
  v_src text;
  v_bad int := 0;
begin
  if to_regprocedure('public.fn_club_bank_send(uuid,uuid,numeric,text,text)') is null then
    raise exception 'fn_club_bank_send missing';
  end if;
  if to_regprocedure('public.fn_club_bank_ledger(uuid,int,int,text[])') is null then
    raise exception 'fn_club_bank_ledger missing';
  end if;
  if to_regprocedure('public.fn_can_use_club_bank(uuid)') is null then
    raise exception 'fn_can_use_club_bank missing';
  end if;

  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_mint_chips_from_diamonds';
  if position('chip_treasury' in v_src) = 0 then
    raise warning 'standalone mint does not credit chip_treasury';
    v_bad := v_bad + 1;
  end if;
  if position('union_wallets' in v_src) = 0 then
    raise warning 'union mint branch was lost';
    v_bad := v_bad + 1;
  end if;

  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_club_money_panel';
  if position('club_rake_treasury' in v_src) = 0 then
    raise warning 'panel does not return club_rake_treasury';
    v_bad := v_bad + 1;
  end if;
  if position('union_rake_weekly' in v_src) = 0 then
    raise warning 'panel lost the rollup read from 20260823120000';
    v_bad := v_bad + 1;
  end if;

  if v_bad > 0 then
    raise exception 'club bank cashier migration failed % assertion(s)', v_bad;
  end if;
end $assert$;

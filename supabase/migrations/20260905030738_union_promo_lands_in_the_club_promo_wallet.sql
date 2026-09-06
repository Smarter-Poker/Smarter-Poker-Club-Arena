-- 20260905030103_union_promo_lands_in_the_club_promo_wallet.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY
--
-- 2026-09-05 02:51 UTC, Dan opened the Midway Union PROMO WALLET and sent
-- 5,000 promo chips to Club JAQK, 5,000 to SHARK CLUB and 5,000 to KingFish.
-- None of it appeared in a promo wallet. Traced row by row:
--
--   1. The two CLUB sends went through fn_union_send_to_club_atomic. That
--      function only knows one route: union_wallets.chip_balance (the union
--      BANK) -> clubs.chip_treasury (the CLUB BANK). The modal called it for
--      every club target regardless of which wallet was open and which kind
--      was picked, and stamped the note "Promo Wallet to club" on a movement
--      that never touched a promo account. union_wallet_transactions
--      4a363124-0287-4a9e-bdfb-e697b0f32018 (JAQK) and
--      a458f05e-1dee-4942-8bd4-ead9616d0ec7 (SHARK), both wallet='chip_balance',
--      tx_type='manual_transfer'.
--
--   2. The KingFish send went through the right RPC (fn_union_send_to_member,
--      kind='promo'), and because KingFish is staff in Club JAQK it landed in
--      agents.promo_wallet_balance, his personal promo float. The club Promo
--      Wallet row on the lobby reads clubs.promo_balance. Two accounts wear
--      the name. That 5,000 is correct under the cashier law ("if it is sent
--      to an agent wallet, it lands in their promo wallet") and stays where
--      it is; the UI now shows it.
--
--   3. Latent: fn_union_promo_send(destination => 'club') - the RPC the
--      modal SHOULD have called - credits clubs.chip_treasury too. The union
--      promo wallet had no path into a club promo wallet at all.
--
-- This migration, in one transaction:
--
--   A. fn_union_promo_send: destination 'club' now credits clubs.promo_balance
--      (the club's Promo Wallet), journals one chip_ledger row
--      union_wallet -> promo_wallet, writes the union-side and club-side
--      transaction rows, and refuses a caller who cannot manage the union's
--      wallets (service_role, i.e. the World Hub API route, passes).
--
--   B. fn_club_promo_wallet_send: NEW. Spends clubs.promo_balance into a
--      player wallet (as cash) or an agent's promo float. Owner, co-owner,
--      admin, super agent. fn_promo_wallet_send is untouched: it still spends
--      the CALLER'S OWN float, which is what an agent opening "Promo Wallet"
--      means.
--
--   C. fn_promo_wallet_ledger: NEW. One read for the transaction ledger that
--      Dan requires on every promo wallet - union (union_wallet_transactions,
--      any wallet column), club promo pot (chip_ledger rows on the club's
--      promo_wallet account), and an agent's own float (chip_ledger rows on
--      their promo_wallet account inside that club).
--
--   D. The two club sends are REROUTED to what was asked for: each club's
--      Club Bank gives back the 5,000 it should never have received, the
--      union bank gets its 10,000 back, the union promo wallet pays the
--      10,000 it was asked to pay, and each club's Promo Wallet receives its
--      5,000. Every leg has a union_wallet_transactions row, a
--      chip_transactions row and a chip_ledger row naming the original
--      transaction it corrects. CLAUDE.md 10.9: the outcome was READ from
--      union_wallet_transactions, chip_transactions and chip_ledger; nothing
--      is paid twice (the block is keyed on the original ids and refuses to
--      run again); nothing is taken from a player (both accounts are Dan's
--      own club and union books); the numbers are asserted so the block
--      aborts if the books moved underneath it.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- A. fn_union_promo_send: 'club' lands in the club's PROMO wallet
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_union_promo_send(
  p_union_id uuid,
  p_amount numeric,
  p_destination text,
  p_club_id uuid,
  p_op_id uuid,
  p_created_by uuid DEFAULT NULL::uuid,
  p_notes text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_amt        numeric := round(COALESCE(p_amount, 0), 2);
  v_actor      uuid := COALESCE(p_created_by, auth.uid());
  v_promo      numeric;
  v_after      numeric;
  v_club_after numeric;
  v_pool_id    uuid;
  v_club_name  text;
  v_note       text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT public.fn_union_can_manage_wallets(p_union_id, auth.uid()) THEN
    RETURN jsonb_build_object('success', false,
      'error', 'Only the union owner, co-owner or an admin can send from union wallets.');
  END IF;
  IF v_amt <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;
  IF p_destination NOT IN ('club', 'bbj_main') THEN
    RETURN jsonb_build_object('success', false, 'error', 'destination must be club or bbj_main');
  END IF;
  IF p_op_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'op_id_required');
  END IF;

  SELECT COALESCE(promo_wallet, 0) INTO v_promo
    FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
  IF v_promo IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union wallet not found');
  END IF;
  IF v_promo < v_amt THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient promo balance',
                              'available', v_promo, 'requested', v_amt);
  END IF;

  IF p_destination = 'club' THEN
    IF p_club_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'club_id required');
    END IF;
    -- A union may only fund ITS OWN clubs. Without this a promo transfer is a
    -- chip mint into any club in the database.
    IF NOT EXISTS (SELECT 1 FROM union_clubs uc
                    WHERE uc.union_id = p_union_id AND uc.club_id = p_club_id) THEN
      RETURN jsonb_build_object('success', false, 'error', 'club is not in this union');
    END IF;
    SELECT c.name INTO v_club_name FROM clubs c WHERE c.id = p_club_id FOR UPDATE;
    IF v_club_name IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'club not found');
    END IF;
    v_note := COALESCE(NULLIF(btrim(p_notes), ''), 'Union Promo Wallet To ' || v_club_name || ' Promo Wallet');

    -- CHIP STANDARD 2.4: ONE journal row, union_wallet -> promo_wallet(club).
    -- The union_wallets trigger is skipped; the clubs trigger writes the row
    -- with the union wallet as its counterparty.
    PERFORM public.fn_ca_declare_ledger('promo_send', 'union_wallet', p_union_id, NULL,
      'union_promo_to_club:' || p_op_id::text, ARRAY['union_wallets']);
    PERFORM set_config('app.ledger_correlation', p_op_id::text, true);

    UPDATE union_wallets SET promo_wallet = promo_wallet - v_amt, updated_at = now()
     WHERE union_id = p_union_id RETURNING promo_wallet INTO v_after;

    -- THE CLUB'S PROMO WALLET. Not chip_treasury: that is the Club Bank, and
    -- a promo send that lands there is a promo send nobody can find.
    UPDATE clubs SET promo_balance = COALESCE(promo_balance, 0) + v_amt, updated_at = now()
     WHERE id = p_club_id RETURNING promo_balance INTO v_club_after;

    PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);

    INSERT INTO union_wallet_transactions
      (union_id, club_id, wallet, direction, amount, balance_after, tx_type, period_id, notes, created_by)
    VALUES
      (p_union_id, p_club_id, 'promo_wallet', 'debit', v_amt, v_after, 'promo_to_club', p_op_id,
       v_note, v_actor);

    INSERT INTO chip_transactions
      (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, metadata)
    VALUES
      (p_club_id, v_actor, NULL, v_amt, 'union_promo_to_club', v_note, v_club_after,
       jsonb_build_object('union_id', p_union_id, 'op_id', p_op_id,
                          'destination', 'club_promo_wallet',
                          'union_promo_after', v_after,
                          'club_promo_after', v_club_after));

    RETURN jsonb_build_object('success', true, 'destination', 'club', 'amount', v_amt,
                              'promo_after', v_after,
                              'club_promo_after', v_club_after,
                              -- kept for the World Hub route, which reads this key
                              'club_treasury_after', NULL);
  END IF;

  -- destination = 'bbj_main'
  UPDATE union_wallets SET promo_wallet = promo_wallet - v_amt, updated_at = now()
   WHERE union_id = p_union_id RETURNING promo_wallet INTO v_after;

  UPDATE bbj_pools
     SET main_balance = COALESCE(main_balance,0) + v_amt,
         pool_amount  = COALESCE(pool_amount,0)  + v_amt,
         updated_at   = now()
   WHERE union_id = p_union_id AND status = 'active'
   RETURNING id INTO v_pool_id;
  IF v_pool_id IS NULL THEN
    RAISE EXCEPTION 'no active BBJ pool for union %', p_union_id;
  END IF;

  INSERT INTO union_wallet_transactions
    (union_id, wallet, direction, amount, balance_after, tx_type, period_id, notes, created_by)
  VALUES
    (p_union_id, 'promo_wallet', 'debit', v_amt, v_after, 'promo_to_bbj_main', p_op_id,
     COALESCE(NULLIF(p_notes, ''), 'Promo wallet -> main jackpot'), v_actor);

  RETURN jsonb_build_object('success', true, 'destination', 'bbj_main', 'amount', v_amt,
                            'promo_after', v_after, 'pool_id', v_pool_id);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', false, 'duplicate', true,
                            'error', 'operation already processed');
END;
$function$;

COMMENT ON FUNCTION public.fn_union_promo_send(uuid, numeric, text, uuid, uuid, uuid, text) IS
  'Spends union_wallets.promo_wallet. destination=club credits clubs.promo_balance (the club Promo Wallet, NOT chip_treasury) - 2026-09-05. destination=bbj_main tops up the live jackpot.';

-- ───────────────────────────────────────────────────────────────────────────
-- B. fn_club_promo_wallet_send: the CLUB'S promo pot, spent by club staff
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_club_promo_wallet_send(
  p_club_id uuid,
  p_to_user_id uuid,
  p_amount numeric,
  p_destination text DEFAULT 'player_wallet'::text,
  p_reason text DEFAULT NULL::text,
  p_op_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_dest         text := lower(coalesce(p_destination, 'player_wallet'));
  v_op_id        uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior        record;
  v_pot_before   numeric;
  v_pot_after    numeric;
  v_to_role      text;
  v_to_after     numeric;
  v_agent_id     uuid;
  v_tx_id        uuid;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  -- The club promo pot is CLUB money, at exactly the sensitivity of the Club
  -- Bank beside it, so it is the Club Bank's four roles that may spend it.
  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null or v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only An Owner, Co Owner, Admin Or Super Agent May Send From The Club Promo Wallet');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('success', false, 'error', 'Chips Move In Hundredths At Most');
  end if;
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'Amount Exceeds The Single Send Limit');
  end if;
  if v_dest not in ('player_wallet', 'agent_wallet') then
    return jsonb_build_object('success', false, 'error', 'Unknown Destination Wallet');
  end if;
  if p_to_user_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose A Recipient');
  end if;

  -- Lock the club FIRST, then look for a replay: two deliveries of one op_id
  -- serialise on this row, so the second always sees the first's receipt.
  select coalesce(c.promo_balance, 0) into v_pot_before
    from clubs c where c.id = p_club_id for update;
  if v_pot_before is null then
    return jsonb_build_object('success', false, 'error', 'Club Not Found');
  end if;

  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'club_promo_send'
     and from_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'pot_after', (v_prior.metadata ->> 'pot_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
  end if;

  if v_pot_before < p_amount then
    return jsonb_build_object('success', false, 'error', 'Insufficient Club Promo Wallet Balance',
      'balance', v_pot_before, 'requested', p_amount);
  end if;

  select cm.role into v_to_role
    from club_members cm
   where cm.club_id = p_club_id
     and cm.user_id = p_to_user_id
     and coalesce(cm.status, 'active') in ('active', 'approved')
   for update;
  if v_to_role is null then
    return jsonb_build_object('success', false, 'error', 'Recipient Is Not An Active Member Of This Club');
  end if;
  if v_dest = 'agent_wallet'
     and v_to_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false, 'error', 'Only Staff Or Agents Hold A Promo Wallet');
  end if;
  -- Same rule as the Club Bank: an admin holds no player wallet, so a player
  -- wallet credit to one is refused rather than stranded.
  if v_dest = 'player_wallet' and v_to_role = 'admin' then
    return jsonb_build_object('success', false, 'error', 'An Admin Does Not Hold A Player Wallet');
  end if;
  if p_to_user_id <> v_actor
     and not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_to_user_id) then
    return jsonb_build_object('success', false, 'error', 'That Member Is Not In Your Downline');
  end if;

  -- CHIP STANDARD 2.4: ONE journal row from the club's promo wallet to the
  -- wallet that receives it. The clubs trigger is skipped; the receiving
  -- wallet's trigger writes the row with the club promo pot as counterparty.
  perform public.fn_ca_declare_ledger('promo_send', 'promo_wallet', p_club_id, null,
    'club_promo_send:' || v_op_id::text, array['clubs']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);

  update clubs
     set promo_balance = coalesce(promo_balance, 0) - p_amount,
         updated_at = now()
   where id = p_club_id
   returning promo_balance into v_pot_after;

  if v_dest = 'player_wallet' then
    -- "IF IT LANDS IN A PLAYER WALLET, ITS JUST AS GOOD AS CASH."
    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount,
           updated_at = now()
     where club_id = p_club_id and user_id = p_to_user_id
     returning chip_balance into v_to_after;
  else
    v_agent_id := public.fn_ensure_agent_row(p_club_id, p_to_user_id, v_to_role);
    if v_agent_id is null then
      raise exception 'could not ensure agents row for % in club %', p_to_user_id, p_club_id;
    end if;
    update agents
       set promo_wallet_balance = coalesce(promo_wallet_balance, 0) + p_amount,
           updated_at = now()
     where id = v_agent_id
     returning promo_wallet_balance into v_to_after;
  end if;
  if v_to_after is null then
    raise exception 'club promo credit landed nowhere for % in %', p_to_user_id, p_club_id;
  end if;
  perform set_config('app.ledger_autoskip_clubs', '', true);

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (p_club_id, v_actor, p_to_user_id, p_amount, 'club_promo_send',
     coalesce(nullif(btrim(p_reason), ''), 'Club Promo Wallet Send'),
     jsonb_build_object(
       'op_id', v_op_id,
       'destination', v_dest,
       'source', 'club_promo_wallet',
       'actor_role', v_actor_role,
       'recipient_role', v_to_role,
       'pot_before', v_pot_before,
       'pot_after', v_pot_after,
       'recipient_balance_after', v_to_after),
     v_pot_after)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true, 'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', p_amount,
    'destination', v_dest,
    'pot_before', v_pot_before,
    'pot_after', v_pot_after,
    'recipient_balance_after', v_to_after);
end
$function$;

REVOKE ALL ON FUNCTION public.fn_club_promo_wallet_send(uuid, uuid, numeric, text, text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_promo_wallet_send(uuid, uuid, numeric, text, text, uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.fn_club_promo_wallet_send(uuid, uuid, numeric, text, text, uuid) IS
  'Spends clubs.promo_balance (the club Promo Wallet) into a member player wallet (as cash) or an agent promo float. Club Bank roles only. fn_promo_wallet_send is the AGENT''S own float; this is the CLUB''S pot.';

-- ───────────────────────────────────────────────────────────────────────────
-- C. fn_promo_wallet_ledger: the ledger attached to every promo wallet
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_promo_wallet_ledger(
  p_scope text,
  p_scope_id uuid,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_wallet text DEFAULT 'promo_wallet'::text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor  uuid := auth.uid();
  v_limit  int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_entity uuid;
  v_total  bigint;
  v_rows   jsonb;
  v_in     numeric;
  v_out    numeric;
begin
  if p_scope = 'union' then
    if coalesce(auth.role(), '') <> 'service_role'
       and not public.fn_union_can_manage_wallets(p_scope_id, v_actor)
       and not exists (select 1 from union_admins ua
                        where ua.union_id = p_scope_id and ua.user_id = v_actor) then
      return jsonb_build_object('authorized', false,
        'error', 'The Union Wallet Ledger Is Restricted To Union Staff');
    end if;
    if p_wallet not in ('chip_balance', 'rake_wallet', 'bbj_wallet', 'promo_wallet',
                        'insurance_wallet', 'spin_reserve_wallet') then
      return jsonb_build_object('authorized', false, 'error', 'Unknown Union Wallet');
    end if;

    select count(*),
           coalesce(sum(t.amount) filter (where t.direction = 'credit'), 0),
           coalesce(sum(t.amount) filter (where t.direction = 'debit'), 0)
      into v_total, v_in, v_out
      from union_wallet_transactions t
     where t.union_id = p_scope_id and t.wallet = p_wallet;

    select coalesce(jsonb_agg(r), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
               'id', t.id,
               'created_at', t.created_at,
               'amount', round(coalesce(t.amount, 0), 2),
               'direction', case when t.direction = 'credit' then 'in' else 'out' end,
               'category', t.tx_type,
               'notes', t.notes,
               'balance_after', t.balance_after,
               'counterparty_type', case when t.club_id is not null then 'club' else null end,
               'counterparty_name', c.name,
               'actor_name', coalesce(public.fn_arena_name(pa.alias, pa.username, pa.display_name,
                                       pa.first_name, pa.last_name, pa.full_name), pa.username)
             ) as r
        from union_wallet_transactions t
        left join clubs c on c.id = t.club_id
        left join profiles pa on pa.id = t.created_by
       where t.union_id = p_scope_id and t.wallet = p_wallet
       order by t.created_at desc
       limit v_limit offset v_offset
    ) s;

    return jsonb_build_object('authorized', true, 'scope', 'union', 'wallet', p_wallet,
      'total', v_total, 'limit', v_limit, 'offset', v_offset,
      'totals', jsonb_build_object('in', round(v_in, 2), 'out', round(v_out, 2),
                                   'net', round(v_in - v_out, 2)),
      'rows', v_rows);
  end if;

  -- The two club-surface promo wallets live in chip_ledger under the account
  -- type 'promo_wallet': entity = the club for clubs.promo_balance, entity =
  -- the person for agents.promo_wallet_balance (scoped to one club by club_id).
  if p_scope = 'club' then
    if not public.fn_can_use_club_bank(p_scope_id) then
      return jsonb_build_object('authorized', false,
        'error', 'The Club Promo Wallet Ledger Is Restricted To Owners, Co Owners, Admins And Super Agents');
    end if;
    v_entity := p_scope_id;
  elsif p_scope = 'agent' then
    if v_actor is null or not exists (
         select 1 from club_members cm
          where cm.club_id = p_scope_id and cm.user_id = v_actor
            and coalesce(cm.status, 'active') in ('active', 'approved')) then
      return jsonb_build_object('authorized', false,
        'error', 'You Do Not Hold A Promo Wallet In This Club');
    end if;
    v_entity := v_actor;
  else
    return jsonb_build_object('authorized', false, 'error', 'Unknown Ledger Scope');
  end if;

  select count(*),
         coalesce(sum(l.amount) filter (where l.to_type = 'promo_wallet' and l.to_entity_id = v_entity), 0),
         coalesce(sum(l.amount) filter (where l.from_type = 'promo_wallet' and l.from_entity_id = v_entity), 0)
    into v_total, v_in, v_out
    from chip_ledger l
   where ((l.to_type = 'promo_wallet' and l.to_entity_id = v_entity)
       or (l.from_type = 'promo_wallet' and l.from_entity_id = v_entity))
     and (p_scope = 'club' or l.club_id = p_scope_id);

  select coalesce(jsonb_agg(r), '[]'::jsonb) into v_rows
  from (
    select jsonb_build_object(
             'id', l.id,
             'created_at', l.created_at,
             'amount', round(coalesce(l.amount, 0), 2),
             'direction', x.dir,
             'category', l.category,
             'notes', coalesce(l.notes, l.description),
             'balance_after', case when x.dir = 'in' then l.post_to_balance else l.post_from_balance end,
             'counterparty_type', x.cp_type,
             'counterparty_name',
               case
                 when pp.id is not null then coalesce(public.fn_arena_name(pp.alias, pp.username,
                        pp.display_name, pp.first_name, pp.last_name, pp.full_name), pp.username)
                 when cc.id is not null then cc.name
                 when uu.id is not null then uu.name
                 else null
               end,
             'actor_name', coalesce(public.fn_arena_name(pa.alias, pa.username, pa.display_name,
                                     pa.first_name, pa.last_name, pa.full_name), pa.username)
           ) as r
      from chip_ledger l
      cross join lateral (
        select case when l.to_type = 'promo_wallet' and l.to_entity_id = v_entity then 'in' else 'out' end as dir,
               case when l.to_type = 'promo_wallet' and l.to_entity_id = v_entity then l.from_type else l.to_type end as cp_type,
               case when l.to_type = 'promo_wallet' and l.to_entity_id = v_entity then l.from_entity_id else l.to_entity_id end as cp_id
      ) x
      left join profiles pp on pp.id = x.cp_id
        and x.cp_type in ('player_wallet', 'agent_wallet', 'promo_wallet')
      left join clubs cc on cc.id = x.cp_id and pp.id is null
      left join unions uu on uu.id = x.cp_id and pp.id is null and cc.id is null
      left join profiles pa on pa.id = l.performed_by
     where ((l.to_type = 'promo_wallet' and l.to_entity_id = v_entity)
         or (l.from_type = 'promo_wallet' and l.from_entity_id = v_entity))
       and (p_scope = 'club' or l.club_id = p_scope_id)
     order by l.created_at desc
     limit v_limit offset v_offset
  ) s;

  return jsonb_build_object('authorized', true, 'scope', p_scope, 'wallet', 'promo_wallet',
    'total', v_total, 'limit', v_limit, 'offset', v_offset,
    'totals', jsonb_build_object('in', round(v_in, 2), 'out', round(v_out, 2),
                                 'net', round(v_in - v_out, 2)),
    'rows', v_rows);
end
$function$;

REVOKE ALL ON FUNCTION public.fn_promo_wallet_ledger(text, uuid, integer, integer, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_promo_wallet_ledger(text, uuid, integer, integer, text) TO authenticated, service_role;
COMMENT ON FUNCTION public.fn_promo_wallet_ledger(text, uuid, integer, integer, text) IS
  'The transaction ledger attached to a promo wallet. scope=union (any union wallet column via p_wallet), scope=club (clubs.promo_balance), scope=agent (the caller''s agents.promo_wallet_balance in that club). Newest first, paged.';

-- ───────────────────────────────────────────────────────────────────────────
-- D. Reroute the two club sends of 2026-09-05 02:51 UTC to what was asked for
-- ───────────────────────────────────────────────────────────────────────────
DO $reroute$
DECLARE
  c_union   CONSTANT uuid := 'fade0000-0000-0000-0000-000000000001';
  c_actor   CONSTANT uuid := '47965354-0e56-43ef-931c-ddaab82af765';
  c_amount  CONSTANT numeric := 5000.00;
  r         record;
  v_bank_before  numeric;
  v_promo_before numeric;
  v_bank_after   numeric;
  v_promo_after  numeric;
  v_treas_before numeric;
  v_pot_before   numeric;
  v_treas_after  numeric;
  v_pot_after    numeric;
  v_ubank_after  numeric;
  v_upromo_after numeric;
  v_done         int := 0;
BEGIN
  SELECT chip_balance, promo_wallet INTO v_bank_before, v_promo_before
    FROM union_wallets WHERE union_id = c_union FOR UPDATE;
  IF v_bank_before IS NULL THEN
    RAISE EXCEPTION 'reroute: union wallet % not found', c_union;
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('4a363124-0287-4a9e-bdfb-e697b0f32018'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid,
       '8e71c3ef-6253-4103-9f12-d8fcec7ab412'::uuid),
      ('a458f05e-1dee-4942-8bd4-ead9616d0ec7'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,
       '3997a465-508f-488a-871a-2c54751321e9'::uuid)
    ) AS v(union_tx_id, club_id, club_tx_id)
  LOOP
    -- READ, not assumed: the original rows must be exactly what the trace found.
    IF NOT EXISTS (
      SELECT 1 FROM union_wallet_transactions t
       WHERE t.id = r.union_tx_id AND t.union_id = c_union AND t.club_id = r.club_id
         AND t.wallet = 'chip_balance' AND t.direction = 'debit'
         AND t.amount = c_amount AND t.tx_type = 'manual_transfer'
         AND t.notes = 'Promo Wallet to club' AND t.created_by = c_actor) THEN
      RAISE EXCEPTION 'reroute: union transaction % is not the row that was traced', r.union_tx_id;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM chip_transactions x
       WHERE x.id = r.club_tx_id AND x.club_id = r.club_id AND x.amount = c_amount
         AND x.transaction_type = 'union_transfer') THEN
      RAISE EXCEPTION 'reroute: club transaction % is not the row that was traced', r.club_tx_id;
    END IF;
    -- NOBODY IS PAID TWICE: the correction is keyed on the original id.
    IF EXISTS (SELECT 1 FROM chip_transactions x
                WHERE x.club_id = r.club_id AND x.metadata ->> 'reroute_of' = r.union_tx_id::text) THEN
      RAISE NOTICE 'reroute: % already corrected, skipping', r.union_tx_id;
      CONTINUE;
    END IF;

    SELECT COALESCE(chip_treasury, 0), COALESCE(promo_balance, 0)
      INTO v_treas_before, v_pot_before
      FROM clubs WHERE id = r.club_id FOR UPDATE;
    IF v_treas_before < c_amount THEN
      RAISE EXCEPTION 'reroute: club % bank holds % which is below the % being given back',
        r.club_id, v_treas_before, c_amount;
    END IF;

    -- Leg 1: REVERSE the wrong route. Club Bank -> Union Bank, one journal row
    -- (club_treasury -> union_bank), keyed on the original transaction.
    PERFORM public.fn_ca_declare_ledger('reversal', 'union_bank', c_union, NULL,
      'promo_reroute_reversal:' || r.union_tx_id::text, ARRAY['union_wallets']);
    UPDATE clubs SET chip_treasury = chip_treasury - c_amount, updated_at = now()
     WHERE id = r.club_id RETURNING chip_treasury INTO v_treas_after;
    UPDATE union_wallets SET chip_balance = chip_balance + c_amount, updated_at = now()
     WHERE union_id = c_union RETURNING chip_balance INTO v_ubank_after;
    PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);

    INSERT INTO union_wallet_transactions
      (union_id, club_id, wallet, direction, amount, balance_after, tx_type, period_id, notes, created_by)
    VALUES
      (c_union, r.club_id, 'chip_balance', 'credit', c_amount, v_ubank_after, 'manual_transfer_reversal',
       gen_random_uuid(),
       'Reversal Of A Promo Send That Was Routed Through The Union Bank (Corrects ' || r.union_tx_id::text || ')',
       c_actor);
    INSERT INTO chip_transactions
      (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, metadata)
    VALUES
      (r.club_id, NULL, NULL, c_amount, 'union_transfer_reversal',
       'Club Bank Gives Back A Promo Send That Landed In The Wrong Wallet',
       v_treas_after,
       jsonb_build_object('union_id', c_union, 'reverses', r.club_tx_id, 'reroute_of', r.union_tx_id,
                          'bank_after', v_treas_after));

    -- Leg 2: the SEND THAT WAS ASKED FOR. Union Promo Wallet -> Club Promo
    -- Wallet, one journal row (union_wallet -> promo_wallet(club)).
    PERFORM public.fn_ca_declare_ledger('promo_send', 'union_wallet', c_union, NULL,
      'promo_reroute_send:' || r.union_tx_id::text, ARRAY['union_wallets']);
    UPDATE union_wallets SET promo_wallet = promo_wallet - c_amount, updated_at = now()
     WHERE union_id = c_union AND promo_wallet >= c_amount
     RETURNING promo_wallet INTO v_upromo_after;
    IF v_upromo_after IS NULL THEN
      RAISE EXCEPTION 'reroute: union promo wallet cannot cover %', c_amount;
    END IF;
    UPDATE clubs SET promo_balance = COALESCE(promo_balance, 0) + c_amount, updated_at = now()
     WHERE id = r.club_id RETURNING promo_balance INTO v_pot_after;
    PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);

    INSERT INTO union_wallet_transactions
      (union_id, club_id, wallet, direction, amount, balance_after, tx_type, period_id, notes, created_by)
    VALUES
      (c_union, r.club_id, 'promo_wallet', 'debit', c_amount, v_upromo_after, 'promo_to_club',
       gen_random_uuid(),
       'Promo Wallet To Club Promo Wallet (Rerouted From ' || r.union_tx_id::text || ')',
       c_actor);
    INSERT INTO chip_transactions
      (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, metadata)
    VALUES
      (r.club_id, c_actor, NULL, c_amount, 'union_promo_to_club',
       'Union Promo Wallet To Club Promo Wallet (Rerouted From The Club Bank)',
       v_pot_after,
       jsonb_build_object('union_id', c_union, 'reroute_of', r.union_tx_id,
                          'destination', 'club_promo_wallet',
                          'union_promo_after', v_upromo_after, 'club_promo_after', v_pot_after));

    -- The club's books moved by exactly the amount, in both accounts.
    IF v_treas_after <> v_treas_before - c_amount OR v_pot_after <> v_pot_before + c_amount THEN
      RAISE EXCEPTION 'reroute: club % books did not move as expected (bank % -> %, promo % -> %)',
        r.club_id, v_treas_before, v_treas_after, v_pot_before, v_pot_after;
    END IF;
    v_done := v_done + 1;
  END LOOP;

  SELECT chip_balance, promo_wallet INTO v_bank_after, v_promo_after
    FROM union_wallets WHERE union_id = c_union;
  IF v_bank_after <> v_bank_before + (v_done * c_amount)
     OR v_promo_after <> v_promo_before - (v_done * c_amount) THEN
    RAISE EXCEPTION 'reroute: union books did not move as expected (bank % -> %, promo % -> %, legs %)',
      v_bank_before, v_bank_after, v_promo_before, v_promo_after, v_done;
  END IF;
  RAISE NOTICE 'reroute: % club sends rerouted; union bank % -> %, union promo % -> %',
    v_done, v_bank_before, v_bank_after, v_promo_before, v_promo_after;
END
$reroute$;

COMMIT;

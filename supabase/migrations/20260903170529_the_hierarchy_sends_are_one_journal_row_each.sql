-- ═══════════════════════════════════════════════════════════════════════════════
--  THE HIERARCHY SENDS ARE ONE JOURNAL ROW EACH
--  Chip Accounting Standard Phase 2, lane 2.4 (audit F3, lane2-hierarchy.md 2.2 / 3.1)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- DECLARATION ONLY. No balance write moves, no amount changes, no new refusal,
-- no change to any auth check, limit, window or credit rule. Part 2 of 2;
-- the vocabulary and the writer default are in the companion migration
-- (the_hierarchy_has_words_for_its_sends_and_an_undeclared_wallet_write_is_honest).
--
-- Every function below is the live body (pg_get_functiondef, 2026-09-03 ~16:30
-- UTC) with lines ADDED around its balance writes and nothing removed: the
-- rebuilt bodies were checked line by line against the live prosrc before
-- apply (every live line survives, in order), and the self-check at the end
-- counts each body's refusals and RAISEs against the live numbers.
--
-- WHAT WAS WRONG. The hierarchy RPCs write two balance columns and journal
-- nothing themselves; the auto-ledger triggers (fn_ca_autoledger on clubs /
-- agents / union_wallets, fn_club_members_ledger_writer on
-- club_members.chip_balance) each wrote one single-leg `adjustment` row
-- against settlement_suspense (or an invented table_stack), with no key and
-- no correlation. Verified: fn_agent_wallet_send 2026-09-01 14:23:18,
-- 10,000.00 to a player -> `adjustment agent_wallet -> settlement_suspense`
-- + `adjustment table_stack -> player_wallet`; fn_club_bank_send 2026-09-01
-- 14:02:19, 3,750,000.00 -> `adjustment club_treasury -> settlement_suspense`
-- + `adjustment settlement_suspense -> agent_wallet`. 30 days: 416 agent
-- sends / 12,860,000.00, 32 self-stakes / 320,000.00, 5 bank sends /
-- 7,601,001.00, 1 reversal, 1 staff pull; suspense +182,131.56 in 23h.
--
-- THE RULE (S3 / P3, R9). One movement, one row, sender's account -> receiver's
-- account, a category that names the event, keyed on the op, correlated on
-- the op. Suspense trends to zero.
--
-- HOW (the Phase 1.2 / 1.3 shape, 20260902220500 and 20260902224000): the
-- function calls fn_ca_declare_ledger(category, counterparty, entity, NULL,
-- key, autoskip) before its first balance write. The counterparty is declared
-- on ONE side and the OTHER side's table is autoskipped, so the one trigger
-- that still fires writes the whole row. fn_club_members_ledger_writer does
-- not read the autoskip GUC, so the club_members side is always the side that
-- writes and the treasury / float side is the side that is skipped. Where
-- both sides live in the same table (agent float -> agent float, promo float
-- -> promo float) the table is skipped and the row is posted explicitly
-- through fn_ca_post_leg, which never blocks the money (a failed insert lands
-- in ca_ledger_write_failures, the same contract as the triggers and as
-- fn_horse_fund_from_treasury). The autoskip is cleared right after the
-- write it covers. app.ledger_correlation = the op id, so a two-row movement
-- (a send that drew credit) is one correlation.
--
--   C1  fn_club_bank_send            club_bank_send   club_treasury(club)  -> agent_wallet | promo_wallet | player_wallet
--   C2a fn_club_bank_claim_back      club_bank_claim  agent_wallet | promo_wallet | player_wallet -> club_treasury(club)
--   C2b fn_club_bank_reverse         reversal         recipient wallet -> club_treasury(club)
--   C2c fn_admin_remove_player_chips club_bank_claim  player_wallet -> club_treasury(club)
--   C3a fn_agent_wallet_send_core_20260830
--                                    agent_send       agent_wallet(actor) -> player_wallet | agent_wallet
--                                    + credit_draw    credit_facility(actor) -> agent_wallet(actor)  [only the shortfall]
--   C3b fn_agent_wallet_claim_back_phase2_core_20260831
--                                    agent_claim      player_wallet | agent_wallet -> agent_wallet(actor)
--                                    + credit_repayment agent_wallet(actor) -> credit_facility(actor) [only the repayment]
--   C3c fn_agent_wallet_self_stake   agent_send       agent_wallet(actor) -> player_wallet(actor)
--   C3d fn_promo_wallet_send         promo_send       promo_wallet(actor) -> player_wallet | promo_wallet
--   U3c fn_union_clawback_from_club  union_settlement club_treasury(club) -> union_bank(union)
--
-- THE CREDIT LINE. When a post-paid agent's float is short, the float pays
-- p_amount - v_shortfall and credit_used grows by v_shortfall; the receiver
-- gets p_amount. Journaled as the send row for the whole p_amount plus a
-- `credit_draw credit_facility -> agent_wallet` row for the shortfall, so the
-- agent_wallets trial-balance line reconciles exactly (-(p_amount -
-- shortfall) on both sides). The claim back mirrors it: `agent_claim` for the
-- whole v_take plus `credit_repayment agent_wallet -> credit_facility` for
-- v_repay. credit_facility is NOT one of fn_ca_noncirculating_chip_stores(),
-- so a credit draw shows in total_supply as it did before this migration
-- (the chips did appear); whether the facility is an issuance account is the
-- Mint lane's decision, not a declaration. credit_used is 0.00 on every agent
-- today, so this path has no live volume.
--
-- NOT CHANGED (read, reported): fn_union_send_to_club_atomic,
-- fn_union_send_chips_to_club, fn_cashier_send_chips, fn_cashier_claim_back,
-- fn_wallet_claim_back are orphan doors with no caller (another lane revokes
-- them); fn_member_leave_to_treasury journals its wallet side through the
-- DELETE trigger (C8 is a policy question, not a declaration); the wrappers
-- fn_agent_wallet_send, fn_agent_wallet_claim_back and
-- fn_agent_wallet_send_phase2_core_20260831 write no balance and are untouched.
--
-- Grants: CREATE OR REPLACE keeps every ACL; they are restated below so the
-- repository says who may call. fn_ca_post_leg is new and service_role-only
-- (it is only ever reached from inside these SECURITY DEFINER bodies).

BEGIN;

-- ── 0. the explicit-row primitive: never blocks the money ─────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_post_leg(
  p_category text, p_from_type text, p_from_entity uuid, p_to_type text, p_to_entity uuid,
  p_amount numeric, p_club_id uuid, p_idempotency_key text, p_description text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_st text; v_msg text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN false;
  END IF;
  BEGIN
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, description, idempotency_key)
    VALUES (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
            p_from_type, p_from_entity, p_to_type, p_to_entity,
            round(p_amount, 2), p_category, p_club_id, p_description, p_idempotency_key);
    RETURN true;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_st = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    BEGIN
      INSERT INTO public.ca_ledger_write_failures (club_id, user_id, delta, sqlstate, message)
      VALUES (p_club_id, COALESCE(p_to_entity, p_from_entity), p_amount, v_st,
              'fn_ca_post_leg ' || p_category || ' ' || p_from_type || ' -> ' || p_to_type || ': ' || v_msg);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RETURN false;
  END;
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_post_leg(text, text, uuid, text, uuid, numeric, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_post_leg(text, text, uuid, text, uuid, numeric, uuid, text, text)
  TO service_role;

-- ── fn_club_bank_send ──
CREATE OR REPLACE FUNCTION public.fn_club_bank_send(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'agent_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_dest         text := lower(coalesce(p_destination, 'agent_wallet'));
  v_op_id        uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior        record;
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

  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'club_bank_send'
     and from_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'bank_after', (v_prior.metadata ->> 'bank_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('success', false,
      'error', 'Chips Move In Hundredths At Most');
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

  select cm.role into v_to_role
    from club_members cm
   where cm.club_id = p_club_id
     and cm.user_id = p_to_user_id
     and coalesce(cm.status, 'active') in ('active', 'approved')
   for update;
  if v_to_role is null then
    return jsonb_build_object('success', false, 'error', 'Recipient Is Not An Active Member Of This Club');
  end if;
  if v_dest in ('agent_wallet', 'promo_wallet')
     and v_to_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only Staff Or Agents Hold An Agent Wallet');
  end if;
  -- Dan 2026-09-02: "ALL CLUB OWNERS AND CO-OWNERS SHOULD HAVE A PLAYER
  -- WALLET (ADMIN'S SHOULD NOT)". A player-wallet credit to an admin lands in
  -- a balance no surface shows them, so it is refused here rather than
  -- stranded.
  if v_dest = 'player_wallet' and v_to_role = 'admin' then
    return jsonb_build_object('success', false,
      'error', 'An Admin Does Not Hold A Player Wallet');
  end if;

  if p_to_user_id <> v_actor
     and not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_to_user_id) then
    return jsonb_build_object('success', false,
      'error', 'That Member Is Not In Your Downline');
  end if;

  select coalesce(c.chip_treasury, 0) into v_bank_before
    from clubs c where c.id = p_club_id for update;
  if v_bank_before is null then
    return jsonb_build_object('success', false, 'error', 'Club Not Found');
  end if;
  if v_bank_before < p_amount then
    return jsonb_build_object('success', false, 'error', 'Insufficient Club Bank Balance',
      'balance', v_bank_before, 'requested', p_amount);
  end if;

  -- CHIP STANDARD 2.4 (2026-09-03): a club bank send is ONE journal row from
  -- the bank to the wallet that receives it. Undeclared, the two balance
  -- writes landed as `adjustment club_treasury -> settlement_suspense` plus
  -- `adjustment settlement_suspense -> agent_wallet` (or `table_stack ->
  -- player_wallet`), unkeyed and uncorrelated (3,750,000.00 on 2026-09-01
  -- 14:02:19 journaled exactly so). The clubs trigger is skipped for this
  -- write; the receiving wallet's trigger writes the row with the bank as its
  -- counterparty, keyed and correlated on the op. Never a refusal: a journal
  -- miss falls back inside the trigger, the money moves as before.
  perform public.fn_ca_declare_ledger('club_bank_send', 'club_treasury', p_club_id, null,
    'club_bank_send:' || v_op_id::text, array['clubs']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);

  update clubs
     set chip_treasury = coalesce(chip_treasury, 0) - p_amount,
         updated_at = now()
   where id = p_club_id
   returning chip_treasury into v_bank_after;

  if v_dest = 'player_wallet' then
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
  perform set_config('app.ledger_autoskip_clubs', '', true);

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata,
     balance_after, reversible_until)
  values
    (p_club_id, v_actor, p_to_user_id, p_amount, 'club_bank_send',
     coalesce(nullif(btrim(p_reason), ''), 'Club Bank Send'),
     jsonb_build_object(
       'op_id', v_op_id,
       'destination', v_dest,
       'actor_role', v_actor_role,
       'recipient_role', v_to_role,
       'bank_before', v_bank_before,
       'bank_after', v_bank_after,
       'recipient_balance_after', v_to_after),
     v_bank_after, now() + interval '7 days')
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true,
    'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', p_amount,
    'destination', v_dest,
    'bank_before', v_bank_before,
    'bank_after', v_bank_after,
    'recipient_balance_after', v_to_after);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from chip_transactions
     where club_id = p_club_id
       and transaction_type = 'club_bank_send'
       and from_user_id = v_actor
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    if v_prior.id is null then
      raise;
    end if;
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'bank_after', (v_prior.metadata ->> 'bank_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
end
$function$
;

-- ── fn_club_bank_claim_back ──
CREATE OR REPLACE FUNCTION public.fn_club_bank_claim_back(p_club_id uuid, p_from_user_id uuid, p_amount numeric, p_source text DEFAULT 'agent_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_source       text := lower(coalesce(p_source, 'agent_wallet'));
  v_op_id        uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior        record;
  v_holder_role  text;
  v_held         numeric;
  v_agent_id     uuid;
  v_holder_after numeric;
  v_bank_after   numeric;
  v_tx_id        uuid;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null or v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only An Owner, Co Owner, Admin Or Super Agent May Claim Chips Back Into The Club Bank');
  end if;

  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'club_bank_claim'
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'source', v_prior.metadata ->> 'source',
      'bank_after', (v_prior.metadata ->> 'bank_after')::numeric,
      'holder_balance_after', (v_prior.metadata ->> 'holder_balance_after')::numeric);
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'Amount Exceeds The Single Claim Limit');
  end if;
  if v_source not in ('agent_wallet', 'promo_wallet', 'player_wallet') then
    return jsonb_build_object('success', false, 'error', 'Unknown Source Wallet');
  end if;
  if p_from_user_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose Whose Wallet To Claim From');
  end if;

  if p_from_user_id <> v_actor
     and not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_from_user_id) then
    return jsonb_build_object('success', false,
      'error', 'That Member Is Not In Your Downline');
  end if;

  select cm.role into v_holder_role
    from club_members cm
   where cm.club_id = p_club_id
     and cm.user_id = p_from_user_id
     and coalesce(cm.status, 'active') in ('active', 'approved')
   for update;
  if v_holder_role is null then
    return jsonb_build_object('success', false, 'error', 'That Person Is Not An Active Member Of This Club');
  end if;

  if v_source = 'player_wallet' then
    select coalesce(chip_balance, 0) into v_held
      from club_members
     where club_id = p_club_id and user_id = p_from_user_id
     for update;
  else
    if v_holder_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
      return jsonb_build_object('success', false,
        'error', 'Only Staff Or Agents Hold An Agent Wallet');
    end if;
    select a.id, coalesce(case when v_source = 'promo_wallet'
                               then a.promo_wallet_balance
                               else a.agent_wallet_balance end, 0)
      into v_agent_id, v_held
      from agents a
     where a.club_id = p_club_id and a.user_id = p_from_user_id
     for update;
    if v_agent_id is null then
      return jsonb_build_object('success', false,
        'error', 'That Member Has Never Been Funded, So There Is Nothing To Claim');
    end if;
  end if;

  if v_held < p_amount then
    return jsonb_build_object('success', false,
      'error', 'That Wallet Only Holds ' || trim(to_char(v_held, 'FM999,999,999,990.00')) || ' Chips',
      'held', v_held, 'requested', p_amount);
  end if;

  -- CHIP STANDARD 2.4 (2026-09-03): ONE row from the wallet claimed to the
  -- club bank, keyed and correlated on the op. The clubs trigger is skipped;
  -- the holder's wallet trigger writes the row with the bank as counterparty.
  perform public.fn_ca_declare_ledger('club_bank_claim', 'club_treasury', p_club_id, null,
    'club_bank_claim:' || v_op_id::text, array['clubs']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);

  if v_source = 'player_wallet' then
    update club_members
       set chip_balance = coalesce(chip_balance, 0) - p_amount,
           updated_at = now()
     where club_id = p_club_id and user_id = p_from_user_id
     returning chip_balance into v_holder_after;
  elsif v_source = 'promo_wallet' then
    update agents
       set promo_wallet_balance = coalesce(promo_wallet_balance, 0) - p_amount,
           updated_at = now()
     where id = v_agent_id
     returning promo_wallet_balance into v_holder_after;
  else
    update agents
       set agent_wallet_balance = coalesce(agent_wallet_balance, 0) - p_amount,
           updated_at = now()
     where id = v_agent_id
     returning agent_wallet_balance into v_holder_after;
  end if;

  update clubs
     set chip_treasury = coalesce(chip_treasury, 0) + p_amount,
         updated_at = now()
   where id = p_club_id
   returning chip_treasury into v_bank_after;
  if v_bank_after is null then
    raise exception 'club % not found while crediting the bank', p_club_id;
  end if;
  perform set_config('app.ledger_autoskip_clubs', '', true);

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (p_club_id, p_from_user_id, v_actor, p_amount, 'club_bank_claim',
     coalesce(nullif(btrim(p_reason), ''), 'Club Bank Claim Back'),
     jsonb_build_object(
       'op_id', v_op_id,
       'source', v_source,
       'direction', 'into_bank',
       'actor_role', v_actor_role,
       'holder_role', v_holder_role,
       'bank_after', v_bank_after,
       'holder_balance_after', v_holder_after),
     v_bank_after)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true, 'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', p_amount,
    'source', v_source,
    'bank_after', v_bank_after,
    'holder_balance_after', v_holder_after);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from chip_transactions
     where club_id = p_club_id
       and transaction_type = 'club_bank_claim'
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'source', v_prior.metadata ->> 'source',
      'bank_after', (v_prior.metadata ->> 'bank_after')::numeric,
      'holder_balance_after', (v_prior.metadata ->> 'holder_balance_after')::numeric);
end
$function$
;

-- ── fn_club_bank_reverse ──
CREATE OR REPLACE FUNCTION public.fn_club_bank_reverse(p_transaction_id uuid, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_op_id      uuid := coalesce(p_op_id, gen_random_uuid());
  v_tx         record;
  v_dest       text;
  v_held       numeric;
  v_agent_id   uuid;
  v_bank_after numeric;
  v_to_after   numeric;
  v_new_id     uuid;
  v_prior      record;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  select id, club_id, from_user_id, to_user_id, amount, transaction_type,
         coalesce(metadata, '{}'::jsonb) as metadata,
         coalesce(is_reversed, false) as is_reversed, reversible_until
    into v_tx
    from chip_transactions
   where id = p_transaction_id
   for update;
  if v_tx.id is null then
    return jsonb_build_object('success', false, 'error', 'That Ledger Entry Was Not Found');
  end if;

  v_actor_role := public.fn_club_bank_role(v_tx.club_id);
  if v_actor_role is null or v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only An Owner, Co Owner, Admin Or Super Agent May Reverse A Club Bank Send');
  end if;

  select id into v_prior from chip_transactions
   where club_id = v_tx.club_id
     and transaction_type = 'club_bank_reversal'
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object('success', true, 'replayed', true, 'transaction_id', v_prior.id);
  end if;

  if v_tx.transaction_type <> 'club_bank_send' then
    return jsonb_build_object('success', false,
      'error', 'Only A Club Bank Send Can Be Reversed Here');
  end if;
  if v_tx.is_reversed then
    return jsonb_build_object('success', false, 'error', 'That Send Has Already Been Reversed');
  end if;
  if v_tx.reversible_until is not null and now() > v_tx.reversible_until then
    return jsonb_build_object('success', false,
      'error', 'That Send Is Outside Its Seven Day Reversal Window');
  end if;

  v_dest := coalesce(v_tx.metadata ->> 'destination', 'agent_wallet');

  -- Take the chips back only if they are still there.
  if v_dest = 'player_wallet' then
    select coalesce(chip_balance, 0) into v_held
      from club_members
     where club_id = v_tx.club_id and user_id = v_tx.to_user_id
     for update;
  else
    select a.id, coalesce(case when v_dest = 'promo_wallet'
                               then a.promo_wallet_balance
                               else a.agent_wallet_balance end, 0)
      into v_agent_id, v_held
      from agents a
     where a.club_id = v_tx.club_id and a.user_id = v_tx.to_user_id
     for update;
  end if;

  if v_held is null then
    return jsonb_build_object('success', false, 'error', 'That Wallet No Longer Exists');
  end if;
  if v_held < v_tx.amount then
    return jsonb_build_object('success', false,
      'error', 'Those Chips Have Already Been Spent, So The Send Cannot Be Reversed',
      'held', v_held, 'required', v_tx.amount);
  end if;

  -- CHIP STANDARD 2.4 (2026-09-03): ONE `reversal` row from the wallet that
  -- received the send back to the club bank, keyed and correlated on the op.
  -- The clubs trigger is skipped; the recipient's wallet trigger writes it.
  perform public.fn_ca_declare_ledger('reversal', 'club_treasury', v_tx.club_id, null,
    'club_bank_reversal:' || v_op_id::text, array['clubs']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);

  if v_dest = 'player_wallet' then
    update club_members set chip_balance = chip_balance - v_tx.amount, updated_at = now()
     where club_id = v_tx.club_id and user_id = v_tx.to_user_id
     returning chip_balance into v_to_after;
  elsif v_dest = 'promo_wallet' then
    update agents set promo_wallet_balance = promo_wallet_balance - v_tx.amount, updated_at = now()
     where id = v_agent_id returning promo_wallet_balance into v_to_after;
  else
    update agents set agent_wallet_balance = agent_wallet_balance - v_tx.amount, updated_at = now()
     where id = v_agent_id returning agent_wallet_balance into v_to_after;
  end if;

  update clubs set chip_treasury = coalesce(chip_treasury, 0) + v_tx.amount, updated_at = now()
   where id = v_tx.club_id returning chip_treasury into v_bank_after;
  perform set_config('app.ledger_autoskip_clubs', '', true);

  update chip_transactions
     set is_reversed = true, clawed_back = true
   where id = v_tx.id;

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (v_tx.club_id, v_tx.to_user_id, v_tx.from_user_id, v_tx.amount, 'club_bank_reversal',
     coalesce(nullif(btrim(p_reason), ''), 'Club Bank Send Reversed'),
     jsonb_build_object(
       'op_id', v_op_id,
       'reverses', v_tx.id,
       'destination', v_dest,
       'actor_role', v_actor_role,
       'bank_after', v_bank_after,
       'recipient_balance_after', v_to_after),
     v_bank_after)
  returning id into v_new_id;

  return jsonb_build_object(
    'success', true, 'replayed', false,
    'transaction_id', v_new_id, 'reversed', v_tx.id,
    'amount', v_tx.amount, 'bank_after', v_bank_after,
    'recipient_balance_after', v_to_after);
end
$function$
;

-- ── fn_admin_remove_player_chips ──
CREATE OR REPLACE FUNCTION public.fn_admin_remove_player_chips(p_club_id uuid, p_player_id uuid, p_amount numeric, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- CHIP STANDARD 2.4 (2026-09-03): ONE `club_bank_claim` row from the
  -- member's wallet to the club bank, keyed and correlated on the op. The
  -- clubs trigger is skipped; the club_members trigger writes the row with
  -- the bank as its counterparty (it used to invent `table_stack`).
  perform public.fn_ca_declare_ledger('club_bank_claim', 'club_treasury', p_club_id, null,
    'admin_removal:' || v_op_id::text, array['clubs']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);

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
  perform set_config('app.ledger_autoskip_clubs', '', true);

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
$function$
;

-- ── fn_agent_wallet_send_core_20260830 ──
CREATE OR REPLACE FUNCTION public.fn_agent_wallet_send_core_20260830(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
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
  v_agent_id     uuid;
  v_float_before numeric;
  v_float_after  numeric;
  v_is_prepaid   boolean;
  v_credit_limit numeric;
  v_credit_used  numeric;
  v_credit_after numeric;
  v_shortfall    numeric := 0;
  v_headroom     numeric;
  v_to_role      text;
  v_to_agent_id  uuid;
  v_to_after     numeric;
  v_tx_id        uuid;
  v_until        timestamptz;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'agent_wallet_send'
     and from_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric,
      'credit_drawn', coalesce((v_prior.metadata ->> 'credit_drawn')::numeric, 0),
      'credit_used_after', (v_prior.metadata ->> 'credit_used_after')::numeric,
      'credit_limit', (v_prior.metadata ->> 'credit_limit')::numeric);
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null
     or v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only Staff Or Agents Hold An Agent Wallet');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('success', false,
      'error', 'Chips Move In Hundredths At Most');
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
  if p_to_user_id = v_actor then
    return jsonb_build_object('success', false,
      'error', 'You Cannot Send Chips To Yourself');
  end if;

  if not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_to_user_id) then
    return jsonb_build_object('success', false,
      'error', 'That Member Is Not In Your Downline');
  end if;

  select cm.role into v_to_role
    from club_members cm
   where cm.club_id = p_club_id
     and cm.user_id = p_to_user_id
     and coalesce(cm.status, 'active') in ('active', 'approved')
   for update;
  if v_to_role is null then
    return jsonb_build_object('success', false,
      'error', 'Recipient Is Not An Active Member Of This Club');
  end if;
  if v_dest = 'agent_wallet'
     and v_to_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only Staff Or Agents Hold An Agent Wallet');
  end if;

  if v_to_role in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    v_dest := 'agent_wallet';
  end if;

  select a.id, coalesce(a.agent_wallet_balance, 0),
         coalesce(a.is_prepaid, true),
         coalesce(a.credit_limit, 0), coalesce(a.credit_used, 0)
    into v_agent_id, v_float_before, v_is_prepaid, v_credit_limit, v_credit_used
    from agents a
   where a.club_id = p_club_id and a.user_id = v_actor
   for update;
  if v_agent_id is null then
    return jsonb_build_object('success', false,
      'error', 'Your Agent Wallet Has Not Been Funded Yet');
  end if;

  -- THE CREDIT LINE. Dan, 2026-08-31: "IF THEY GO BELOW THE CREDIT LIMIT, THEY
  -- MUST 'SQUARE UP' OR PRE PAY FOR CHIPS FOR THE REST OF THE WEEK." So the
  -- limit caps the debt outstanding, not the amount ever borrowed: an agent
  -- draws credit_limit - credit_used, and paying an invoice frees it again
  -- (fn_apply_credit_payment pays credit_used down, phase 1).
  if v_float_before < p_amount then
    v_shortfall := round(p_amount - v_float_before, 2);

    -- A prepaid agent, and an agent with no line at all, get the plain answer
    -- about their wallet. Talking about a credit line to somebody who has none
    -- is the sort of message that sends a person looking for a setting.
    if v_is_prepaid or v_credit_limit <= 0 then
      return jsonb_build_object('success', false,
        'error', 'Your Agent Wallet Only Holds '
                 || trim(to_char(v_float_before, 'FM999,999,999,990.00')) || ' Chips',
        'balance', v_float_before, 'requested', p_amount,
        'prepaid', v_is_prepaid);
    end if;

    v_headroom := v_credit_limit - v_credit_used;
    if v_shortfall > v_headroom then
      return jsonb_build_object('success', false,
        'error', 'Your Wallet Holds '
                 || trim(to_char(v_float_before, 'FM999,999,999,990.00'))
                 || ' Chips And Your Credit Line Has '
                 || trim(to_char(greatest(v_headroom, 0), 'FM999,999,999,990.00'))
                 || ' Left. Square Up Your Invoice Or Add Chips To Send This Much.',
        'balance', v_float_before, 'requested', p_amount,
        'credit_limit', v_credit_limit, 'credit_used', v_credit_used,
        'credit_available', greatest(v_headroom, 0),
        'shortfall', v_shortfall);
    end if;
  end if;

  -- CHIP STANDARD 2.4 (2026-09-03): an agent wallet send is ONE `agent_send`
  -- row from the sender's float to the wallet that receives it, keyed and
  -- correlated on the op. Verified on 2026-09-01 14:23:18 (10,000.00 to a
  -- player) the undeclared journal was `adjustment agent_wallet ->
  -- settlement_suspense` plus `adjustment table_stack -> player_wallet`. The
  -- agents trigger is skipped for both float writes: a player recipient's
  -- club_members trigger writes the row with the sender's float as its
  -- counterparty; an agent recipient (both sides in `agents`) gets the row
  -- posted explicitly below. When the credit line covers a shortfall the
  -- float only pays p_amount - v_shortfall, so the draw is its own
  -- `credit_draw credit_facility -> agent_wallet` row for the difference and
  -- the send row still carries the whole amount. Never a refusal.
  perform public.fn_ca_declare_ledger('agent_send', 'agent_wallet', v_actor, null,
    'agent_send:' || v_op_id::text, array['agents']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);
  if v_shortfall > 0 then
    perform public.fn_ca_post_leg('credit_draw', 'credit_facility', v_actor, 'agent_wallet', v_actor,
      v_shortfall, p_club_id, 'agent_send:credit:' || v_op_id::text,
      'Agent credit line covers the shortfall of an agent wallet send (fn_agent_wallet_send_core_20260830)');
  end if;

  -- The wallet pays what it can and the line covers the rest, so the balance
  -- lands on exactly zero rather than going negative.
  update agents
     set agent_wallet_balance = coalesce(agent_wallet_balance, 0) - (p_amount - v_shortfall),
         credit_used          = coalesce(credit_used, 0) + v_shortfall,
         updated_at = now()
   where id = v_agent_id
   returning agent_wallet_balance, credit_used into v_float_after, v_credit_after;

  if v_dest = 'player_wallet' then
    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount,
           updated_at = now()
     where club_id = p_club_id and user_id = p_to_user_id
     returning chip_balance into v_to_after;
  else
    v_to_agent_id := public.fn_ensure_agent_row(p_club_id, p_to_user_id, v_to_role);
    if v_to_agent_id is null then
      raise exception 'could not ensure agents row for % in club %', p_to_user_id, p_club_id;
    end if;
    update agents
       set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + p_amount,
           updated_at = now()
     where id = v_to_agent_id
     returning agent_wallet_balance into v_to_after;
    perform set_config('app.ledger_idempotency_key', '', true);
    perform public.fn_ca_post_leg('agent_send', 'agent_wallet', v_actor, 'agent_wallet', p_to_user_id,
      p_amount, p_club_id, 'agent_send:' || v_op_id::text,
      'Agent wallet send to a downline agent wallet (fn_agent_wallet_send_core_20260830)');
  end if;

  perform set_config('app.ledger_autoskip_agents', '', true);

  v_until := now() + interval '10 minutes';

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata,
     balance_after, reversible_until)
  values
    (p_club_id, v_actor, p_to_user_id, p_amount, 'agent_wallet_send',
     coalesce(nullif(btrim(p_reason), ''), 'Agent Wallet Send'),
     jsonb_build_object(
       'op_id', v_op_id,
       'destination', v_dest,
       'actor_role', v_actor_role,
       'recipient_role', v_to_role,
       'agent_wallet_before', v_float_before,
       'agent_wallet_after', v_float_after,
       'recipient_balance_after', v_to_after,
       'claimed_back', 0,
       -- What was borrowed to make this send, and how much of that borrowing
       -- has since been handed back. The claim back reads both.
       'credit_drawn', v_shortfall,
       'credit_repaid', 0,
       'credit_used_after', v_credit_after,
       'credit_limit', v_credit_limit,
       'clawback_window_minutes', 10),
     v_float_after, v_until)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true, 'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', p_amount,
    'destination', v_dest,
    'agent_wallet_before', v_float_before,
    'agent_wallet_after', v_float_after,
    'recipient_balance_after', v_to_after,
    'credit_drawn', v_shortfall,
    'credit_used_after', v_credit_after,
    'credit_limit', v_credit_limit,
    'reversible_until', v_until);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from chip_transactions
     where club_id = p_club_id
       and transaction_type = 'agent_wallet_send'
       and from_user_id = v_actor
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    if v_prior.id is null then
      raise;
    end if;
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric,
      'credit_drawn', coalesce((v_prior.metadata ->> 'credit_drawn')::numeric, 0),
      'credit_used_after', (v_prior.metadata ->> 'credit_used_after')::numeric,
      'credit_limit', (v_prior.metadata ->> 'credit_limit')::numeric);
end
$function$
;

-- ── fn_agent_wallet_claim_back_phase2_core_20260831 ──
CREATE OR REPLACE FUNCTION public.fn_agent_wallet_claim_back_phase2_core_20260831(p_club_id uuid, p_transaction_id uuid, p_amount numeric DEFAULT NULL::numeric, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor            uuid := auth.uid();
  v_op_id            uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior            record;
  v_src              record;
  v_claimed          numeric;
  v_claimed_after    numeric;
  v_remaining_exact  numeric;
  v_remaining        numeric;
  v_take             numeric;
  v_complete         boolean;
  v_dest             text;
  v_held             numeric;
  v_agent_id         uuid;
  v_float_after      numeric;
  v_holder_after     numeric;
  v_tx_id            uuid;
  v_drawn            numeric;
  v_repaid           numeric;
  v_repay            numeric := 0;
  v_my_agent_id      uuid;
  v_my_used          numeric;
  v_credit_after     numeric;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;
  if p_club_id is null or p_transaction_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose A Recent Agent Wallet Send');
  end if;
  if p_amount is not null and
     (p_amount <= 0 or p_amount > 1e9 or p_amount <> round(p_amount, 2)) then
    return jsonb_build_object(
      'success', false,
      'error', 'Claim Back Amounts Must Be Positive Whole Cents');
  end if;

  -- One caller/op pair is serialized, so two simultaneous retries cannot both
  -- pass the replay read and enter the money section.
  perform pg_advisory_xact_lock(hashtextextended(
    'agent-wallet-claim:' || p_club_id::text || ':' || v_actor::text || ':' || v_op_id::text,
    0
  ));

  select id, amount, metadata into v_prior
    from public.chip_transactions
   where club_id = p_club_id
     and transaction_type = 'agent_wallet_claim_back'
     and to_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    if coalesce(v_prior.metadata ->> 'original_transaction_id', '')
         is distinct from p_transaction_id::text
       or (p_amount is not null and v_prior.amount is distinct from p_amount) then
      return jsonb_build_object(
        'success', false,
        'error', 'That Retry Key Belongs To A Different Claim Back');
    end if;
    return jsonb_build_object(
      'success', true,
      'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'credit_repaid', coalesce((v_prior.metadata ->> 'credit_repaid')::numeric, 0),
      'credit_used_after', (v_prior.metadata ->> 'credit_used_after')::numeric);
  end if;

  select * into v_src
    from public.chip_transactions
   where id = p_transaction_id
     and club_id = p_club_id
   for update;
  if v_src is null then
    return jsonb_build_object('success', false, 'error', 'That Send Could Not Be Found');
  end if;
  if v_src.transaction_type <> 'agent_wallet_send' then
    return jsonb_build_object(
      'success', false,
      'error', 'Only An Agent Wallet Send Can Be Claimed Back This Way');
  end if;
  if v_src.from_user_id is distinct from v_actor then
    return jsonb_build_object(
      'success', false,
      'error', 'You Can Only Claim Back Chips You Sent Yourself');
  end if;
  if coalesce(v_src.is_reversed, false) then
    return jsonb_build_object('success', false, 'error', 'That Send Has Already Been Claimed Back');
  end if;
  if v_src.reversible_until is null or now() > v_src.reversible_until then
    return jsonb_build_object(
      'success', false,
      'error', 'The Ten Minute Window To Claim These Chips Back Has Closed. '
               || 'The Player Must Request A Cash Out Instead');
  end if;

  v_claimed := coalesce((v_src.metadata ->> 'claimed_back')::numeric, 0);
  v_remaining_exact := greatest(v_src.amount - v_claimed, 0);

  -- Round DOWN, never to nearest. A historical 9.9951 remainder can safely
  -- return 9.99; rounding it to 10.00 would create another 0.0049 chips.
  v_remaining := trunc(v_remaining_exact, 2);
  if v_remaining < 0.01 then
    return jsonb_build_object('success', false, 'error', 'That Send Has Already Been Claimed Back');
  end if;

  -- Null means all safely claimable whole cents. This is what the cashier uses
  -- so contaminated historical rows can be closed without echoing sub-cents.
  v_take := coalesce(p_amount, v_remaining);
  if v_take > v_remaining then
    return jsonb_build_object(
      'success', false,
      'error', 'Only ' || trim(to_char(v_remaining, 'FM999,999,999,990.00'))
               || ' Chips Of That Send Are Left To Claim Back',
      'remaining', v_remaining,
      'requested', v_take);
  end if;

  v_claimed_after := v_claimed + v_take;
  v_complete := (v_src.amount - v_claimed_after) < 0.01;

  v_dest := coalesce(v_src.metadata ->> 'destination', 'player_wallet');
  if v_dest = 'player_wallet' then
    select coalesce(chip_balance, 0) into v_held
      from public.club_members
     where club_id = p_club_id and user_id = v_src.to_user_id
     for update;
  else
    select a.id, coalesce(a.agent_wallet_balance, 0) into v_agent_id, v_held
      from public.agents a
     where a.club_id = p_club_id and a.user_id = v_src.to_user_id
     for update;
  end if;

  if v_held is null then
    return jsonb_build_object(
      'success', false,
      'error', 'That Wallet Could Not Be Read, So Nothing Was Moved');
  end if;
  if v_held < v_take then
    return jsonb_build_object(
      'success', false,
      'error', 'Those Chips Have Already Been Spent. That Wallet Only Holds '
               || trim(to_char(v_held, 'FM999,999,999,990.00')) || ' Chips',
      'held', v_held,
      'requested', v_take);
  end if;

  -- CHIP STANDARD 2.4 (2026-09-03): a claim back is ONE `agent_claim` row from
  -- the wallet that held the send back to the agent's float, keyed and
  -- correlated on the op. The agents trigger is skipped for both float
  -- writes: a player holder's club_members trigger writes the row with the
  -- agent's float as counterparty; an agent holder (both sides in `agents`)
  -- gets the row posted explicitly below. The share that repays the credit
  -- line never reaches the float, so it is its own `credit_repayment
  -- agent_wallet -> credit_facility` row. Never a refusal.
  perform public.fn_ca_declare_ledger('agent_claim', 'agent_wallet', v_actor, null,
    'agent_claim:' || v_op_id::text, array['agents']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);

  if v_dest = 'player_wallet' then
    update public.club_members
       set chip_balance = coalesce(chip_balance, 0) - v_take,
           updated_at = now()
     where club_id = p_club_id and user_id = v_src.to_user_id
     returning chip_balance into v_holder_after;
  else
    update public.agents
       set agent_wallet_balance = coalesce(agent_wallet_balance, 0) - v_take,
           updated_at = now()
     where id = v_agent_id
     returning agent_wallet_balance into v_holder_after;
    perform set_config('app.ledger_idempotency_key', '', true);
    perform public.fn_ca_post_leg('agent_claim', 'agent_wallet', v_src.to_user_id, 'agent_wallet', v_actor,
      v_take, p_club_id, 'agent_claim:' || v_op_id::text,
      'Agent wallet claim back from a downline agent wallet (fn_agent_wallet_claim_back_phase2_core_20260831)');
  end if;

  -- HOW MUCH OF THIS CLAIM IS A REPAYMENT.
  --
  -- credit_drawn is what this send borrowed; credit_repaid is how much of that
  -- borrowing earlier partial claims have already handed back. The share of a
  -- partial claim is proportional, truncated down so repeated partials can
  -- never repay more than was drawn. The final claim settles the exact
  -- remainder, so truncation cannot strand a cent of debt on a send that has
  -- been returned in full.
  v_drawn  := coalesce((v_src.metadata ->> 'credit_drawn')::numeric, 0);
  v_repaid := coalesce((v_src.metadata ->> 'credit_repaid')::numeric, 0);

  select a.id, coalesce(a.credit_used, 0) into v_my_agent_id, v_my_used
    from public.agents a
   where a.club_id = p_club_id and a.user_id = v_actor
   for update;
  if v_my_agent_id is null then
    raise exception 'agent wallet row vanished for % in club %', v_actor, p_club_id;
  end if;

  if v_drawn > 0 then
    if v_complete then
      v_repay := greatest(v_drawn - v_repaid, 0);
    else
      v_repay := least(trunc(v_drawn * v_take / v_src.amount, 2),
                       greatest(v_drawn - v_repaid, 0));
    end if;
    -- The debt may already have been settled another way: an invoice paid
    -- inside the ten minute window pays credit_used down (phase 1), and paying
    -- twice for the same borrowing would hand the agent free chips.
    v_repay := greatest(least(v_repay, v_my_used), 0);
  end if;

  if v_repay > 0 then
    perform public.fn_ca_post_leg('credit_repayment', 'agent_wallet', v_actor, 'credit_facility', v_actor,
      v_repay, p_club_id, 'agent_claim:credit:' || v_op_id::text,
      'Claimed back chips repay the credit line drawn for the send (fn_agent_wallet_claim_back_phase2_core_20260831)');
  end if;

  -- Every chip returns: what is not repaying a debt becomes float.
  update public.agents
     set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + (v_take - v_repay),
         credit_used          = greatest(coalesce(credit_used, 0) - v_repay, 0),
         updated_at = now()
   where id = v_my_agent_id
   returning agent_wallet_balance, credit_used into v_float_after, v_credit_after;
  perform set_config('app.ledger_autoskip_agents', '', true);

  update public.chip_transactions
     set metadata = coalesce(metadata, '{}'::jsonb)
                    || jsonb_build_object('claimed_back', v_claimed_after,
                                          'credit_repaid', v_repaid + v_repay),
         is_reversed = v_complete,
         clawed_back = v_complete
   where id = v_src.id;

  insert into public.chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (p_club_id, v_src.to_user_id, v_actor, v_take, 'agent_wallet_claim_back',
     coalesce(nullif(btrim(p_reason), ''), 'Agent Wallet Claim Back Inside The Ten Minute Window'),
     jsonb_build_object(
       'op_id', v_op_id,
       'source', v_dest,
       'original_transaction_id', v_src.id,
       'holder_balance_after', v_holder_after,
       'agent_wallet_after', v_float_after,
       'credit_repaid', v_repay,
       'credit_used_after', v_credit_after),
     v_float_after)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true,
    'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', v_take,
    'source', v_dest,
    'holder_balance_after', v_holder_after,
    'agent_wallet_after', v_float_after,
    'credit_repaid', v_repay,
    'credit_used_after', v_credit_after);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from public.chip_transactions
     where club_id = p_club_id
       and transaction_type = 'agent_wallet_claim_back'
       and to_user_id = v_actor
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    if v_prior.id is null then
      raise;
    end if;
    if coalesce(v_prior.metadata ->> 'original_transaction_id', '')
         is distinct from p_transaction_id::text
       or (p_amount is not null and v_prior.amount is distinct from p_amount) then
      return jsonb_build_object(
        'success', false,
        'error', 'That Retry Key Belongs To A Different Claim Back');
    end if;
    return jsonb_build_object(
      'success', true,
      'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'credit_repaid', coalesce((v_prior.metadata ->> 'credit_repaid')::numeric, 0),
      'credit_used_after', (v_prior.metadata ->> 'credit_used_after')::numeric);
end
$function$
;

-- ── fn_agent_wallet_self_stake ──
CREATE OR REPLACE FUNCTION public.fn_agent_wallet_self_stake(p_club_id uuid, p_amount numeric, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_prior record;
  v_role text;
  v_wallet_after numeric;
  v_player_after numeric;
  v_tx uuid;
begin
  if v_actor is null then
    return jsonb_build_object('success',false,'error','Not Authenticated');
  end if;
  if p_op_id is null then
    return jsonb_build_object('success',false,'error','A Retry Key Is Required For Every Send');
  end if;
  if p_club_id is null then
    return jsonb_build_object('success',false,'error','That Club Could Not Be Found');
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1e9 or p_amount <> round(p_amount,2) then
    return jsonb_build_object('success',false,'error','Enter A Valid Send Amount');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'agent-wallet-send:'||p_club_id::text||':'||v_actor::text||':'||p_op_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:'||p_club_id::text,0));

  select ct.* into v_prior from public.chip_transactions ct
   where ct.club_id=p_club_id and ct.transaction_type='agent_wallet_self_stake'
     and ct.from_user_id=v_actor and ct.metadata->>'op_id'=p_op_id::text limit 1;
  if found then
    if v_prior.amount is distinct from p_amount then
      return jsonb_build_object('success',false,
        'error','That Retry Key Belongs To A Different Agent Wallet Send');
    end if;
    return jsonb_build_object('success',true,'replayed',true,
      'transaction_id',v_prior.id,'amount',v_prior.amount,
      'agent_wallet_after',(v_prior.metadata->>'agent_wallet_after')::numeric,
      'player_wallet_after',(v_prior.metadata->>'player_wallet_after')::numeric);
  end if;

  perform 1 from public.clubs where id=p_club_id for update;
  if not found then
    return jsonb_build_object('success',false,'error','That Club Could Not Be Found');
  end if;
  perform 1 from public.club_members where club_id=p_club_id and user_id=v_actor for update;

  v_role := public.fn_club_bank_role(p_club_id, v_actor);
  -- Dan 2026-09-02: owners and co-owners hold a player wallet again, and they
  -- have always held an agent wallet, so the rung exists for them too. An
  -- admin holds no player wallet, so there is nowhere for the chips to land.
  if v_role is null or v_role not in ('owner','co_owner','super_agent','agent','sub_agent') then
    return jsonb_build_object('success',false,'error','Only An Agent Wallet Holder With A Player Wallet Can Stake Their Own Seat');
  end if;

  -- CHIP STANDARD 2.4 (2026-09-03): ONE `agent_send` row from the agent's own
  -- float to their own player wallet, keyed and correlated on the op (32
  -- stakes / 320,000.00 in 30d journaled as two suspense legs). The agents
  -- trigger is skipped; the club_members trigger writes the row.
  perform public.fn_ca_declare_ledger('agent_send', 'agent_wallet', v_actor, null,
    'agent_self_stake:' || p_op_id::text, array['agents']);
  perform set_config('app.ledger_correlation', p_op_id::text, true);

  update public.agents
     set agent_wallet_balance = agent_wallet_balance - p_amount
   where club_id=p_club_id and user_id=v_actor
     and coalesce(status,'active')='active'
     and agent_wallet_balance >= p_amount
   returning agent_wallet_balance into v_wallet_after;
  if v_wallet_after is null then
    return jsonb_build_object('success',false,'error','Your Agent Wallet Cannot Cover That Amount');
  end if;

  update public.club_members
     set chip_balance = coalesce(chip_balance,0) + p_amount
   where club_id=p_club_id and user_id=v_actor
   returning chip_balance into v_player_after;
  perform set_config('app.ledger_autoskip_agents', '', true);
  if v_player_after is null then
    raise exception 'membership row vanished for % in % after wallet debit', v_actor, p_club_id;
  end if;

  insert into public.chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (p_club_id, v_actor, v_actor, p_amount, 'agent_wallet_self_stake',
     coalesce(p_reason,'Agent Wallet To Own Player Wallet'),
     jsonb_build_object('op_id',p_op_id::text,'destination','player_wallet',
       'actor_role',v_role,
       'agent_wallet_after',v_wallet_after,'player_wallet_after',v_player_after),
     v_player_after)
  returning id into v_tx;

  return jsonb_build_object('success',true,'transaction_id',v_tx,'amount',p_amount,
    'agent_wallet_after',v_wallet_after,'player_wallet_after',v_player_after);
end
$function$
;

-- ── fn_promo_wallet_send ──
CREATE OR REPLACE FUNCTION public.fn_promo_wallet_send(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor          uuid := auth.uid();
  v_actor_role     text;
  v_dest           text := lower(coalesce(p_destination, 'player_wallet'));
  v_op_id          uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior          record;
  v_sender_id      uuid;
  v_sender_promo   numeric;
  v_sender_after   numeric;
  v_to_role        text;
  v_to_agent_id    uuid;
  v_to_after       numeric;
  v_tx_id          uuid;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null
     or v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only An Agent Or Club Staff May Send From A Promo Wallet');
  end if;

  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'promo_wallet_send'
     and from_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'sender_promo_after', (v_prior.metadata ->> 'sender_promo_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('success', false,
      'error', 'Chips Move In Hundredths At Most');
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
  if p_to_user_id = v_actor then
    return jsonb_build_object('success', false, 'error', 'A Promo Wallet Cannot Send To Itself');
  end if;

  if not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_to_user_id) then
    return jsonb_build_object('success', false,
      'error', 'That Member Is Not In Your Downline');
  end if;

  select a.id, coalesce(a.promo_wallet_balance, 0)
    into v_sender_id, v_sender_promo
    from agents a
   where a.club_id = p_club_id and a.user_id = v_actor
   for update;
  if v_sender_id is null then
    return jsonb_build_object('success', false,
      'error', 'You Do Not Hold A Promo Wallet In This Club');
  end if;
  if v_sender_promo < p_amount then
    return jsonb_build_object('success', false, 'error', 'Insufficient Promo Wallet Balance',
      'balance', v_sender_promo, 'requested', p_amount);
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
    return jsonb_build_object('success', false,
      'error', 'Only Staff Or Agents Hold A Promo Wallet');
  end if;

  -- CHIP STANDARD 2.4 (2026-09-03): ONE `promo_send` row from the sender's
  -- promo float to the wallet that receives it, keyed and correlated on the
  -- op. The agents trigger is skipped for both promo writes: a player
  -- recipient's club_members trigger writes the row with the promo float as
  -- counterparty; an agent recipient (both sides in `agents`) gets the row
  -- posted explicitly below. Never a refusal.
  perform public.fn_ca_declare_ledger('promo_send', 'promo_wallet', v_actor, null,
    'promo_send:' || v_op_id::text, array['agents']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);

  update agents
     set promo_wallet_balance = coalesce(promo_wallet_balance, 0) - p_amount,
         updated_at = now()
   where id = v_sender_id
   returning promo_wallet_balance into v_sender_after;

  if v_dest = 'player_wallet' then
    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount,
           updated_at = now()
     where club_id = p_club_id and user_id = p_to_user_id
     returning chip_balance into v_to_after;
  else
    v_to_agent_id := public.fn_ensure_agent_row(p_club_id, p_to_user_id, v_to_role);
    if v_to_agent_id is null then
      raise exception 'could not ensure agents row for % in club %', p_to_user_id, p_club_id;
    end if;
    update agents
       set promo_wallet_balance = coalesce(promo_wallet_balance, 0) + p_amount,
           updated_at = now()
     where id = v_to_agent_id
     returning promo_wallet_balance into v_to_after;
    perform set_config('app.ledger_idempotency_key', '', true);
    perform public.fn_ca_post_leg('promo_send', 'promo_wallet', v_actor, 'promo_wallet', p_to_user_id,
      p_amount, p_club_id, 'promo_send:' || v_op_id::text,
      'Promo wallet send to a downline agent promo wallet (fn_promo_wallet_send)');
  end if;

  perform set_config('app.ledger_autoskip_agents', '', true);

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (p_club_id, v_actor, p_to_user_id, p_amount, 'promo_wallet_send',
     coalesce(nullif(btrim(p_reason), ''), 'Promo Wallet Send'),
     jsonb_build_object(
       'op_id', v_op_id,
       'destination', v_dest,
       'source', 'promo_wallet',
       'actor_role', v_actor_role,
       'recipient_role', v_to_role,
       'sender_promo_after', v_sender_after,
       'recipient_balance_after', v_to_after),
     null)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true, 'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', p_amount,
    'destination', v_dest,
    'sender_promo_after', v_sender_after,
    'recipient_balance_after', v_to_after);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from chip_transactions
     where club_id = p_club_id
       and transaction_type = 'promo_wallet_send'
       and from_user_id = v_actor
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    if v_prior.id is null then
      raise;
    end if;
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'sender_promo_after', (v_prior.metadata ->> 'sender_promo_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
end
$function$
;

-- ── fn_union_clawback_from_club ──
CREATE OR REPLACE FUNCTION public.fn_union_clawback_from_club(p_union_id uuid, p_club_id uuid, p_amount numeric, p_notes text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_is_lead boolean;
  v_treasury numeric;
  v_after numeric;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authenticated');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM union_admins ua
     WHERE ua.union_id = p_union_id AND ua.user_id = v_uid AND ua.role = 'union_lead'
  ) OR EXISTS (
    SELECT 1 FROM unions u WHERE u.id = p_union_id AND u.owner_id = v_uid
  ) INTO v_is_lead;
  IF NOT v_is_lead THEN
    RETURN jsonb_build_object('success', false, 'error', 'union lead access required');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM union_clubs uc WHERE uc.union_id = p_union_id AND uc.club_id = p_club_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'club is not in this union');
  END IF;

  -- CHIP STANDARD 2.4 (2026-09-03): a clawback is ONE `union_settlement` row
  -- from the club bank to the union bank, keyed and correlated on the op when
  -- one is given. The union_wallets trigger is skipped; the clubs trigger
  -- writes the row with the union bank as its counterparty. Never a refusal.
  PERFORM public.fn_ca_declare_ledger('union_settlement', 'union_bank', p_union_id, NULL,
    CASE WHEN p_op_id IS NOT NULL THEN 'union_clawback:' || p_op_id::text END, ARRAY['union_wallets']);
  IF p_op_id IS NOT NULL THEN
    PERFORM set_config('app.ledger_correlation', p_op_id::text, true);
  END IF;

  UPDATE clubs SET chip_treasury = COALESCE(chip_treasury, 0) - p_amount
   WHERE id = p_club_id AND COALESCE(chip_treasury, 0) >= p_amount
  RETURNING chip_treasury INTO v_treasury;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient club treasury balance');
  END IF;

  INSERT INTO union_wallets (union_id, chip_balance)
  VALUES (p_union_id, p_amount)
  ON CONFLICT (union_id) DO UPDATE
    SET chip_balance = COALESCE(union_wallets.chip_balance, 0) + p_amount,
        updated_at = NOW()
  RETURNING chip_balance INTO v_after;
  PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);

  INSERT INTO union_wallet_transactions (
    union_id, wallet, direction, amount, balance_after, tx_type, club_id, period_id, notes, created_by
  ) VALUES (
    p_union_id, 'chip_balance', 'credit', p_amount, v_after, 'clawback',
    p_club_id, p_op_id, COALESCE(NULLIF(p_notes, ''), 'Clawback from club treasury'), v_uid
  );

  INSERT INTO chip_transactions (club_id, amount, transaction_type, notes)
  VALUES (p_club_id, p_amount, 'union_clawback',
          COALESCE(NULLIF(p_notes, ''), 'Union clawback from club treasury'));

  RETURN jsonb_build_object(
    'success', true, 'amount', p_amount,
    'club_treasury', v_treasury, 'union_balance', v_after
  );
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', false, 'duplicate', true,
                            'error', 'operation already processed');
END;
$function$
;


-- ── grants: unchanged from production, stated in the file ─────────────────────
-- Browser doors keep `authenticated` (each binds the actor to auth.uid()).
GRANT EXECUTE ON FUNCTION public.fn_club_bank_send(uuid, uuid, numeric, text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_club_bank_claim_back(uuid, uuid, numeric, text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_club_bank_reverse(uuid, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_admin_remove_player_chips(uuid, uuid, numeric, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_agent_wallet_self_stake(uuid, numeric, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_promo_wallet_send(uuid, uuid, numeric, text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_union_clawback_from_club(uuid, uuid, numeric, text, uuid) TO authenticated, service_role;
-- The two agent-wallet cores are reached only through their wrappers.
REVOKE ALL ON FUNCTION public.fn_agent_wallet_send_core_20260830(uuid, uuid, numeric, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_agent_wallet_send_core_20260830(uuid, uuid, numeric, text, text, uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_agent_wallet_claim_back_phase2_core_20260831(uuid, uuid, numeric, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_agent_wallet_claim_back_phase2_core_20260831(uuid, uuid, numeric, text, uuid)
  TO service_role;

-- ── self-check: the live bodies declare, and nothing else about them moved ────
DO $chk$
DECLARE
  r record;
  v_src text;
  v_n int;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('fn_club_bank_send',            'fn_ca_declare_ledger(''club_bank_send'', ''club_treasury'', p_club_id, null,',        'array[''clubs'']',         13, 1),
      ('fn_club_bank_claim_back',      'fn_ca_declare_ledger(''club_bank_claim'', ''club_treasury'', p_club_id, null,',       'array[''clubs'']',         11, 1),
      ('fn_club_bank_reverse',         'fn_ca_declare_ledger(''reversal'', ''club_treasury'', v_tx.club_id, null,',           'array[''clubs'']',          8, 0),
      ('fn_admin_remove_player_chips', 'fn_ca_declare_ledger(''club_bank_claim'', ''club_treasury'', p_club_id, null,',       'array[''clubs'']',          6, 0),
      ('fn_agent_wallet_send_core_20260830',
                                       'fn_ca_declare_ledger(''agent_send'', ''agent_wallet'', v_actor, null,',              'array[''agents'']',        14, 1),
      ('fn_agent_wallet_claim_back_phase2_core_20260831',
                                       'fn_ca_declare_ledger(''agent_claim'', ''agent_wallet'', v_actor, null,',             'array[''agents'']',        14, 1),
      ('fn_agent_wallet_self_stake',   'fn_ca_declare_ledger(''agent_send'', ''agent_wallet'', v_actor, null,',              'array[''agents'']',         8, 1),
      ('fn_promo_wallet_send',         'fn_ca_declare_ledger(''promo_send'', ''promo_wallet'', v_actor, null,',              'array[''agents'']',        13, 1),
      ('fn_union_clawback_from_club',  'fn_ca_declare_ledger(''union_settlement'', ''union_bank'', p_union_id, NULL,',       'ARRAY[''union_wallets'']',  6, 0)
    ) AS t(fn, declare_call, autoskip, refusals, raises)
  LOOP
    SELECT prosrc INTO v_src FROM pg_proc
     WHERE proname = r.fn AND pronamespace = 'public'::regnamespace;
    IF v_src IS NULL THEN
      RAISE EXCEPTION '% is missing', r.fn;
    END IF;
    IF position(r.declare_call IN v_src) = 0 THEN
      RAISE EXCEPTION '% does not declare its ledger shape (%)', r.fn, r.declare_call;
    END IF;
    IF position(r.autoskip IN v_src) = 0 THEN
      RAISE EXCEPTION '% does not autoskip the other side (%)', r.fn, r.autoskip;
    END IF;
    IF position('app.ledger_correlation' IN v_src) = 0 THEN
      RAISE EXCEPTION '% does not correlate on the op', r.fn;
    END IF;
    -- refusals: the count of `'success', false` (self-stake writes it without the space)
    v_n := (length(lower(v_src)) - length(replace(lower(v_src), '''success'', false', ''))) / length('''success'', false')
         + (length(lower(v_src)) - length(replace(lower(v_src), '''success'',false', ''))) / length('''success'',false');
    IF v_n <> r.refusals THEN
      RAISE EXCEPTION '% refusal count changed: % (expected %) - an auth check, limit or window moved', r.fn, v_n, r.refusals;
    END IF;
    v_n := (length(lower(v_src)) - length(replace(lower(v_src), 'raise exception', ''))) / length('raise exception');
    IF v_n <> r.raises THEN
      RAISE EXCEPTION '% RAISE EXCEPTION count changed: % (expected %)', r.fn, v_n, r.raises;
    END IF;
  END LOOP;

  -- the two same-table legs and the two credit legs are posted explicitly
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_agent_wallet_send_core_20260830' AND pronamespace = 'public'::regnamespace;
  IF position('fn_ca_post_leg(''credit_draw'', ''credit_facility'', v_actor, ''agent_wallet'', v_actor,' IN v_src) = 0
     OR position('fn_ca_post_leg(''agent_send'', ''agent_wallet'', v_actor, ''agent_wallet'', p_to_user_id,' IN v_src) = 0
     OR position('interval ''10 minutes''' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fn_agent_wallet_send_core_20260830 lost a leg or its ten minute window';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_agent_wallet_claim_back_phase2_core_20260831' AND pronamespace = 'public'::regnamespace;
  IF position('fn_ca_post_leg(''credit_repayment'', ''agent_wallet'', v_actor, ''credit_facility'', v_actor,' IN v_src) = 0
     OR position('fn_ca_post_leg(''agent_claim'', ''agent_wallet'', v_src.to_user_id, ''agent_wallet'', v_actor,' IN v_src) = 0
     OR position('The Ten Minute Window To Claim These Chips Back Has Closed' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fn_agent_wallet_claim_back_phase2_core_20260831 lost a leg or its ten minute rule';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_promo_wallet_send' AND pronamespace = 'public'::regnamespace;
  IF position('fn_ca_post_leg(''promo_send'', ''promo_wallet'', v_actor, ''promo_wallet'', p_to_user_id,' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fn_promo_wallet_send lost its promo -> promo leg';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_club_bank_reverse' AND pronamespace = 'public'::regnamespace;
  IF position('Seven Day Reversal Window' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fn_club_bank_reverse lost its seven day window';
  END IF;

  -- the primitive swallows, never refuses, and only service_role may reach it
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_ca_post_leg' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL OR position('ca_ledger_write_failures' IN v_src) = 0 OR position('RAISE' IN v_src) > 0 THEN
    RAISE EXCEPTION 'fn_ca_post_leg must swallow into ca_ledger_write_failures and never raise';
  END IF;
  IF has_function_privilege('authenticated', 'public.fn_ca_post_leg(text, text, uuid, text, uuid, numeric, uuid, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_ca_post_leg(text, text, uuid, text, uuid, numeric, uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_ca_post_leg must not be callable from a browser';
  END IF;

  -- the words every declaration above relies on are in the live vocabulary
  FOR r IN SELECT unnest(ARRAY['club_bank_send','club_bank_claim','agent_send','agent_claim','union_settlement',
                               'promo_send','reversal','credit_draw','credit_repayment']) AS w LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.chip_ledger'::regclass AND conname = 'chip_ledger_category_check'
                      AND pg_get_constraintdef(oid) LIKE '%''' || r.w || '''%') THEN
      RAISE EXCEPTION 'chip_ledger_category_check lacks % - apply the vocabulary migration first', r.w;
    END IF;
  END LOOP;

  -- who may call did not move
  IF NOT has_function_privilege('authenticated', 'public.fn_club_bank_send(uuid, uuid, numeric, text, text, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fn_agent_wallet_send(uuid, uuid, numeric, text, text, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_agent_wallet_send_core_20260830(uuid, uuid, numeric, text, text, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_agent_wallet_claim_back_phase2_core_20260831(uuid, uuid, numeric, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a grant moved; this migration must not change who may call';
  END IF;
END $chk$;

COMMIT;

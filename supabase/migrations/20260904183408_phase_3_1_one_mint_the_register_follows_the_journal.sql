-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 3.1 - ONE MINT (chip standard, 2026-09-04)
--
-- Dan's ruling (2026-09-03): "ALL CHIPS AND DIAMONDS ARE CREATED, AND MUST
-- FLOW FROM" the Mint. The acceptance line in the roadmap: every chip that
-- enters the estate does so through the Mint, and ca_mint_ledger accounts for
-- the full circulating supply including an explicit, labelled opening
-- baseline for the four estates.
--
-- MEASURED BEFORE THIS MIGRATION
--   ca_mint_ledger held 319 chip rows: 2 club opening grants (200,000, both
--   certification fixtures since retired) and 317 restorations of erased
--   seat credits (41,161.27). Meanwhile the journal held issuance legs the
--   register never saw: 11 opening grants from the retired system_mint name
--   (1,100,000) and 15 fixture retirements into chip_retirement (1,500,000).
--   fn_mint_chips_from_diamonds - the one product door that creates chips,
--   an owner converting diamonds in ChipMintModal - declared no counterparty
--   at all, so its next use would have landed in settlement_suspense with no
--   register row. fn_mint_club_chips was executable by every signed-in
--   browser with no caller in either repo.
--
-- WHAT THIS DOES, IN ORDER
--   1. THE REGISTER FOLLOWS THE JOURNAL. A deferred constraint trigger on
--      chip_ledger: at commit, every leg whose source is a non-circulating
--      store (a mint) or whose destination is one (a burn) must have a
--      ca_mint_ledger row linked to it, and gets one if the door that wrote
--      the leg did not (fn_ca_mint, the opening grant and the restoration door
--      write their own; the trigger sees them at commit and adds nothing).
--      This is the structural guarantee: the register cannot be bypassed by
--      any door, present or future, because the journal is the door.
--   2. THE ERA IS BACKFILLED. Every issuance leg since 2026-08-31 00:00 UTC -
--      when the declared stores began - that lacks a register row gets one:
--      12 mints (11 legacy grants, 1 compensating entry) and 20 burns (15
--      fixture retirements, 5 cert-owner wallet reversals).
--   3. THE OPENING BASELINE. One labelled row per estate (Club JAQK, SHARK
--      CLUB, Deep Stack Society, Midway Union) for the chips each holds at
--      this instant, plus one 'circulation' row for stores that belong to no
--      estate and for the pre-register history, sized so that the register's
--      net (mints minus burns) equals the supply meter's total at the same
--      instant, read in one REPEATABLE READ snapshot. The rows say what they
--      are: an opening balance, not issuance that happened today. No journal
--      leg is written - no chip moves.
--   4. THE DIAMOND MINT IS THE MINT. fn_mint_chips_from_diamonds declares
--      issuance_reserve -> club/union with the op id as the journal key; the
--      register row follows from (1).
--   5. fn_mint_club_chips is revoked from anon and authenticated (no caller
--      in either repo; service_role keeps it until Phase 3.3 drops it).
--   6. fn_ca_mint_register_vs_supply() reports the register net against the
--      latest snapshot total; the difference from here on is the meter's own
--      unexplained drift and nothing else. Asserted 0.00 at the end.
-- ═══════════════════════════════════════════════════════════════════════════
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The register follows the journal
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_register_issuance_leg(p_ledger_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  l record; v_action text; v_holder_type text; v_holder uuid; v_label text;
  v_before numeric; v_after numeric; v_supply numeric; v_reason text; v_op text;
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
BEGIN
  SELECT * INTO l FROM public.chip_ledger WHERE id = p_ledger_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.ca_mint_ledger m WHERE m.chip_ledger_id = l.id) THEN
    RETURN false;
  END IF;
  IF l.category = 'correction' AND l.metadata->>'posted_via' = 'fn_ca_post_correction' THEN
    RETURN false;  -- a correction moves no balance (a_correction_is_not_a_mint)
  END IF;
  IF l.from_type = ANY (v_outside) AND NOT (l.to_type = ANY (v_outside)) THEN
    v_action := 'mint'; v_holder := l.to_entity_id;
    v_holder_type := CASE l.to_type
      WHEN 'club_treasury' THEN 'club' WHEN 'club_wallet' THEN 'club'
      WHEN 'union_bank' THEN 'union' WHEN 'union_wallet' THEN 'union'
      WHEN 'player_wallet' THEN 'player' WHEN 'promo_wallet' THEN 'player'
      ELSE 'circulation' END;
  ELSIF l.to_type = ANY (v_outside) AND NOT (l.from_type = ANY (v_outside)) THEN
    v_action := 'burn'; v_holder := l.from_entity_id;
    v_holder_type := CASE l.from_type
      WHEN 'club_treasury' THEN 'club' WHEN 'club_wallet' THEN 'club'
      WHEN 'union_bank' THEN 'union' WHEN 'union_wallet' THEN 'union'
      WHEN 'player_wallet' THEN 'player' WHEN 'promo_wallet' THEN 'player'
      ELSE 'circulation' END;
  ELSE
    RETURN false;  -- store to store, or circulating to circulating
  END IF;
  -- The autoledger stamps a union wallet's row with the union id; a union is
  -- also a row in clubs (is_union), so resolve by what the id actually is.
  IF v_holder_type = 'club' AND EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = v_holder AND COALESCE(c.is_union, false)) THEN
    v_holder_type := 'union';
  END IF;
  IF v_holder IS NULL THEN
    v_holder_type := 'circulation';
  END IF;
  IF v_holder_type = 'circulation' THEN
    v_holder := '00000000-0000-0000-0000-00000000c1c0';  -- the circulation sentinel (the house is ...d1a0)
  END IF;
  v_label := CASE v_holder_type
    WHEN 'club'   THEN (SELECT c.name FROM public.clubs c WHERE c.id = v_holder)
    WHEN 'union'  THEN COALESCE((SELECT u.name FROM public.unions u WHERE u.id = v_holder), (SELECT c.name FROM public.clubs c WHERE c.id = v_holder))
    WHEN 'player' THEN (SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text) FROM public.profiles p WHERE p.id = v_holder)
    ELSE 'circulation' END;
  -- A leg written by hand (a linked compensating entry) carries no balances;
  -- the register still wants a pair, so the pair is the amount itself.
  /* A door that wrote its own register row but did not link the leg
     (fn_ca_burn looks the leg up by a shape it does not always match):
     adopt that row rather than write a second one. Same action, holder,
     amount, asset, within five seconds of the leg, not yet linked. */
  UPDATE public.ca_mint_ledger m
     SET chip_ledger_id = l.id
   WHERE m.id = (SELECT m2.id FROM public.ca_mint_ledger m2
                  WHERE m2.chip_ledger_id IS NULL AND m2.asset = 'chips' AND m2.action = v_action
                    AND m2.amount = l.amount AND m2.holder_id = v_holder
                    AND m2.created_at BETWEEN l.created_at - interval '5 seconds' AND l.created_at + interval '5 seconds'
                  ORDER BY m2.created_at LIMIT 1);
  IF FOUND THEN RETURN false; END IF;
  v_before := COALESCE(CASE WHEN v_action = 'mint' THEN l.pre_to_balance ELSE l.pre_from_balance END, 0);
  v_after  := COALESCE(CASE WHEN v_action = 'mint' THEN l.post_to_balance ELSE l.post_from_balance END,
                       v_before + CASE WHEN v_action = 'mint' THEN l.amount ELSE -l.amount END);
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
       + CASE WHEN v_action = 'mint' THEN l.amount ELSE -l.amount END
    INTO v_supply FROM public.ca_mint_ledger WHERE asset = 'chips';
  v_op := 'ledger:' || l.id::text;
  v_reason := left(COALESCE(NULLIF(btrim(l.description), ''), l.category) || ' (' || l.category
              || CASE WHEN l.idempotency_key IS NOT NULL THEN ', key ' || l.idempotency_key ELSE '' END
              || '; registered from the journal leg)', 500);
  IF length(btrim(v_reason)) < 10 THEN v_reason := v_reason || ' - registered from the journal'; END IF;
  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount,
     balance_before, balance_after, supply_after, reason, performed_by, performed_by_label, db_role, chip_ledger_id, created_at)
  VALUES (v_op, v_action, 'chips', v_holder_type, v_holder, v_label, l.amount,
          v_before, v_after, v_supply, v_reason, l.performed_by, COALESCE(l.actor_service, l.db_role), l.db_role, l.id, l.created_at)
  ON CONFLICT (op_id) DO NOTHING;
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_register_issuance_leg(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_register_issuance_leg(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_issuance_leg_is_registered()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.fn_ca_register_issuance_leg(NEW.id);
  RETURN NULL;
END;
$function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The era is backfilled (declared stores began 2026-08-31)
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE r record; v_n int := 0;
BEGIN
  FOR r IN SELECT l.id FROM public.chip_ledger l
            WHERE l.created_at >= '2026-08-31 00:00:00+00'
              AND (l.from_type = ANY (public.fn_ca_noncirculating_chip_stores())
                OR l.to_type   = ANY (public.fn_ca_noncirculating_chip_stores()))
              AND NOT EXISTS (SELECT 1 FROM public.ca_mint_ledger m WHERE m.chip_ledger_id = l.id)
            ORDER BY l.created_at LOOP
    IF public.fn_ca_register_issuance_leg(r.id) THEN v_n := v_n + 1; END IF;
  END LOOP;
  -- 12 mints (11 legacy opening grants + 1 compensating entry for a swallowed
  -- journal row) and 20 burns (15 fixture retirements + 5 cert-owner wallet
  -- reversals), all of them balance-moving legs of 2026-09-01..04.
  IF v_n <> 32 THEN
    RAISE EXCEPTION 'expected to register 32 legs of the era (12 mints + 20 burns), registered %', v_n;
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The opening baseline, per estate, in the same snapshot as the meter
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_total numeric; v_snap_at timestamptz; v_register_net numeric; v_sum_estates numeric := 0;
  v_est record; v_amt numeric; v_circ numeric; v_supply numeric; v_stamp text;
BEGIN
  PERFORM public.fn_ca_supply_snapshot();
  SELECT total, taken_at INTO v_total, v_snap_at FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1;
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
    INTO v_register_net FROM public.ca_mint_ledger WHERE asset = 'chips';
  v_stamp := to_char(v_snap_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') || ' UTC';

  FOR v_est IN
    SELECT c.id, c.name, COALESCE(c.is_union, false) AS is_union FROM public.clubs c
     WHERE c.id IN ('a0000000-0000-0000-0000-000000000001', 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
                    '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3', 'fade0000-0000-0000-0000-000000000001')
     ORDER BY c.name
  LOOP
    SELECT round(
        (SELECT COALESCE(sum(chip_balance), 0) + COALESCE(sum(promo_balance), 0) FROM public.club_members WHERE club_id = v_est.id)
      + (SELECT COALESCE(sum(s.stack), 0) FROM public.table_seats s JOIN public.tables t ON t.id = s.table_id
          WHERE s.left_at IS NULL AND t.tournament_id IS NULL AND t.club_id = v_est.id)
      + (SELECT COALESCE(chip_treasury, 0) + COALESCE(chip_pool, 0) + COALESCE(promo_balance, 0) + COALESCE(insurance_balance, 0) FROM public.clubs WHERE id = v_est.id)
      + (SELECT COALESCE(sum(chip_balance), 0) FROM public.club_wallets WHERE club_id = v_est.id)
      + CASE WHEN v_est.is_union THEN (SELECT COALESCE(sum(chip_balance + rake_wallet + bbj_wallet + promo_wallet + insurance_wallet + COALESCE(spin_reserve_wallet, 0)), 0)
                                        FROM public.union_wallets WHERE union_id = v_est.id) ELSE 0 END
      + (SELECT COALESCE(sum(COALESCE(agent_wallet_balance, 0) + COALESCE(promo_wallet_balance, 0)), 0) FROM public.agents WHERE club_id = v_est.id)
      + (SELECT COALESCE(sum(main_balance + backup_balance + promo_balance), 0) FROM public.bbj_pools WHERE club_id = v_est.id)
      + (SELECT COALESCE(sum(balance), 0) FROM public.spin_bonus_pools WHERE club_id = v_est.id)
      + (SELECT COALESCE(sum(COALESCE(prize_pool, 0) + COALESCE(bounty_pool, 0) - COALESCE(bounty_pool_paid, 0) + COALESCE(total_rake, 0)), 0)
           FROM public.tournaments WHERE club_id = v_est.id AND status NOT IN ('COMPLETED', 'CANCELLED'))
      + (SELECT COALESCE(sum(leaderboard_seed_remaining), 0) FROM public.club_opening_setups WHERE club_id = v_est.id)
    , 2) INTO v_amt;
    IF v_amt <= 0 THEN
      RAISE EXCEPTION 'estate % holds % - an estate with nothing is not expected', v_est.name, v_amt;
    END IF;
    v_sum_estates := v_sum_estates + v_amt;
    v_supply := v_register_net + v_sum_estates;
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after, supply_after,
       reason, performed_by, performed_by_label, db_role, created_at)
    VALUES ('register-opening-baseline:' || v_est.id::text || ':2026-09-04', 'mint', 'chips',
            CASE WHEN v_est.is_union THEN 'union' ELSE 'club' END, v_est.id, v_est.name, v_amt, 0, v_amt, v_supply,
            'OPENING BASELINE, not issuance: the chips this estate held at ' || v_stamp
            || ' across every store the supply meter counts (member wallets and promo, cash felt, treasury, chip pool, promo and insurance floats, club wallets'
            || CASE WHEN v_est.is_union THEN ', union wallets' ELSE '' END
            || ', agent floats, jackpot and spin pools, live tournament liabilities, leaderboard seed). Written by Phase 3.1 of the chip standard so the register accounts for the full circulating supply from this instant; the history before the Mint is folded into it.',
            NULL, 'chip standard phase 3.1', current_user, v_snap_at);
  END LOOP;

  v_circ := round(v_total - v_register_net - v_sum_estates, 2);
  IF v_circ <= 0 THEN
    RAISE EXCEPTION 'the circulation remainder is % (total %, register net %, estates %) - expected positive', v_circ, v_total, v_register_net, v_sum_estates;
  END IF;
  v_supply := v_register_net + v_sum_estates + v_circ;
  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after, supply_after,
     reason, performed_by, performed_by_label, db_role, created_at)
  VALUES ('register-opening-baseline:circulation:2026-09-04', 'mint', 'chips', 'circulation', '00000000-0000-0000-0000-00000000c1c0', 'circulation', v_circ, 0, v_circ, v_supply,
          'OPENING BASELINE, not issuance: the remainder of the supply meter''s total at ' || v_stamp
          || ' that belongs to no one of the four estates (stores keyed to retired or foreign club ids) plus the net of the register''s own pre-baseline rows, so that the register''s net equals the meter''s total ('
          || v_total::text || ') at this instant. Every chip after this instant enters or leaves through a registered leg.',
          NULL, 'chip standard phase 3.1', current_user, v_snap_at);

  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
    INTO v_register_net FROM public.ca_mint_ledger WHERE asset = 'chips';
  IF round(v_register_net, 2) <> round(v_total, 2) THEN
    RAISE EXCEPTION 'register net % does not equal the meter total % after the baseline', v_register_net, v_total;
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The diamond mint is the Mint
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_mint_chips_from_diamonds(p_club_id uuid, p_diamonds numeric, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_op_id uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior record;
  v_diamonds numeric;
  v_chips numeric;
  v_deduct jsonb;
  v_diamonds_after numeric;
  v_club record;
  v_is_union_minter boolean := false;
  v_pool_after numeric;
  v_union_bank_after numeric;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;
  if p_diamonds is null or p_diamonds <= 0 or p_diamonds <> floor(p_diamonds) then
    return jsonb_build_object('success', false, 'error', 'Diamonds Must Be A Positive Whole Number');
  end if;
  if p_diamonds > 1000000 then
    return jsonb_build_object('success', false, 'error', 'Maximum 1,000,000 Diamonds Per Mint');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_club_id::text || ':' || v_op_id::text, 0));

  select amount, transaction_type, metadata, balance_after into v_prior
    from chip_transactions
   where transaction_type = 'mint'
     and club_id = p_club_id
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object('success', true, 'replayed', true,
      'scope', v_prior.metadata ->> 'scope',
      'chips', v_prior.amount,
      'diamonds_spent', (v_prior.metadata ->> 'diamonds_spent')::numeric,
      'diamonds_after', (select coalesce(diamonds, 0) from profiles where id = v_actor),
      'club_pool_after', case when (v_prior.metadata ->> 'scope') = 'club'
                              then v_prior.balance_after end,
      'union_bank_after', case when (v_prior.metadata ->> 'scope') = 'union'
                               then v_prior.balance_after end);
  end if;

  v_diamonds := p_diamonds;
  v_chips := v_diamonds * 100; -- THE RATE: 100 diamonds = 10,000 chips

  select id, name, union_id, owner_id into v_club
    from clubs where id = p_club_id for update;
  if v_club.id is null then
    return jsonb_build_object('success', false, 'error', 'That Club Could Not Be Found');
  end if;

  if v_club.union_id is not null then
    if exists (select 1 from unions u where u.id = v_club.union_id and u.owner_id = v_actor)
       or exists (select 1 from union_admins ua where ua.union_id = v_club.union_id and ua.user_id = v_actor) then
      v_is_union_minter := true;
    end if;
    if not v_is_union_minter then
      return jsonb_build_object('success', false,
        'error', 'Chip Mint Is Revoked For Clubs In A Union. Chips Flow From The Union. Ask Your Union Owner');
    end if;

    v_deduct := deduct_diamonds(
      v_actor, v_diamonds::integer,
      'Chip Mint: ' || v_chips::text || ' chips minted to union bank',
      'chip_mint', 'chip_mint',
      jsonb_build_object('club_id', p_club_id, 'union_id', v_club.union_id,
                         'chips', v_chips, 'op_id', v_op_id),
      null, 0);
    if coalesce((v_deduct->>'success')::boolean, false) = false then
      return jsonb_build_object('success', false,
        'error', coalesce(v_deduct->>'error', 'That Diamond Deduction Did Not Go Through'));
    end if;
    select coalesce(diamonds, 0) into v_diamonds_after from profiles where id = v_actor;

    /* THE MINT (chip standard 3.1, 2026-09-04): chips bought with diamonds
       are ISSUED. Declared issuance_reserve -> union_bank with the op id as
       the journal key; the register row follows from the leg (deferred
       trigger on chip_ledger). Undeclared, this landed in suspense and the
       register never saw it. */
    perform public.fn_ca_declare_ledger('mint', 'issuance_reserve', null, null,
                                        'diamond-mint:' || v_op_id::text, null);
    insert into union_wallets (union_id, chip_balance)
    values (v_club.union_id, v_chips)
    on conflict (union_id)
    do update set chip_balance = coalesce(union_wallets.chip_balance, 0) + v_chips,
                  updated_at = now();
    perform set_config('app.ledger_category', '', true);
    perform set_config('app.ledger_counterparty', '', true);
    perform set_config('app.ledger_idempotency_key', '', true);
    select chip_balance into v_union_bank_after
      from union_wallets where union_id = v_club.union_id;

    insert into chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
    values (p_club_id, v_actor, null, v_chips, 'mint',
            'Union Chip Mint: ' || v_chips::text || ' chips from ' || v_diamonds::text || ' diamonds',
            jsonb_build_object('op_id', v_op_id, 'scope', 'union',
                               'diamonds_spent', v_diamonds, 'union_id', v_club.union_id),
            v_union_bank_after);

    return jsonb_build_object('success', true, 'replayed', false, 'scope', 'union',
      'chips', v_chips, 'diamonds_spent', v_diamonds,
      'diamonds_after', v_diamonds_after, 'union_bank_after', v_union_bank_after);
  else
    -- STANDALONE CLUB: owner / co_owner / admin may mint into the club's pool.
    -- BOTH membership words (2026-08-27): status='active' alone refused the
    -- ~98% of production rows still carrying the pre-2026-07-22 'approved'.
    if not (v_club.owner_id = v_actor
            or exists (select 1 from club_members cm
                        where cm.club_id = p_club_id and cm.user_id = v_actor
                          and cm.role in ('owner', 'co_owner', 'admin')
                          and coalesce(cm.status, 'active') in ('active', 'approved'))) then
      return jsonb_build_object('success', false,
        'error', 'Only The Club Owner Or An Admin May Mint Chips');
    end if;

    v_deduct := deduct_diamonds(
      v_actor, v_diamonds::integer,
      'Chip Mint: ' || v_chips::text || ' chips minted to club bank',
      'chip_mint', 'chip_mint',
      jsonb_build_object('club_id', p_club_id, 'chips', v_chips, 'op_id', v_op_id),
      null, 0);
    if coalesce((v_deduct->>'success')::boolean, false) = false then
      return jsonb_build_object('success', false,
        'error', coalesce(v_deduct->>'error', 'That Diamond Deduction Did Not Go Through'));
    end if;
    select coalesce(diamonds, 0) into v_diamonds_after from profiles where id = v_actor;

    /* THE MINT (chip standard 3.1, 2026-09-04): see the union branch. */
    perform public.fn_ca_declare_ledger('mint', 'issuance_reserve', null, null,
                                        'diamond-mint:' || v_op_id::text, null);
    update clubs set chip_treasury = coalesce(chip_treasury, 0) + v_chips, updated_at = now()
     where id = p_club_id
     returning chip_treasury into v_pool_after;
    perform set_config('app.ledger_category', '', true);
    perform set_config('app.ledger_counterparty', '', true);
    perform set_config('app.ledger_idempotency_key', '', true);

    insert into chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
    values (p_club_id, v_actor, null, v_chips, 'mint',
            'Chip Mint: ' || v_chips::text || ' chips from ' || v_diamonds::text || ' diamonds',
            jsonb_build_object('op_id', v_op_id, 'scope', 'club',
                               'diamonds_spent', v_diamonds),
            v_pool_after);

    return jsonb_build_object('success', true, 'replayed', false, 'scope', 'club',
      'chips', v_chips, 'diamonds_spent', v_diamonds,
      'diamonds_after', v_diamonds_after, 'club_pool_after', v_pool_after);
  end if;
end
$function$;


-- ───────────────────────────────────────────────────────────────────────────
-- 5. A mint door with no caller is not a browser's to call
-- ───────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.fn_mint_club_chips(uuid, numeric, text, text) FROM PUBLIC, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The check: register net against the meter
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_mint_register_vs_supply()
 RETURNS TABLE(register_net numeric, meter_total numeric, meter_taken_at timestamptz, difference numeric, unexplained_since_baseline numeric)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH r AS (SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) AS net FROM public.ca_mint_ledger WHERE asset = 'chips'),
       s AS (SELECT total, taken_at FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1),
       b AS (SELECT min(created_at) AS at FROM public.ca_mint_ledger WHERE op_id LIKE 'register-opening-baseline:%'),
       u AS (SELECT COALESCE(sum(unexplained), 0) AS drift FROM public.ca_supply_snapshots, b WHERE taken_at > b.at)
  SELECT round(r.net, 2), round(s.total, 2), s.taken_at, round(s.total - r.net, 2), round(u.drift, 2) FROM r, s, u;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_mint_register_vs_supply() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint_register_vs_supply() TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. LAST, because it locks chip_ledger against the engine's writers for
--    as long as the transaction lasts: the trigger that makes (1) structural.
-- ───────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS zz_ca_issuance_leg_is_registered ON public.chip_ledger;
-- DEFERRABLE INITIALLY DEFERRED: the doors that write their own register row
-- (fn_ca_mint, the opening grant, the restoration door) do so AFTER the leg
-- in the same transaction; checking at commit lets them, and catches every
-- door that does not. The store list mirrors fn_ca_noncirculating_chip_stores.
CREATE CONSTRAINT TRIGGER zz_ca_issuance_leg_is_registered
  AFTER INSERT ON public.chip_ledger
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.from_type IN ('system_mint', 'system_burn', 'issuance_reserve', 'chip_retirement')
     OR NEW.to_type   IN ('system_mint', 'system_burn', 'issuance_reserve', 'chip_retirement'))
  EXECUTE FUNCTION public.fn_ca_issuance_leg_is_registered();

DO $$
DECLARE v record;
BEGIN
  SELECT * INTO v FROM public.fn_ca_mint_register_vs_supply();
  IF v.difference <> 0 THEN
    RAISE EXCEPTION 'register net % vs meter total %: difference %', v.register_net, v.meter_total, v.difference;
  END IF;
  IF to_regprocedure('public.fn_ca_register_issuance_leg(uuid)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.chip_ledger'::regclass AND tgname = 'zz_ca_issuance_leg_is_registered' AND tgdeferrable AND tginitdeferred) THEN
    RAISE EXCEPTION 'the register trigger did not land deferred';
  END IF;
  IF has_function_privilege('authenticated', 'public.fn_mint_club_chips(uuid, numeric, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_mint_club_chips is still executable by a browser';
  END IF;
  IF position('diamond-mint:' IN pg_get_functiondef('public.fn_mint_chips_from_diamonds'::regproc)) = 0 THEN
    RAISE EXCEPTION 'fn_mint_chips_from_diamonds does not declare the Mint';
  END IF;
END $$;

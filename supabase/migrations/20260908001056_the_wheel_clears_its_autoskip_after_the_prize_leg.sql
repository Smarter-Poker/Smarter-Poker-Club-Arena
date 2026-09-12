-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260908001056; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260908001056   (the stamp IS the apply time, UTC: 2026-09-08 00:10:56)
--   name        the_wheel_clears_its_autoskip_after_the_prize_leg
--   created_by  (not recorded)
--   statements  1 statement(s), 20359 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260908001056 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_wheel_spin
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- 20260908001056_the_wheel_clears_its_autoskip_after_the_prize_leg.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- fn_wheel_spin (20260907233833) declares its prize leg with an autoskip on
-- the host bank table (union_wallets or clubs) so the union_bank -> player leg
-- is ONE journal row, the shape of fn_union_send_to_member_zd3core. The
-- autoskip GUC is transaction-scoped and fn_ca_declare_ledger only ever sets
-- it. Inside one RPC call that is harmless: the mint leg comes before the
-- prize leg. Inside one TRANSACTION with two spins - the rolled-back probe,
-- any batch - the second spin's mint leg found the autoskip still set and the
-- host bank moved with NO journal row; the function's own check caught it
-- ("the host bank moved but no mint leg was journaled") and refused the spin.
--
-- Right outcome, wrong reason to depend on: the guard should never have to
-- fire. The prize leg now clears both autoskips as it clears the other four
-- GUCs. Nothing else in the body changes; the probe then runs forty spins in
-- one transaction with forty mint legs and rolls back clean.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ── THE SPIN ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_wheel_spin(p_club_id uuid, p_commit_id uuid, p_client_seed text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  c_two48 constant numeric := 281474976710656;   -- 2^48
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.wheel_configs%ROWTYPE;
  pool public.wheel_pools%ROWTYPE;
  cm public.wheel_seed_commits%ROWTYPE;
  prior public.wheel_spins%ROWTYPE;
  a record;
  v_rate integer := public.fn_ca_bridge_rate();
  v_price integer; v_mult integer; v_intake numeric;
  v_mint_exact numeric; v_mint_now numeric; v_carry numeric; v_dia_now numeric;
  v_bank numeric; v_bank_after numeric;
  v_client text := left(btrim(COALESCE(p_client_seed, '')), 64);
  v_nonce bigint; v_hmac bytea; v_roll numeric; v_point numeric;
  v_total integer := 0; v_acc integer := 0;
  v_eligible smallint[] := '{}'; v_locked jsonb := '[]'::jsonb;
  seg record; v_pick record; v_found boolean := false;
  v_value_chips numeric := 0; v_prize_chips numeric := 0; v_prize_dia integer := 0;
  v_today integer; v_last timestamptz;
  v_spendable integer; v_diamonds numeric; v_purchased integer;
  v_lot record; v_remaining integer; v_take integer;
  v_deduct jsonb; v_credit jsonb;
  v_member_after numeric; v_dia_after numeric;
  v_spin_id uuid := gen_random_uuid();
  v_is_fixture boolean := false;
  v_result jsonb;
BEGIN
  -- ── who and where ──────────────────────────────────────────────────────────
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Bridge Rate Is Not Set');
  END IF;
  IF length(v_client) < 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'A Client Seed Is Required');
  END IF;

  -- ── replay: a commit is spent once; the second call returns the first spin ─
  SELECT * INTO prior FROM public.wheel_spins WHERE commit_id = p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.user_id <> v_user THEN
      RETURN jsonb_build_object('ok', false, 'error', 'That Spin Belongs To Another Player');
    END IF;
    RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', true);
  END IF;

  -- ── the freeze and the kill switch, before any money moves ─────────────────
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Platform Is In Its Maintenance Break. Spin Again In A Few Minutes');
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'wheel' AND f.cleared_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Diamond Wheel Is Paused');
  END IF;

  -- ── the host, its table, its pool: one lock serialises every spin on it ────
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = v_host FOR UPDATE;
  IF cfg.host_id IS NULL OR NOT cfg.enabled THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Diamond Wheel Is Not Open Here');
  END IF;
  INSERT INTO public.wheel_pools (host_id) VALUES (v_host) ON CONFLICT (host_id) DO NOTHING;
  SELECT * INTO pool FROM public.wheel_pools WHERE host_id = v_host FOR UPDATE;

  SELECT x.* INTO a FROM public.fn_wheel_segments_audit(cfg.segment_version) x;
  IF a.weight_total IS DISTINCT FROM 100000 OR a.spec_rtp IS DISTINCT FROM 0.800000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Prize Table Failed Its Audit. The Wheel Is Closed Until It Is Fixed');
  END IF;
  SELECT cfg.spin_price_diamonds / v.spin_price_diamonds INTO v_mult
    FROM public.wheel_segment_versions v WHERE v.version = cfg.segment_version;
  v_price  := cfg.spin_price_diamonds;
  v_intake := v_price::numeric / v_rate;
  v_mint_exact := round(v_intake * a.chip_share, 6) + pool.mint_carry;
  v_mint_now   := floor(v_mint_exact * 100) / 100;
  v_carry      := round(v_mint_exact - v_mint_now, 6);
  v_dia_now    := round(v_price * a.diamond_share, 4);

  -- ── the player: member, not a fixture, inside the limits, able to pay ──────
  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = p_club_id AND m.user_id = v_user
                    AND COALESCE(m.status, 'active') IN ('active', 'approved')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Join The Club Before You Spin');
  END IF;
  v_is_fixture := public.fn_ca_is_fixture_account(v_user) OR public.fn_ca_is_cert_account(v_user);
  IF v_is_fixture AND NOT cfg.allow_fixture_accounts THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Certification Accounts Do Not Spin This Wheel');
  END IF;
  SELECT * INTO cm FROM public.wheel_seed_commits
   WHERE id = p_commit_id AND user_id = v_user AND consumed_by IS NULL FOR UPDATE;
  IF cm.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Spin Ticket Is Not Yours Or Was Already Used. Open The Wheel Again');
  END IF;
  IF cm.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Spin Ticket Expired. Open The Wheel Again');
  END IF;
  SELECT count(*)::integer, max(s.created_at) INTO v_today, v_last
    FROM public.wheel_spins s
   WHERE s.user_id = v_user AND s.host_id = v_host
     AND (s.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
  IF v_today >= cfg.max_spins_per_player_per_day THEN
    RETURN jsonb_build_object('ok', false, 'error', format('You Have Reached Today''s Limit Of %s Spins', cfg.max_spins_per_player_per_day));
  END IF;
  IF v_last IS NOT NULL AND now() - v_last < make_interval(secs => cfg.min_seconds_between_spins) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'One Moment Between Spins');
  END IF;
  SELECT COALESCE(p.diamonds, 0) INTO v_diamonds FROM public.profiles p WHERE p.id = v_user;
  v_purchased := public.fn_wheel_purchased_available(v_user);
  v_spendable := CASE WHEN cfg.purchased_only THEN LEAST(v_diamonds, v_purchased)::integer ELSE v_diamonds::integer END;
  IF v_spendable < v_price THEN
    RETURN jsonb_build_object('ok', false,
      'error', CASE WHEN cfg.purchased_only AND v_diamonds >= v_price
                    THEN 'This Wheel Spins Purchased Diamonds Only'
                    ELSE 'Not Enough Diamonds For A Spin' END,
      'diamonds', v_diamonds, 'spendable', v_spendable, 'spin_price_diamonds', v_price);
  END IF;

  -- ── the host bank, locked ──────────────────────────────────────────────────
  IF v_kind = 'union' THEN
    INSERT INTO public.union_wallets (union_id, created_at, updated_at) VALUES (v_host, now(), now())
    ON CONFLICT (union_id) DO NOTHING;
    SELECT COALESCE(w.chip_balance, 0) INTO v_bank FROM public.union_wallets w WHERE w.union_id = v_host FOR UPDATE;
  ELSE
    SELECT COALESCE(c.chip_treasury, 0) INTO v_bank FROM public.clubs c WHERE c.id = v_host FOR UPDATE;
  END IF;
  v_bank := COALESCE(v_bank, 0);

  -- ── eligibility: the affordability gate ────────────────────────────────────
  FOR seg IN SELECT * FROM public.wheel_segments g WHERE g.version = cfg.segment_version ORDER BY g.ord LOOP
    IF seg.kind = 'chips' THEN
      IF pool.chips_paid + seg.amount * v_mult > pool.chips_minted + v_mint_now + cfg.exposure_allowance_chips THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'exposure',
                      'unlocks_at', round(pool.chips_paid + seg.amount * v_mult - v_mint_now - cfg.exposure_allowance_chips, 2));
        CONTINUE;
      END IF;
      IF v_bank + v_mint_now < seg.amount * v_mult THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'bank', 'unlocks_at', round(seg.amount * v_mult, 2));
        CONTINUE;
      END IF;
    ELSIF seg.kind = 'diamonds' THEN
      IF pool.diamond_float + v_dia_now < seg.amount * v_mult THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'diamond_float',
                      'unlocks_at', round(seg.amount * v_mult - v_dia_now, 0));
        CONTINUE;
      END IF;
    END IF;
    v_eligible := v_eligible || seg.ord;
    v_total := v_total + seg.weight;
  END LOOP;
  IF v_total <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No Prize Can Be Paid Right Now. Try Again Shortly', 'locked', v_locked);
  END IF;

  -- ── the roll: committed seed, player seed, per-player nonce ────────────────
  SELECT count(*) + 1 INTO v_nonce FROM public.wheel_spins s WHERE s.user_id = v_user;
  v_hmac := extensions.hmac(convert_to(v_client || ':' || v_nonce::text, 'UTF8'),
                            convert_to(cm.server_seed, 'UTF8'), 'sha256');
  v_roll  := (('x' || encode(substring(v_hmac from 1 for 6), 'hex'))::bit(48)::bigint)::numeric;
  v_point := floor(v_roll * v_total / c_two48);
  v_acc := 0;
  FOR seg IN SELECT * FROM public.wheel_segments g
              WHERE g.version = cfg.segment_version AND g.ord = ANY (v_eligible) ORDER BY g.ord LOOP
    v_acc := v_acc + seg.weight;
    IF v_point < v_acc THEN v_pick := seg; v_found := true; EXIT; END IF;
  END LOOP;
  IF NOT v_found THEN
    SELECT * INTO v_pick FROM public.wheel_segments g
     WHERE g.version = cfg.segment_version AND g.ord = v_eligible[array_length(v_eligible, 1)];
  END IF;

  -- ── 1. the spin is paid for ────────────────────────────────────────────────
  v_deduct := public.deduct_diamonds(
    v_user, v_price,
    format('Diamond Wheel Spin (%s Diamonds)', v_price),
    'wheel_spin', 'wheel_spin',
    jsonb_build_object('spin_id', v_spin_id, 'club_id', p_club_id, 'host_id', v_host,
                       'commit_id', p_commit_id, 'segment_version', cfg.segment_version),
    'wheel:' || v_spin_id::text, 0);
  IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Not Enough Diamonds For A Spin',
                              'detail', v_deduct->>'error');
  END IF;
  IF cfg.purchased_only THEN
    v_remaining := v_price;
    FOR v_lot IN SELECT * FROM public.diamond_purchase_lots l
                  WHERE l.user_id = v_user AND l.frozen_at IS NULL
                    AND (l.issued - l.consumed - l.refunded) > 0
                  ORDER BY l.created_at, l.id FOR UPDATE LOOP
      EXIT WHEN v_remaining <= 0;
      v_take := LEAST(v_remaining, v_lot.issued - v_lot.consumed - v_lot.refunded);
      UPDATE public.diamond_purchase_lots SET consumed = consumed + v_take WHERE id = v_lot.id;
      v_remaining := v_remaining - v_take;
    END LOOP;
    IF v_remaining > 0 THEN
      RAISE EXCEPTION 'fn_wheel_spin: purchased lots could not cover the spin (% short) after the availability check passed', v_remaining;
    END IF;
  END IF;

  -- ── 2. the host is paid its chip share: an issuance, registered ────────────
  IF v_mint_now > 0 THEN
    PERFORM public.fn_ca_declare_ledger('mint', 'issuance_reserve', NULL, NULL, 'wheel-mint:' || v_spin_id::text, NULL);
    IF v_kind = 'union' THEN
      UPDATE public.union_wallets SET chip_balance = COALESCE(chip_balance, 0) + v_mint_now, updated_at = now()
       WHERE union_id = v_host RETURNING chip_balance INTO v_bank_after;
    ELSE
      UPDATE public.clubs SET chip_treasury = COALESCE(chip_treasury, 0) + v_mint_now, updated_at = now()
       WHERE id = v_host RETURNING chip_treasury INTO v_bank_after;
    END IF;
    PERFORM set_config('app.ledger_category', '', true);
    PERFORM set_config('app.ledger_counterparty', '', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
    PERFORM set_config('app.ledger_idempotency_key', '', true);
    IF NOT EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key = 'wheel-mint:' || v_spin_id::text) THEN
      RAISE EXCEPTION 'fn_wheel_spin: the host bank moved but no mint leg was journaled for spin %', v_spin_id;
    END IF;
    v_bank := v_bank_after;
  END IF;

  -- ── 3. the prize ───────────────────────────────────────────────────────────
  IF v_pick.kind = 'chips' THEN
    v_prize_chips := round(v_pick.amount * v_mult, 2);
    v_value_chips := v_prize_chips;
    IF v_bank < v_prize_chips THEN
      RAISE EXCEPTION 'fn_wheel_spin: host bank % below the prize % after the gate passed', v_bank, v_prize_chips;
    END IF;
    PERFORM public.fn_ca_declare_ledger('wheel_prize',
              CASE WHEN v_kind = 'union' THEN 'union_bank' ELSE 'club_treasury' END,
              v_host, NULL, 'wheel-prize:' || v_spin_id::text,
              CASE WHEN v_kind = 'union' THEN ARRAY['union_wallets'] ELSE ARRAY['clubs'] END);
    IF v_kind = 'union' THEN
      UPDATE public.union_wallets SET chip_balance = chip_balance - v_prize_chips, updated_at = now()
       WHERE union_id = v_host AND COALESCE(chip_balance, 0) >= v_prize_chips
       RETURNING chip_balance INTO v_bank_after;
    ELSE
      UPDATE public.clubs SET chip_treasury = chip_treasury - v_prize_chips, updated_at = now()
       WHERE id = v_host AND COALESCE(chip_treasury, 0) >= v_prize_chips
       RETURNING chip_treasury INTO v_bank_after;
    END IF;
    IF v_bank_after IS NULL THEN
      RAISE EXCEPTION 'fn_wheel_spin: the host bank refused the prize debit of %', v_prize_chips;
    END IF;
    UPDATE public.club_members SET chip_balance = COALESCE(chip_balance, 0) + v_prize_chips, updated_at = now()
     WHERE club_id = p_club_id AND user_id = v_user
       AND COALESCE(status, 'active') IN ('active', 'approved')
     RETURNING chip_balance INTO v_member_after;
    IF v_member_after IS NULL THEN
      RAISE EXCEPTION 'fn_wheel_spin: the prize landed nowhere for % in club %', v_user, p_club_id;
    END IF;
    PERFORM set_config('app.ledger_category', '', true);
    PERFORM set_config('app.ledger_counterparty', '', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
    PERFORM set_config('app.ledger_idempotency_key', '', true);
    -- The autoskip is transaction-scoped and fn_ca_declare_ledger only sets it.
    -- Clear it here so a later balance write in the same transaction (a probe,
    -- a batch, a second spin) is journaled: left set, the next mint leg on
    -- this table would silently write no journal row (found by the rolled-back
    -- probe of 20260907233833: spin 2 in one transaction minted unjournaled).
    PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
    PERFORM set_config('app.ledger_autoskip_clubs', '', true);
    IF v_kind = 'union' THEN
      INSERT INTO public.union_wallet_transactions
        (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes, created_by)
      VALUES (v_host, p_club_id, 'chip_balance', 'debit', v_prize_chips, v_bank_after, 'wheel_prize',
              format('Diamond Wheel prize, spin %s', v_spin_id), v_user);
    END IF;
    INSERT INTO public.chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
    VALUES (p_club_id, NULL, v_user, v_prize_chips, 'wheel_prize',
            format('Diamond Wheel: %s', v_pick.label),
            jsonb_build_object('spin_id', v_spin_id, 'host_id', v_host, 'host_kind', v_kind,
                               'segment_version', cfg.segment_version, 'ord', v_pick.ord),
            v_member_after);
    v_bank := v_bank_after;
  ELSIF v_pick.kind = 'diamonds' THEN
    v_prize_dia := (v_pick.amount * v_mult)::integer;
    v_value_chips := round(v_prize_dia::numeric / v_rate, 4);
    v_credit := public.add_diamonds_to_balance(v_user, v_prize_dia, 'wheel_prize',
                  format('Diamond Wheel: %s', v_pick.label), 'wheel:' || v_spin_id::text || ':prize');
    IF COALESCE((v_credit->>'success')::boolean, false) = false THEN
      RAISE EXCEPTION 'fn_wheel_spin: the diamond prize could not be credited: %', v_credit->>'error';
    END IF;
  END IF;

  -- ── 4. the pool remembers ──────────────────────────────────────────────────
  UPDATE public.wheel_pools
     SET spins = spins + 1,
         intake_diamonds = intake_diamonds + v_price,
         chips_minted = chips_minted + v_mint_now,
         mint_carry = v_carry,
         chips_paid = chips_paid + v_prize_chips,
         diamond_float = diamond_float + v_dia_now - v_prize_dia,
         diamonds_paid = diamonds_paid + v_prize_dia,
         constrained_spins = constrained_spins + CASE WHEN jsonb_array_length(v_locked) > 0 THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE host_id = v_host
   RETURNING * INTO pool;
  IF pool.chips_paid > pool.chips_minted + cfg.exposure_allowance_chips THEN
    RAISE EXCEPTION 'fn_wheel_spin: chips_paid % would exceed chips_minted % + allowance % - the gate was bypassed',
      pool.chips_paid, pool.chips_minted, cfg.exposure_allowance_chips;
  END IF;

  SELECT COALESCE(p.diamonds, 0) INTO v_dia_after FROM public.profiles p WHERE p.id = v_user;
  IF v_member_after IS NULL THEN
    SELECT COALESCE(m.chip_balance, 0) INTO v_member_after FROM public.club_members m
     WHERE m.club_id = p_club_id AND m.user_id = v_user LIMIT 1;
  END IF;

  INSERT INTO public.wheel_spins
    (id, host_id, host_kind, club_id, user_id, segment_version, spin_price_diamonds, multiplier, diamonds_per_chip,
     commit_id, server_seed_hash, server_seed, client_seed, nonce, roll, weight_total, eligible_ords, locked,
     outcome_ord, outcome_kind, outcome_amount, prize_value_chips, chips_minted, diamond_accrual,
     pool_chips_minted_after, pool_chips_paid_after, pool_diamond_float_after, diamonds_after, member_chips_after, is_fixture)
  VALUES
    (v_spin_id, v_host, v_kind, p_club_id, v_user, cfg.segment_version, v_price, v_mult, v_rate,
     cm.id, cm.server_seed_hash, cm.server_seed, v_client, v_nonce, v_roll, v_total, v_eligible, v_locked,
     v_pick.ord, v_pick.kind, v_pick.amount * v_mult, v_value_chips, v_mint_now, v_dia_now,
     pool.chips_minted, pool.chips_paid, pool.diamond_float, v_dia_after, v_member_after, v_is_fixture)
  RETURNING * INTO prior;
  UPDATE public.wheel_seed_commits SET consumed_by = v_spin_id WHERE id = cm.id;

  RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', false);
END $function$;

GRANT EXECUTE ON FUNCTION public.fn_wheel_spin(uuid, uuid, text) TO authenticated, service_role;


DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_wheel_spin' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%app.ledger_autoskip_union_wallets'', ''''%' OR v_src NOT LIKE '%app.ledger_autoskip_clubs'', ''''%' THEN
    RAISE EXCEPTION 'POST-APPLY: fn_wheel_spin does not clear the autoskips after the prize leg';
  END IF;
END $$;

COMMIT;

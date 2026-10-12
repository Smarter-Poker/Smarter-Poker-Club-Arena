-- ===========================================================================
--  A HOUSE MINT CARRIES ITS REASON, AND STRANDED CERTIFICATION POOLS ARE
--  RETIRED
-- ===========================================================================
--
-- Launch-readiness money sweep, 2026-10-02 (lane B: every chip store balances
-- and nothing mints or burns outside an authorized path). Read from rows:
--
-- 1. THE TWO DEEP STACK SOCIETY MINTS WERE NOT HAND EDITS, BUT THEY LOOKED
--    LIKE ONE. system_mint -> club_treasury 14,630.53 at 09:44:51 UTC and
--    34,625.00 at 11:30:59 UTC (club 2a1132b9) were migrations 20261002092328
--    and 20261002110247 calling fn_ca_fund_club, each under its own
--    idempotency key. The 2,029.90 club_treasury -> player_wallet settlement
--    at 09:07:12 was 20261002082429 (key pko-unclaimed-bounty:3f19bd70...).
--    But fn_ca_fund_club threw its p_reason away: the journal leg says only
--    "auto-ledgered clubs.chip_treasury delta" and the mint register row was
--    written from that leg (origin 'journal'), so the house's reason for
--    creating 49,255.53 chips exists nowhere in the database. And nothing
--    distinguished that door from a raw UPDATE whose session had set
--    app.ledger_counterparty = 'system_mint' by hand: probed 2026-10-02 in
--    one rolled-back DO block, an undeclared raw UPDATE of clubs.chip_treasury
--    or club_members.chip_balance is already REFUSED at commit
--    (balance_moved_against_settlement_suspense, 23514), but a raw UPDATE
--    under a hand-set system_mint declaration COMMITTED.
--
--    FIX, at the door and at commit (CLAUDE.md 10.11):
--      * fn_ca_fund_club writes its own register row - op_id = its key,
--        reason = p_reason, linked to its leg - and clears its declaration so
--        a later write in the same transaction is never journalled as this
--        mint.
--      * fn_ca_issuance_leg_is_registered (the commit-time constraint every
--        mint and burn leg already passes) now also refuses
--          - a leg that issues chips into circulation with no idempotency key
--            (every such leg in the last 30 days carried one: opening grants,
--            fn_ca_mint, add-on restorations, game mints, fn_ca_fund_club);
--          - a system_mint / system_burn leg with no register row written by
--            a door (op_id not 'ledger:%'): the house mints only through
--            fn_ca_fund_club, which now writes one, so a hand-declared
--            system_mint is refused (REFUSED: house_issuance_without_its_door).
--        Corrections (fn_ca_post_correction) are untouched, exactly as the
--        register already treats them.
--
-- 2. 1,800.00 CHIPS STRANDED IN TWELVE POOLS WHOSE CLUBS NO LONGER EXIST.
--    Every club-create certification club is minted 100,000.00 from the
--    issuance reserve (club-opening-grant), seeds 200.00 to its Spin reserve
--    and 100.00 to its BBJ pool, and is retired by burning all three. For six
--    "Crest Cert" clubs created 01:40-02:50 UTC on 2026-10-02 (before the
--    certification cleanup retired the pools) the treasury 99,700.00 was
--    burned and the club deleted, but the two pools were left holding 300.00
--    each: chips in the supply that belong to no club and no player. Every
--    later certification club nets to exactly zero (measured over 72 hours:
--    26 retired with their pools, 292 without seeds). The 1,800.00 is retired
--    here through the journal (declared burn -> chip_retirement, one key per
--    pool), the same path the certification cleanup uses. Nothing is taken
--    from any player or club.
--
-- 3. THE BBJ PAYOUT SELF-TEST READ A RETURNED SHARE AS A MINT.
--    fn_platform_invariants_health reported bbj_payout_conservation VIOLATED
--    ("pool is 5600.00, expected 5000.00"). Probed in a rolled-back DO block:
--    bbj_atomic_payout_v2 paid 800.00 out of the pool, delivered 200.00 to the
--    winner and returned the 600.00 loser share to the pool because the
--    self-test's synthetic loser has no membership to credit - journalled
--    table_stack -> bbj_pool 600.00. Conserved. The self-test treated
--    total_payout as the pool's net outflow. It now subtracts the shares the
--    journal shows coming back to the pool and asserts conservation on both
--    hits, so it still fails on a real mint (the pool growing by more than
--    came back), on a reserve that funds a payout and on a reserve that moves
--    on a partial hit.
--
-- CLAUDE.md section 2: one migration, one transaction; no table lock is taken
-- (CREATE OR REPLACE FUNCTION and twelve row updates). Applied once, by
-- apply-merged-migration.yml, outside :50-:03 UTC.
-- ===========================================================================
-- @live-proof: (SELECT count(*) FROM public.chip_ledger WHERE idempotency_key LIKE 'cert-orphan-pool-retired:%') = 12

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 0. Preimage: the bodies replaced here are the ones read on 2026-10-02
-- ---------------------------------------------------------------------------

DO $pre$
DECLARE
  r record;
  v_live text;
  v_n integer;
  v_sum numeric;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('fn_ca_fund_club',                      '6a4c4ce04b75eb2ae0ea802b10fbaff4'),
      ('fn_ca_issuance_leg_is_registered',     '7a41ac630bad489e02f05f47ff5ffa1e'),
      ('fn_bbj_selftest_payout_conservation',  '23bad6cf967556c8eba76dcc9147954c')) AS x(f, m)
  LOOP
    SELECT md5(pg_get_functiondef(p.oid)) INTO v_live
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.f;
    IF v_live IS DISTINCT FROM r.m THEN
      RAISE EXCEPTION 'preimage: % is not the body read on 2026-10-02 (md5 %, expected %); re-read it before redefining it', r.f, v_live, r.m;
    END IF;
  END LOOP;

  -- No live writer mints into circulation without a key (the new refusal).
  SELECT count(*) INTO v_n FROM public.chip_ledger
   WHERE created_at > now() - interval '30 days'
     AND from_type = ANY (public.fn_ca_noncirculating_chip_stores())
     AND NOT (to_type = ANY (public.fn_ca_noncirculating_chip_stores()))
     AND category <> 'correction'
     AND idempotency_key IS NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'preimage: % keyless issuance leg(s) in 30 days; a live writer would be refused - give it a key first', v_n;
  END IF;

  -- The stranded pools are exactly the twelve read on 2026-10-02.
  SELECT count(*), COALESCE(sum(balance), 0) INTO v_n, v_sum
    FROM public.spin_bonus_pools s
   WHERE s.club_id IS NOT NULL AND s.balance <> 0
     AND NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = s.club_id);
  IF v_n <> 6 OR v_sum <> 1200.00 THEN
    RAISE EXCEPTION 'preimage: expected 6 orphan Spin reserves holding 1200.00, found % holding %', v_n, v_sum;
  END IF;
  SELECT count(*), COALESCE(sum(main_balance), 0) INTO v_n, v_sum
    FROM public.bbj_pools b
   WHERE b.club_id IS NOT NULL
     AND (COALESCE(b.main_balance, 0) + COALESCE(b.backup_balance, 0) + COALESCE(b.promo_balance, 0)) <> 0
     AND NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = b.club_id);
  IF v_n <> 6 OR v_sum <> 600.00 THEN
    RAISE EXCEPTION 'preimage: expected 6 orphan BBJ pools holding 600.00 in main, found % holding %', v_n, v_sum;
  END IF;
  IF EXISTS (SELECT 1 FROM public.bbj_pools b
              WHERE b.club_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = b.club_id)
                AND (COALESCE(b.backup_balance, 0) <> 0 OR COALESCE(b.promo_balance, 0) <> 0)) THEN
    RAISE EXCEPTION 'preimage: an orphan BBJ pool holds backup or promo chips; read it before retiring';
  END IF;
  IF EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key LIKE 'cert-orphan-pool-retired:%') THEN
    RAISE EXCEPTION 'preimage: the orphan pools were already retired';
  END IF;
END $pre$;

-- ---------------------------------------------------------------------------
-- 1. The house door writes its reason into the register
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_fund_club(p_club_id uuid, p_amount numeric, p_reason text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_club record; v_key text; v_before numeric; v_after numeric;
  v_leg uuid; v_supply numeric; v_reason text := btrim(COALESCE(p_reason, ''));
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'fund_club refused: amount must be positive to two decimals';
  END IF;
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'fund_club refused: a reason of at least 10 characters is required';
  END IF;
  SELECT * INTO v_club FROM public.clubs WHERE id = p_club_id FOR NO KEY UPDATE;
  IF v_club.id IS NULL THEN
    RAISE EXCEPTION 'fund_club refused: unknown club %', p_club_id;
  END IF;
  v_key := COALESCE(p_idempotency_key,
                    'club-funding:' || p_club_id::text || ':' ||
                    extract(epoch from clock_timestamp())::bigint::text);
  -- Replay safety: an identical key that already journaled is a no-op.
  IF EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key = v_key) THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'idempotency_key', v_key);
  END IF;
  v_before := COALESCE(v_club.chip_treasury, 0);

  PERFORM public.fn_ca_declare_ledger('mint', 'system_mint', NULL, NULL, v_key);
  UPDATE public.clubs
     SET chip_treasury = COALESCE(chip_treasury,0) + p_amount
   WHERE id = p_club_id
   RETURNING chip_treasury INTO v_after;
  SELECT id INTO v_leg FROM public.chip_ledger WHERE idempotency_key = v_key;
  -- The declaration is this mint's alone: a later write in the same
  -- transaction must never be journalled as house issuance.
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);
  IF v_leg IS NULL THEN
    RAISE EXCEPTION 'fund_club: the treasury moved but no journal leg carries key % - refusing to mint what the journal does not carry', v_key;
  END IF;

  -- The register row is the door's, with the door's reason (2026-10-02): the
  -- commit-time check refuses a system_mint leg without one.
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) + p_amount
    INTO v_supply FROM public.ca_mint_ledger WHERE asset = 'chips';
  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount,
     balance_before, balance_after, supply_after, reason,
     performed_by, performed_by_label, chip_ledger_id)
  VALUES
    (v_key, 'mint', 'chips',
     CASE WHEN COALESCE(v_club.is_union, false) THEN 'union' ELSE 'club' END,
     p_club_id, v_club.name, p_amount,
     v_before, v_after, v_supply, left(v_reason, 2000),
     auth.uid(), 'fn_ca_fund_club', v_leg);

  RETURN jsonb_build_object('ok', true, 'replayed', false, 'club_id', p_club_id,
                            'amount', p_amount, 'treasury_after', v_after,
                            'idempotency_key', v_key, 'reason', v_reason,
                            'ledger_id', v_leg);
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_fund_club(uuid, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_fund_club(uuid, numeric, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. At commit: issuance carries a key, and house issuance has its door
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_issuance_leg_is_registered()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
  v_pol public.ca_mint_policy%ROWTYPE;
  v_24h numeric;
BEGIN
  IF NEW.from_type = ANY (v_outside) AND NOT (NEW.to_type = ANY (v_outside))
     AND NEW.category <> 'correction' THEN
    SELECT * INTO v_pol FROM public.ca_mint_policy WHERE id = 1;
    IF NEW.amount > v_pol.per_operation_cap_chips THEN
      RAISE EXCEPTION 'issuance refused: % chips in one leg is over the per-operation ceiling of % (ca_mint_policy; raise it with a reason through fn_ca_mint_policy_set before a deliberate batch)',
        NEW.amount, v_pol.per_operation_cap_chips USING ERRCODE = 'P0403';
    END IF;
    v_24h := public.fn_ca_mint_issued_24h('chips', NEW.id) + NEW.amount;
    IF v_24h > v_pol.rolling_24h_cap_chips THEN
      RAISE EXCEPTION 'issuance refused: this leg would bring the last 24 hours to % chips, over the rolling ceiling of % (ca_mint_policy; raise it with a reason through fn_ca_mint_policy_set before a deliberate batch)',
        v_24h, v_pol.rolling_24h_cap_chips USING ERRCODE = 'P0403';
    END IF;
    -- 2026-10-02: chips enter circulation only under an operation key.
    IF NEW.idempotency_key IS NULL OR btrim(NEW.idempotency_key) = '' THEN
      RAISE EXCEPTION 'REFUSED: issuance_without_an_operation_key (% chips % -> %)', NEW.amount, NEW.from_type, NEW.to_type
        USING ERRCODE = '23514',
              HINT = 'Mint through a door that keys its leg: fn_ca_mint, fn_ca_fund_club, or a declared write with fn_ca_declare_ledger(..., p_idempotency_key).';
    END IF;
  END IF;
  PERFORM public.fn_ca_register_issuance_leg(NEW.id);
  -- 2026-10-02: the house mints and burns only through a door that writes its
  -- own register row with its reason. A hand-declared system_mint has none.
  IF (NEW.from_type IN ('system_mint', 'system_burn') OR NEW.to_type IN ('system_mint', 'system_burn'))
     AND NEW.category <> 'correction'
     AND NOT EXISTS (SELECT 1 FROM public.ca_mint_ledger m
                      WHERE m.chip_ledger_id = NEW.id AND m.op_id NOT LIKE 'ledger:%') THEN
    RAISE EXCEPTION 'REFUSED: house_issuance_without_its_door (% chips % -> %)', NEW.amount, NEW.from_type, NEW.to_type
      USING ERRCODE = '23514',
            HINT = 'House funding goes through fn_ca_fund_club(club, amount, reason, key), which records its reason in ca_mint_ledger.';
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_issuance_leg_is_registered() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The BBJ self-test counts a share returned to the pool
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_bbj_selftest_payout_conservation()
 RETURNS TABLE(ok boolean, detail text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pool uuid; err text := ''; r record;
  m_full numeric; b_full numeric; paid_full numeric; back_full numeric;
  m_part numeric; b_part numeric; paid_part numeric; back_part numeric;
  v_back0 numeric; v_back1 numeric; v_back2 numeric;
  v_u1 uuid; v_u2 uuid;
BEGIN
  SELECT id INTO v_pool FROM bbj_pools WHERE status='active' ORDER BY main_balance DESC LIMIT 1;
  IF v_pool IS NULL THEN
    RETURN QUERY SELECT true, 'skipped: no active pool'; RETURN;
  END IF;
  SELECT id INTO v_u1 FROM profiles LIMIT 1;
  SELECT id INTO v_u2 FROM profiles OFFSET 1 LIMIT 1;

  BEGIN
    /* A share the payer cannot deliver (the synthetic loser has no
       membership) is journalled back into the pool as a bbj_payout leg from
       the felt. It is not a mint: the pool's net outflow is the payout less
       what came back (2026-10-02). */
    SELECT COALESCE(sum(amount), 0) INTO v_back0 FROM chip_ledger
     WHERE created_at = now() AND category = 'bbj_payout'
       AND to_type = 'bbj_pool' AND to_entity_id = v_pool AND from_type <> 'bbj_pool';

    -- FULL hit: 100% of main, reserve funded and must reseed.
    UPDATE bbj_pools SET main_balance = 800, backup_balance = 5000 WHERE id = v_pool;
    SELECT * INTO r FROM bbj_atomic_payout_v2(v_pool, gen_random_uuid(), 999999881::bigint,
      100::numeric, v_u1, v_u2, ARRAY[]::uuid[], ARRAY[]::uuid[], '{"selftest":true}'::jsonb);
    paid_full := COALESCE(r.total_payout,0);
    SELECT main_balance, COALESCE(backup_balance,0) INTO m_full, b_full FROM bbj_pools WHERE id=v_pool;
    SELECT COALESCE(sum(amount), 0) INTO v_back1 FROM chip_ledger
     WHERE created_at = now() AND category = 'bbj_payout'
       AND to_type = 'bbj_pool' AND to_entity_id = v_pool AND from_type <> 'bbj_pool';

    -- PARTIAL hit: at most 85% of main, the reserve must not move, and the
    -- pool loses exactly what left it net of what came back. (The payer's
    -- state from the full hit above can lower what it pays here, so the
    -- self-test asserts conservation, not a fixed remainder.)
    UPDATE bbj_pools SET main_balance = 1000, backup_balance = 5000 WHERE id = v_pool;
    SELECT * INTO r FROM bbj_atomic_payout_v2(v_pool, gen_random_uuid(), 999999882::bigint,
      85::numeric, v_u1, v_u2, ARRAY[]::uuid[], ARRAY[]::uuid[], '{"selftest":true}'::jsonb);
    paid_part := COALESCE(r.total_payout,0);
    SELECT main_balance, COALESCE(backup_balance,0) INTO m_part, b_part FROM bbj_pools WHERE id=v_pool;
    SELECT COALESCE(sum(amount), 0) INTO v_back2 FROM chip_ledger
     WHERE created_at = now() AND category = 'bbj_payout'
       AND to_type = 'bbj_pool' AND to_entity_id = v_pool AND from_type <> 'bbj_pool';

    RAISE EXCEPTION 'SELFTEST-ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'SELFTEST-ROLLBACK' THEN GET STACKED DIAGNOSTICS err = MESSAGE_TEXT; END IF;
  END;

  back_full := COALESCE(v_back1 - v_back0, 0);
  back_part := COALESCE(v_back2 - v_back1, 0);

  IF err <> '' THEN
    RETURN QUERY SELECT false, 'selftest errored: ' || err;
  ELSIF paid_full > 800.005 THEN
    RETURN QUERY SELECT false, format('RESERVE FUNDED A PAYOUT: paid %s from a main of 800', paid_full);
  ELSIF back_full < 0 OR back_full > paid_full + 0.005 THEN
    RETURN QUERY SELECT false, format('RETURNED MORE THAN PAID on full hit: paid %s, returned %s', paid_full, back_full);
  ELSIF ABS((m_full + b_full) - (5800 - (paid_full - back_full))) > 0.005 THEN
    RETURN QUERY SELECT false, format('NOT CONSERVED on full hit: pool is %s, expected %s (paid %s, returned %s)',
                                      m_full + b_full, 5800 - (paid_full - back_full), paid_full, back_full);
  ELSIF ABS(m_full - back_full - 5000) > 0.005 OR ABS(b_full) > 0.005 THEN
    RETURN QUERY SELECT false, format('RESEED FAILED: after a 100%% hit main=%s backup=%s (returned %s), expected main=5000 backup=0',
                                      m_full, b_full, back_full);
  ELSIF ABS(b_part - 5000) > 0.005 THEN
    RETURN QUERY SELECT false, format('RESERVE MOVED ON A PARTIAL HIT: backup=%s, expected 5000', b_part);
  ELSIF paid_part > 850.005 OR back_part < 0 OR back_part > paid_part + 0.005 THEN
    RETURN QUERY SELECT false, format('PARTIAL HIT OVERPAID: paid %s (returned %s) from 85%% of a main of 1000', paid_part, back_part);
  ELSIF ABS((m_part + b_part) - (6000 - (paid_part - back_part))) > 0.005 THEN
    RETURN QUERY SELECT false, format('NOT CONSERVED on partial hit: pool is %s, expected %s (paid %s, returned %s)',
                                      m_part + b_part, 6000 - (paid_part - back_part), paid_part, back_part);
  ELSE
    RETURN QUERY SELECT true, format(
      'full hit: paid %s (returned %s), reserve reseeded main to %s; partial hit: paid %s (returned %s), reserve untouched',
      paid_full, back_full, m_full, paid_part, back_part);
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_bbj_selftest_payout_conservation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_selftest_payout_conservation() TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Retire the 1,800.00 stranded in the twelve orphan certification pools
-- ---------------------------------------------------------------------------

DO $retire$
DECLARE
  r record;
  v_n integer := 0;
  v_total numeric := 0;
  v_legs numeric;
BEGIN
  FOR r IN SELECT s.id, s.balance FROM public.spin_bonus_pools s
            WHERE s.club_id IS NOT NULL AND s.balance <> 0
              AND NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = s.club_id)
            ORDER BY s.id FOR UPDATE
  LOOP
    PERFORM public.fn_ca_declare_ledger('burn', 'chip_retirement', NULL, NULL,
                                        'cert-orphan-pool-retired:' || r.id::text);
    UPDATE public.spin_bonus_pools SET balance = 0 WHERE id = r.id;
    v_n := v_n + 1; v_total := v_total + r.balance;
  END LOOP;
  FOR r IN SELECT b.id, b.main_balance FROM public.bbj_pools b
            WHERE b.club_id IS NOT NULL AND COALESCE(b.main_balance, 0) <> 0
              AND NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = b.club_id)
            ORDER BY b.id FOR UPDATE
  LOOP
    PERFORM public.fn_ca_declare_ledger('burn', 'chip_retirement', NULL, NULL,
                                        'cert-orphan-pool-retired:' || r.id::text);
    UPDATE public.bbj_pools SET main_balance = 0 WHERE id = r.id;
    v_n := v_n + 1; v_total := v_total + r.main_balance;
  END LOOP;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);

  SELECT COALESCE(sum(amount), 0) INTO v_legs FROM public.chip_ledger
   WHERE idempotency_key LIKE 'cert-orphan-pool-retired:%' AND to_type = 'chip_retirement';
  IF v_n <> 12 OR v_total <> 1800.00 OR v_legs <> 1800.00 THEN
    RAISE EXCEPTION 'retire post-image: % pools, % retired, % journalled (expected 12, 1800.00, 1800.00)', v_n, v_total, v_legs;
  END IF;
  RAISE NOTICE 'retired % chips from % orphan certification pools', v_total, v_n;
END $retire$;

-- ---------------------------------------------------------------------------
-- 5. Proof, in savepoints rolled back: the door commits, a hand mint does not
-- ---------------------------------------------------------------------------

DO $proof$
DECLARE
  v_club uuid;
  v_st text; v_msg text;
  v_door text := 'not run'; v_hand text := 'not run'; v_test text := 'not run';
  v_res jsonb;
BEGIN
  SELECT id INTO v_club FROM public.clubs
   WHERE COALESCE(lifecycle_status, 'active') = 'active'
     AND COALESCE(asset, 'chips') <> 'diamonds'
   ORDER BY (name LIKE 'Crest Cert %') DESC, created_at LIMIT 1;

  BEGIN
    v_res := public.fn_ca_fund_club(v_club, 1.00, 'migration self-proof of the house door, rolled back',
                                    'fund-club-self-proof:' || gen_random_uuid()::text);
    SET CONSTRAINTS ALL IMMEDIATE;
    IF NOT EXISTS (SELECT 1 FROM public.ca_mint_ledger
                    WHERE chip_ledger_id = (v_res->>'ledger_id')::uuid
                      AND reason = 'migration self-proof of the house door, rolled back') THEN
      v_door := 'no register row with the reason';
    ELSE
      v_door := 'ok';
    END IF;
    RAISE EXCEPTION 'PROOF-ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_st = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg <> 'PROOF-ROLLBACK' THEN v_door := 'errored: ' || v_msg; END IF;
  END;

  BEGIN
    PERFORM set_config('app.ledger_category', 'mint', true);
    PERFORM set_config('app.ledger_counterparty', 'system_mint', true);
    PERFORM set_config('app.ledger_idempotency_key', 'hand-mint-self-proof:' || gen_random_uuid()::text, true);
    UPDATE public.clubs SET chip_treasury = COALESCE(chip_treasury, 0) + 1 WHERE id = v_club;
    SET CONSTRAINTS ALL IMMEDIATE;
    v_hand := 'COMMITTED';
    RAISE EXCEPTION 'PROOF-ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_st = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg LIKE 'REFUSED: house_issuance_without_its_door%' THEN
      v_hand := 'refused';
    ELSIF v_msg <> 'PROOF-ROLLBACK' THEN
      v_hand := 'errored: ' || v_msg;
    END IF;
  END;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);
  -- The self-test's own raw fixture writes are judged at commit and rolled
  -- back inside it; run it with the commit-time checks deferred, as it runs
  -- under fn_platform_invariants_health.
  SET CONSTRAINTS ALL DEFERRED;

  SELECT CASE WHEN t.ok THEN 'ok' ELSE t.detail END INTO v_test
    FROM public.fn_bbj_selftest_payout_conservation() t;

  IF v_door <> 'ok' OR v_hand <> 'refused' OR v_test <> 'ok' THEN
    RAISE EXCEPTION 'proof failed: door=% hand_mint=% bbj_selftest=%', v_door, v_hand, v_test;
  END IF;
  RAISE NOTICE 'proof: the house door commits with its reason; a hand-declared system_mint is refused; the BBJ self-test is green';
END $proof$;

COMMIT;

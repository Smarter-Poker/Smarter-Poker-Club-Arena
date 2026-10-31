-- 20261031184340_the_lightning_internal_pilot_is_retired_and_its_estate_retur.sql
--
-- OWNER INSTRUCTION (Dan, 2026-10-31, verbatim): "REMOVE THE LIGHTNING INTERNAL
-- PILOT, AND ANY AND ALL TRACES OF IT IF ITS NO LONGER NEEDED FOR ANYTHING."
-- On 2026-10-24 he had already ruled the pilot shut ("LIGHTNING GAMES WENT LIVE
-- IN MIDWAY UNION. THAT SHOULD BE SHUT DOWN."). Lightning lives in Midway Union.
--
-- What was still left of club 95087 (e14bc9f7...), read 2026-10-31 18:20 UTC:
--  - Nothing in play: 14 cash games dormant and disabled, 1,786 tables all
--    closed, no live seat, 1,680 tournaments all completed or cancelled, no
--    active schedule, the pilot assignment inactive since 2026-10-24 22:29 UTC,
--    no chip movement since 2026-10-25 08:35 UTC. All 237 rakeback periods
--    are paid and both settlement periods closed, so nobody is owed anything.
--  - Still switched on: its Diamond Spin wheel and four Diamond games.
--  - Its chips, exactly 100,000.00 in all: bank 77,367.48, promo 436.02,
--    member wallets 20,585.66 (144 active horses, 47 suspended horses and the
--    KingFish account's 50.00), BBJ main 969.84 and backup 435.28, Spin pool
--    205.72. No agent, credit, held, locked, promo-member or diamond balance.
--  - 193 memberships, which is why the card still showed "146 members" in the
--    lobby for anyone who belongs to it.
--
-- What this does, in one transaction:
--  1. Switches the wheel and the four Diamond games off.
--  2. Returns every member wallet to the club's main bank, one keyed
--     club_bank_claim leg each (the fn_club_bank_claim_core contract, and the
--     owner's standing rule that chips of a removed holder go back to the bank).
--  3. Retires the BBJ and Spin stores, then the bank and the promo wallet, to
--     the Mint: each balance delta is journaled to chip_retirement, the shape the
--     retirement door itself uses for an opening grant (20261002152925) and for a
--     retired club's seeded stores (20261002021610). The chips were minted for
--     this club (the 100,000 opening grant), so retiring them is net zero.
--  4. Retires the club through the original retained-record authority
--     (fn_retire_settled_club_core_20260906) as its owner, the platform service
--     identity "Smarter.Poker Official" (CLAUDE.md 10.10 rule 2). That door
--     rechecks every balance and obligation, flips lifecycle_status to retired,
--     sets is_public false, writes the audit trail and the identity events, so
--     every member surface drops the card (ClubsService already filters retired
--     clubs out of the lobby). Records are retained, as for every retired club.
--
-- Probed in self-aborting DO blocks on production at 18:40-18:50 UTC with SET
-- CONSTRAINTS ALL IMMEDIATE: ledger 192 club_bank_claim legs = 20,585.66 and
-- chip_retirement legs = 100,000.00 (bank 97,953.14, promo 436.02, BBJ
-- 1,405.12, Spin 205.72); the core returned success; impact after = all zero;
-- every deferred ledger check passed; 7 to 11 s end to end, holding locks only
-- on this club's own rows.
--
-- The pilot's code, tooling, workflows and its two tables and eight functions
-- are removed by the follow-up change; this file only settles and retires the
-- club. Replay-safe: refuses if its bank leg or its record already exists.
--
-- @live-proof: EXISTS (SELECT 1 FROM public.clubs WHERE id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d' AND lifecycle_status = 'retired' AND NOT is_public AND chip_treasury = 0 AND promo_balance = 0) AND NOT EXISTS (SELECT 1 FROM public.club_members WHERE club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d' AND chip_balance <> 0) AND EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key = 'lightning-internal-pilot-retired-20261031:bank' AND to_type = 'chip_retirement') AND EXISTS (SELECT 1 FROM public.financial_alerts WHERE source = 'lightning-internal-pilot-retired-20261031' AND (context->>'ledger_retired')::numeric = 100000.00)

BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '90s';

DO $retire$
DECLARE
 c        constant uuid := 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';  -- Lightning Internal Pilot, club 95087
 c_owner  constant uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';  -- Smarter.Poker Official, the platform identity that owns it
 c_op     constant text := 'lightning-internal-pilot-retired-20261031';
 c_corr   constant uuid := '5e1f0d2a-95c8-4b7e-9e31-310a20261031';
 c_reason constant text := 'Owner 2026-10-31: remove the Lightning Internal Pilot. Lightning runs live in Midway Union; the pilot is no longer needed for anything.';
 v_club public.clubs%ROWTYPE;
 r record;
 v_estate_before numeric;
 v_members_moved numeric := 0;
 v_members_n int := 0;
 v_bbj public.bbj_pools%ROWTYPE;
 v_spin numeric := 0;
 v_burn_treasury numeric;
 v_burn_promo numeric;
 v_burn_pools numeric := 0;
 v_retired_by_ledger numeric;
 v_impact jsonb;
 v_result jsonb;
 v_keys text[] := ARRAY[]::text[];
BEGIN
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PILOT_RETIREMENT_PLATFORM_FROZEN'; END IF;
 IF EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key = c_op || ':bank')
    OR EXISTS (SELECT 1 FROM public.financial_alerts WHERE source = c_op) THEN
  RAISE EXCEPTION 'PILOT_RETIREMENT_ALREADY_APPLIED';
 END IF;

 -- The club, locked first, exactly as the retirement door orders its locks.
 PERFORM pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:' || c::text, 0));
 SELECT * INTO v_club FROM public.clubs WHERE id = c FOR UPDATE;
 IF NOT FOUND OR v_club.club_id <> 95087 OR v_club.name <> 'Lightning Internal Pilot'
    OR v_club.owner_id <> c_owner OR v_club.lifecycle_status <> 'active'
    OR v_club.union_id IS NOT NULL OR coalesce(v_club.is_union, false) THEN
  RAISE EXCEPTION 'PILOT_RETIREMENT_CLUB_NOT_AS_QUALIFIED';
 END IF;

 -- Nothing may be in play: no open table, live seat, unfinished tournament,
 -- enabled cash game, active schedule or pending game command.
 IF EXISTS (SELECT 1 FROM public.tables t WHERE t.club_id = c AND coalesce(t.is_deleted, false) = false
             AND lower(coalesce(t.status::text, '')) NOT IN ('closed', 'deleted'))
    OR EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id = s.table_id
                WHERE t.club_id = c AND s.left_at IS NULL)
    OR EXISTS (SELECT 1 FROM public.tournaments t WHERE t.club_id = c
                AND lower(coalesce(t.status::text, '')) NOT IN ('completed', 'cancelled', 'canceled'))
    OR EXISTS (SELECT 1 FROM public.cash_games g WHERE g.club_id = c AND (g.enabled OR g.state <> 'dormant'))
    OR EXISTS (SELECT 1 FROM public.tournament_schedules s WHERE s.club_id = c AND s.active)
    OR EXISTS (SELECT 1 FROM public.lightning_pilot_assignment a WHERE a.club_id = c AND a.active) THEN
  RAISE EXCEPTION 'PILOT_RETIREMENT_SOMETHING_IS_STILL_IN_PLAY';
 END IF;

 -- The whole chip estate before: bank, promo, every member wallet, BBJ, Spin.
 SELECT coalesce(v_club.chip_treasury, 0) + coalesce(v_club.promo_balance, 0)
      + coalesce(v_club.chip_pool, 0) + coalesce(v_club.insurance_balance, 0)
      + (SELECT coalesce(sum(coalesce(chip_balance, 0)), 0) FROM public.club_members WHERE club_id = c)
      + (SELECT coalesce(sum(main_balance + backup_balance + promo_balance), 0) FROM public.bbj_pools WHERE club_id = c)
      + (SELECT coalesce(sum(balance), 0) FROM public.spin_bonus_pools WHERE club_id = c)
   INTO v_estate_before;
 IF v_estate_before <> 100000.00 THEN
  RAISE EXCEPTION 'PILOT_RETIREMENT_ESTATE_CHANGED %', v_estate_before;
 END IF;
 IF coalesce(v_club.chip_pool, 0) <> 0 OR coalesce(v_club.insurance_balance, 0) <> 0
    OR EXISTS (SELECT 1 FROM public.club_members WHERE club_id = c
                AND (coalesce(held_chips, 0) <> 0 OR coalesce(locked_chips, 0) <> 0
                  OR coalesce(promo_balance, 0) <> 0 OR coalesce(credit_used, 0) <> 0
                  OR coalesce(diamonds, 0) <> 0 OR coalesce(chip_balance, 0) < 0))
    OR EXISTS (SELECT 1 FROM public.agents WHERE club_id = c)
    OR EXISTS (SELECT 1 FROM public.club_wallets WHERE club_id = c AND coalesce(chip_balance, 0) <> 0) THEN
  RAISE EXCEPTION 'PILOT_RETIREMENT_UNEXPECTED_HOLDING';
 END IF;

 -- 1. Switch off the club's Diamond Spin wheel and its four Diamond games.
 UPDATE public.wheel_configs SET enabled = false, updated_at = now()
  WHERE host_kind = 'club' AND host_id = c AND enabled;
 UPDATE public.diamond_game_configs SET enabled = false
  WHERE host_kind = 'club' AND host_id = c AND enabled;

 -- 2. Every member's chips go back to the club's main bank, one keyed leg
 --    each, the same contract as fn_club_bank_claim_core (the wallet journal
 --    writes the leg with the bank as counterparty; the bank side stands down).
 FOR r IN SELECT m.user_id, m.chip_balance FROM public.club_members m
           WHERE m.club_id = c AND coalesce(m.chip_balance, 0) > 0
           ORDER BY m.user_id FOR UPDATE OF m
 LOOP
  PERFORM public.fn_ca_declare_ledger('club_bank_claim', 'club_treasury', c, NULL,
    c_op || ':member:' || r.user_id::text, ARRAY['clubs']);
  v_keys := v_keys || (c_op || ':member:' || r.user_id::text);
  PERFORM set_config('app.ledger_correlation', c_corr::text, true);
  UPDATE public.club_members SET chip_balance = 0, updated_at = now()
   WHERE club_id = c AND user_id = r.user_id;
  UPDATE public.clubs SET chip_treasury = chip_treasury + r.chip_balance, updated_at = now()
   WHERE id = c;
  PERFORM set_config('app.ledger_autoskip_clubs', '', true);
  INSERT INTO public.chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  SELECT c, r.user_id, c_owner, r.chip_balance, 'club_bank_claim',
         'Lightning Internal Pilot Retired: Wallet Returned To The Club Bank',
         jsonb_build_object('op_id', c_op || ':member:' || r.user_id::text, 'source', 'player_wallet',
           'destination', 'club_bank', 'direction', 'into_bank', 'reason', 'club_retirement',
           'correlation', c_corr, 'holder_balance_after', 0, 'bank_after', cl.chip_treasury),
         cl.chip_treasury
    FROM public.clubs cl WHERE cl.id = c;
  v_members_moved := v_members_moved + r.chip_balance;
  v_members_n := v_members_n + 1;
 END LOOP;

 -- 3. The BBJ and Spin stores retire straight to the Mint, the established
 --    shape for a retired club's seeded child stores (20261002021610):
 --    each balance delta is journaled to chip_retirement.
 SELECT * INTO v_bbj FROM public.bbj_pools WHERE club_id = c FOR UPDATE;
 IF FOUND THEN
  IF public.fn_bbj_parked_reserve(v_bbj.id, 'main') <> 0
     OR public.fn_bbj_parked_reserve(v_bbj.id, 'backup') <> 0 THEN
   RAISE EXCEPTION 'PILOT_RETIREMENT_BBJ_PARKED_RESERVE';
  END IF;
  IF v_bbj.main_balance <> 0 THEN
   PERFORM public.fn_ca_declare_ledger('burn', 'chip_retirement', NULL, NULL, c_op || ':bbj-main', NULL);
   v_keys := v_keys || (c_op || ':bbj-main');
   UPDATE public.bbj_pools SET main_balance = 0, updated_at = now() WHERE id = v_bbj.id;
  END IF;
  IF v_bbj.backup_balance <> 0 THEN
   PERFORM public.fn_ca_declare_ledger('burn', 'chip_retirement', NULL, NULL, c_op || ':bbj-backup', NULL);
   v_keys := v_keys || (c_op || ':bbj-backup');
   UPDATE public.bbj_pools SET backup_balance = 0, updated_at = now() WHERE id = v_bbj.id;
  END IF;
  IF v_bbj.promo_balance <> 0 THEN
   PERFORM public.fn_ca_declare_ledger('burn', 'chip_retirement', NULL, NULL, c_op || ':bbj-promo', NULL);
   v_keys := v_keys || (c_op || ':bbj-promo');
   UPDATE public.bbj_pools SET promo_balance = 0, updated_at = now() WHERE id = v_bbj.id;
  END IF;
  v_burn_pools := v_bbj.main_balance + v_bbj.backup_balance + v_bbj.promo_balance;
 END IF;
 FOR r IN SELECT id, balance FROM public.spin_bonus_pools WHERE club_id = c AND balance <> 0 ORDER BY id FOR UPDATE
 LOOP
  PERFORM public.fn_ca_declare_ledger('burn', 'chip_retirement', NULL, NULL, c_op || ':spin:' || r.id::text, NULL);
  v_keys := v_keys || (c_op || ':spin:' || r.id::text);
  UPDATE public.spin_bonus_pools SET balance = 0 WHERE id = r.id;
  v_spin := v_spin + r.balance;
 END LOOP;
 v_burn_pools := v_burn_pools + v_spin;

 -- 4. The main bank and the promo wallet retire to the Mint (the retirement
 --    door's own opening-grant burn, 20261002152925).
 SELECT chip_treasury, promo_balance INTO v_burn_treasury, v_burn_promo
   FROM public.clubs WHERE id = c FOR UPDATE;
 PERFORM public.fn_ca_declare_ledger('burn', 'chip_retirement', NULL, NULL, c_op || ':bank', NULL);
 v_keys := v_keys || (c_op || ':bank');
 UPDATE public.clubs SET chip_treasury = 0, updated_at = clock_timestamp() WHERE id = c;
 PERFORM set_config('app.ledger_category', '', true);
 PERFORM set_config('app.ledger_counterparty', '', true);
 IF v_burn_promo <> 0 THEN
  PERFORM public.fn_ca_declare_ledger('burn', 'chip_retirement', NULL, NULL, c_op || ':promo', NULL);
  v_keys := v_keys || (c_op || ':promo');
  UPDATE public.clubs SET promo_balance = 0, updated_at = clock_timestamp() WHERE id = c;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
 END IF;

 -- Conservation: everything that was there is now either retired to the Mint
 -- or, for members, passed through the bank on the way.
 IF v_burn_treasury + v_burn_promo + v_burn_pools <> v_estate_before
    OR v_burn_treasury <> v_club.chip_treasury + v_members_moved THEN
  RAISE EXCEPTION 'PILOT_RETIREMENT_CONSERVATION % % % % %',
    v_estate_before, v_burn_treasury, v_burn_promo, v_burn_pools, v_members_moved;
 END IF;
 SELECT coalesce(sum(amount), 0) INTO v_retired_by_ledger FROM public.chip_ledger
  WHERE idempotency_key = ANY (v_keys) AND to_type = 'chip_retirement';
 IF v_retired_by_ledger <> v_estate_before THEN
  RAISE EXCEPTION 'PILOT_RETIREMENT_LEDGER_DISAGREES % %', v_retired_by_ledger, v_estate_before;
 END IF;

 -- 5. Retire the club through the original retained-record authority, as the
 --    club's owner (the platform service identity, CLAUDE.md 10.10 rule 2). It
 --    rechecks every balance and obligation, writes the audit trail, flips the
 --    lifecycle, hides the club (is_public false) and emits the identity
 --    event that makes every member surface drop the card.
 PERFORM set_config('request.jwt.claims',
   jsonb_build_object('sub', c_owner, 'role', 'authenticated')::text, true);
 PERFORM set_config('request.jwt.claim.sub', c_owner::text, true);
 v_impact := public.fn_club_retirement_impact(c);
 v_result := public.fn_retire_settled_club_core_20260906(c, 'Lightning Internal Pilot', c_reason);
 IF coalesce((v_result ->> 'success')::boolean, false) IS NOT TRUE
    OR coalesce((v_result ->> 'already_retired')::boolean, true) THEN
  RAISE EXCEPTION 'PILOT_RETIREMENT_REFUSED % %', v_result, v_impact;
 END IF;
 FOR r IN SELECT DISTINCT cm.user_id FROM public.club_members cm WHERE cm.club_id = c LOOP
  PERFORM public.fn_emit_game_management_event(
    'club_identity_changed', c, NULL, r.user_id, 'club', c, NULL,
    jsonb_build_object('operation', 'retire', 'lifecycle_status', 'retired', 'records_retained', true));
 END LOOP;
 PERFORM set_config('request.jwt.claims', '', true);
 PERFORM set_config('request.jwt.claim.sub', '', true);

 SET CONSTRAINTS ALL IMMEDIATE;

 INSERT INTO public.financial_alerts(severity, source, message, context, resolved, resolved_at, resolution)
 VALUES ('info', c_op, 'Lightning Internal Pilot Retired; Its Whole Estate Returned To The Mint',
   jsonb_build_object('club', c, 'club_number', 95087, 'estate', v_estate_before,
     'members_returned_to_bank', v_members_moved, 'member_wallets', v_members_n,
     'bank_retired', v_burn_treasury, 'promo_retired', v_burn_promo, 'pools_retired', v_burn_pools,
     'ledger_retired', v_retired_by_ledger, 'impact_at_retirement', v_impact, 'result', v_result),
   true, now(), c_reason);

 RAISE NOTICE 'pilot retired: estate %, members % (%), bank %, promo %, pools %',
   v_estate_before, v_members_moved, v_members_n, v_burn_treasury, v_burn_promo, v_burn_pools;
END $retire$;

COMMIT;

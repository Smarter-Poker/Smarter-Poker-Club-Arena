-- 20261007000010_the_diamond_arena_spawns_the_midway_schedule.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ============================================================================
-- THE DIAMOND ARENA RUNS THE MIDWAY UNION'S TOURNAMENT SCHEDULE AND RAKE
-- ============================================================================
--
-- OWNER RULING (Dan, 2026-10-06 13:09 CT, verbatim):
--   "USE THE SAME TOURNAMENT SCHEDULE AND RAKE AS THE MIDWAY UNION FOR NOW"
-- for the Diamond Arena (club 002c2d27-9584-4e52-835a-bb2be148fc81, asset
-- diamonds, union_id NULL). Midway Union (fade0000-...-0001) has 63 active
-- tournament_schedules rows; a later step seeds them for the arena. This file
-- is the DATABASE half that lets those rows spawn real, correctly priced and
-- correctly funded Diamond events. It seeds no schedule row and mints nothing.
--
-- DECISIONS IT IMPLEMENTS (made before this file; not re-opened here):
--   * Fee: Midway's 10% of the entry total, 5% when the field is capped at 2,
--     rounded DOWN to a whole Diamond (so a 3 or 5 Diamond entry pays 0). The
--     rule the creation door already runs, unchanged.
--   * Scale: 1 chip = 1 Diamond (a 100 guarantee is 100 Diamonds).
--   * Guarantees: backed by ca_diamond_house through the earmark ledger
--     ca_diamond_house_earmarks, set aside at creation (A7), refused at
--     creation by the A4/A5 caps and by fn_ca_diamond_house_available() (A8),
--     covering the prize pool only (A6). A schedule row seeded under Dan's
--     ruling is the platform-admin authority (A9) for every guarantee it spawns.
--   * Freerolls: offered exactly as Midway runs them - 0 to enter, a guarantee,
--     rebuy and add-on at 1 Diamond each, 100% to the prize pool. Dan's ruling
--     supersedes the recorded A11 answer "none_offered"; this file appends the
--     new answer to ca_diamond_economics with that reason.
--   * Bounties: a bounty that is not a whole Diamond (Midway's 2.5, 6.75) is
--     rounded DOWN on the scheduled door; the remainder stays in the prize part.
--   * No rakeback, no agents, no unions in the arena. Nothing here reads
--     is_horse: a horse registers, rebuys and is paid through the same doors.
--
-- WHAT CHANGES
--   1. fn_poker_diamond_create_tournament_core(p_config, p_authority): the
--      live creation door's body (md5 05e4ae642e1a3949da8bb34bc62f7f3d) with
--      every validation kept, made the core of two doors:
--        fn_poker_diamond_create_tournament(jsonb)  - the staff door, same
--          authority (platform admin + live session), same audit row;
--        fn_poker_diamond_spawn_scheduled_tournament(uuid, timestamptz, jsonb)
--          - NEW, service_role only, idempotent per (schedule, start).
--   2. The guarantee's live path (no sweep, no repair job - CLAUDE.md 10.12):
--        creation  opens a 'guarantee:<id>' earmark for max(guarantee,
--                  satellite seats x target ticket) BEFORE the row exists;
--        insert    trg_tournaments_guarantee_affordable and the readiness
--                  contract read that earmark instead of a chip bank;
--        lock      fn_ca_fund_overlay_on_lock pays the shortfall from the house
--                  into the entry custody (fn_poker_diamond_tournament_settle_
--                  overlay), records the earmark 'pay' and releases the rest;
--        pool close fn_apply_prize_guarantee's excess-return step brings a
--                  Diamond pool to exactly max(guarantee, collected) through
--                  the same function (excess back to the house);
--        cancel/complete release whatever is still earmarked.
--      Two ledger kinds, 'overlay' and 'overlay_return', carry those legs with
--      the shape a Spin's reserve legs already have; the escrow reader, the
--      shadow, the drain and the refund door learn them.
--   3. Freeroll entry: the human and horse registration cores give a 0-charge
--      Diamond entry an active zero-balance custody row
--      (fn_poker_diamond_tournament_free_entry), so the seat guards admit the
--      seat and a 1-Diamond rebuy or add-on has an entry to land in; the refund
--      door releases such an entry at zero.
--
-- p_config KEYS THE SCHEDULED DOOR READS (the creation door's shape, plus the
-- keys Midway's schedule configs carry). Money keys must be whole Diamonds.
--   name, type ('mtt','bounty','progressive_bounty','mystery_bounty',
--     'satellite','sng'; 'spin' is refused on this door), gameVariant ('nlh',
--     'plo'='plo4','plo5','plo6','plo8','short_deck','flh','flo8'),
--   buyIn          the SNAPPED entry TOTAL in Diamonds (0 = freeroll); the
--                  fee is derived from it (10%, 5% at a 2-seat cap, floored),
--   guaranteedPrize | guarantee   whole Diamonds (both spellings; may not differ),
--   isRebuy | rebuy, isReentry | reentry (defaults to rebuy),
--   addOnAvailable | addOn, rebuyCost, addonCost | addOnCost (default buyIn;
--                  forced to 1 on a freeroll), rebuyChips, addonChips |
--                  addOnChips, rebuyLevels, addonLevels | addOnLevels,
--                  maxRebuys, maxReentries (absent = unlimited, Midway's spawn),
--   bountyAmount   floored to a whole Diamond, 1..buy-in after fee,
--   mysteryBountyMin, mysteryBountyMax, mysteryBounty {activation, ...},
--   satelliteTargetId (uuid of a Diamond MTT that starts later), satelliteSeats,
--   blindStructure, payoutStructure (arrays; the engine resolves presets),
--   startingStack, tableSize, maxPlayers, minPlayers, payoutPercent,
--   lateRegistrationLevels | lateRegLevels, actionTimeSeconds, shortDescription,
--   isFeatured, bubbleProtection, finalTableDealEnabled, bigBlindAnte.
-- startTime is ignored on this door: the event starts at p_scheduled_start.
-- Refused: freeBuy true, addOnFromStart, any spin key.
--
-- RETURNS {ok:true, tournament_id, replayed, buy_in_amount, buy_in_fee,
-- bounty_amount, guaranteed_prize} | {ok:true, tournament_id, replayed:true}
-- | {ok:false, reason[, detail, sqlstate]}. Reasons include service_role_only,
-- invalid_request, schedule_not_found, schedule_not_active,
-- schedule_is_not_a_diamond_arena_schedule, diamond_tournaments_not_open,
-- scheduled_occurrence_already_on_the_board, diamond_house_cannot_set_aside,
-- diamond_guarantee_over_per_event_cap, diamond_guarantee_over_outstanding_cap,
-- and every validation reason of the creation door.
--
-- PROVED on an isolated PostgreSQL 17 by tests/sql/run-diamond-scheduled-
-- tournaments.py, which loads the live bodies this file substitutes into
-- (each pinned by md5 below), applies this file verbatim and drives the money
-- through the real doors inside its private cluster. Never against production.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. PRE-IMAGE: every body this file redefines is the one it was written on.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_poker_diamond_create_tournament(jsonb)', '05e4ae642e1a3949da8bb34bc62f7f3d'),
    ('public.fn_poker_diamond_tournament_escrow(uuid)', 'd31432344bd1e28904416f5924b75670'),
    ('public.fn_poker_diamond_tournament_open_shadow(uuid)', 'a48dc93434b566767bf9baa0f63abee4')
  ) AS t(sig, pin) LOOP
    IF md5(pg_get_functiondef(r.sig::regprocedure)) <> r.pin THEN
      RAISE EXCEPTION 'pre-image: % moved off %', r.sig, r.pin;
    END IF;
  END LOOP;
  IF to_regclass('public.ca_diamond_house_earmarks') IS NULL
     OR to_regclass('public.ca_diamond_economics') IS NULL THEN
    RAISE EXCEPTION 'pre-image: the earmark ledger and the economics table must exist';
  END IF;
  IF public.fn_ca_diamond_economic_text('guarantee_funding_moment') <> 'set_aside_at_creation'
     OR public.fn_ca_diamond_economic_text('guarantee_overlay_account') <> 'ca_diamond_house'
     OR public.fn_ca_diamond_economic_text('guarantee_covers') <> 'prize_pool_only' THEN
    RAISE EXCEPTION 'pre-image: the guarantee answers this file implements are not the recorded ones';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_diamond_house_earmarks) THEN
    RAISE EXCEPTION 'pre-image: the earmark ledger already holds rows';
  END IF;
END $pre$;

-- ---------------------------------------------------------------------------
-- 1. EVERY NEW MONEY FUNCTION IS REGISTERED BEFORE IT EXISTS.
-- ---------------------------------------------------------------------------
INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_poker_diamond_create_tournament_core', 'approved', 'Diamond tournament creation core (staff and scheduled doors); opens the guarantee earmark; moves no Diamond'),
  ('fn_poker_diamond_spawn_scheduled_tournament', 'approved', 'service_role door: spawns a Diamond Arena tournament_schedules occurrence through the creation core; idempotent per (schedule, start); receipt in ca_diamond_scheduled_spawns'),
  ('fn_poker_diamond_tournament_settle_overlay', 'approved', 'moves a guarantee overlay house <-> entry custody: house burn/mint + player-registered journal, movement and overlay ledger rows; asserts custody = banks'),
  ('fn_poker_diamond_guarantee_release', 'system', 'releases an open guarantee earmark; moves no Diamond'),
  ('fn_poker_diamond_tournament_free_entry', 'approved', 'opens a zero-balance active Diamond freeroll entry custody row; moves no Diamond'),
  ('fn_poker_diamond_tournament_effective_guarantee', 'system', 'reads an event''s guarantee or satellite seat promise'),
  ('fn_ca_diamond_scheduled_spawns_append_only', 'system', 'append-only guard')
ON CONFLICT (proname) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. A11 IS ANSWERED AGAIN, BY THE OWNER
-- ---------------------------------------------------------------------------
-- 'none_offered' (recorded 2026-10-05 by the destinations lane) is superseded by
-- Dan's ruling: Midway's freerolls offer a 1-Diamond rebuy and a 1-Diamond
-- add-on, all of it to the prize pool. The table is append-only; the new
-- answer is a new row and the old rows stay as the record.
ALTER TABLE public.ca_diamond_economics
  DROP CONSTRAINT ca_diamond_economics_choice_is_an_option,
  ADD CONSTRAINT ca_diamond_economics_choice_is_an_option CHECK (
    units <> 'choice' OR CASE name
      WHEN 'guarantee_covers'               THEN value_text IN ('prize_pool_only','prize_pool_and_bounties')
      WHEN 'guarantee_funding_moment'       THEN value_text IN ('set_aside_at_creation','checked_at_creation_paid_at_close')
      WHEN 'freeroll_rebuy_cost'            THEN value_text IN ('none_offered','one_diamond_to_the_prize_pool')
      WHEN 'freeroll_addon_cost'            THEN value_text IN ('none_offered','one_diamond_to_the_prize_pool')
      WHEN 'promo_entry_refund_destination' THEN value_text IN ('funding_account','unused_promotional_entry','player_wallet')
      WHEN 'horse_entry_funding'            THEN value_text IN ('own_balance','funding_account')
      WHEN 'cash_rake_rounding'             THEN value_text IN ('down','nearest','up')
      ELSE false
    END
  );
INSERT INTO public.ca_diamond_economics
  (name, scope, value, value_text, units, approved_quote, basis, approved_on, recorded_by)
VALUES
  ('freeroll_rebuy_cost', 'all', NULL, 'one_diamond_to_the_prize_pool', 'choice',
   'USE THE SAME TOURNAMENT SCHEDULE AND RAKE AS THE MIDWAY UNION FOR NOW',
   'Dan 2026-10-06: same tournament schedule and rake as the Midway Union. Midway''s four daily $100 freerolls (tournament_schedules, union fade0000-0000-0000-0000-000000000001) carry rebuyCost 1 and "100% Of $1 Rebuys And $1 Add-Ons Are Added To The Prize Pool"; at 1 chip = 1 Diamond that is a 1-Diamond rebuy, no fee. Supersedes the 2026-10-05 answer none_offered.',
   DATE '2026-10-06', 'claude-code:diamond-scheduled-tournaments-db'),
  ('freeroll_addon_cost', 'all', NULL, 'one_diamond_to_the_prize_pool', 'choice',
   'USE THE SAME TOURNAMENT SCHEDULE AND RAKE AS THE MIDWAY UNION FOR NOW',
   'Dan 2026-10-06: same tournament schedule and rake as the Midway Union. Midway''s freerolls carry addonCost 1, wholly to the prize pool; at 1 chip = 1 Diamond that is a 1-Diamond add-on, no fee. Supersedes the 2026-10-05 answer none_offered.',
   DATE '2026-10-06', 'claude-code:diamond-scheduled-tournaments-db');

-- ---------------------------------------------------------------------------
-- 3. THE LEDGER LEARNS TWO KINDS: THE HOUSE'S OVERLAY IN, AND ITS RETURN
-- ---------------------------------------------------------------------------
-- An 'overlay' row is the house paying part of a guarantee into one entry's
-- custody; an 'overlay_return' row is overlay the entries made unnecessary
-- going back. Both are prize-bank legs with the shape a Spin's reserve legs
-- already have: a player, the custody row and the journal row, all prize.
ALTER TABLE public.poker_diamond_tournament_ledger
  DROP CONSTRAINT poker_diamond_tournament_ledger_kind_check,
  ADD CONSTRAINT poker_diamond_tournament_ledger_kind_check CHECK (kind = ANY (ARRAY[
    'entry','rebuy','reentry','addon','prize','bounty','fee','refund',
    'spin_underwrite','spin_surplus','overlay','overlay_return'])),
  DROP CONSTRAINT poker_diamond_tournament_ledger_outflow,
  ADD CONSTRAINT poker_diamond_tournament_ledger_outflow CHECK (
    ((kind = ANY (ARRAY['prize','bounty','refund'])) AND (user_id IS NOT NULL))
    OR ((kind = 'fee') AND (user_id IS NULL) AND (prize_part = 0) AND (bounty_part = 0))
    OR (kind = ANY (ARRAY['entry','rebuy','reentry','addon']))
    OR ((kind = ANY (ARRAY['spin_underwrite','spin_surplus','overlay','overlay_return']))
        AND (user_id IS NOT NULL) AND (custody_id IS NOT NULL) AND (wallet_journal_id IS NOT NULL)
        AND (prize_part = amount) AND (bounty_part = 0) AND (fee_part = 0)));

-- ---------------------------------------------------------------------------
-- 4. THE BANKS COUNT THE OVERLAY
-- ---------------------------------------------------------------------------
-- The prize bank is every prize part in, plus overlay in, less overlay
-- returned, less what was paid and refunded. overlay_in reports the net
-- overlay, which is also the chip escrow's convention (fn_ca_escrow_apply adds
-- overlay_in to prize_balance), so fn_ca_tournament_escrow passes it through
-- unchanged.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_escrow(p_tournament_id uuid)
 RETURNS TABLE(prize_in numeric, bounty_in numeric, fee_in numeric, overlay_in numeric, satellite_in numeric, prize_out numeric, bounty_out numeric, fee_out numeric, refund_out numeric, prize_balance numeric, bounty_balance numeric, fee_balance numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH l AS (
    SELECT
      COALESCE(sum(prize_part)  FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS prize_in,
      COALESCE(sum(bounty_part) FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS bounty_in,
      COALESCE(sum(fee_part)    FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS fee_in,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'prize'),0)  AS prize_out,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'bounty'),0) AS bounty_out,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'fee'),0)    AS fee_out,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'refund'),0) AS refund_out,
      COALESCE(sum(prize_part)  FILTER (WHERE kind = 'refund'),0) AS refund_prize,
      COALESCE(sum(bounty_part) FILTER (WHERE kind = 'refund'),0) AS refund_bounty,
      COALESCE(sum(fee_part)    FILTER (WHERE kind = 'refund'),0) AS refund_fee,
      -- DIAMOND PHASE 9: a Spin's reserve legs move its prize bank, whole.
      COALESCE(sum(amount)      FILTER (WHERE kind = 'spin_underwrite'),0) AS spin_underwrite,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'spin_surplus'),0) AS spin_surplus,
      -- 2026-10-06: a guarantee's overlay legs move it too, whole.
      COALESCE(sum(amount)      FILTER (WHERE kind = 'overlay'),0) AS overlay,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'overlay_return'),0) AS overlay_return
    FROM public.poker_diamond_tournament_ledger WHERE tournament_id = p_tournament_id)
  SELECT prize_in::numeric, bounty_in::numeric, fee_in::numeric, (overlay - overlay_return)::numeric, 0::numeric,
         prize_out::numeric, bounty_out::numeric, fee_out::numeric, refund_out::numeric,
         (prize_in + spin_underwrite - spin_surplus + overlay - overlay_return - prize_out - refund_prize)::numeric,
         (bounty_in - bounty_out - refund_bounty)::numeric,
         (fee_in - fee_out - refund_fee)::numeric
  FROM l;
$function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_escrow(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_tournament_escrow(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_open_shadow(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE l record; v_x record;
BEGIN
  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;
  SELECT
    COALESCE(sum(prize_part)  FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS prize_in,
    COALESCE(sum(bounty_part) FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS bounty_in,
    COALESCE(sum(fee_part)    FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS fee_in,
    COALESCE(sum(amount)      FILTER (WHERE kind = 'prize'),0)  AS prize_out,
    COALESCE(sum(amount)      FILTER (WHERE kind = 'bounty'),0) AS bounty_out,
    COALESCE(sum(amount)      FILTER (WHERE kind = 'fee'),0)    AS fee_out,
    COALESCE(sum(prize_part)  FILTER (WHERE kind = 'refund'),0) AS refund_prize,
    COALESCE(sum(bounty_part) FILTER (WHERE kind = 'refund'),0) AS refund_bounty,
    COALESCE(sum(fee_part)    FILTER (WHERE kind = 'refund'),0) AS refund_fee,
    -- DIAMOND PHASE 9: a Spin's reserve legs, the chip escrow's reserve_in and reserve_out.
    COALESCE(sum(amount)      FILTER (WHERE kind = 'spin_underwrite'),0) AS spin_underwrite,
    COALESCE(sum(amount)      FILTER (WHERE kind = 'spin_surplus'),0) AS spin_surplus,
    -- 2026-10-06: a guarantee's overlay legs, the chip escrow's overlay_in (net).
    COALESCE(sum(amount)      FILTER (WHERE kind = 'overlay'),0)
      - COALESCE(sum(amount)  FILTER (WHERE kind = 'overlay_return'),0) AS overlay
    INTO l
    FROM public.poker_diamond_tournament_ledger WHERE tournament_id = p_tournament_id;
  INSERT INTO public.tournament_escrow
    (tournament_id, enforced, gross_in, fee_entries_in, satellite_fee_in, bounty_in, overlay_in, satellite_in,
     prize_out, bounty_out, fee_out, refund_prize, refund_bounty, refund_fee, reserve_out, reserve_in,
     prize_balance, bounty_balance, fee_balance, opened_from)
  VALUES
    (p_tournament_id, true, l.prize_in + l.bounty_in + l.fee_in, l.fee_in, 0, l.bounty_in, l.overlay, 0,
     l.prize_out, l.bounty_out, l.fee_out, l.refund_prize, l.refund_bounty, l.refund_fee, l.spin_surplus, l.spin_underwrite,
     l.prize_in - l.prize_out - l.refund_prize - l.spin_surplus + l.spin_underwrite + l.overlay, l.bounty_in - l.bounty_out - l.refund_bounty,
     l.fee_in - l.fee_out - l.refund_fee, 'diamond terminal shadow (from the Diamond ledger)')
  ON CONFLICT (tournament_id) DO NOTHING;
  SELECT x.* INTO v_x FROM public.tournament_escrow x WHERE x.tournament_id = p_tournament_id;
  IF v_x.prize_balance IS DISTINCT FROM (l.prize_in - l.prize_out - l.refund_prize - l.spin_surplus + l.spin_underwrite + l.overlay)::numeric
     OR v_x.reserve_in IS DISTINCT FROM l.spin_underwrite::numeric
     OR v_x.reserve_out IS DISTINCT FROM l.spin_surplus::numeric
     OR v_x.overlay_in IS DISTINCT FROM l.overlay::numeric
     OR v_x.bounty_balance IS DISTINCT FROM (l.bounty_in - l.bounty_out - l.refund_bounty)::numeric
     OR v_x.fee_balance IS DISTINCT FROM (l.fee_in - l.fee_out - l.refund_fee)::numeric
     OR v_x.prize_balance + v_x.bounty_balance + v_x.fee_balance
        IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric THEN
    RAISE EXCEPTION 'tournament % escrow shadow disagrees with its Diamond banks', p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  RETURN jsonb_build_object('ok',true,'prize_balance',v_x.prize_balance,'bounty_balance',v_x.bounty_balance,'fee_balance',v_x.fee_balance);
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_open_shadow(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. THE GUARANTEE'S DOORS
-- ---------------------------------------------------------------------------
-- What an event promises: its guarantee, or a satellite's seats at the
-- target's whole ticket, whichever is larger (the chip lock's own rule).
CREATE FUNCTION public.fn_poker_diamond_tournament_effective_guarantee(p_tournament_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT GREATEST(COALESCE(t.guaranteed_prize, 0),
    CASE WHEN COALESCE(t.satellite_seats, 0) > 0
              AND (t.variant = 'satellite' OR upper(COALESCE(t.tournament_type, '')) = 'SATELLITE'
                   OR t.satellite_target_id IS NOT NULL)
         THEN COALESCE((SELECT (COALESCE(t2.buy_in_amount, 0) + COALESCE(t2.buy_in_fee, 0)) * t.satellite_seats
                          FROM public.tournaments t2
                         WHERE t2.id = COALESCE(t.satellite_target_id, t.satellite_target)), 0)
         ELSE 0 END)
    FROM public.tournaments t WHERE t.id = p_tournament_id
$$;

-- The promise ends: whatever the event's guarantee earmark still holds goes
-- back to the house's available balance. Moves no Diamond (rule R3).
CREATE FUNCTION public.fn_poker_diamond_guarantee_release(p_tournament_id uuid, p_moment text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_open bigint;
BEGIN
  IF p_tournament_id IS NULL OR p_moment NOT IN ('lock','finalize','cancel','complete') THEN
    RAISE EXCEPTION 'invalid_diamond_guarantee_release' USING ERRCODE = '22023';
  END IF;
  v_open := public.fn_ca_diamond_earmark_open('guarantee:' || p_tournament_id::text);
  IF v_open <= 0 THEN RETURN 0; END IF;
  INSERT INTO public.ca_diamond_house_earmarks (entry, earmark_key, purpose, amount, tournament_id, reason)
  VALUES ('release', 'guarantee:' || p_tournament_id::text, 'guarantee', v_open, p_tournament_id,
          'Guarantee earmark released at ' || p_moment || ': the event no longer needs it');
  RETURN v_open;
END $$;

-- THE ONE FUNCTION THAT MOVES A GUARANTEE'S DIAMONDS. It brings the event's
-- prize bank to exactly max(guarantee, collected), where collected is every
-- prize part the entries paid in, less refunds:
--   short  -> the house pays the difference into the event's entry custody:
--             one house 'burn' register row, and per custody share a credit
--             journal row on that entrant (class 'arena', balance_after
--             unchanged: the Diamonds land in custody, never in a wallet, and
--             are paid out only as prizes), its 'reserve' movement and an
--             'overlay' ledger row; the earmark records the payment.
--   excess -> overlay the entries made unnecessary returns from the custody to
--             the house through fn_poker_diamond_tournament_drain (each share
--             a spend the register retires) and one house 'mint' row, with an
--             'overlay_return' ledger row per leg.
-- The Spin draw's reserve legs are the template, row for row. Every Diamond is
-- whole, custody equals the banks afterwards, and the supply identity is
-- untouched (house -x, arena float +x). Returns the signed change to the
-- prize bank.
CREATE FUNCTION public.fn_poker_diamond_tournament_settle_overlay(p_tournament_id uuid, p_moment text, p_guarantee numeric)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c_house constant uuid := '00000000-0000-0000-0000-00000000d1a0';
  v_t record; v_l record; v_g bigint; v_collected bigint; v_funded bigint; v_delta bigint; v_amount bigint;
  v_key text; v_n integer; v_share bigint; v_rest bigint; v_take bigint; v_i integer := 0;
  v_c public.poker_diamond_custody%ROWTYPE; v_wallet bigint; v_journal uuid; v_journals uuid[] := ARRAY[]::uuid[];
  v_req uuid; v_before numeric; v_after numeric; v_supply numeric; v_registered numeric;
  v_drained jsonb; v_d jsonb; v_open bigint;
BEGIN
  IF p_tournament_id IS NULL OR p_moment NOT IN ('lock','finalize') OR p_guarantee IS NULL
     OR p_guarantee < 0 OR p_guarantee <> trunc(p_guarantee) THEN
    RAISE EXCEPTION 'invalid_diamond_overlay_request' USING ERRCODE = '22023';
  END IF;
  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE = '23514';
  END IF;
  SELECT t.id, t.club_id, t.name INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id;
  v_g := p_guarantee;
  SELECT COALESCE(sum(prize_part) FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0)
           - COALESCE(sum(prize_part) FILTER (WHERE kind = 'refund'),0) AS collected,
         COALESCE(sum(amount) FILTER (WHERE kind = 'overlay'),0)
           - COALESCE(sum(amount) FILTER (WHERE kind = 'overlay_return'),0) AS funded
    INTO v_l FROM public.poker_diamond_tournament_ledger WHERE tournament_id = p_tournament_id;
  v_collected := v_l.collected; v_funded := v_l.funded;
  v_delta := GREATEST(v_g, v_collected) - (v_collected + v_funded);
  IF v_delta = 0 THEN RETURN 0; END IF;

  INSERT INTO public.ca_diamond_house (id, balance) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
  SELECT COALESCE(h.balance, 0) INTO v_before FROM public.ca_diamond_house h WHERE h.id = 1 FOR UPDATE;
  SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0) INTO v_supply
    FROM public.ca_mint_ledger m WHERE m.asset = 'diamonds';

  IF v_delta > 0 THEN
    v_amount := v_delta;
    v_key := 'poker-guarantee-overlay:' || p_tournament_id::text || ':' || p_moment;
    -- The promise was set aside at creation; it is kept from the earmark and
    -- from nothing else (A7). Ruling 21: no cap is read here.
    v_open := public.fn_ca_diamond_earmark_open('guarantee:' || p_tournament_id::text);
    IF v_open < v_amount THEN
      RAISE EXCEPTION 'diamond_guarantee_overlay_exceeds_its_earmark:% set aside, % needed', v_open, v_amount
        USING ERRCODE = '23514';
    END IF;
    IF v_before < v_amount THEN
      RAISE EXCEPTION 'diamond_house_cannot_pay_the_overlay:% held, % needed', v_before, v_amount
        USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO v_n FROM public.poker_diamond_custody c
     WHERE c.purpose = 'tournament_entry' AND c.target_id = p_tournament_id AND c.state = 'active';
    IF v_n = 0 THEN
      RAISE EXCEPTION 'diamond_overlay_has_no_entry_to_hold_it' USING ERRCODE = '55000';
    END IF;
    UPDATE public.ca_diamond_house SET balance = balance - v_amount, updated_at = now()
     WHERE id = 1 RETURNING balance INTO v_after;
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after, supply_after, reason)
    VALUES (v_key, 'burn', 'diamonds', 'house', c_house, 'the house', v_amount, v_before, v_after, v_supply - v_amount,
      'Diamond guarantee overlay paid from the house into the event custody (' || COALESCE(v_t.name, 'tournament')
      || ', ' || p_moment || '), the guarantee set aside at creation');
    SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry IMMEDIATE;
    v_share := v_amount / v_n;
    v_rest := v_amount % v_n;
    FOR v_c IN SELECT c.* FROM public.poker_diamond_custody c
                WHERE c.purpose = 'tournament_entry' AND c.target_id = p_tournament_id AND c.state = 'active'
                ORDER BY c.created_at, c.id FOR UPDATE LOOP
      v_i := v_i + 1;
      v_take := v_share + CASE WHEN v_i <= v_rest THEN 1 ELSE 0 END;
      CONTINUE WHEN v_take = 0;
      SELECT COALESCE(pr.diamonds, 0) INTO v_wallet FROM public.profiles pr WHERE pr.id = v_c.user_id;
      INSERT INTO public.diamond_transactions(user_id, type, transaction_type, amount, balance_after, reference_id,
        description, source, issuance_class, counterparty, metadata)
      VALUES (v_c.user_id, 'arena_guarantee_overlay', 'arena_guarantee_overlay', v_take::integer, v_wallet,
        v_key || ':' || v_c.id::text,
        'Diamond guarantee overlay: ' || COALESCE(v_t.name, 'tournament')
          || ' was short of its guarantee; the house paid this share into the entry custody (paid out as prizes, never spendable)',
        'poker_arena', 'arena', 'house',
        jsonb_build_object('custody_id', v_c.id, 'tournament_id', p_tournament_id, 'source', 'house',
                           'destination', 'custody', 'moment', p_moment))
      RETURNING id INTO v_journal;
      v_journals := v_journals || v_journal;
      v_req := uuid_in(md5(v_key || ':' || v_c.id::text)::cstring);
      INSERT INTO public.poker_diamond_movements(request_id, custody_id, user_id, action, amount,
        source_account, destination_account, wallet_journal_id, request, receipt)
      VALUES (v_req, v_c.id, v_c.user_id, 'reserve', v_take, 'house:' || c_house::text, 'arena_custody:' || v_c.id::text,
        v_journal,
        jsonb_build_object('action', 'guarantee_overlay', 'bank', 'prize', 'tournament_id', p_tournament_id,
                           'custody_id', v_c.id, 'amount', v_take),
        jsonb_build_object('success', true, 'custody_id', v_c.id, 'amount', v_take,
                           'custody_balance', v_c.balance + v_take, 'journal_id', v_journal));
      UPDATE public.poker_diamond_custody SET balance = balance + v_take WHERE id = v_c.id;
      INSERT INTO public.poker_diamond_tournament_ledger(tournament_id, arena_id, user_id, custody_id, kind, amount,
        prize_part, bounty_part, fee_part, idempotency_key, wallet_journal_id, request)
      VALUES (p_tournament_id, v_t.club_id, v_c.user_id, v_c.id, 'overlay', v_take, v_take, 0, 0,
        v_key || ':' || v_c.id::text, v_journal,
        jsonb_build_object('kind', 'overlay', 'source', 'house', 'moment', p_moment, 'request_id', v_req));
    END LOOP;
    SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry DEFERRED;
    SELECT COALESCE(sum(m.amount), 0) INTO v_registered FROM public.ca_mint_ledger m
     WHERE m.asset = 'diamonds' AND m.action = 'mint' AND m.holder_type = 'player'
       AND m.diamond_tx_id = ANY (v_journals);
    IF v_registered IS DISTINCT FROM v_amount::numeric THEN
      RAISE EXCEPTION 'diamond_overlay_not_registered_to_players (% of %)', v_registered, v_amount USING ERRCODE = 'P0404';
    END IF;
    INSERT INTO public.ca_diamond_house_earmarks (entry, earmark_key, purpose, amount, tournament_id, reason)
    VALUES ('pay', 'guarantee:' || p_tournament_id::text, 'guarantee', v_amount, p_tournament_id,
            'Guarantee overlay paid into the event custody at ' || p_moment);
    IF EXISTS (SELECT 1 FROM public.tournament_escrow x WHERE x.tournament_id = p_tournament_id) THEN
      PERFORM public.fn_ca_escrow_apply(p_tournament_id, 'diamond guarantee overlay', p_overlay_in => v_amount);
    END IF;
  ELSE
    v_amount := LEAST(-v_delta, v_funded);
    IF v_amount <= 0 THEN RETURN 0; END IF;
    v_key := 'poker-guarantee-overlay-return:' || p_tournament_id::text || ':' || p_moment;
    v_drained := public.fn_poker_diamond_tournament_drain(p_tournament_id, 'prize', v_amount, v_key, 'house', NULL);
    SELECT COALESCE(sum(m.amount), 0) INTO v_registered FROM public.ca_mint_ledger m
     WHERE m.asset = 'diamonds' AND m.action = 'burn' AND m.holder_type = 'player'
       AND m.diamond_tx_id IN (SELECT (d->>'journal_id')::uuid FROM jsonb_array_elements(v_drained) d);
    IF v_registered IS DISTINCT FROM v_amount::numeric THEN
      RAISE EXCEPTION 'diamond_overlay_return_not_retired_from_players (% of %)', v_registered, v_amount USING ERRCODE = 'P0404';
    END IF;
    UPDATE public.ca_diamond_house SET balance = balance + v_amount, updated_at = now()
     WHERE id = 1 RETURNING balance INTO v_after;
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after, supply_after, reason)
    VALUES (v_key, 'mint', 'diamonds', 'house', c_house, 'the house', v_amount, v_before, v_after, v_supply + v_amount,
      'Diamond guarantee overlay the entries made unnecessary returned from the event custody to the house ('
      || COALESCE(v_t.name, 'tournament') || ', ' || p_moment || ')');
    FOR v_d IN SELECT d.value FROM jsonb_array_elements(v_drained) d LOOP
      INSERT INTO public.poker_diamond_tournament_ledger(tournament_id, arena_id, user_id, custody_id, kind, amount,
        prize_part, bounty_part, fee_part, idempotency_key, wallet_journal_id, request)
      VALUES (p_tournament_id, v_t.club_id, (v_d->>'user_id')::uuid, (v_d->>'custody_id')::uuid, 'overlay_return',
        (v_d->>'amount')::bigint, (v_d->>'amount')::bigint, 0, 0,
        v_key || ':' || (v_d->>'custody_id'), (v_d->>'journal_id')::uuid,
        jsonb_build_object('kind', 'overlay_return', 'destination', 'house', 'moment', p_moment,
                           'request_id', v_d->>'request_id'));
    END LOOP;
    IF EXISTS (SELECT 1 FROM public.tournament_escrow x WHERE x.tournament_id = p_tournament_id) THEN
      PERFORM public.fn_ca_escrow_apply(p_tournament_id, 'diamond guarantee overlay return', p_overlay_in => -v_amount);
    END IF;
    v_amount := -v_amount;
  END IF;

  IF (SELECT prize_balance + bounty_balance + fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id))
     IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric THEN
    RAISE EXCEPTION 'diamond_tournament_escrow_disagrees_with_custody' USING ERRCODE = 'P0404';
  END IF;
  RETURN v_amount;
END $$;

-- A FREEROLL ENTRY: an active custody row at zero, named for its registration,
-- never bound to a seat. It is what the seat guards admit a seat against, and
-- what a one-Diamond rebuy or add-on is added to. Nothing moves.
CREATE FUNCTION public.fn_poker_diamond_tournament_free_entry(p_user_id uuid, p_tournament_id uuid, p_registration_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_t record; v_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_tournament_id IS NULL OR p_registration_id IS NULL THEN
    RAISE EXCEPTION 'invalid_diamond_free_entry' USING ERRCODE = '22023';
  END IF;
  SELECT t.club_id, t.buy_in_amount, t.buy_in_fee INTO v_t
    FROM public.tournaments t JOIN public.clubs c ON c.id = t.club_id
   WHERE t.id = p_tournament_id AND c.asset = 'diamonds' AND c.is_platform IS TRUE
     AND c.union_id IS NULL AND t.union_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE = '23514'; END IF;
  IF COALESCE(v_t.buy_in_amount, 0) <> 0 OR COALESCE(v_t.buy_in_fee, 0) <> 0 THEN
    RAISE EXCEPTION 'diamond_free_entry_requires_a_freeroll' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_arena_settings a
                  WHERE a.id = 1 AND a.club_id = v_t.club_id AND a.tournaments_enabled) THEN
    RAISE EXCEPTION 'diamond_tournaments_not_open' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.poker_diamond_custody c
              WHERE c.user_id = p_user_id AND c.purpose = 'tournament_entry'
                AND c.target_id = p_tournament_id AND c.state <> 'released') THEN
    RAISE EXCEPTION 'diamond_tournament_entry_already_held' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.poker_diamond_custody (id, user_id, arena_id, purpose, target_id, entry_key, balance, state)
  VALUES (gen_random_uuid(), p_user_id, v_t.club_id, 'tournament_entry', p_tournament_id,
          'entry:' || p_registration_id::text, 0, 'active')
  RETURNING id INTO v_id;
  UPDATE public.tournaments t SET entry_contract_locked = true
   WHERE t.id = p_tournament_id AND NOT t.entry_contract_locked;
  RETURN jsonb_build_object('success', true, 'free_entry', true, 'custody_id', v_id, 'amount', 0, 'journal_id', NULL);
END $$;

-- The creation core: the live creation door (md5 05e4ae642e1a3949da8bb34bc62f7f3d)
-- with every validation kept. What changed is marked 2026-10-06 inline.
CREATE FUNCTION public.fn_poker_diamond_create_tournament_core(p_config jsonb, p_authority jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_arena uuid; v_id uuid;
  v_total bigint; v_fee bigint; v_buy_in bigint; v_ratio numeric;
  v_max integer; v_min integer; v_type text; v_variant text; v_game text;
  v_start timestamptz; v_payouts jsonb; v_blinds jsonb; v_pct numeric; v_chips integer;
  v_rebuy boolean; v_reentry boolean; v_addon boolean; v_rebuy_cost bigint; v_addon_cost bigint;
  v_rebuy_num numeric; v_addon_num numeric; v_name text;
  v_is_bounty boolean; v_bounty_num numeric; v_bounty bigint;
  v_mystery boolean; v_mb_activation text; v_mb_profile text; v_mb_value numeric; v_mb_top numeric;
  v_mb_pool numeric; v_mb_regular numeric; v_mb_min_mult numeric; v_mb_max_mult numeric;
  v_unlimited boolean;
  v_satellite boolean; v_target_text text; v_target_id uuid; v_target public.tournaments%ROWTYPE;
  -- 2026-10-06: the two doors this core serves, and what Midway's board needs.
  v_cfg jsonb := p_config;
  v_door text := COALESCE(p_authority->>'door','');
  v_schedule uuid := NULLIF(p_authority->>'schedule_id','')::uuid;
  v_key text; v_from text; v_to text;
  v_guar_num numeric; v_guarantee bigint := 0;
  v_seats_num numeric; v_seats integer := 0; v_seat_guarantee bigint := 0; v_effective bigint := 0;
  v_freeroll boolean := false;
  v_rebuy_chips integer; v_addon_chips integer; v_rebuy_levels integer; v_addon_levels integer;
  v_max_rebuys integer; v_max_reentries integer; v_action_seconds integer := 15;
BEGIN
  -- 2026-10-06: TWO DOORS, ONE RULE BOOK. The staff door (a signed-in platform
  -- admin with a live session, exactly as before) and the scheduled door (the
  -- service role spawning a tournament_schedules row seeded under Dan's ruling
  -- of 2026-10-06). Every validation below runs for both.
  IF v_door = 'admin' THEN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='28000'; END IF;
    IF NOT public.fn_is_platform_admin() THEN
      RAISE EXCEPTION 'diamond_tournament_staff_only' USING ERRCODE='42501';
    END IF;
    -- DIAMOND PHASE 11: a signed-out staff token moves nothing here either.
    IF NOT public.fn_caller_session_is_live() THEN
      RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE='28000';
    END IF;
  ELSIF v_door = 'schedule' THEN
    IF v_schedule IS NULL OR NULLIF(p_authority->>'scheduled_start','') IS NULL
       OR COALESCE(auth.role(),'') <> 'service_role' THEN
      RAISE EXCEPTION 'diamond_schedule_authority_incomplete' USING ERRCODE='42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'diamond_tournament_unknown_door' USING ERRCODE='42501';
  END IF;
  SELECT c.id INTO v_arena FROM public.clubs c
   WHERE c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL LIMIT 1;
  IF v_arena IS NULL THEN RAISE EXCEPTION 'diamond_arena_not_found' USING ERRCODE='P0002'; END IF;
  IF v_cfg IS NULL OR jsonb_typeof(v_cfg)<>'object' THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_configuration' USING ERRCODE='22023';
  END IF;
  -- DIAMOND PHASE 9, STEP 0 (the_chip_legs_refuse_a_diamond_row): the estate's builder
  -- (TournamentService.buildRpcConfig) sends these money keys, and this door reads
  -- guarantee, rebuy, reentry, addOn and addonCost instead. A value in one of them
  -- would be dropped and the event created without it, so it is refused by name.
  -- The builder's own default (0, false or null) means what the door does without
  -- the key, and is admitted.
  IF EXISTS (SELECT 1 FROM jsonb_each(v_cfg) k
              WHERE k.key IN ('addOnFromStart')
                AND k.value NOT IN ('0'::jsonb, 'false'::jsonb, 'null'::jsonb)) THEN
    RAISE EXCEPTION 'diamond_tournament_money_key_not_read: %', (
      SELECT string_agg(k.key, ', ' ORDER BY k.key) FROM jsonb_each(v_cfg) k
       WHERE k.key IN ('addOnFromStart')
         AND k.value NOT IN ('0'::jsonb, 'false'::jsonb, 'null'::jsonb))
      USING ERRCODE = '22023';
  END IF;
  -- 2026-10-06: THE BUILDER'S MONEY KEYS ARE READ, NOT REFUSED. Midway's
  -- schedule configs (and TournamentService.buildRpcConfig) spell the guarantee
  -- guaranteedPrize and the rebuy and add-on isRebuy, isReentry, addOnAvailable
  -- and addOnCost. Each is folded onto the key this door has always read; the
  -- two spellings of one key may not disagree.
  FOR v_key IN SELECT unnest(ARRAY['guaranteedPrize>guarantee','isRebuy>rebuy','isReentry>reentry',
                                   'addOnAvailable>addOn','addOnCost>addonCost'])
  LOOP
    v_from := split_part(v_key,'>',1); v_to := split_part(v_key,'>',2);
    IF v_cfg ? v_from AND v_cfg->v_from <> 'null'::jsonb THEN
      IF v_cfg ? v_to AND v_cfg->v_to <> 'null'::jsonb AND v_cfg->v_to <> v_cfg->v_from THEN
        RAISE EXCEPTION 'diamond_tournament_money_keys_disagree:%/%', v_from, v_to USING ERRCODE='22023';
      END IF;
      v_cfg := jsonb_set(v_cfg - v_from, ARRAY[v_to], v_cfg->v_from);
    ELSE
      v_cfg := v_cfg - v_from;
    END IF;
  END LOOP;

  v_type := lower(COALESCE(v_cfg->>'type','mtt'));
  -- DIAMOND PHASE 9: A SPIN IS ADMITTED BY ITS OWN BRANCH, under the chip
  -- seat-first configuration door's rules (fn_poker_diamond_create_spin:
  -- three seats, no fee, a multiplier that is drawn and never configured, a
  -- multiplier table held to the draw authority's rules and to whole Diamonds
  -- at its buy-in). A Spin's configuration on any other format is refused.
  IF v_type = 'spin' THEN
    -- DIAMOND PHASE 10: the answer files its audit row on the way out.
    IF v_door <> 'admin' THEN
      RAISE EXCEPTION 'diamond_schedule_cannot_create_a_spin' USING ERRCODE='55000';
    END IF;
    RETURN public.fn_poker_diamond_create_spin(v_cfg, v_arena);
  END IF;
  IF v_cfg ?| ARRAY['spinTiers','spinMultiplier','spinLockedTiers','spin_multiplier','spin_locked_tiers'] THEN
    RAISE EXCEPTION 'diamond_tournament_spin_requires_a_spin_format' USING ERRCODE='22023';
  END IF;
  IF v_type NOT IN ('mtt','sng','bounty','progressive_bounty','mystery_bounty','satellite') THEN
    -- spin is admitted above, by fn_poker_diamond_create_spin.
    RAISE EXCEPTION 'diamond_tournament_format_not_open' USING ERRCODE='55000';
  END IF;
  IF COALESCE((v_cfg->>'freeBuy')::boolean,false) THEN
    RAISE EXCEPTION 'diamond_tournament_format_not_open' USING ERRCODE='55000';
  END IF;
  -- 2026-10-06: A GUARANTEE IS SET ASIDE ON THE HOUSE AT CREATION (A1, A7).
  -- Whole Diamonds; the earmark ledger's guard applies A4 and A5 and the
  -- house's available balance when the earmark is opened below.
  v_guar_num := COALESCE(NULLIF(v_cfg->>'guarantee','')::numeric,0);
  IF v_guar_num <> trunc(v_guar_num) OR v_guar_num < 0 OR v_guar_num > 2147483647 THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_whole_guarantee' USING ERRCODE='22023';
  END IF;
  v_guarantee := v_guar_num;
  -- A satellite is a format, not a flag: its target rides on a 'satellite'
  -- event and on nothing else, and a satellite has exactly one target.
  v_satellite := v_type = 'satellite';
  v_target_text := NULLIF(btrim(COALESCE(v_cfg->>'satelliteTargetId','')),'');
  IF v_target_text IS NOT NULL AND NOT v_satellite THEN
    RAISE EXCEPTION 'diamond_tournament_target_requires_a_satellite_format' USING ERRCODE='22023';
  END IF;
  IF v_satellite THEN
    IF v_target_text IS NULL
       OR v_target_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'diamond_satellite_requires_a_target' USING ERRCODE='22023';
    END IF;
    v_target_id := v_target_text::uuid;
    -- ASSETS NEVER CROSS: a Diamond satellite seats a Diamond target only.
    IF NOT public.fn_poker_diamond_tournament(v_target_id) THEN
      RAISE EXCEPTION 'diamond_satellite_target_must_be_a_diamond_tournament' USING ERRCODE='22023';
    END IF;
    IF NOT public.fn_ca_diamond_satellite_target_accepts_new_feeder(v_target_id) THEN
      RAISE EXCEPTION 'diamond_satellite_target_cannot_take_a_satellite' USING ERRCODE='22023';
    END IF;
    SELECT * INTO v_target FROM public.tournaments t WHERE t.id=v_target_id;
    IF upper(COALESCE(v_target.status,'')) NOT IN ('ANNOUNCED','REGISTERING')
       OR COALESCE(v_target.prize_pool_finalized,false) THEN
      RAISE EXCEPTION 'diamond_satellite_target_is_not_open' USING ERRCODE='55000';
    END IF;
    -- A seat count promised in advance is a guarantee: reserved to the owner.
    -- 2026-10-06: A SEAT COUNT PROMISED IN ADVANCE IS A GUARANTEE, and it is
    -- set aside on the house like one: seats x the target's whole ticket.
    v_seats_num := COALESCE(NULLIF(v_cfg->>'satelliteSeats','')::numeric,0);
    IF v_seats_num <> trunc(v_seats_num) OR v_seats_num < 0 OR v_seats_num > 10000 THEN
      RAISE EXCEPTION 'diamond_satellite_requires_whole_seats' USING ERRCODE='22023';
    END IF;
    v_seats := v_seats_num;
    v_seat_guarantee := v_seats::bigint * (COALESCE(v_target.buy_in_amount,0) + COALESCE(v_target.buy_in_fee,0))::bigint;
    -- The chip scheduled satellite is a freezeout; so is this one.
    IF COALESCE((v_cfg->>'rebuy')::boolean,false) OR COALESCE((v_cfg->>'reentry')::boolean,false)
       OR COALESCE((v_cfg->>'addOn')::boolean,false) THEN
      RAISE EXCEPTION 'diamond_satellite_is_a_freezeout' USING ERRCODE='22023';
    END IF;
  END IF;
  -- A knockout bounty is a format, not a flag: the flat bounty rides on a
  -- 'bounty', 'progressive_bounty' or 'mystery_bounty' event and on nothing else.
  v_is_bounty := v_type IN ('bounty','progressive_bounty','mystery_bounty');
  v_mystery := v_type = 'mystery_bounty';
  v_bounty_num := COALESCE((v_cfg->>'bountyAmount')::numeric,0);
  IF NOT v_is_bounty AND (v_bounty_num<>0 OR COALESCE((v_cfg->>'isBounty')::boolean,false)) THEN
    RAISE EXCEPTION 'diamond_tournament_bounty_requires_a_bounty_format' USING ERRCODE='22023';
  END IF;
  IF NOT v_mystery AND (v_cfg ? 'mysteryBountyMin' OR v_cfg ? 'mysteryBountyMax' OR v_cfg ? 'mysteryBounty') THEN
    RAISE EXCEPTION 'diamond_tournament_mystery_requires_a_mystery_format' USING ERRCODE='22023';
  END IF;
  v_game := upper(btrim(COALESCE(v_cfg->>'gameVariant','NLH')));
  -- 2026-10-06: the schedule spellings the engine's GAME_TYPE_MAP already reads.
  v_game := CASE v_game WHEN 'PLO' THEN 'PLO4' WHEN 'SHORTDECK' THEN 'SHORT_DECK' ELSE v_game END;
  IF v_game NOT IN ('NLH','PLO4','PLO5','PLO6','PLO8','SHORT_DECK','FLH','FLO8') THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_supported_game' USING ERRCODE='22023';
  END IF;

  v_total := COALESCE((v_cfg->>'buyIn')::numeric,0);
  IF (v_cfg->>'buyIn')::numeric IS DISTINCT FROM v_total::numeric OR v_total<0 OR v_total>2147483647 THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_whole_positive_buy_in' USING ERRCODE='22023';
  END IF;
  -- 2026-10-06: A FREEROLL (A10, A11). Zero to enter, a plain MTT, its prize
  -- the guarantee set aside on the house, and rebuys and add-ons at one Diamond
  -- each wholly to the prize pool, as Midway runs its own (Dan, 2026-10-06:
  -- "USE THE SAME TOURNAMENT SCHEDULE AND RAKE AS THE MIDWAY UNION FOR NOW").
  v_freeroll := v_total = 0;
  IF v_freeroll THEN
    IF v_type <> 'mtt' THEN
      RAISE EXCEPTION 'diamond_freeroll_must_be_a_plain_mtt' USING ERRCODE='22023';
    END IF;
    IF v_guarantee < 1 THEN
      RAISE EXCEPTION 'diamond_freeroll_requires_a_guarantee' USING ERRCODE='22023';
    END IF;
    IF NOT public.fn_ca_diamond_economic_on('freeroll_allowed') THEN
      RAISE EXCEPTION 'diamond_freeroll_not_open' USING ERRCODE='55000';
    END IF;
    IF public.fn_ca_diamond_economic_text('freeroll_rebuy_cost') IS DISTINCT FROM 'one_diamond_to_the_prize_pool'
       OR public.fn_ca_diamond_economic_text('freeroll_addon_cost') IS DISTINCT FROM 'one_diamond_to_the_prize_pool' THEN
      RAISE EXCEPTION 'diamond_freeroll_rebuy_and_addon_are_not_offered' USING ERRCODE='55000';
    END IF;
  END IF;
  v_unlimited:=public.fn_ca_new_tournament_is_unlimited(jsonb_build_object('tournament_type',
    CASE WHEN v_type='sng' THEN 'SNG' WHEN v_satellite THEN 'SATELLITE' ELSE 'MTT' END));
  v_max := CASE WHEN v_unlimited THEN NULL ELSE COALESCE((v_cfg->>'maxPlayers')::int,0) END;
  IF NOT v_unlimited AND (v_max<2 OR v_max>10000) THEN RAISE EXCEPTION 'diamond_tournament_requires_a_real_field' USING ERRCODE='22023'; END IF;
  v_min := GREATEST(COALESCE((v_cfg->>'minPlayers')::int,3),CASE WHEN v_unlimited THEN 3 ELSE 2 END);
  IF NOT v_unlimited AND v_min>v_max THEN v_min := v_max; END IF;
  -- The fee rule the recovery fee already states, at this entry's own unit.
  v_ratio := CASE WHEN NOT v_unlimited AND v_max<=2 THEN 0.05 ELSE 0.10 END;
  v_fee := public.fn_ca_unit_floor_cents(round(v_total*100*v_ratio)::bigint, 100)/100;
  v_buy_in := v_total - v_fee;
  IF v_buy_in<1 AND NOT v_freeroll THEN RAISE EXCEPTION 'diamond_tournament_buy_in_below_one_diamond' USING ERRCODE='22023'; END IF;
  -- The chip door's bounty rule at the Diamond unit: a whole bounty of at
  -- least one Diamond, no larger than the buy-in after the fee (the prize
  -- part is what remains; it may be zero, as the chip split allows).
  -- 2026-10-06: a scheduled bounty that is not a whole Diamond (Midway's 2.5,
  -- 6.75) is rounded DOWN; the remainder stays in the prize part of the entry.
  IF v_door = 'schedule' THEN
    v_bounty_num := trunc(v_bounty_num);
  END IF;
  IF v_is_bounty THEN
    IF v_bounty_num<>trunc(v_bounty_num) OR v_bounty_num<1 OR v_bounty_num>v_buy_in THEN
      RAISE EXCEPTION 'diamond_tournament_requires_a_whole_bounty_within_the_buy_in' USING ERRCODE='22023';
    END IF;
    v_bounty := v_bounty_num;
  ELSE
    v_bounty := 0;
  END IF;
  -- The mystery rules are the chip configuration door's rules
  -- (fn_apply_mystery_bounty_config), stamped here because that door consults
  -- a club owner the arena does not have. The lobby's advertised range is the
  -- chip door's multipliers on the flat bounty, in whole Diamonds.
  IF v_mystery THEN
    v_mb_activation := COALESCE(v_cfg->'mysteryBounty'->>'activation', 'at_the_money');
    IF v_mb_activation NOT IN ('at_the_money','percent_field','player_count') THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_bad_activation_mode' USING ERRCODE='22023';
    END IF;
    v_mb_profile := COALESCE(v_cfg->'mysteryBounty'->>'profile', 'classic');
    IF v_mb_profile NOT IN ('balanced','classic','jackpot') THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_bad_profile' USING ERRCODE='22023';
    END IF;
    v_mb_value := (v_cfg->'mysteryBounty'->>'activationValue')::numeric;
    IF v_mb_activation = 'percent_field' AND (COALESCE(v_mb_value,0) <= 0 OR v_mb_value > 100) THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_activation_percent_out_of_range' USING ERRCODE='22023';
    END IF;
    IF v_mb_activation = 'player_count' AND COALESCE(v_mb_value,0) < 2 THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_activation_count_too_small' USING ERRCODE='22023';
    END IF;
    v_mb_top := COALESCE((v_cfg->'mysteryBounty'->>'topPercent')::numeric, 20);
    IF v_mb_top <= 0 OR v_mb_top > 100 THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_top_percent_out_of_range' USING ERRCODE='22023';
    END IF;
    v_mb_pool := COALESCE((v_cfg->'mysteryBounty'->>'poolPercent')::numeric, 50);
    v_mb_regular := COALESCE((v_cfg->'mysteryBounty'->>'regularPoolPercent')::numeric, 100 - v_mb_pool);
    IF v_mb_pool < 0 OR v_mb_regular < 0 OR v_mb_pool + v_mb_regular <= 0 THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_pool_split_invalid' USING ERRCODE='22023';
    END IF;
    v_mb_min_mult := COALESCE(NULLIF(v_cfg->>'mysteryBountyMin','')::numeric, 0.5);
    v_mb_max_mult := COALESCE(NULLIF(v_cfg->>'mysteryBountyMax','')::numeric, 13);
    IF v_mb_min_mult <= 0 OR v_mb_max_mult < v_mb_min_mult THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_range_invalid' USING ERRCODE='22023';
    END IF;
  END IF;

  v_chips := COALESCE((v_cfg->>'startingStack')::int, 10000);
  IF v_chips<1 THEN RAISE EXCEPTION 'diamond_tournament_requires_a_starting_stack' USING ERRCODE='22023'; END IF;
  v_blinds := COALESCE(v_cfg->'blindStructure','[]'::jsonb);
  v_payouts := COALESCE(v_cfg->'payoutStructure','[]'::jsonb);
  IF jsonb_typeof(v_blinds)<>'array' OR jsonb_array_length(v_blinds)=0 THEN
    RAISE EXCEPTION 'blind_structure_required' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(v_payouts)<>'array' OR jsonb_array_length(v_payouts)=0 THEN
    RAISE EXCEPTION 'payout_structure_required' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(sum((e->>'percentage')::numeric),0) INTO v_pct FROM jsonb_array_elements(v_payouts) e;
  IF abs(v_pct-100)>1 THEN RAISE EXCEPTION 'payouts_must_total_100' USING ERRCODE='22023'; END IF;
  IF NOT v_unlimited AND jsonb_array_length(v_payouts)>v_max THEN RAISE EXCEPTION 'more_paid_places_than_players' USING ERRCODE='22023'; END IF;
  v_start := CASE WHEN v_door = 'schedule' THEN (p_authority->>'scheduled_start')::timestamptz
                  ELSE COALESCE((v_cfg->>'startTime')::timestamptz, now()+interval '1 minute') END;
  -- A satellite plays before its target, as the chip scheduled satellite does.
  IF v_satellite AND (v_target.start_time IS NULL OR v_start >= v_target.start_time) THEN
    RAISE EXCEPTION 'diamond_satellite_must_start_before_its_target' USING ERRCODE='22023';
  END IF;
  v_rebuy := COALESCE((v_cfg->>'rebuy')::boolean,false);
  v_reentry := COALESCE((v_cfg->>'reentry')::boolean,v_rebuy);
  v_addon := COALESCE((v_cfg->>'addOn')::boolean,false);
  v_rebuy_num := COALESCE((v_cfg->>'rebuyCost')::numeric, v_total);
  v_addon_num := COALESCE((v_cfg->>'addonCost')::numeric, v_total);
  IF (v_rebuy OR v_reentry) AND (v_rebuy_num <> trunc(v_rebuy_num) OR v_rebuy_num < 1 OR v_rebuy_num > 2147483647) THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_whole_rebuy_cost' USING ERRCODE='22023';
  END IF;
  IF v_addon AND (v_addon_num <> trunc(v_addon_num) OR v_addon_num < 1 OR v_addon_num > 2147483647) THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_whole_addon_cost' USING ERRCODE='22023';
  END IF;
  v_rebuy_cost := v_rebuy_num; v_addon_cost := v_addon_num;
  IF v_freeroll THEN
    IF (v_cfg ? 'rebuyCost' AND v_cfg->'rebuyCost' <> 'null'::jsonb AND v_rebuy_num <> 1)
       OR (v_cfg ? 'addonCost' AND v_cfg->'addonCost' <> 'null'::jsonb AND v_addon_num <> 1) THEN
      RAISE EXCEPTION 'diamond_freeroll_rebuy_and_addon_cost_one_diamond' USING ERRCODE='22023';
    END IF;
    v_rebuy := true; v_reentry := COALESCE((v_cfg->>'reentry')::boolean, true); v_addon := true;
    v_rebuy_cost := 1; v_addon_cost := 1;
  END IF;
  -- The staff door's structure defaults are unchanged. The scheduled door reads
  -- Midway's own: the rebuy and add-on stacks and levels it configures, and no
  -- rebuy or re-entry limit unless one is set (the chip spawner's NULL).
  v_rebuy_chips := v_chips; v_addon_chips := v_chips; v_rebuy_levels := 6; v_addon_levels := 1;
  v_max_rebuys := COALESCE((v_cfg->>'maxRebuys')::int,2);
  v_max_reentries := COALESCE((v_cfg->>'maxReentries')::int,1);
  IF v_door = 'schedule' THEN
    v_rebuy_chips := COALESCE(NULLIF((v_cfg->>'rebuyChips')::int,0), v_chips);
    v_addon_chips := COALESCE(NULLIF(COALESCE(v_cfg->>'addOnChips', v_cfg->>'addonChips')::int,0), v_chips);
    v_rebuy_levels := COALESCE(NULLIF((v_cfg->>'rebuyLevels')::int,0), 6);
    v_addon_levels := COALESCE(NULLIF(COALESCE(v_cfg->>'addOnLevels', v_cfg->>'addonLevels')::int,0), 1);
    v_max_rebuys := (v_cfg->>'maxRebuys')::int;
    v_max_reentries := (v_cfg->>'maxReentries')::int;
    v_action_seconds := LEAST(60, GREATEST(5, COALESCE((v_cfg->>'actionTimeSeconds')::int, 15)));
    IF v_rebuy_chips < 1 OR v_addon_chips < 1 OR v_rebuy_levels < 1 OR v_addon_levels < 1
       OR COALESCE(v_max_rebuys,0) < 0 OR COALESCE(v_max_reentries,0) < 0 THEN
      RAISE EXCEPTION 'diamond_tournament_requires_a_real_rebuy_structure' USING ERRCODE='22023';
    END IF;
  END IF;

  -- THE GUARANTEE IS SET ASIDE BEFORE THE ROW EXISTS. The row's id is drawn
  -- first so the earmark can name it, and trg_tournaments_guarantee_affordable
  -- and the readiness contract find the earmark when the INSERT below runs.
  -- The earmark guard (fn_ca_diamond_earmark_guard) refuses by name a
  -- guarantee over A4, over A5, or over what the house has available.
  v_effective := GREATEST(v_guarantee, v_seat_guarantee);
  v_id := gen_random_uuid();
  IF v_effective > 0 THEN
    INSERT INTO public.ca_diamond_house_earmarks
      (entry, earmark_key, purpose, amount, tournament_id, recorded_by, reason)
    VALUES ('open', 'guarantee:' || v_id::text, 'guarantee', v_effective, v_id,
      CASE WHEN v_door = 'admin' THEN v_actor END,
      CASE WHEN v_door = 'schedule'
           THEN format('Scheduled guarantee set aside at creation: schedule %s at %s, a row seeded under Dan 2026-10-06 "USE THE SAME TOURNAMENT SCHEDULE AND RAKE AS THE MIDWAY UNION FOR NOW"',
                       v_schedule, p_authority->>'scheduled_start')
           ELSE format('Staff guarantee set aside at creation by platform admin %s', v_actor) END);
  END IF;
  v_name := COALESCE(NULLIF(btrim(v_cfg->>'name'),''),'Diamond Tournament');
  v_variant := CASE v_type WHEN 'sng' THEN 'sng' WHEN 'bounty' THEN 'bounty'
                           WHEN 'progressive_bounty' THEN 'progressive_bounty'
                           WHEN 'mystery_bounty' THEN 'mystery_bounty'
                           WHEN 'satellite' THEN 'satellite' ELSE 'freezeout' END;

  INSERT INTO public.tournaments (
    id, club_id, union_id, name, game_type, variant, tournament_type,
    buy_in_amount, buy_in_fee, guaranteed_prize, starting_chips, max_players, table_size, min_players,
    current_players, status, blind_structure, payout_structure, start_time,
    late_reg_levels, late_reg_mins, is_bounty, is_pko, is_mystery_bounty, bounty_amount,
    mystery_bounty_min, mystery_bounty_max,
    mystery_bounty_activation, mystery_bounty_activation_value, mystery_bounty_profile,
    mystery_bounty_top_percent, mystery_bounty_pool_percent, mystery_bounty_regular_pool_percent,
    is_rebuy, is_reentry, rebuy_cost, rebuy_chips, rebuy_levels, max_rebuys, max_reentries,
    add_on_available, addon_cost, addon_chips, addon_levels,
    payout_percent, free_buy, is_private, action_time_seconds,
    satellite_target_id, satellite_seats,
    schedule_id, short_description, is_pinned, bubble_protection, final_table_deal_enabled, big_blind_ante)
  VALUES (
    v_id, v_arena, NULL, v_name, v_game, v_variant,
    CASE WHEN v_type='sng' THEN 'SNG' WHEN v_satellite THEN 'SATELLITE' ELSE 'MTT' END,
    v_buy_in, v_fee, v_guarantee, v_chips, v_max, CASE WHEN v_unlimited THEN LEAST(9,GREATEST(2,COALESCE((v_cfg->>'tableSize')::int,9))) ELSE LEAST(9,GREATEST(2,v_max)) END, v_min,
    0, 'REGISTERING', v_blinds::text, v_payouts::text, v_start,
    CASE WHEN v_satellite THEN 0 ELSE COALESCE((v_cfg->>'lateRegLevels')::int,
      CASE WHEN v_door='schedule' THEN (v_cfg->>'lateRegistrationLevels')::int END,
      CASE WHEN v_type='sng' THEN 0 ELSE 8 END) END,
    CASE WHEN v_satellite THEN 0 ELSE 8 END,
    v_is_bounty, v_type='progressive_bounty', v_mystery, v_bounty,
    CASE WHEN v_mystery THEN trunc(v_bounty * v_mb_min_mult) ELSE 0 END,
    CASE WHEN v_mystery THEN trunc(v_bounty * v_mb_max_mult) ELSE 0 END,
    CASE WHEN v_mystery THEN v_mb_activation ELSE 'at_the_money' END, CASE WHEN v_mystery THEN v_mb_value END,
    CASE WHEN v_mystery THEN v_mb_profile ELSE 'classic' END,
    CASE WHEN v_mystery THEN v_mb_top ELSE 20 END, CASE WHEN v_mystery THEN v_mb_pool ELSE 50 END,
    CASE WHEN v_mystery THEN v_mb_regular ELSE 50 END,
    v_rebuy, v_reentry, CASE WHEN v_rebuy OR v_reentry THEN v_rebuy_cost ELSE 0 END,
    CASE WHEN v_rebuy OR v_reentry THEN v_rebuy_chips ELSE 0 END, CASE WHEN v_rebuy OR v_reentry THEN v_rebuy_levels ELSE 4 END,
    CASE WHEN v_rebuy THEN v_max_rebuys ELSE 0 END,
    CASE WHEN v_reentry THEN v_max_reentries ELSE 0 END,
    v_addon, CASE WHEN v_addon THEN v_addon_cost ELSE 0 END, CASE WHEN v_addon THEN v_addon_chips ELSE 0 END, v_addon_levels,
    CASE WHEN (v_cfg->>'payoutPercent')::int IN (10,15,20) THEN (v_cfg->>'payoutPercent')::smallint ELSE 10 END,
    false, false, v_action_seconds,
    CASE WHEN v_satellite THEN v_target_id END, CASE WHEN v_satellite THEN v_seats END,
    v_schedule,
    CASE WHEN v_door='schedule' THEN NULLIF(btrim(COALESCE(v_cfg->>'shortDescription','')),'') END,
    v_door='schedule' AND COALESCE((v_cfg->>'isFeatured')::boolean,false),
    v_door='schedule' AND COALESCE((v_cfg->>'bubbleProtection')::boolean,false),
    v_door='schedule' AND COALESCE((v_cfg->>'finalTableDealEnabled')::boolean,false),
    v_door='schedule' AND COALESCE((v_cfg->>'bigBlindAnte')::boolean,false))
  RETURNING id INTO v_id;
  -- The guarantee the row carries is exactly what was set aside for it.
  IF public.fn_ca_diamond_earmark_open('guarantee:' || v_id::text) <> v_effective THEN
    RAISE EXCEPTION 'diamond_guarantee_earmark_does_not_match_the_row' USING ERRCODE='23514';
  END IF;

  -- The row this door wrote must be one the money path will price: whole
  -- Diamonds everywhere, and the unit rule must recognise it.
  IF public.fn_ca_tournament_unit_cents(v_id) <> 100 OR NOT public.fn_poker_diamond_tournament(v_id) THEN
    RAISE EXCEPTION 'diamond_tournament_would_not_be_recognised' USING ERRCODE='23514';
  END IF;
  -- The staff door files its audit row with this answer on the way out; the
  -- scheduled door files its receipt in ca_diamond_scheduled_spawns.
  RETURN jsonb_build_object('success',true,'tournamentId',v_id,
    'guaranteed_prize',v_guarantee,'guarantee_set_aside',v_effective,'freeroll',v_freeroll,
    'satellite_seats',CASE WHEN v_satellite THEN v_seats END,'schedule_id',v_schedule,'id',v_id,'buy_in_amount',v_buy_in,'buy_in_fee',v_fee,
    'total',v_total,'bounty_amount',v_bounty,'is_mystery_bounty',v_mystery,'asset','diamonds',
    'satellite_target_id',v_target_id,'satellite_ticket',
    CASE WHEN v_satellite THEN v_target.buy_in_amount + COALESCE(v_target.buy_in_fee,0) END);
END $function$;

-- The staff door: unchanged in who may call it and in what it audits. It now
-- runs the shared core, so a platform admin may also create a guaranteed
-- event, a freeroll or a satellite with promised seats, under the same rules
-- the scheduled door runs.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_create_tournament(p_config jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='28000'; END IF;
  IF NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_tournament_staff_only' USING ERRCODE='42501';
  END IF;
  -- DIAMOND PHASE 11: a signed-out staff token moves nothing here either.
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE='28000';
  END IF;
  -- DIAMOND PHASE 10: the answer files its audit row on the way out.
  RETURN public.fn_poker_diamond_audit_tournament_created(
    public.fn_poker_diamond_create_tournament_core(p_config, jsonb_build_object('door', 'admin')));
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_create_tournament(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_create_tournament(jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. THE SCHEDULED DOOR
-- ---------------------------------------------------------------------------
-- One receipt per (schedule, scheduled start): the idempotency key of the
-- scheduled door and its audit row, since no staff member stands behind a
-- spawn. Append-only. No foreign key to tournaments (CLAUDE.md section 2, rule 7).
CREATE TABLE public.ca_diamond_scheduled_spawns (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  schedule_id     uuid        NOT NULL,
  scheduled_start timestamptz NOT NULL,
  tournament_id   uuid        NOT NULL UNIQUE,
  config          jsonb       NOT NULL,
  result          jsonb       NOT NULL,
  authority       text        NOT NULL CHECK (btrim(authority) <> ''),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ca_diamond_scheduled_spawns_one_per_occurrence UNIQUE (schedule_id, scheduled_start)
);
COMMENT ON TABLE public.ca_diamond_scheduled_spawns IS
  'One row per Diamond Arena tournament spawned from tournament_schedules by fn_poker_diamond_spawn_scheduled_tournament: the idempotency key (schedule, scheduled start) and the audit record of the config it was created from. Append-only.';
CREATE FUNCTION public.fn_ca_diamond_scheduled_spawns_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'ca_diamond_scheduled_spawns is append-only' USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_scheduled_spawns_append_only() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_ca_diamond_scheduled_spawns_append_only
  BEFORE UPDATE OR DELETE ON public.ca_diamond_scheduled_spawns
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_diamond_scheduled_spawns_append_only();
CREATE TRIGGER trg_ca_diamond_scheduled_spawns_no_truncate
  BEFORE TRUNCATE ON public.ca_diamond_scheduled_spawns
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_diamond_scheduled_spawns_append_only();
ALTER TABLE public.ca_diamond_scheduled_spawns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_diamond_scheduled_spawns FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.ca_diamond_scheduled_spawns TO service_role;

-- THE CONTRACT THE ENGINE CODES AGAINST (do not change it):
--   fn_poker_diamond_spawn_scheduled_tournament(p_schedule_id uuid,
--     p_scheduled_start timestamptz, p_config jsonb) RETURNS jsonb
--   -> {ok:true, tournament_id, replayed} | {ok:false, reason[, detail]}
-- service_role only; idempotent per (p_schedule_id, p_scheduled_start). See the
-- header of this file for every p_config key it reads.
CREATE FUNCTION public.fn_poker_diamond_spawn_scheduled_tournament(
  p_schedule_id uuid, p_scheduled_start timestamptz, p_config jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_arena uuid; v_s record; v_prior public.ca_diamond_scheduled_spawns%ROWTYPE;
  v_result jsonb; v_id uuid; v_state text; v_msg text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'service_role_only');
  END IF;
  IF p_schedule_id IS NULL OR p_scheduled_start IS NULL OR p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;
  SELECT c.id INTO v_arena FROM public.clubs c
   WHERE c.asset = 'diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL LIMIT 1;
  IF v_arena IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamond_arena_not_found');
  END IF;
  SELECT s.id, s.club_id, s.union_id, s.active INTO v_s
    FROM public.tournament_schedules s WHERE s.id = p_schedule_id FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'schedule_not_found'); END IF;
  IF v_s.club_id IS DISTINCT FROM v_arena OR v_s.union_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'schedule_is_not_a_diamond_arena_schedule');
  END IF;

  -- One spawn per occurrence: concurrent callers queue here, and the second
  -- finds the first one's receipt.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'diamond-scheduled-spawn:' || p_schedule_id::text || ':' || p_scheduled_start::text, 0));
  SELECT * INTO v_prior FROM public.ca_diamond_scheduled_spawns r
   WHERE r.schedule_id = p_schedule_id AND r.scheduled_start = p_scheduled_start;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', v_prior.tournament_id, 'replayed', true);
  END IF;

  IF v_s.active IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'schedule_not_active');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_arena_settings a
                  WHERE a.club_id = v_arena AND a.tournaments_enabled) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamond_tournaments_not_open');
  END IF;

  BEGIN
    v_result := public.fn_poker_diamond_create_tournament_core(p_config, jsonb_build_object(
      'door', 'schedule', 'schedule_id', p_schedule_id, 'scheduled_start', p_scheduled_start));
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      RETURN jsonb_build_object('ok', false, 'reason', 'scheduled_occurrence_already_on_the_board', 'detail', v_msg);
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RETURN jsonb_build_object('ok', false,
        'reason', btrim(split_part(split_part(v_msg, ':', 1), ' ', 1)),
        'detail', v_msg, 'sqlstate', v_state);
  END;
  v_id := (v_result->>'tournamentId')::uuid;
  INSERT INTO public.ca_diamond_scheduled_spawns
    (schedule_id, scheduled_start, tournament_id, config, result, authority)
  VALUES (p_schedule_id, p_scheduled_start, v_id, p_config, v_result,
    'tournament_schedules row ' || p_schedule_id::text
    || ', seeded under Dan 2026-10-06: "USE THE SAME TOURNAMENT SCHEDULE AND RAKE AS THE MIDWAY UNION FOR NOW"');
  RETURN jsonb_build_object('ok', true, 'tournament_id', v_id, 'replayed', false,
    'buy_in_amount', v_result->'buy_in_amount', 'buy_in_fee', v_result->'buy_in_fee',
    'bounty_amount', v_result->'bounty_amount', 'guaranteed_prize', v_result->'guaranteed_prize');
END $$;

-- ---------------------------------------------------------------------------
-- 7. ASSERTED SUBSTITUTIONS INTO THE LIVE BODIES
-- ---------------------------------------------------------------------------
-- Each body is read from the database, required to carry its pinned md5, and
-- every clause replaced is required to occur exactly once. The helper lives in
-- pg_temp and dies with the session (CLAUDE.md 11.5 rule 4).
CREATE FUNCTION pg_temp.ca_substitute(p_fn regprocedure, p_pin text, p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_def text := pg_get_functiondef(p_fn); i integer; v_n integer;
BEGIN
  IF md5(v_def) <> p_pin THEN
    RAISE EXCEPTION '% moved off its pin % (now %)', p_fn, p_pin, md5(v_def);
  END IF;
  FOR i IN 1..array_length(p_old, 1) LOOP
    v_n := (length(v_def) - length(replace(v_def, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '% clause % occurs % times, expected exactly once', p_fn, i, v_n;
    END IF;
    v_def := replace(v_def, p_old[i], p_new[i]);
  END LOOP;
  EXECUTE v_def;
  IF md5(pg_get_functiondef(p_fn)) = p_pin THEN
    RAISE EXCEPTION '% did not change', p_fn;
  END IF;
END $f$;

SELECT pg_temp.ca_substitute('public.trg_tournaments_guarantee_affordable()'::regprocedure, 'df859238ed5ef32a565a44b6bd7143ea',
  ARRAY[$o0$  if exists (select 1 from public.clubs c where c.id = new.club_id and c.asset = 'diamonds') then
    raise exception 'diamond_guarantee_has_no_chip_bank' using errcode = '55000';
  end if;
$o0$],
  ARRAY[$n0$  -- 2026-10-06 (20261007000010): a Diamond event's guarantee is never read
  -- against a chip bank. It is admitted only when the house has set aside,
  -- under 'guarantee:<id>', every Diamond of it the prize pool does not
  -- already hold. An un-earmarked Diamond guarantee is still refused, by name.
  if exists (select 1 from public.clubs c where c.id = new.club_id and c.asset = 'diamonds') then
    if public.fn_ca_diamond_earmark_open('guarantee:' || new.id::text)
       < greatest(coalesce(new.guaranteed_prize, 0) - coalesce(new.prize_pool, 0), 0) then
      raise exception 'diamond_guarantee_is_not_set_aside' using errcode = '55000';
    end if;
    return new;
  end if;
$n0$]);

SELECT pg_temp.ca_substitute('public.fn_ca_fund_overlay_on_lock()'::regprocedure, '3f55869778cc3c02ca1406fa22c908d4',
  ARRAY[$o0$  IF v_short <= 0 THEN RETURN NEW; END IF;
$o0$,$o1$  IF EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = NEW.club_id AND c.asset = 'diamonds') THEN
    RAISE EXCEPTION 'diamond_overlay_has_no_chip_bank' USING ERRCODE = '55000';
  END IF;
$o1$],
  ARRAY[$n0$  /* 2026-10-06 (20261007000010): A DIAMOND OVERLAY IS PAID FROM THE HOUSE AT
     LOCK. The shortfall moves from ca_diamond_house into the event's entry
     custody through fn_poker_diamond_tournament_settle_overlay (a house burn
     and a player-registered credit per custody share, each with its movement
     and an 'overlay' ledger row, so custody and the ledger agree), the
     earmark records the payment, and whatever the guarantee no longer needs
     is released back to the house's available balance. Never a chip bank. */
  IF EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = NEW.club_id AND c.asset = 'diamonds') THEN
    IF v_short > 0 THEN
      v_short := public.fn_poker_diamond_tournament_settle_overlay(NEW.id, 'lock', v_guarantee);
      NEW.prize_pool := round(v_pool_before + v_short, 2);
    END IF;
    PERFORM public.fn_poker_diamond_guarantee_release(NEW.id, 'lock');
    RETURN NEW;
  END IF;
  IF v_short <= 0 THEN RETURN NEW; END IF;
$n0$,$n1$  -- (2026-10-06: the Diamond arm above returns before this point.)
$n1$]);

SELECT pg_temp.ca_substitute('public.fn_ca_return_excess_start_overlay_locked(uuid)'::regprocedure, '2e670daae9319aed70b3477283aacba5',
  ARRAY[$o0$    RETURN NULL;  -- a finalized pool is never repriced
  END IF;
$o0$],
  ARRAY[$n0$    RETURN NULL;  -- a finalized pool is never repriced
  END IF;
  /* 2026-10-06 (20261007000010): A DIAMOND GUARANTEE IS A FLOOR TOO. When the
     prize pool closes, a Diamond event's pool is brought to exactly
     max(guarantee, collected): overlay the entries collected since lock made
     unnecessary returns from the custody to the house, and any guarantee
     still uncovered is paid from its earmark. One function, the same one the
     lock uses; the unused earmark is released. */
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    v_excess := public.fn_poker_diamond_tournament_settle_overlay(p_tournament_id, 'finalize',
                  public.fn_poker_diamond_tournament_effective_guarantee(p_tournament_id));
    PERFORM public.fn_poker_diamond_guarantee_release(p_tournament_id, 'finalize');
    IF v_excess = 0 THEN RETURN NULL; END IF;
    UPDATE public.tournaments SET prize_pool = round(COALESCE(prize_pool, 0) + v_excess, 2)
     WHERE id = p_tournament_id;
    RETURN jsonb_build_object('asset', 'diamonds', 'bank_type', 'diamond_house',
      'overlay_delta', v_excess, 'amount', GREATEST(-v_excess, 0),
      'pool_before', round(COALESCE(v_t.prize_pool, 0), 2),
      'pool_after', round(COALESCE(v_t.prize_pool, 0) + v_excess, 2));
  END IF;
$n0$]);

SELECT pg_temp.ca_substitute('public.fn_tournament_management_readiness_for_row(jsonb)'::regprocedure, '885132de6733f2c3d9c79c33345af45c',
  ARRAY[$o0$  v_locked := EXISTS (
$o0$],
  ARRAY[$n0$  -- 2026-10-06 (20261007000010): A DIAMOND EVENT'S BANK IS ITS EARMARK. The
  -- Diamond Arena holds no chips; its guarantee is set aside on the house at
  -- creation under 'guarantee:<id>', so that earmark, and nothing else, is
  -- what covers this event's own overlay.
  IF v_row_union IS NULL AND EXISTS (SELECT 1 FROM public.clubs c
                                      WHERE c.id = v_club AND c.asset = 'diamonds'
                                        AND c.is_platform IS TRUE AND c.union_id IS NULL) THEN
    v_bank_type := 'diamond_house_earmark';
    v_bank := public.fn_ca_diamond_earmark_open('guarantee:' || v_id::text);
    v_floor := 0;
    v_exposure := 0;
    v_portfolio_short := greatest(v_required - v_bank, 0);
    v_short := CASE WHEN v_required > 0 THEN greatest(v_required - v_bank, 0) ELSE 0 END;
  END IF;
  v_locked := EXISTS (
$n0$]);

SELECT pg_temp.ca_substitute('public.fn_poker_diamond_tournament_drain(uuid,text,bigint,text,text,uuid)'::regprocedure, 'ceffb36777bfa7067c4fac90c51d5858',
  ARRAY[$o0$l.kind IN ('entry','rebuy','reentry','addon','spin_underwrite'))$o0$,$o1$        CASE WHEN p_bank='prize' THEN 'arena_spin_surplus' ELSE 'tournament_fee' END,
        CASE WHEN p_bank='prize' THEN 'arena_spin_surplus' ELSE 'tournament_fee' END,-v_take::integer,v_wallet,$o1$,$o2$             THEN 'Diamond Spin surplus: '$o2$],
  ARRAY[$n0$l.kind IN ('entry','rebuy','reentry','addon','spin_underwrite','overlay'))$n0$,$n1$        CASE WHEN p_bank='prize' AND p_reason LIKE 'poker-guarantee-overlay-return:%' THEN 'arena_guarantee_overlay_return'
             WHEN p_bank='prize' THEN 'arena_spin_surplus' ELSE 'tournament_fee' END,
        CASE WHEN p_bank='prize' AND p_reason LIKE 'poker-guarantee-overlay-return:%' THEN 'arena_guarantee_overlay_return'
             WHEN p_bank='prize' THEN 'arena_spin_surplus' ELSE 'tournament_fee' END,-v_take::integer,v_wallet,$n1$,$n2$             AND p_reason LIKE 'poker-guarantee-overlay-return:%'
             THEN 'Diamond guarantee overlay returned: '||COALESCE(v_name,'tournament')||' collected more than its guarantee needed (from custody to the house)'
             WHEN p_bank='prize'
             THEN 'Diamond Spin surplus: '$n2$]);

SELECT pg_temp.ca_substitute('public.fn_poker_diamond_tournament_refund(uuid,uuid,text,text,uuid)'::regprocedure, 'a1b8b3b5bd4d7d50af063a3534f6372b',
  ARRAY[$o0$    RAISE EXCEPTION 'diamond_spin_entry_already_booked' USING ERRCODE='55000';
  END IF;
$o0$,$o1$  IF v_c.state<>'active' OR v_c.balance<1 OR v_c.seat_id IS NOT NULL THEN$o1$],
  ARRAY[$n0$    RAISE EXCEPTION 'diamond_spin_entry_already_booked' USING ERRCODE='55000';
  END IF;
  -- 2026-10-06 (20261007000010): a guaranteed event whose overlay the house
  -- has paid into custody has started; its entries are its prize pool.
  IF EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l
              WHERE l.tournament_id=p_tournament_id AND l.kind IN ('overlay','overlay_return')) THEN
    RAISE EXCEPTION 'diamond_guaranteed_entry_already_funded' USING ERRCODE='55000';
  END IF;
$n0$,$n1$  -- 2026-10-06 (20261007000010): A FREEROLL ENTRY HOLDS NOTHING. Its custody
  -- row was opened at zero (fn_poker_diamond_tournament_free_entry) and has
  -- taken no inflow, so it is released whole, at zero, and no ledger row is
  -- written: there is nothing to return.
  IF v_c.state='active' AND v_c.balance=0 AND v_c.seat_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l WHERE l.custody_id=v_c.id) THEN
    PERFORM set_config('app.poker_diamond_tournament_release', v_c.id::text, true);
    v_receipt := public.fn_poker_diamond_release(v_c.id, p_request_id);
    PERFORM set_config('app.poker_diamond_tournament_release', '', true);
    IF COALESCE((v_receipt->>'success')::boolean,false) IS NOT TRUE OR (v_receipt->>'amount')::bigint <> 0 THEN
      RAISE EXCEPTION 'diamond_tournament_release_failed' USING ERRCODE='P0404';
    END IF;
    RETURN jsonb_build_object('ok',true,'fully_settled',true,'remaining',0,'paid',0,'free_entry',true,
      'refund_prize',0,'refund_bounty',0,'refund_fee',0,'custody_id',v_c.id,'ledger_id',NULL,
      'obligation_id',NULL,'journal_id',NULL,'available_balance',v_receipt->>'available_balance');
  END IF;
  IF v_c.state<>'active' OR v_c.balance<1 OR v_c.seat_id IS NOT NULL THEN$n1$]);

SELECT pg_temp.ca_substitute('public.fn_poker_diamond_tournament_cancel(uuid,uuid)'::regprocedure, 'ee91eac08d166e096ca5faa8c52ff296',
  ARRAY[$o0$  UPDATE public.tournament_players
     SET status='eliminated',eliminated_at=v_cancelled_at,chips=0,current_bounty=0
   WHERE tournament_id=p_tournament_id;$o0$],
  ARRAY[$n0$  -- 2026-10-06 (20261007000010): a cancelled event keeps no promise; its
  -- guarantee earmark is released back to the house's available balance.
  PERFORM public.fn_poker_diamond_guarantee_release(p_tournament_id, 'cancel');
  UPDATE public.tournament_players
     SET status='eliminated',eliminated_at=v_cancelled_at,chips=0,current_bounty=0
   WHERE tournament_id=p_tournament_id;$n0$]);

SELECT pg_temp.ca_substitute('public.fn_poker_diamond_tournament_close_custody(uuid)'::regprocedure, '2c1ca86d949cc689fe1f19c98e08b9db',
  ARRAY[$o0$  RETURN jsonb_build_object('ok',true,'closed',v_n,'still_held',0);$o0$],
  ARRAY[$n0$  -- 2026-10-06 (20261007000010): a completed event keeps no promise; any
  -- guarantee earmark still open is released (fn_settle_tournament_rake calls
  -- this door at the terminal).
  PERFORM public.fn_poker_diamond_guarantee_release(p_tournament_id, 'complete');
  RETURN jsonb_build_object('ok',true,'closed',v_n,'still_held',0);$n0$]);

SELECT pg_temp.ca_substitute('public.fn_register_for_tournament_before_atomic_capacity_20260907(uuid,boolean)'::regprocedure, '591867b92e0749eb0e493c56707ae328',
  ARRAY[$o0$  ELSIF v_split.charge > 0 THEN
    -- CHIP STANDARD 1.2 (2026-09-02): THE REGISTRATION DEBIT$o0$],
  ARRAY[$n0$  ELSIF v_split.charge = 0 AND v_unit = 100 THEN
    -- 2026-10-06 (20261007000010): A DIAMOND FREEROLL ENTRY. Nothing is
    -- charged; the entry is an active custody row at zero, so the seat guards
    -- (P0810, P0812) admit the seat and a one-Diamond rebuy or add-on has an
    -- entry to land in. A horse enters through this same arm (CLAUDE.md 10.5).
    v_player_id := gen_random_uuid();
    BEGIN
      v_dia := public.fn_poker_diamond_tournament_free_entry(v_uid, p_tournament_id, v_player_id);
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '%diamond_tournaments_not_open%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'diamond_tournaments_not_open');
      ELSIF SQLERRM LIKE '%diamond_tournament_entry_already_held%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
      END IF;
      RAISE;
    END;
  ELSIF v_split.charge > 0 THEN
    -- CHIP STANDARD 1.2 (2026-09-02): THE REGISTRATION DEBIT$n0$]);

SELECT pg_temp.ca_substitute('public.fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid)'::regprocedure, '7afb8f82f3d9de26ddec4d6c13ff9d45',
  ARRAY[$o0$  ELSIF v_split.charge > 0 THEN
    -- CHIP STANDARD 1.2 (2026-09-02): THE HORSE DOOR$o0$],
  ARRAY[$n0$  ELSIF v_split.charge = 0 AND v_unit = 100 THEN
    -- 2026-10-06 (20261007000010): A DIAMOND FREEROLL ENTRY. Nothing is
    -- charged; the entry is an active custody row at zero, so the seat guards
    -- (P0810, P0812) admit the seat and a one-Diamond rebuy or add-on has an
    -- entry to land in. A horse enters through this same arm (CLAUDE.md 10.5).
    v_player_id := gen_random_uuid();
    BEGIN
      v_dia := public.fn_poker_diamond_tournament_free_entry(p_user_id, p_tournament_id, v_player_id);
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '%diamond_tournaments_not_open%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'diamond_tournaments_not_open');
      ELSIF SQLERRM LIKE '%diamond_tournament_entry_already_held%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
      END IF;
      RAISE;
    END;
  ELSIF v_split.charge > 0 THEN
    -- CHIP STANDARD 1.2 (2026-09-02): THE HORSE DOOR$n0$]);


-- Watched guards moved on purpose, in this transaction.
SELECT public.fn_ca_declare_guard_redefinition(n, '20261007000010_the_diamond_arena_spawns_the_midway_schedule')
  FROM unnest(ARRAY['fn_poker_diamond_tournament_drain','fn_poker_diamond_tournament_refund',
                    'fn_poker_diamond_tournament_cancel','fn_poker_diamond_tournament_close_custody',
                    'fn_poker_diamond_tournament_open_shadow']) AS n;

-- ---------------------------------------------------------------------------
-- 8. GRANTS: only the scheduled door is reachable, and only by the engine.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fn_poker_diamond_create_tournament_core(jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_settle_overlay(uuid, text, numeric) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_guarantee_release(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_free_entry(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_effective_guarantee(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_spawn_scheduled_tournament(uuid, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_spawn_scheduled_tournament(uuid, timestamptz, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- 9. POST-IMAGE
-- ---------------------------------------------------------------------------
DO $post$
BEGIN
  IF has_function_privilege('authenticated', 'public.fn_poker_diamond_spawn_scheduled_tournament(uuid,timestamptz,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_poker_diamond_spawn_scheduled_tournament(uuid,timestamptz,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_poker_diamond_spawn_scheduled_tournament(uuid,timestamptz,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-image: the scheduled door is reachable by the wrong roles';
  END IF;
  IF has_function_privilege('authenticated', 'public.fn_poker_diamond_create_tournament_core(jsonb,jsonb)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.fn_poker_diamond_create_tournament_core(jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-image: the creation core is reachable from a client role';
  END IF;
  IF public.fn_ca_diamond_economic_text('freeroll_rebuy_cost') <> 'one_diamond_to_the_prize_pool'
     OR public.fn_ca_diamond_economic_text('freeroll_addon_cost') <> 'one_diamond_to_the_prize_pool' THEN
    RAISE EXCEPTION 'post-image: the freeroll answer did not land';
  END IF;
  IF position('fn_poker_diamond_tournament_close_custody' IN
       pg_get_functiondef('public.fn_settle_tournament_rake(uuid,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'post-image: the terminal no longer closes Diamond custody, so completion would not release the earmark';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_diamond_house_earmarks) THEN
    RAISE EXCEPTION 'post-image: this file promised nothing and must leave the earmark ledger empty';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'post-image: the Diamond identity is not whole';
  END IF;
END $post$;

COMMIT;

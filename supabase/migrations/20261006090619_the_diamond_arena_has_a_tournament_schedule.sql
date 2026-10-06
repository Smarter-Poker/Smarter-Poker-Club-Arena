-- ============================================================================
-- THE DIAMOND ARENA HAS A TOURNAMENT SCHEDULE
-- ============================================================================
--
-- The Diamond Arena (club 002c2d27-9584-4e52-835a-bb2be148fc81, asset
-- 'diamonds', is_platform true, union_id NULL) has ca_arena_settings
-- .tournaments_enabled = true and, measured on production 2026-10-06
-- (read-only, REPEATABLE READ), ZERO tournaments of any status and ZERO
-- tournament_schedules rows, while 271 schedule rows and 438,803 tournaments
-- exist platform-wide, every one of them a chip club. A player arriving at the
-- arena finds an empty lobby. This file gives it a starter recurring schedule
-- modelled on Midway Union, the estate's own reference board.
--
-- It adds five tournament_schedules rows and nothing else. It creates no
-- table, function, trigger or policy, changes no existing row, and does not
-- touch either arena switch.
--
-- ----------------------------------------------------------------------------
-- WHAT THE DOOR ACTUALLY PERMITS A DIAMOND EVENT TO BE
-- ----------------------------------------------------------------------------
--
-- Measured on production 2026-10-06 by reading the live function bodies, not
-- from a document. Three of the five Midway event families are REFUSED for a
-- Diamond club today, and this schedule therefore does not contain them. A
-- schedule that spawns a refusal is worse than no schedule.
--
-- 1. A GUARANTEE IS REFUSED BY NAME. trg_tournaments_guarantee_affordable is a
--    BEFORE INSERT trigger on public.tournaments with
--    WHEN (COALESCE(new.guaranteed_prize,0) > 0), and its body opens:
--
--      if exists (select 1 from public.clubs c
--                  where c.id = new.club_id and c.asset = 'diamonds') then
--        raise exception 'diamond_guarantee_has_no_chip_bank' using errcode='55000';
--
--    So ANY Diamond event carrying a positive guarantee cannot be inserted at
--    all. The recorded owner answers in ca_diamond_economics
--    (guarantee_authority = platform_admin, guarantee_overlay_account =
--    ca_diamond_house, guarantee_max_per_event = 1,000,000,
--    guarantee_max_outstanding = 2,000,000, all approved 2026-10-05) describe
--    the guarantee the arena is MEANT to have; the door has not been opened to
--    it yet. Every row below therefore carries guaranteedPrize 0, and says so
--    in its own shortDescription using Midway's existing wording for an
--    unguaranteed event ("No Guarantee"). Nothing here promises money the door
--    will not let the arena promise.
--
-- 2. A SATELLITE IS REFUSED BY NAME. fn_award_satellite_seat, the only door
--    that seats a satellite winner, opens:
--
--      IF public.fn_poker_diamond_tournament(p_satellite_id)
--         OR public.fn_poker_diamond_tournament(p_target_id) THEN
--        RAISE EXCEPTION 'diamond_satellite_is_never_settled_on_chip_rails: ...'
--
--    and fn_settle_satellite_finish_atomic refuses the same pair. A Diamond
--    satellite would spawn, take entries, run to its finish and then be unable
--    to deliver the seat it sold. That is the worst failure available here, so
--    there is NO satellite in this schedule. Midway's two satellite rows are
--    deliberately not cloned.
--
-- 3. A SPIN IS NOT SCHEDULED. clubs.spins_enabled is false on the arena and
--    fn_spin_tournament_contract_is_draw carries an unfinished Diamond branch.
--    Midway's spin row is not cloned.
--
--    What IS permitted, and is used below:
--
-- 4. A FREEROLL IS PERMITTED. ca_diamond_economics.freeroll_allowed = 'yes'
--    (approved 2026-10-05), and no door refuses a 0-buy-in Diamond event:
--    fn_is_free_buy_event reads only the money, type and variant, and
--    fn_freerolls_are_free_buy NORMALIZES such a row rather than refusing it.
--    NOTE FOR THE RECORD, because it is a real disagreement and not a defect
--    this file may paper over: the recorded answers freeroll_rebuy_cost and
--    freeroll_addon_cost are both 'none_offered' (a Diamond freeroll is a
--    freezeout), while fn_freerolls_are_free_buy forces is_rebuy,
--    add_on_available, rebuy_cost 1.00 and addon_cost 1.00 onto every free-buy
--    MTT regardless of asset. The freeroll row below authors NEITHER a rebuy
--    nor an add-on, so the figure that reaches the database is the trigger's,
--    not one invented here. One Diamond is a whole Diamond, so no fractional
--    value can result; reconciling the trigger with the recorded answer is a
--    change to that function, not to a schedule row, and is reported rather
--    than worked around.
--
-- 5. A BOUNTY AND A PROGRESSIVE BOUNTY ARE PERMITTED. The Diamond rails for
--    them exist and are asset-aware: fn_claim_tournament_bounty_elimination
--    and fn_eliminate_tournament_player_atomic both carry a DIAMOND PHASE 8
--    branch, and fn_ca_tournament_terminal_receipt carries a DIAMOND PHASE 9
--    branch reading "a Diamond bounty is a ledger row, not a wallet row".
--    Neither raises for a Diamond club.
--
--    A MYSTERY BOUNTY is left out of this starter board: it is the one bounty
--    family whose creation contract (fn_guard_tournament_mystery_creation_
--    contract, plus five mystery_bounty_* columns) was not established for a
--    Diamond club in this pass, and "basic" does not require it. The
--    progressive bounty covers the same ground with a verified door.
--
-- 6. NO UNIONS AND NO AGENTS. tournament_schedules.union_id is nullable and
--    every row below sets it NULL explicitly. The spawner copies it verbatim
--    (ScheduledTournamentService: `union_id: schedule.union_id ?? null`,
--    `is_xmtt: !!schedule.union_id`), and fn_stamp_tournament_union_ownership
--    cannot back-fill one here because the arena has no union_clubs row
--    (measured: 0) and clubs.union_id is NULL. This matters because
--    fn_poker_guard_arena_structure refuses a Diamond game whose union_id is
--    not NULL ('Diamond Games Cannot Belong To A Union'), and because
--    fn_poker_diamond_tournament only recognises a Diamond event when
--    c.union_id IS NULL AND t.union_id IS NULL - a stamped union_id would
--    silently take every Diamond money door offline for the event.
--
--    The poker_arena_no_hierarchy trigger (fn_poker_reject_diamond_hierarchy,
--    "Diamond Arena Has No Agents Or Commissions") is installed on exactly
--    eleven tables, measured 2026-10-06: agents, sub_agents,
--    player_agent_assignments, agent_commissions,
--    agent_commission_settlements, ca_club_commission_daily, rakeback_periods,
--    rakeback_daily_state, rakeback_daily_user, rakeback_distributions,
--    rakeback_period_payouts. Neither tournament_schedules,
--    tournament_schedule_spawns nor tournaments is among them, so that law
--    does not sit on this path. It is satisfied, not avoided: nothing below
--    names an agent, a commission or a union.
--
-- ----------------------------------------------------------------------------
-- WHERE EVERY NUMBER COMES FROM. NOTHING HERE IS INVENTED.
-- ----------------------------------------------------------------------------
--
-- THE UNIT. The Diamond Arena is a diamonds-only 1:1 clone of a chip club and
-- the conversion is the one 20261005183028_diamond_cash_rake_reads_the_owner_
-- settings established for the cash ladder: ONE CHIP CENT BECOMES ONE DIAMOND.
-- The code says the same thing twice over: tournamentUnit.ts sets
-- DIAMOND_UNIT_CENTS = 100, so one Diamond is 1.00 in a numeric money column,
-- and fn_guard_tournament_prize_math_contract resolves
--
--   CASE WHEN c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL
--        THEN 100 ELSE 1 END
--
-- into payout_unit_cents with the comment "a caller cannot request fractional
-- Diamonds". Every money field below is therefore a WHOLE number.
--
-- THE LADDER. Midway's chip buy-in totals, read in the Diamond unit:
--
--   chip 3.30 -> 330      chip 5.50 -> 550      chip 8.80 -> 880
--   chip 11.00 -> 1100    chip 22.00 -> 2200
--
-- Those converted figures cannot be authored as they stand, and this is the
-- single most important constraint in this file. ScheduledTournamentService
-- does not store config.buyIn: it reads it as the TOTAL and passes it through
--
--   const buyIn = wholeChips(cfg.buyIn);
--   const split = buyIn > 0 ? buyInFor(buyIn, rakeRate) : {total:0,prize:0,fee:0};
--
-- and buyInFor is splitBuyIn(snapToWholeBuyIn(amount)) - it SNAPS the total
-- onto BUY_IN_LADDER (server/src/config/buyIn.ts), which is
-- 1,2,3,5,10,15,20,25,30,50,75,100,150,200,250,300,500,750,1000,1500,2000,5000.
-- An off-ladder figure is silently repriced to its nearest rung, so an
-- authored 550 would charge the player 500. The authored figure must already
-- BE the rung it snaps to:
--
--   snapToWholeBuyIn(330)  = 300      (|300-330|=30  beats |500-330|=170)
--   snapToWholeBuyIn(550)  = 500      (|500-550|=50  beats |750-550|=200)
--   snapToWholeBuyIn(880)  = 1000     (|1000-880|=120 beats |750-880|=130)
--   snapToWholeBuyIn(1100) = 1000     (|1000-1100|=100 beats |1500-1100|=400)
--   snapToWholeBuyIn(2200) = 2000     (|2000-2200|=200; 2500 is not a rung)
--
-- THE SECOND FILTER. The fee is floor(total x 0.10) to the cent (feeToCents,
-- a floor and never a round, so the 10% ceiling is never breached), and the
-- prize side is total - fee. For the fee AND the prize to be whole Diamonds
-- the total must be a multiple of 10. 300, 500, 1000 and 2000 all are; the
-- 1/2/3/5/15/25/75 rungs are not and are unusable in this arena.
--
-- So the Diamond starter ladder is 0, 300, 500, 1000, 2000, splitting as
--
--   total 300  -> buy_in_amount 270  + buy_in_fee 30
--   total 500  -> buy_in_amount 450  + buy_in_fee 50
--   total 1000 -> buy_in_amount 900  + buy_in_fee 100
--   total 2000 -> buy_in_amount 1800 + buy_in_fee 200
--
-- each satisfying fn_enforce_whole_dollar_buyin (prize + fee is whole) with
-- every one of the six money fields a whole Diamond.
--
-- THE BOUNTY FIGURES, read off Midway's own rule rather than chosen. Midway's
-- fixed-bounty rows say "25% Of Each Entry Contribution Funds A Fixed Knockout
-- Bounty" and, at chip buyIn 11 (prize side 10), carry bountyAmount 2.5 -
-- 25% of the PRIZE side, not of the total. Its PKO row says 50% and, at chip
-- buyIn 15 (prize side 13.50), carries bountyAmount 6.75 - again 50% of the
-- prize side. Applied to the Diamond rungs:
--
--   bounty at 1000:             25% of 900  = 225   (whole)
--   progressive bounty at 2000: 50% of 1800 = 900   (whole)
--
-- and fn_tournament_entry_split then reconciles exactly: 675 + 225 + 100 =
-- 1000, and 900 + 900 + 200 = 2000.
--
-- THE STACKS, PRESETS, FIELD SIZES AND LATE-REG LEVELS are Midway's own,
-- carried across UNCHANGED, because a starting stack is tournament chips and
-- not money: the clone swaps the money unit, not the chip count. Freeroll
-- 5000 / STANDARD / 6 levels; turbo 12000 / TURBO / 7; deep stack 30000 /
-- DEEPSTACK / 9; fixed bounty 18000 / STANDARD / 8; PKO 22000 / TURBO / 9.
-- tableSize 9, maxPlayers 500, minPlayers 4 and payoutPreset NINE are
-- Midway's values on every corresponding row.
--
-- THE CLOCK. days_of_week [0,1,2,3,4,5,6] (daily), time_zone NULL and
-- interval_minutes NULL on every row, which is Midway's own shape on 93 of its
-- 94 rows. The eight daily start times are Midway's own slots: 05:00, 11:00,
-- 17:00 and 23:00 are its four freeroll slots verbatim; 01:00 is its Midweek
-- Bounty slot; 03:00 its PKO slot; 14:00 its morning slot; 20:00 its prime
-- evening slot. The result is an event roughly every three hours, so the lobby
-- is never empty.
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5, no exceptions). horsesToRegister is 0 on
-- every row, SET EXPLICITLY and not omitted, because omitting it is not
-- neutral: ScheduledTournamentService falls back to min_players when the key
-- is absent or unparseable, which would pre-seat three horses into every
-- Diamond event at spawn. 0 does not exclude horses - the spawner's own log
-- line for it reads "open for registration, horses join at start", and
-- GameServer's past-start top-up fills any short field on the clock, exactly
-- as it does for a chip event. A horse funds the entry from its own balance
-- through the same door a person uses: ca_diamond_economics.horse_entry_funding
-- = 'own_balance' (approved 2026-10-05), which
-- fn_register_horse_for_tournament now reads AT CALL TIME. So 0 is the only
-- value that leaves a horse neither privileged with a free pre-seat nor
-- excluded from the board, and it is also the value all 94 Midway rows carry.
--
-- COPY. Every shortDescription is Title Case, carries no em dash, and either
-- is Midway's own sentence verbatim or states the guarantee position in
-- Midway's own wording.
--
-- ============================================================================

BEGIN;

-- ── PRE-IMAGE ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_asset text; v_platform boolean; v_union uuid; v_existing integer;
  v_union_clubs integer;
BEGIN
  SELECT c.asset, c.is_platform, c.union_id
    INTO v_asset, v_platform, v_union
    FROM public.clubs c
   WHERE c.id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pre-image: the Diamond Arena club does not exist';
  END IF;
  IF v_asset IS DISTINCT FROM 'diamonds' OR v_platform IS NOT TRUE
     OR v_union IS NOT NULL THEN
    RAISE EXCEPTION
      'pre-image: 002c2d27 is not the platform Diamond arena (asset %, is_platform %, union_id %)',
      v_asset, v_platform, v_union;
  END IF;

  SELECT count(*) INTO v_union_clubs FROM public.union_clubs
   WHERE club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid;
  IF v_union_clubs <> 0 THEN
    RAISE EXCEPTION
      'pre-image: the arena has % union_clubs row(s); fn_stamp_tournament_union_ownership would back-fill a union_id onto every spawn',
      v_union_clubs;
  END IF;

  SELECT count(*) INTO v_existing FROM public.tournament_schedules
   WHERE club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid;
  IF v_existing <> 0 THEN
    RAISE EXCEPTION
      'pre-image: the arena already holds % schedule row(s); this file is written for an empty board',
      v_existing;
  END IF;
END $$;

-- ── THE FIVE ROWS ──────────────────────────────────────────────────────────
-- union_id is NULL on every row. guaranteedPrize is 0 on every row. No
-- satellite, no spin, no mystery bounty. Every money field a whole Diamond.

INSERT INTO public.tournament_schedules
  (union_id, club_id, name, description, active, days_of_week, start_times_utc,
   interval_minutes, time_zone, config)
VALUES
  -- 1. The free door into the arena. Four slots a day, Midway's own freeroll
  --    spine. Authored as a freezeout per freeroll_rebuy_cost /
  --    freeroll_addon_cost = 'none_offered'.
  (NULL, '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid,
   'Diamond Freeroll',
   'The free daily door into the Diamond Arena. Four slots a day.',
   true, ARRAY[0,1,2,3,4,5,6]::integer[],
   ARRAY['05:00','11:00','17:00','23:00']::text[], NULL, NULL,
   jsonb_build_object(
     'name','Diamond Freeroll',
     'type','mtt',
     'buyIn',0,
     'gameVariant','nlh',
     'blindPreset','STANDARD',
     'payoutPreset','NINE',
     'startingStack',5000,
     'tableSize',9,
     'maxPlayers',500,
     'minPlayers',4,
     'bigBlindAnte',true,
     'guaranteedPrize',0,
     'horsesToRegister',0,
     'lateRegistrationLevels',6,
     'shortDescription','Entry Is Free. No Guarantee.')),

  -- 2. The cheapest priced rung: Midway chip 3.30 read in Diamonds (330),
  --    snapped to its ladder rung 300 = 270 + 30.
  (NULL, '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid,
   'Diamond Daily Turbo 300',
   'The entry-priced daily turbo. 300 Diamonds, 270 to the prize pool.',
   true, ARRAY[0,1,2,3,4,5,6]::integer[], ARRAY['14:00']::text[], NULL, NULL,
   jsonb_build_object(
     'name','Diamond Daily Turbo 300',
     'type','mtt',
     'buyIn',300,
     'gameVariant','nlh',
     'blindPreset','TURBO',
     'payoutPreset','NINE',
     'startingStack',12000,
     'tableSize',9,
     'maxPlayers',500,
     'minPlayers',4,
     'bigBlindAnte',true,
     'guaranteedPrize',0,
     'horsesToRegister',0,
     'lateRegistrationLevels',7,
     'shortDescription','300 Diamonds To Enter. No Guarantee.')),

  -- 3. Midway chip 5.50 read in Diamonds (550), snapped to 500 = 450 + 50,
  --    on Midway's deep stack structure.
  (NULL, '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid,
   'Diamond Daily Deep Stack 500',
   'The prime evening deep stack. 500 Diamonds, 450 to the prize pool.',
   true, ARRAY[0,1,2,3,4,5,6]::integer[], ARRAY['20:00']::text[], NULL, NULL,
   jsonb_build_object(
     'name','Diamond Daily Deep Stack 500',
     'type','mtt',
     'buyIn',500,
     'gameVariant','nlh',
     'blindPreset','DEEPSTACK',
     'payoutPreset','NINE',
     'startingStack',30000,
     'tableSize',9,
     'maxPlayers',500,
     'minPlayers',4,
     'bigBlindAnte',true,
     'guaranteedPrize',0,
     'horsesToRegister',0,
     'lateRegistrationLevels',9,
     'shortDescription','500 Diamonds To Enter. No Guarantee.')),

  -- 4. Midway chip 8.80/11.00 read in Diamonds (880/1100), both snapping to
  --    1000 = 900 + 100. Fixed knockout bounty at Midway's own 25% of the
  --    prize side: 225.
  (NULL, '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid,
   'Diamond Bounty Hunt 1000',
   'The nightly fixed knockout bounty. 1,000 Diamonds, 225 of it the bounty.',
   true, ARRAY[0,1,2,3,4,5,6]::integer[], ARRAY['01:00']::text[], NULL, NULL,
   jsonb_build_object(
     'name','Diamond Bounty Hunt 1000',
     'type','bounty',
     'buyIn',1000,
     'bountyAmount',225,
     'gameVariant','nlh',
     'blindPreset','STANDARD',
     'payoutPreset','NINE',
     'startingStack',18000,
     'tableSize',9,
     'maxPlayers',500,
     'minPlayers',4,
     'bigBlindAnte',true,
     'guaranteedPrize',0,
     'horsesToRegister',0,
     'lateRegistrationLevels',8,
     'shortDescription','25% Of Each Entry Contribution Funds A Fixed Knockout Bounty. No Guarantee.')),

  -- 5. Midway chip 22.00 read in Diamonds (2200), snapped to 2000 = 1800 +
  --    200. Progressive bounty at Midway's own 50% of the prize side: 900.
  (NULL, '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid,
   'Diamond Progressive Bounty 2000',
   'The top of the starter board. 2,000 Diamonds, half of it progressive bounty.',
   true, ARRAY[0,1,2,3,4,5,6]::integer[], ARRAY['03:00']::text[], NULL, NULL,
   jsonb_build_object(
     'name','Diamond Progressive Bounty 2000',
     'type','progressive_bounty',
     'buyIn',2000,
     'bountyAmount',900,
     'gameVariant','nlh',
     'blindPreset','TURBO',
     'payoutPreset','NINE',
     'startingStack',22000,
     'tableSize',9,
     'maxPlayers',500,
     'minPlayers',4,
     'bigBlindAnte',true,
     'guaranteedPrize',0,
     'horsesToRegister',0,
     'lateRegistrationLevels',9,
     'shortDescription','50% Of Each Entry Contribution Funds The Progressive Bounty. Half Of Each Knockout Pays Immediately, Half Rolls Into The Winner''s Bounty. No Guarantee.'));

-- ── POST-IMAGE ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_rows integer; v_bad integer; v_txt text;
  v_cash boolean; v_tourn boolean;
BEGIN
  SELECT count(*) INTO v_rows FROM public.tournament_schedules
   WHERE club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid;
  IF v_rows <> 5 THEN
    RAISE EXCEPTION 'post-image: expected 5 arena schedule rows, found %', v_rows;
  END IF;

  -- NO UNIONS AND NO AGENTS: union_id NULL on every row.
  SELECT count(*) INTO v_bad FROM public.tournament_schedules
   WHERE club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid
     AND union_id IS NOT NULL;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'post-image: % arena schedule row(s) carry a union_id', v_bad;
  END IF;

  -- WHOLE INDIVISIBLE DIAMONDS: every money field in every config.
  SELECT count(*) INTO v_bad
    FROM public.tournament_schedules s,
         LATERAL (VALUES
           ('buyIn', s.config->>'buyIn'),
           ('bountyAmount', s.config->>'bountyAmount'),
           ('rebuyCost', s.config->>'rebuyCost'),
           ('addonCost', s.config->>'addonCost'),
           ('addOnCost', s.config->>'addOnCost'),
           ('guaranteedPrize', s.config->>'guaranteedPrize'),
           ('startingStack', s.config->>'startingStack'),
           ('mysteryBountyMin', s.config->>'mysteryBountyMin'),
           ('mysteryBountyMax', s.config->>'mysteryBountyMax')
         ) AS f(field, val)
   WHERE s.club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid
     AND f.val IS NOT NULL
     AND f.val::numeric <> round(f.val::numeric);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      'post-image: % money field(s) on the arena board are not whole Diamonds', v_bad;
  END IF;

  -- The 10% fee must also be whole, which is what restricts the ladder to
  -- multiples of ten. floor(total/10) = total/10 exactly.
  SELECT count(*) INTO v_bad FROM public.tournament_schedules s
   WHERE s.club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid
     AND COALESCE((s.config->>'buyIn')::numeric, 0) > 0
     AND mod((s.config->>'buyIn')::numeric, 10) <> 0;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      'post-image: % row(s) priced off a ten-Diamond rung, so the 10%% fee is fractional', v_bad;
  END IF;

  -- NO EVENT TYPE THE DOOR REFUSES.
  SELECT count(*) INTO v_bad FROM public.tournament_schedules s
   WHERE s.club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid
     AND (lower(COALESCE(s.config->>'type','mtt')) IN ('satellite','spin')
       OR s.config ? 'satelliteSeats'
       OR s.config ? 'satelliteTargetName'
       OR s.config ? 'satelliteTargetId');
  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      'post-image: % row(s) schedule a satellite or spin, which the Diamond door refuses', v_bad;
  END IF;

  -- A GUARANTEE IS REFUSED, so none may be promised.
  SELECT count(*) INTO v_bad FROM public.tournament_schedules s
   WHERE s.club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid
     AND COALESCE((s.config->>'guaranteedPrize')::numeric, 0) <> 0;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      'post-image: % row(s) promise a guarantee trg_tournaments_guarantee_affordable refuses for a Diamond club', v_bad;
  END IF;

  -- HORSES ARE PLAYERS: horsesToRegister present and 0 on every row, so the
  -- spawner cannot fall back to min_players and pre-seat a privileged field.
  SELECT count(*) INTO v_bad FROM public.tournament_schedules s
   WHERE s.club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid
     AND COALESCE(s.config->>'horsesToRegister','') <> '0';
  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      'post-image: % row(s) do not set horsesToRegister to 0 explicitly', v_bad;
  END IF;

  -- The spawner needs a clock on every row, or the row is a stub.
  SELECT count(*) INTO v_bad FROM public.tournament_schedules s
   WHERE s.club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid
     AND (array_length(s.start_times_utc, 1) IS NULL
       OR array_length(s.days_of_week, 1) IS NULL
       OR s.active IS NOT TRUE);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'post-image: % row(s) cannot be spawned by the poller', v_bad;
  END IF;

  -- COPY GATES: no em dash anywhere a player reads.
  SELECT string_agg(s.name, ', ') INTO v_txt FROM public.tournament_schedules s
   WHERE s.club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid
     AND (COALESCE(s.config->>'shortDescription','') LIKE '%' || chr(8212) || '%'
       OR COALESCE(s.config->>'name','') LIKE '%' || chr(8212) || '%'
       OR s.name LIKE '%' || chr(8212) || '%');
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION 'post-image: em dash in player-facing copy on %', v_txt;
  END IF;

  -- THE ARENA SWITCHES ARE UNTOUCHED.
  SELECT a.cash_games_enabled, a.tournaments_enabled INTO v_cash, v_tourn
    FROM public.ca_arena_settings a
   WHERE a.club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid;
  IF v_cash IS NOT FALSE OR v_tourn IS NOT TRUE THEN
    RAISE EXCEPTION
      'post-image: the arena switches moved (cash_games_enabled %, tournaments_enabled %)',
      v_cash, v_tourn;
  END IF;
END $$;

COMMIT;

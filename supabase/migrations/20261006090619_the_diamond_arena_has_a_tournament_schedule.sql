-- ============================================================================
-- THE DIAMOND ARENA HAS A TOURNAMENT SCHEDULE
-- ============================================================================
--
-- The Diamond Arena (club 002c2d27-9584-4e52-835a-bb2be148fc81, asset
-- 'diamonds', is_platform true, union_id NULL) has ca_arena_settings
-- .tournaments_enabled = true and, measured on production 2026-10-06, ZERO
-- tournaments of any status and ZERO tournament_schedules rows, while 271
-- schedule rows and 438,803 tournaments exist platform-wide, every one of them
-- a chip club. A player arriving at the arena finds an empty lobby. This file
-- gives it a starter recurring schedule modelled on Midway Union, the estate's
-- own reference board: four priced daily events, four spawns a day.
--
-- It adds four tournament_schedules rows and nothing else. It creates no
-- table, function, trigger or policy, changes no existing row, and does not
-- touch either arena switch.
--
-- ----------------------------------------------------------------------------
-- HOW A SCHEDULED DIAMOND EVENT IS CREATED, AND WHAT PROVES IT IS THE DOOR'S
-- ----------------------------------------------------------------------------
--
-- The engine's ScheduledTournamentService spawns every row of this table. It
-- does not call fn_poker_diamond_create_tournament, the Diamond creation door:
-- that door is staff-only (a signed-in platform admin with a live session, and
-- its audit row must name one), and the spawner runs as service_role. The
-- spawner writes the row it builds (buildInsertRow) straight into
-- public.tournaments, and every BEFORE INSERT guard on that table runs on it,
-- fn_poker_guard_arena_structure among them, which admits service_role to a
-- Diamond game and refuses one that names a union.
--
-- So the proof is made on the row, not on the route. The rehearsal of this
-- file (docs/evidence/diamond-arena-schedule/one-spawn-cycle-rehearsal.sql)
-- runs one whole spawn cycle on production inside a rolled-back transaction:
-- every instance the spawner would create for these rows in its look-ahead,
-- with the exact bytes buildInsertRow writes, as service_role, through every
-- live trigger. Every one is admitted. It then makes the system account staff
-- inside the same transaction and asks the real door,
-- fn_poker_diamond_create_tournament, for the same event, and requires the
-- door to admit it with the SAME money: buy_in_amount, buy_in_fee,
-- bounty_amount, guaranteed_prize 0, the bounty flags, and a whole-Diamond
-- unit. A row the door would price differently, or refuse, fails the
-- rehearsal.
--
-- ----------------------------------------------------------------------------
-- WHAT THE DOOR PERMITS A DIAMOND EVENT TO BE, AND WHAT THIS BOARD LEAVES OUT
-- ----------------------------------------------------------------------------
--
-- Measured on production 2026-10-06 by reading the live function bodies.
--
-- 1. A GUARANTEE IS REFUSED. fn_poker_diamond_create_tournament raises
--    diamond_tournament_format_not_open for a non-zero 'guarantee' and refuses
--    the chip key 'guaranteedPrize' by name, and
--    trg_tournaments_guarantee_affordable, a BEFORE INSERT trigger with
--    WHEN (COALESCE(new.guaranteed_prize,0) > 0), opens:
--
--      if exists (select 1 from public.clubs c
--                  where c.id = new.club_id and c.asset = 'diamonds') then
--        raise exception 'diamond_guarantee_has_no_chip_bank' using errcode='55000';
--
--    The recorded owner answers in ca_diamond_economics (guarantee_authority,
--    guarantee_overlay_account = ca_diamond_house, guarantee_max_per_event,
--    guarantee_max_outstanding, guarantee_funding_moment =
--    set_aside_at_creation, all approved 2026-10-05) describe the guarantee
--    the arena is MEANT to have; the door has not been opened to it yet.
--    Every row below carries guaranteedPrize 0 and says "No Guarantee" in its
--    own shortDescription, Midway's wording for an unguaranteed event.
--
-- 2. A FREEROLL IS NOT ON THIS BOARD, BECAUSE TODAY IT IS A REFUSAL. The door
--    raises diamond_tournament_requires_a_whole_positive_buy_in for a buy-in
--    below one Diamond, and diamond_tournament_format_not_open for freeBuy.
--    That is the recorded rule, not an accident of the code:
--    ca_diamond_economics.freeroll_allowed = 'yes' reads "The creation door
--    admits a zero buy-in ONLY together with a guarantee, since a freeroll's
--    prize IS its guarantee", and freeroll_rebuy_cost = freeroll_addon_cost =
--    'none_offered' (a Diamond freeroll is a freezeout, and its prize pool is
--    wholly the guarantee). Until the guarantee door opens, a Diamond freeroll
--    has no prize that can be funded.
--
--    Scheduling one anyway would not be refused at the spawner: it would be
--    something else. buildInsertRow spreads freeBuyColumns over a zero buy-in
--    MTT and zz_freerolls_are_free_buy backs it up, so the event would be born
--    free_buy with unlimited rebuys and an add-on at 1.00 each, which in this
--    arena is one Diamond each - a priced rebuy the recorded answers say does
--    not exist, on a format the door refuses by name. So the freeroll waits
--    for the guarantee door; recorded in docs/DIAMOND-RULINGS.md as decided by
--    Claude on Dan's delegation. When it opens, the freeroll is a new row.
--
-- 3. A SATELLITE IS NOT SCHEDULED. fn_award_satellite_seat, the only door that
--    seats a satellite winner, opens:
--
--      IF public.fn_poker_diamond_tournament(p_satellite_id)
--         OR public.fn_poker_diamond_tournament(p_target_id) THEN
--        RAISE EXCEPTION 'diamond_satellite_is_never_settled_on_chip_rails: ...'
--
--    and the creation door refuses a satellite whose seats are promised in
--    advance (diamond_satellite_seat_guarantee_not_open). A Diamond satellite
--    could sell a seat it can never deliver. Midway's satellite rows are not
--    cloned.
--
-- 4. A SPIN IS NOT SCHEDULED. A Spin has no scheduled time at all (Dan,
--    2026-09-01; buildInsertRow refuses one), clubs.spins_enabled is false on
--    the arena, and a Diamond Spin is still refused until a reserve source is
--    authorized. Midway's spin row is not cloned.
--
-- 5. A BOUNTY AND A PROGRESSIVE BOUNTY ARE PERMITTED. The door admits
--    'bounty' and 'progressive_bounty' with a whole bounty of at least one
--    Diamond and no more than the buy-in after the fee; the Diamond rails for
--    them exist (fn_claim_tournament_bounty_elimination and
--    fn_eliminate_tournament_player_atomic carry a DIAMOND PHASE 8 branch,
--    fn_ca_tournament_terminal_receipt a DIAMOND PHASE 9 branch: "a Diamond
--    bounty is a ledger row, not a wallet row"). A MYSTERY BOUNTY is left out
--    of this starter board; the progressive bounty covers the same ground.
--
-- 6. NO UNIONS AND NO AGENTS. tournament_schedules.union_id is NULL on every
--    row. The spawner copies it verbatim (`union_id: schedule.union_id ??
--    null`, `is_xmtt: !!schedule.union_id`), and
--    fn_stamp_tournament_union_ownership cannot back-fill one here because the
--    arena has no union_clubs row and clubs.union_id is NULL. This matters
--    because fn_poker_guard_arena_structure refuses a Diamond game whose
--    union_id is not NULL ('Diamond Games Cannot Belong To A Union'), and
--    fn_poker_diamond_tournament only recognises a Diamond event when
--    c.union_id IS NULL AND t.union_id IS NULL. Nothing below names an agent,
--    a commission or a union.
--
-- ----------------------------------------------------------------------------
-- WHERE EVERY NUMBER COMES FROM. NOTHING HERE IS INVENTED.
-- ----------------------------------------------------------------------------
--
-- THE UNIT. The Diamond Arena is a diamonds-only 1:1 clone of a chip club and
-- the conversion is the one 20261005183028_diamond_cash_rake_reads_the_owner_
-- settings established for the cash ladder: ONE CHIP CENT BECOMES ONE DIAMOND.
-- tournamentUnit.ts sets DIAMOND_UNIT_CENTS = 100 and fn_ca_tournament_unit_
-- cents answers 100 for this club, so one Diamond is 1.00 in a numeric money
-- column and every money field below is a WHOLE number.
--
-- THE LADDER. Midway's chip buy-in totals, read in the Diamond unit:
--
--   chip 3.30 -> 330      chip 5.50 -> 550      chip 8.80 -> 880
--   chip 11.00 -> 1100    chip 22.00 -> 2200
--
-- Those converted figures cannot be authored as they stand. The spawner does
-- not store config.buyIn: it reads it as the TOTAL and passes it through
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
-- THE FEE. The spawner's fee is floor(total x 0.10) to the cent and the door's
-- is the same rule at the Diamond unit (fn_ca_unit_floor_cents(round(total *
-- 100 * 0.10), 100) / 100, 10% for any field above two seats). For the fee AND
-- the prize side to be whole Diamonds the total must be a multiple of 10.
-- 300, 500, 1000 and 2000 all are, splitting as
--
--   total 300  -> buy_in_amount 270  + buy_in_fee 30
--   total 500  -> buy_in_amount 450  + buy_in_fee 50
--   total 1000 -> buy_in_amount 900  + buy_in_fee 100
--   total 2000 -> buy_in_amount 1800 + buy_in_fee 200
--
-- each satisfying fn_enforce_whole_dollar_buyin and the door's own split.
--
-- THE BOUNTY FIGURES, read off Midway's own rule rather than chosen. Midway's
-- fixed-bounty rows say "25% Of Each Entry Contribution Funds A Fixed Knockout
-- Bounty" and, at chip buyIn 11 (prize side 10), carry bountyAmount 2.5 -
-- 25% of the PRIZE side, not of the total. Its PKO row says 50% and, at chip
-- buyIn 15 (prize side 13.50), carries bountyAmount 6.75 - again 50% of the
-- prize side. Applied to the Diamond rungs:
--
--   bounty at 1000:             25% of 900  = 225   (whole, within 900)
--   progressive bounty at 2000: 50% of 1800 = 900   (whole, within 1800)
--
-- and fn_tournament_entry_split reconciles exactly: 675 + 225 + 100 = 1000,
-- and 900 + 900 + 200 = 2000.
--
-- THE STACKS, PRESETS, FIELD SIZES AND LATE-REG LEVELS are Midway's own,
-- carried across UNCHANGED, because a starting stack is tournament chips and
-- not money: the clone swaps the money unit, not the chip count. Turbo 12000 /
-- TURBO / 7; deep stack 30000 / DEEPSTACK / 9; fixed bounty 18000 / STANDARD /
-- 8; PKO 22000 / TURBO / 9. tableSize 9, maxPlayers 500, minPlayers 4 and
-- payoutPreset NINE are Midway's values on every corresponding row.
--
-- THE CLOCK. days_of_week [0,1,2,3,4,5,6] (daily), time_zone NULL and
-- interval_minutes NULL on every row, Midway's own shape on 93 of its 94 rows.
-- The start times are Midway's own slots, in UTC: 01:00 its Midweek Bounty
-- slot, 03:00 its PKO slot, 14:00 its morning slot, 20:00 its prime evening
-- slot. Every rung is at least 200, so spawnAheadMsFor publishes each row
-- FEATURE_WINDOW_AHEAD_MS (6 days) ahead: the board shows about six days of
-- each event at once, the way it does for a chip event of 200 or more.
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5, no exceptions). horsesToRegister is 0 on
-- every row, SET EXPLICITLY and not omitted, because omitting it is not
-- neutral: ScheduledTournamentService falls back to min_players when the key
-- is absent or unparseable, which would pre-seat horses into every Diamond
-- event at spawn. 0 does not exclude horses - the spawner's own log line for it
-- reads "open for registration, horses join at start", and GameServer's
-- pre-start ramp and past-start top-up fill a short field exactly as they do
-- for a chip event. A horse funds the entry from its own balance through the
-- same door a person uses: ca_diamond_economics.horse_entry_funding =
-- 'own_balance' (approved 2026-10-05). It is also the value all 94 Midway rows
-- carry.
--
-- COPY. Every shortDescription is Title Case, carries no em dash, and either
-- is Midway's own sentence verbatim or states the guarantee position in
-- Midway's own wording.
--
-- ============================================================================
-- @live-proof: (SELECT count(*) = 4 FROM public.tournament_schedules s WHERE s.club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid AND s.union_id IS NULL AND s.name IN ('Diamond Daily Turbo 300', 'Diamond Daily Deep Stack 500', 'Diamond Bounty Hunt 1000', 'Diamond Progressive Bounty 2000'))

BEGIN;

-- ── PRE-IMAGE ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_asset text; v_platform boolean; v_union uuid; v_existing integer;
  v_union_clubs integer; v_cash boolean; v_tourn boolean;
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

  -- The board is for an arena whose tournaments are open. The cash switch is
  -- not this file's business in either direction: it is recorded here only so
  -- the post-image can prove this file moved neither switch.
  SELECT a.cash_games_enabled, a.tournaments_enabled INTO v_cash, v_tourn
    FROM public.ca_arena_settings a
   WHERE a.club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid;
  IF NOT FOUND OR v_tourn IS NOT TRUE THEN
    RAISE EXCEPTION
      'pre-image: the arena''s tournaments are not open (tournaments_enabled %), so a schedule would publish events nobody may enter',
      v_tourn;
  END IF;
  PERFORM set_config('ca.diamond_schedule_switches',
    COALESCE(v_cash::text, 'null') || '/' || COALESCE(v_tourn::text, 'null'), true);
END $$;

-- ── THE FOUR ROWS ──────────────────────────────────────────────────────────
-- union_id is NULL on every row. guaranteedPrize is 0 on every row. No
-- freeroll, no satellite, no spin, no mystery bounty. Every money field a
-- whole Diamond.

INSERT INTO public.tournament_schedules
  (union_id, club_id, name, description, active, days_of_week, start_times_utc,
   interval_minutes, time_zone, config)
VALUES
  -- 1. The cheapest priced rung: Midway chip 3.30 read in Diamonds (330),
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

  -- 2. Midway chip 5.50 read in Diamonds (550), snapped to 500 = 450 + 50,
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

  -- 3. Midway chip 8.80/11.00 read in Diamonds (880/1100), both snapping to
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

  -- 4. Midway chip 22.00 read in Diamonds (2200), snapped to 2000 = 1800 +
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
  IF v_rows <> 4 THEN
    RAISE EXCEPTION 'post-image: expected 4 arena schedule rows, found %', v_rows;
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

  -- EVERY ROW IS PRICED, AND ON A TEN-DIAMOND RUNG. A buy-in below one Diamond
  -- is refused by the door (diamond_tournament_requires_a_whole_positive_
  -- buy_in), and the 10% fee is whole only on a multiple of ten.
  SELECT count(*) INTO v_bad FROM public.tournament_schedules s
   WHERE s.club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid
     AND (COALESCE((s.config->>'buyIn')::numeric, 0) < 1
       OR mod((s.config->>'buyIn')::numeric, 10) <> 0);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      'post-image: % row(s) are unpriced or priced off a ten-Diamond rung', v_bad;
  END IF;

  -- NO EVENT TYPE THE DOOR REFUSES.
  SELECT count(*) INTO v_bad FROM public.tournament_schedules s
   WHERE s.club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid
     AND (lower(COALESCE(s.config->>'type','mtt')) NOT IN ('mtt','bounty','progressive_bounty')
       OR s.config ? 'satelliteSeats'
       OR s.config ? 'satelliteTargetName'
       OR s.config ? 'satelliteTargetId'
       OR COALESCE(s.config->>'freeBuy','false') <> 'false');
  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      'post-image: % row(s) schedule a format the Diamond door refuses', v_bad;
  END IF;

  -- A GUARANTEE IS REFUSED, so none may be promised.
  SELECT count(*) INTO v_bad FROM public.tournament_schedules s
   WHERE s.club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid
     AND (COALESCE((s.config->>'guaranteedPrize')::numeric, 0) <> 0
       OR COALESCE((s.config->>'guarantee')::numeric, 0) <> 0);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      'post-image: % row(s) promise a guarantee the Diamond door refuses', v_bad;
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

  -- THE ARENA SWITCHES ARE UNTOUCHED: exactly what the pre-image read.
  SELECT a.cash_games_enabled, a.tournaments_enabled INTO v_cash, v_tourn
    FROM public.ca_arena_settings a
   WHERE a.club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid;
  IF COALESCE(v_cash::text, 'null') || '/' || COALESCE(v_tourn::text, 'null')
     IS DISTINCT FROM current_setting('ca.diamond_schedule_switches', true) THEN
    RAISE EXCEPTION
      'post-image: the arena switches moved (now cash_games_enabled %, tournaments_enabled %; before %)',
      v_cash, v_tourn, current_setting('ca.diamond_schedule_switches', true);
  END IF;
END $$;

COMMIT;

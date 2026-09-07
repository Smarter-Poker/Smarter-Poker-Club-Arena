-- A SEAT-FIRST BOARD SELLS ITS SEATS ONCE, AND A BUST-OUT DOES NOT PUT ONE
-- BACK ON SALE.
--
-- MEASURED FIRST, on production 2026-09-06 23:32 UTC, over seven days of
-- heads-up events (`max_players = 2`):
--
--   35 events took MORE than two paid entries. The worst took 32.
--   Every one of the 35 was 100% horses, had zero rows in
--   tournament_registrations, and ended with `current_players = 0`.
--   Every entrant really paid: 53e50799 holds prize_pool 1520.00 and
--   total_rake 80.00, which is exactly 32 x (47.50 + 2.50).
--   All 35 conserve - money in equals money out - so nobody is owed anything.
--   This migration is about the entries, not a settlement.
--
-- I FIRST READ THIS AS A LOCK RACE THE PHASE-2 FIXES HAD CLOSED, because 0 of
-- the 982 heads-up events after those fixes were overfilled against 31 of the
-- 3,654 before. That reading was wrong, and the hourly histogram refutes it:
-- these are not a background rate. 31 of the 35 fall inside two hours - 25 in
-- the 11:00 hour alone, out of only 45 heads-up events that hour - and the
-- burst ended at 11:20, four hours BEFORE the lock migrations were applied at
-- 15:27. A rate computed across a window containing one burst will always show
-- the burst "fixed" by whatever happened next. (CLAUDE.md 10.86.)
--
-- THE CAUSE, read from the trigger that was supposed to prevent it.
--
-- `fn_enforce_tournament_capacity` has guarded this table all along, and its
-- count is:
--
--     SELECT count(*) INTO v_have FROM public.tournament_players
--      WHERE tournament_id = NEW.tournament_id
--        AND COALESCE(status, 'registered') NOT IN
--            ('eliminated','winner','left','withdrawn','cancelled',
--             'refunded','busted');
--
-- with the comment "LIVE entrants only. A player who busted ... is not sitting
-- at the table and must not hold a seat against the next one."
--
-- THAT IS THE RIGHT RULE FOR A SEAT AND THE WRONG RULE FOR AN ENTRY. On a
-- multi-table tournament the two never diverge enough to matter. On a
-- two-handed sit-and-go they diverge immediately: the board sells both seats,
-- someone busts, the live count falls to 1, and the guard admits - and charges
-- - another entrant into an event that was already sold. Then again. Up to 32
-- times. It is the same shape as the door in the same file's other half:
-- `fn_sync_seat_first_player_count` overwrites `tournaments.current_players`
-- with the live SEATED count, so the registration functions' own
-- `current_players >= max_players` pre-check is equally blind. Two counters,
-- both meaning "how many are here right now", asked a question about how many
-- have entered.
--
-- THE FIX IS THE COUNT, in the guard that already exists (CLAUDE.md 10.11 -
-- fix the cause; 10.8 - never write a third law where one is already written).
-- For a seat-first board the guard now counts EVERY row: an entry is an entry,
-- whatever became of the player holding it. For everything else the live count
-- is untouched, so no multi-table event changes behaviour at all.
--
-- THREE SMALLER THINGS TRAVEL WITH IT, each measured, none speculative:
--
--   1. THE COUNT IS NOW TAKEN UNDER THE TOURNAMENT ROW LOCK. The guard read
--      the row without one, so two entries arriving together could both count
--      1 and both be admitted. `FOR NO KEY UPDATE` is parent-before-child -
--      the order every registration door already uses, and the one phase 2
--      standardised - so it introduces no new lock order and no inversion.
--   2. `sng` JOINS `spin` IN THE DEFINITION OF SEAT-FIRST. The guard said
--      `(v_variant = 'spin' OR v_max <= 2)` while
--      `fn_sync_seat_first_player_count` says `('spin','sng') OR max <= 2`.
--      Every one of the 35 was variant `sng` and squeaked in only on the
--      `<= 2` half; a six-max sng sat outside the rule entirely. Two
--      definitions of one word is how this class of defect survives.
--   3. `fn_tournament_entry_cap_reached` gives the doors ONE definition of
--      "full" to ask, instead of each reading `current_players` for itself.
--      The horse door and the browser door use it here. It is a POLITE
--      pre-check that returns a reason instead of an exception - the trigger
--      above remains the authority - and because it takes the GREATER of the
--      entry count and the counter it can only ever be stricter than the test
--      it replaces, never looser.
--
--   `atomic_tournament_register` also gets the tournament row lock it never
--   took. It is reachable from the browser
--   (`src/services/TournamentService.ts`, `AgentManagementPage.tsx`), it
--   inserts a tournament_players row and debits a club wallet, and it checked
--   no capacity of any kind.
--
-- BLAST RADIUS, measured before writing: of 316 open capped events, exactly 1
-- is at its cap today and the same 1 is at its cap under the new count. ZERO
-- events change from admitting to refusing. Nothing in flight is disturbed.
--
-- One transaction for all of it, per the production DDL policy in section 2.

BEGIN;

SET LOCAL lock_timeout = '4s';

-- ---------------------------------------------------------------------------
-- ONE DEFINITION OF "FULL" FOR THE DOORS TO ASK.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_tournament_entry_cap_reached(p_tournament_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cap      integer;
  v_counter  integer;
  v_entries  integer;
BEGIN
  SELECT t.max_players, COALESCE(t.current_players, 0)
    INTO v_cap, v_counter
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;

  IF NOT FOUND OR v_cap IS NULL OR v_cap <= 0 THEN
    RETURN false;                      -- uncapped: this function never refuses
  END IF;

  SELECT count(*) INTO v_entries
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;

  /* GREATEST, never the entry count alone: this can only ever be stricter than
     the counter test it replaces, never looser. */
  RETURN GREATEST(v_counter, COALESCE(v_entries, 0)) >= v_cap;
END;
$function$;

COMMENT ON FUNCTION public.fn_tournament_entry_cap_reached(uuid) IS
  'True when a capped tournament already holds max_players ENTRIES. Counts tournament_players, because current_players is overwritten with the live seated count on every seat-first event and cannot answer this question. Takes the greater of the two, so it is never looser than the counter test it replaced. A polite pre-check: fn_enforce_tournament_capacity is the authority.';

/* It answers one boolean about a lobby fact, and a browser genuinely needs it:
   atomic_tournament_register runs as the caller. So authenticated keeps
   EXECUTE, anon does not, and PUBLIC is named because a REVOKE that omits it
   reads as a fix and does nothing. */
REVOKE ALL ON FUNCTION public.fn_tournament_entry_cap_reached(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_tournament_entry_cap_reached(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- THE GUARD ITSELF. The count, the lock, and one word defined once.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_enforce_tournament_capacity()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_max int;
  v_have int;
  v_name text;
  v_status text;
  v_variant text;
  v_seat_first boolean;
BEGIN
  /* UNDER THE ROW LOCK (2026-09-06). This read the tournament without one, so
     two entries arriving together could both see room and both be admitted.
     Parent before child - the order every registration door already uses. */
  SELECT max_players, name, status, COALESCE(variant, '')
    INTO v_max, v_name, v_status, v_variant
    FROM public.tournaments WHERE id = NEW.tournament_id
    FOR NO KEY UPDATE;

  -- No declared capacity means no capacity to exceed (open MTTs).
  IF v_max IS NULL OR v_max <= 0 THEN
    RETURN NEW;
  END IF;

  /* 'sng' JOINS 'spin' (2026-09-06). fn_sync_seat_first_player_count has
     always counted ('spin','sng') OR max <= 2 as seat-first; this said
     'spin' OR max <= 2. All 35 overfilled events were sng, and they qualified
     only on the <= 2 half - a six-max sng was outside the rule entirely. */
  v_seat_first := (v_variant IN ('spin', 'sng') OR v_max <= 2);

  -- A seat-first board sells its seats once. After it stops being joinable it
  -- admits nobody, however many of its entrants have since busted.
  IF v_seat_first
     AND upper(COALESCE(v_status, '')) NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RAISE EXCEPTION
      'tournament_full: % is % and takes no further entrants',
      COALESCE(v_name, NEW.tournament_id::text), lower(v_status)
      USING ERRCODE = '23514';
  END IF;

  IF v_seat_first THEN
    /* AN ENTRY, NOT A SURVIVOR (2026-09-06). This branch used to exclude
       eliminated, winner, left, withdrawn, cancelled, refunded and busted -
       the right rule for a seat and the wrong one for an entry. On a
       two-handed board it meant a bust-out put a sold seat back on sale, and
       35 events took between 3 and 32 paid entries because of it. The board
       sold its seats; what became of the players who bought them is not a
       vacancy. */
    SELECT count(*) INTO v_have
      FROM public.tournament_players
     WHERE tournament_id = NEW.tournament_id;
  ELSE
    -- Multi-table events are unchanged: a busted entrant does not hold a seat
    -- against the next one on a board that is still filling.
    SELECT count(*) INTO v_have
      FROM public.tournament_players
     WHERE tournament_id = NEW.tournament_id
       AND COALESCE(status, 'registered') NOT IN
           ('eliminated', 'winner', 'left', 'withdrawn', 'cancelled', 'refunded', 'busted');
  END IF;

  IF v_have >= v_max THEN
    RAISE EXCEPTION
      'tournament_full: % already has % of % entrants', COALESCE(v_name, NEW.tournament_id::text), v_have, v_max
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.fn_enforce_tournament_capacity() IS
  'Capacity guard on tournament_players. A seat-first board (spin, sng, or max_players <= 2) counts EVERY entry, because a bust-out does not put a sold seat back on sale; a multi-table event counts live entrants as before. Reads the tournament row FOR NO KEY UPDATE so two entries arriving together cannot both find room.';

-- ---------------------------------------------------------------------------
-- THE HORSE DOOR: the one all 35 came through. Only the pre-check changes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_t record; v_username text;
  v_split record;
  v_is_bounty boolean; v_head numeric := 0;
  v_player_id uuid;
  v_is_horse boolean;
  v_ok boolean;
  v_start_chips integer := 0;
  v_led_cat text; v_led_cp text; v_led_ent text; v_led_tid text; -- CHIP STANDARD 1.2 2026-09-02
BEGIN
  SELECT is_horse INTO v_is_horse FROM public.profiles WHERE id = p_user_id;
  IF NOT COALESCE(v_is_horse, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_horse');
  END IF;

  SELECT id, status, buy_in_amount, buy_in_fee, max_players, current_players,
         club_id, name, is_bounty, is_pko, is_mystery_bounty,
         bounty_amount, start_time, early_bird_enabled, early_bird_chips
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;

  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;
  /* ONE DEFINITION OF FULL (2026-09-06). This read `current_players >=
     max_players`, and on a seat-first event that column is overwritten with
     the live SEATED count - so an emptied seat read as a vacancy and this
     function walked back through the door, up to 32 paid entries into a
     two-handed sit-and-go. fn_enforce_tournament_capacity is the authority
     and would now refuse the insert outright; asking here keeps the refusal a
     reason rather than an exception, and rolls back nothing. */
  IF public.fn_tournament_entry_cap_reached(p_tournament_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_full');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players
              WHERE tournament_id = p_tournament_id AND user_id = p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END IF;

  IF COALESCE(v_t.early_bird_enabled, false)
     AND now() < v_t.start_time
     AND COALESCE(v_t.early_bird_chips, 0) > 0 THEN
    v_start_chips := v_t.early_bird_chips;
  END IF;

  SELECT COALESCE(NULLIF(display_name, ''), NULLIF(username, ''), 'Player')
    INTO v_username FROM public.profiles WHERE id = p_user_id;

  v_is_bounty := COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
                 OR COALESCE(v_t.is_mystery_bounty, false);

  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);

  IF v_is_bounty AND v_split.prize < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'misconfigured_bounty');
  END IF;

  -- MYSTERY BOUNTY 2026-08-25: no roll here either. A horse and a human must
  -- enter the same event on the same terms; when the two register functions
  -- disagreed about how a bounty head was set, they were two tournaments.
  IF v_is_bounty THEN
    v_head := v_split.bounty;
  END IF;

  IF v_split.charge > 0 THEN
    -- CHIP STANDARD 1.2 (2026-09-02): THE HORSE DOOR DECLARES EXACTLY AS THE HUMAN
    -- DOOR (R11 - horses and humans are identical on every path). The wallet write
    -- below is journaled by trg_club_members_audit_chip_movement; undeclared it landed
    -- as adjustment player_wallet -> table_stack with no tournament. set_config, not
    -- fn_ca_declare_ledger, for the same reason as fn_register_for_tournament: a
    -- vocabulary miss must never refuse a buy-in. Restored right after the write.
    v_led_cat := current_setting('app.ledger_category', true);
    v_led_cp  := current_setting('app.ledger_counterparty', true);
    v_led_ent := current_setting('app.ledger_counterparty_entity', true);
    v_led_tid := current_setting('app.ledger_tournament', true);
    PERFORM set_config('app.ledger_category', 'tournament_buyin', true);
    PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);
    PERFORM set_config('app.ledger_tournament', p_tournament_id::text, true);
    v_ok := public.atomic_deduct_wallet_and_log(
      p_user_id, v_split.charge, 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
    PERFORM set_config('app.ledger_category', COALESCE(v_led_cat, ''), true);
    PERFORM set_config('app.ledger_counterparty', COALESCE(v_led_cp, ''), true);
    PERFORM set_config('app.ledger_counterparty_entity', COALESCE(v_led_ent, ''), true);
    PERFORM set_config('app.ledger_tournament', COALESCE(v_led_tid, ''), true);
    IF NOT COALESCE(v_ok, false) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance');
    END IF;
    PERFORM public.log_wallet_transaction(
      p_user_id, 'PLAYER', v_split.charge, 'debit', 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
  END IF;

  BEGIN
    IF v_is_bounty THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status, current_bounty,
         mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (p_tournament_id, p_user_id, COALESCE(v_username,'Player'), v_start_chips,
              'registered', v_head, 0, 0, 0)
      RETURNING id INTO v_player_id;
    ELSE
      INSERT INTO public.tournament_players (tournament_id, user_id, username, chips, status)
      VALUES (p_tournament_id, p_user_id, COALESCE(v_username,'Player'), v_start_chips, 'registered')
      RETURNING id INTO v_player_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    IF v_split.charge > 0 THEN
      PERFORM public.credit_player_wallet(p_user_id, v_split.charge,
        'tourn_reg_race:' || p_tournament_id::text || ':' || p_user_id::text);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END;

  IF v_split.rake > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players, bbj_contribution,
       is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_split.rake, v_split.charge, 1, 0, true, p_tournament_id,
            'fn_register_horse_for_tournament',
            jsonb_build_object('kind','tournament_entry_fee','user_id',p_user_id,
                               'registration_id',v_player_id));
  END IF;

  UPDATE public.tournaments
     SET current_players = COALESCE(current_players, 0) + 1,
         prize_pool  = COALESCE(prize_pool, 0)  + v_split.prize,
         bounty_pool = COALESCE(bounty_pool, 0) + v_split.bounty,
         total_rake  = COALESCE(total_rake, 0)  + v_split.rake
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'registration_id', v_player_id,
    'cost', v_split.charge, 'prize_contribution', v_split.prize,
    'bounty_contribution', v_split.bounty, 'rake', v_split.rake);
END; $function$;

-- ---------------------------------------------------------------------------
-- THE BROWSER DOOR: no capacity test of any kind, and no lock. Both added.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.atomic_tournament_register(p_tournament_id uuid, p_user_id uuid, p_username text, p_total_cost numeric, p_current_bounty numeric, p_mystery_bounty_value numeric, p_is_bounty_tournament boolean, p_club_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_balance NUMERIC; v_player_id UUID; v_club uuid;
  v_t_club uuid; v_t_union uuid; v_ban uuid;
BEGIN
  /* THE TOURNAMENT ROW FIRST (2026-09-06). This read the tournament without a
     lock and never looked at max_players at all, while inserting a
     tournament_players row and debiting a club wallet - and it is reachable
     from the browser. Parent before child, the order every other door uses. */
  SELECT t.club_id, t.union_id INTO v_t_club, v_t_union
    FROM tournaments t WHERE t.id = p_tournament_id
    FOR NO KEY UPDATE;

  IF public.fn_tournament_entry_cap_reached(p_tournament_id) THEN
    RAISE EXCEPTION 'Tournament full' USING ERRCODE = '23514';
  END IF;

  IF v_t_club IS NOT NULL OR v_t_union IS NOT NULL THEN
    SELECT id INTO v_ban FROM blacklists
     WHERE user_id = p_user_id AND (expires_at IS NULL OR expires_at > now())
       AND (club_id = v_t_club OR (v_t_union IS NOT NULL AND union_id = v_t_union))
     LIMIT 1;
    IF v_ban IS NOT NULL THEN RAISE EXCEPTION 'Banned from this club'; END IF;
  END IF;

  v_club := public.fn_tournament_club_for_user(p_user_id, p_tournament_id, p_club_id);
  IF v_club IS NULL THEN
    RAISE EXCEPTION 'No club wallet resolves for this tournament entry'
      USING HINT = 'The player must hold a membership in a club belonging to this tournament''s union.';
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id, v_club);

  SELECT chip_balance INTO v_balance FROM club_members
   WHERE user_id = p_user_id AND club_id = v_club FOR UPDATE;
  IF v_balance IS NULL OR v_balance < p_total_cost THEN
    RAISE EXCEPTION 'Insufficient club chips for tournament entry.';
  END IF;
  UPDATE club_members SET chip_balance = chip_balance - p_total_cost, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_club;

  IF p_is_bounty_tournament THEN
    INSERT INTO tournament_players (
      tournament_id, user_id, username, chips, status,
      current_bounty, mystery_bounty_value, bounties_collected, bounty_winnings, club_id
    ) VALUES (
      p_tournament_id, p_user_id, p_username, 0, 'registered',
      p_current_bounty, p_mystery_bounty_value, 0, 0, v_club
    ) RETURNING id INTO v_player_id;
  ELSE
    INSERT INTO tournament_players (tournament_id, user_id, username, chips, status, club_id)
    VALUES (p_tournament_id, p_user_id, p_username, 0, 'registered', v_club)
    RETURNING id INTO v_player_id;
  END IF;

  RETURN v_player_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- PROVE IT, in this transaction, against live rows.
--
-- The proof has to reach the exact case that failed: an event that is still
-- REGISTERING, already at its cap, whose entrants have BUSTED. Under the old
-- count that event had a vacancy and admitted a paying entrant. So the probe
-- takes a finished seat-first event that is already at its cap, puts it back
-- to REGISTERING and marks its entrants eliminated - reproducing the exact
-- state - and attempts one more entry. Every one of those writes happens
-- inside a subtransaction that is ROLLED BACK (CLAUDE.md 11.5): the raise is
-- the success case, no row survives it, and no chip moves because no wallet
-- is touched.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_refused boolean := false;
  v_msg     text;
  v_open    int;
  v_target  uuid;
  v_spare   uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.tournament_players'::regclass
                    AND tgname = 'trg_enforce_tournament_capacity'
                    AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the capacity trigger is not armed on tournament_players';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.fn_tournament_entry_cap_reached(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the browser door cannot reach the cap test it now depends on';
  END IF;

  /* Both doors ask the one definition rather than deciding for themselves. */
  IF (SELECT count(*) FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('fn_register_horse_for_tournament', 'atomic_tournament_register')
         AND p.prosrc !~ 'fn_tournament_entry_cap_reached') <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: a registration door still decides "full" for itself';
  END IF;

  /* THE BUSTED-SEAT CASE, reproduced and refused. */
  SELECT t.id INTO v_target
    FROM public.tournaments t
   WHERE t.max_players IS NOT NULL AND t.max_players > 0
     AND (COALESCE(t.variant,'') IN ('spin','sng') OR t.max_players <= 2)
     AND upper(COALESCE(t.status,'')) NOT IN ('ANNOUNCED', 'REGISTERING', 'RUNNING')
     AND (SELECT count(*) FROM public.tournament_players tp WHERE tp.tournament_id = t.id) >= t.max_players
     /* and its entrants are already busted, so the OLD count saw a vacancy */
     AND (SELECT count(*) FROM public.tournament_players tp
           WHERE tp.tournament_id = t.id
             AND COALESCE(tp.status,'registered') NOT IN
                 ('eliminated','winner','left','withdrawn','cancelled','refunded','busted')) < t.max_players
   ORDER BY t.created_at DESC
   LIMIT 1;

  IF v_target IS NULL THEN
    /* Say so out loud rather than passing quietly - a probe that could not run
       is not a probe that succeeded (CLAUDE.md 10.86). */
    RAISE NOTICE 'CAP_PROBE_NOT_RUN no finished seat-first event at its cap was available to prove the refusal against; the guard is installed but unexercised here';
    v_refused := true;
  ELSE
    SELECT p.id INTO v_spare FROM public.profiles p
     WHERE COALESCE(p.is_horse, false)
       AND NOT EXISTS (SELECT 1 FROM public.tournament_players tp
                        WHERE tp.tournament_id = v_target AND tp.user_id = p.id)
     ORDER BY p.id LIMIT 1;
    IF v_spare IS NULL THEN
      RAISE EXCEPTION 'VERIFY FAILED: no spare player to attempt an entry with';
    END IF;

    BEGIN
      /* Reproduce the exact failing state, inside the rollback. The entrants
         are ALREADY busted - that is how the target was chosen - so only the
         joinable status has to be put back, and no player row is touched. */
      UPDATE public.tournaments SET status = 'REGISTERING' WHERE id = v_target;

      INSERT INTO public.tournament_players (tournament_id, user_id, username, chips, status)
      VALUES (v_target, v_spare, 'zz cap probe', 0, 'registered');

      RAISE EXCEPTION 'zz_the_guard_did_not_refuse';
    EXCEPTION
      WHEN check_violation THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        v_refused := (v_msg LIKE 'tournament_full:%');
      WHEN OTHERS THEN
        IF SQLERRM <> 'zz_the_guard_did_not_refuse' THEN RAISE; END IF;
    END;

    IF EXISTS (SELECT 1 FROM public.tournament_players
                WHERE tournament_id = v_target AND user_id = v_spare) THEN
      RAISE EXCEPTION 'VERIFY FAILED: the probe entry survived its own rollback';
    END IF;
    IF upper((SELECT status FROM public.tournaments WHERE id = v_target)) = 'REGISTERING' THEN
      RAISE EXCEPTION 'VERIFY FAILED: the probe left a finished event marked REGISTERING';
    END IF;
  END IF;

  IF NOT v_refused THEN
    RAISE EXCEPTION 'VERIFY FAILED: a seat-first board at its cap admitted another entry once its entrants were busted - the very case this migration exists for';
  END IF;

  /* And say plainly how many live events the new count would refuse today, so
     the number is on the record rather than discovered by a player. */
  SELECT count(*) INTO v_open
    FROM public.tournaments t
   WHERE upper(COALESCE(t.status,'')) IN ('ANNOUNCED', 'REGISTERING')
     AND t.max_players IS NOT NULL AND t.max_players > 0
     AND (SELECT count(*) FROM public.tournament_players tp WHERE tp.tournament_id = t.id) >= t.max_players;

  RAISE NOTICE 'A_SEAT_IS_SOLD_ONCE a seat-first board at its cap refuses a further entry even when every entrant has busted; % open event(s) sit at or over their cap today', v_open;
END $verify$;

COMMIT;

-- ============================================================================
-- A CAPPED DIAMOND SATELLITE WINNER IS PAID, NOT HELD
-- ============================================================================
--
-- WHAT BROKE, READ FROM ROWS. "Sunday Deep Stack Satellite 10"
-- (a4445447-9baf-4700-8648-34987af2a81f, a Diamond satellite into "Sunday 200
-- Deep Stack") decided at 2026-10-17 01:32:04Z: 24 entrants, positions 2..24
-- recorded, one survivor (82c24bec, a horse) holding every chip. At 01:32:14Z
-- the single-winner settlement authority refused the finish:
--
--   diamond_satellite_winner_at_the_table_cap: satellite a4445447-... award 1
--   user 82c24bec-...
--
-- and kept refusing every bounded engine retry for over two hours, across an
-- engine restart and adoption at 02:56Z. The event sat RUNNING with no hand to
-- deal, MttPlayStopped fired hourly, fn_ca_tournament_finished_but_not_
-- completed filed the unpaid winner, and the owner was paged. "Sunday Deep
-- Stack Satellite 25" (9dc3fae9) hit the same wall at 17:33Z the same day
-- (satellite_qualifiers_refused_repeatedly, 2 awards refused) and finished 56
-- minutes late only because its winners' other games happened to end.
--
-- TWO CAUSES, BOTH IN THE SAME CLAUSE OF BOTH AUTHORITIES
-- (fn_settle_satellite_tournament_pre_money_path_gate and
-- fn_ca_settle_satellite_cohort, Phase 9 migration 20260929161500):
--
--   1. THE DYING SATELLITE COUNTED AGAINST ITS OWN WINNER. The cap read
--      fn_concurrent_game_load(winner, NULL, NULL, target), whose clause (1)
--      counts every live seat at a non-closed table of a non-terminal
--      tournament. The satellite being settled is still RUNNING when its
--      settlement runs (the settlement is what completes it), so the winner's
--      seat at the satellite's own final table counted as a game - the exact
--      miscount the 2026-09-10 note inside fn_concurrent_game_load describes,
--      reachable again because that fix keyed on COMPLETING/COMPLETED status
--      the satellite does not yet have. A winner at 3 other events was
--      therefore "at the cap" by the seat this very transaction releases.
--      That also silently downgraded CHIP winners from a real target seat to
--      a noncash ticket one game too early.
--
--   2. THE DIAMOND REFUSAL HAD NO EXIT. For a Diamond satellite the clause
--      raised by name and documented "nothing moves and the engine retries".
--      The engine does retry, on its bounded backoff (cap 15 minutes) - but a
--      horse seated at four long tournaments stays at the cap for hours, so
--      the refusal is not transient and the event is held hostage: no hands,
--      no finish, no payout, pages every hour. An unbounded hold with no exit
--      is a deadlock, not a rule.
--
-- THE FIX, AT THE ROOT, IN BOTH AUTHORITIES:
--
--   1. The winner's live seats at THIS satellite are subtracted from the cap
--      load, with the same predicates clause (1) counts by, because this
--      settlement releases those seats in this same transaction. A winner's
--      own dying event can never again be the game that caps them.
--
--   2. A Diamond winner still genuinely at the cap takes the ticket's value
--      as money - whole Diamonds through the same pay door the
--      duplicate-qualification rule already uses (fn_credit_and_log ->
--      fn_poker_diamond_tournament_pay, delivery_kind 'cash', payout_source
--      'satellite_ticket', an obligation opened and closed in the same
--      transaction). The Phase 9 header itself names that door for a Diamond
--      ticket paid as money. Nothing divides: the ticket is the target's
--      whole buy-in plus its whole fee, asserted whole before any Diamond
--      moves, and a cash exit closes the prize bank exactly as a seat does.
--      The chip rule is unchanged: a capped chip winner still receives the
--      noncash tournament-entry ticket.
--
--   The event therefore ALWAYS finishes and the winner is ALWAYS paid in the
--   same transaction that records the finish. The engine's existing bounded
--   retry heals the live stuck event within one backoff interval of this
--   apply, through its own finish path - no manual settlement, no repair job.
--
-- Every edit is an asserted substitution: the live md5 pinned, the one shared
-- 871-byte clause occurring exactly once in each authority, the reverse
-- substitution proved to give the pinned text back. Neither authority is on
-- fn_ca_guard_watchlist (checked live), so no guard redefinition declaration
-- is due. Applied once to kuklfnapbkmacvwxktbh in one transaction outside the
-- :50-:03 break window, recorded under its filename version. Never reapply.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)) BEFORE THIS MIGRATION:
--   fn_settle_satellite_tournament_pre_money_path_gate  384887d62082eec9a0d61a9d49d955a2
--   fn_ca_settle_satellite_cohort                       e8986b5b177c88acbde1ac80fe7e029f
-- ============================================================================

DO $do$
DECLARE
  v_name text;
  v_def text;
  v_n integer;
  v_pin text;
  v_pins constant text[] := ARRAY[
    'fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)|384887d62082eec9a0d61a9d49d955a2',
    'fn_ca_settle_satellite_cohort(uuid,uuid[])|e8986b5b177c88acbde1ac80fe7e029f'
  ];
  v_entry text;
  v_old constant text := $o$v_cap_load:=public.fn_concurrent_game_load(
          v_finisher.user_id,NULL,NULL,v_target_id);
        IF v_cap_load>=4 THEN
          -- DIAMOND PHASE 9: the chip estate holds a capped winner's funded
          -- entry in a noncash chip entry ticket. No Diamond entry ticket
          -- exists, so a Diamond settlement is refused by name - nothing has
          -- moved - and is retried once the winner is below the cap.
          IF v_diamond THEN
            RAISE EXCEPTION
              'diamond_satellite_winner_at_the_table_cap: satellite % award % user %',
              p_tournament_id, v_place, v_finisher.user_id USING ERRCODE = '55000';
          END IF;
          -- The cap remains absolute. The winner receives the funded entry as
          -- a noncash tournament ticket instead of a fifth game or wallet chips.
          v_delivery_kind := 'ticket';$o$;
  v_new constant text := $n$v_cap_load:=public.fn_concurrent_game_load(
          v_finisher.user_id,NULL,NULL,v_target_id)
          -- THE DYING SATELLITE IS NOT A GAME (2026-10-17). This settlement
          -- releases the winner's seats at this satellite in this same
          -- transaction, so those seats cannot be the games that cap the
          -- winner. Counting them held Sunday Deep Stack Satellite 10 RUNNING
          -- and unpaid for two hours on 2026-10-16 while its sole survivor
          -- "sat" at the table this settlement was about to close. The
          -- subtraction mirrors clause (1) of fn_concurrent_game_load exactly,
          -- so it removes only seats that clause counted.
          - (SELECT count(*)::int
               FROM public.table_seats zts
               JOIN public.tables zt ON zt.id = zts.table_id
              WHERE zts.user_id = v_finisher.user_id
                AND zts.left_at IS NULL
                AND zt.status <> 'closed'
                AND zt.tournament_id = p_tournament_id
                AND NOT EXISTS (
                  SELECT 1 FROM public.tournaments ztr
                   WHERE ztr.id = zt.tournament_id
                     AND ztr.status IN ('COMPLETING','COMPLETED','CANCELLED')));
        IF v_cap_load>=4 THEN
          IF v_diamond THEN
            -- A CAPPED DIAMOND WINNER IS PAID, NOT HELD (2026-10-17). The
            -- refusal this replaces promised "the engine retries", but a
            -- winner seated at four long events keeps the satellite RUNNING,
            -- undealt and unpaid for hours - a deadlock, not a rule. The
            -- duplicate-qualification rule already pays a Diamond ticket's
            -- value as money through the same pay door (fn_credit_and_log ->
            -- fn_poker_diamond_tournament_pay); the capped winner takes
            -- exactly that path, whole Diamonds, obligation opened and
            -- closed in this transaction, so the event always finishes and
            -- the winner is always paid at once.
            v_delivery_kind := 'cash';
          ELSE
          -- The cap remains absolute. The winner receives the funded entry as
          -- a noncash tournament ticket instead of a fifth game or wallet chips.
          v_delivery_kind := 'ticket';
          END IF;$n$;
BEGIN
  FOREACH v_entry IN ARRAY v_pins LOOP
    v_name := split_part(v_entry, '|', 1);
    v_pin  := split_part(v_entry, '|', 2);
    v_def  := pg_get_functiondef(('public.' || v_name)::regprocedure);
    IF md5(v_def) <> v_pin THEN
      RAISE EXCEPTION '% is not the pinned text (md5 %)', v_name, md5(v_def);
    END IF;
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: the cap clause occurs % times, expected once', v_name, v_n;
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
    v_def := pg_get_functiondef(('public.' || v_name)::regprocedure);
    v_n := (length(v_def) - length(replace(v_def, v_new, ''))) / length(v_new);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: the replacement landed % times, expected once', v_name, v_n;
    END IF;
    IF md5(replace(v_def, v_new, v_old)) <> v_pin THEN
      RAISE EXCEPTION '% is NOT the pinned text plus the documented substitution', v_name;
    END IF;
    IF position('diamond_satellite_winner_at_the_table_cap' IN v_def) <> 0 THEN
      RAISE EXCEPTION '% still carries the no-exit refusal', v_name;
    END IF;
  END LOOP;
END $do$;

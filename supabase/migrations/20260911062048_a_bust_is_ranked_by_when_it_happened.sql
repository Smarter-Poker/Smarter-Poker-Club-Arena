-- 20260911062048_a_bust_is_ranked_by_when_it_happened
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-11 06:20:48 UTC.
-- Written, proved, NOT applied. Amended on 2026-09-11 (second pass, after an
-- adversarial review) so that it is still one change in one transaction.
--
-- DO NOT APPLY INSIDE MINUTE :50-:03 UTC. That is the hourly break window: the
-- database refuses DDL in it (ca_break_window_refuses_ddl) and a migration
-- there lands on the break announcement. Apply once, after :03, never in a
-- retry loop (CLAUDE.md, production DDL policy, rules 2 and 8).
--
-- THE RULE (decided 2026-09-11). A finishing place is decided by when the bust
-- happened: the commit time of the accepted hand that took the stack,
-- hand_atomic_commits.committed_at. Busts in different hands are ordered by
-- those commit times, not by hand number (the global deal order, which
-- disagrees with commit order for about a third of cross-table busts). Busts
-- in one hand rank the smaller hand-start stack first - it busts first and
-- finishes lower (TDA) - then user id, one microsecond apart. Hand-for-hand
-- play, where TDA treats busts at different tables in one hand-for-hand hand
-- as simultaneous, is out of scope: those busts are ordered by commit time.
-- The engine still records busts in hand-number order, because the PKO
-- watermark settles bounties in that order; the place it hands out while
-- recording is provisional, and the finish below re-derives every place.
--
-- WHAT WAS WRONG (read from production 2026-09-11, read-only).
--
-- 1. THE FINISH PAID RECORDING ORDER. Every tournament finishes through
--    fn_complete_tournament_terminal -> fn_complete_tournament_terminal_pre_seat_guard
--    -> fn_settle_tournament_places, which renumbered the eliminated rows by
--    elimination_sequence - a trigger stamps it when the knockout door RECORDS
--    a bust - and paid the ladder by those positions. A bust the door recorded
--    hours late was paid a place it did not finish in: 15 COMPLETED events in
--    34 hours misallocated about 1,437-1,659 chips, 11 of them bounty events.
-- 2. BOTH KNOCKOUT DOORS STAMPED THE CLOCK. The write halves of the non-bounty
--    door (fn_eliminate_player_legacy_candidate_20260907) and of the bounty
--    door (fn_claim_bounty_legacy_candidate_20260907) set eliminated_at =
--    now(), the moment they ACCEPTED a bust: in 798866ae 64 of 83 busts were
--    recorded more than a minute late, 26 more than an hour, one 26h42m late.
-- 3. THE NORMALIZER MOVED PLACES WITHOUT MOVING THEIR PRICE (the prepare and
--    ruling path, which the server does not call): it renumbered positions and
--    left tp.prize behind, so fn_prepare_tournament_place_obligations refused
--    the event for ever with recorded_prize_disagrees_with_structure.
-- 4. AN ORPHANED GENERATION BLOCKED A REAL BUST FOR EVER. The 2026-09-08/09
--    rebuy chain bought players back in without resolving the busted knockout
--    generation to 'rebought', and both doors then refused the player's next,
--    real bust with unresolved_knockout_generation_chain (356 refusals of one
--    player in 798866ae in 39 minutes). Data repairs at 07:04 and 07:23 UTC
--    resolved the four players held at 06:20 UTC; at ~09:00 UTC no RUNNING
--    event holds an older non-rebought generation. The rule below is
--    protection for the next one.
-- 5. A PLAYER WHO PLAYED ON AFTER A REBUY COULD BE RECORDED AT A BUST THEY
--    CAME BACK FROM. When that chain left the generation 'pending' and the
--    player kept playing, the generation the door binds is still the old one.
--    Seven eliminated rows have that shape (none in the money): 798866ae
--    22af2652, 6d6b3cc2, 20a40df1, 45a5e770 (COMPLETED); 7aa16fa7 71efcdb3
--    and a5aa6984 55256246 (RUNNING); 2e7240ea 2a763abd (COMPLETED). This
--    migration writes no data; they are listed, not repaired.
-- 6. THE UNFINISHED-FINISH ALARM (cron 304, fn_ca_tournament_finished_but_not_completed)
--    measured from max(eliminated_at); with a bust-time stamp, a final bust
--    recorded late would raise a critical alarm the moment the event became
--    finishable.
--
-- WHAT THIS CHANGES. Seven existing functions; same signatures, owner,
-- SECURITY DEFINER, settings and grants (restated below); nothing else in
-- them touched.
--
--   fn_settle_tournament_places ranks every eliminated row by when its bust
--     happened, derived in the statements that use it from what the knockout
--     door proved: the commit time of the accepted hand of the player's
--     latest 'eliminated' knockout generation, plus the same-hand microsecond
--     rank. A row with no such witness falls back to its eliminated_at; a row
--     with neither is refused (P0404), never guessed. Equal times fall back to
--     elimination_sequence, then id. elimination_sequence still alone names the
--     last elimination, and so the winner when the whole field reads
--     eliminated. The check that decides whether places move uses the same
--     order, so a ladder already in true order is not touched. Every refusal is
--     kept: places that carry money (a positioned payout or a place obligation)
--     are never relabelled - the one case that is not a relabel is a
--     COMPLETING event whose places are exactly the recording-order ladder,
--     which the rule this replaces already paid, and which is replayed as paid;
--     COMPLETED events are exact replays and are never renumbered.
--   fn_eliminate_player_legacy_candidate_20260907 (non-bounty write half) and
--   fn_claim_bounty_legacy_candidate_20260907 (bounty write half) stamp
--     eliminated_at with the bust by the same rule, and refuse
--     (knockout_bust_time_unproven) a bust whose hand cannot be read, and a
--     generation the player provably played on from: a posted rebuy leg after
--     it AND a later hand of this event that deals the player in.
--   fn_eliminate_tournament_player_atomic (non-bounty door) and
--   fn_claim_tournament_bounty_elimination (bounty door) resolve an older
--     PENDING generation to 'rebought' when, and only when, a posted 'rebuy'
--     leg from this player's wallet to this event's prize liability was
--     written after that generation was captured and before the player's next
--     generation was. The bounty door also requires that generation's head to
--     be closed: no bounty obligation names its hand or its chair, or every one
--     that does is settled with its complete marker. An obligation still owed
--     keeps it refused: collected after this claim, it would be paid against a
--     player recorded under a newer head, and nothing here proves that safe.
--     The resolution commits with the newer bust (rebought_generations).
--   fn_normalize_tournament_final_standings re-prices every row it moves by
--     fn_prepare_tournament_place_obligations's own ladder rule, in the same
--     write; refuses (moved_places_cannot_be_repriced_after_money_moved) only
--     once PLACE money moved - a payout from any source but a bounty or a
--     satellite seat, or a place or Bubble Protection obligation - and refuses
--     (moved_places_cannot_be_priced) when no ladder can be derived.
--   fn_ca_tournament_finished_but_not_completed measures from when the last
--     bust was RECORDED: GREATEST(max(eliminated_at), the latest resolved_at
--     of a knockout generation the door consumed).
--
-- NO DATA IS WRITTEN AND NO BACKFILL IS NEEDED. The settlement derives each
-- bust from the witnesses the door already proved (the consumed generation and
-- its hand's commit), so rows recorded before this migration are ranked by
-- their hands exactly like rows recorded after it.
--
-- eliminated_at IS A MIXED COLUMN FROM HERE ON. Rows recorded before this
-- migration carry the moment they were recorded; rows recorded after it carry
-- the bust. Nothing that decides a place relies on it where a witness exists.
-- The normalizer and the place prepare (the ruling path, not called by the
-- server) still rank by eliminated_at, so on an event recorded across this
-- migration their order is only as good as the older rows' recording times.
--
-- MEASURED ON PRODUCTION: see the changelog,
-- docs/changelog/2026-09-11-a-bust-is-ranked-by-when-it-happened.md.
--
-- DEPLOY ORDER. The engine half of this change (server/src/tournament/bustOrder.ts
-- and TournamentManagerEliminations.ts on this branch) deploys WITH OR BEFORE
-- this migration: the doors now resolve orphaned generations, and an engine
-- still ordering by the earliest pending generation would record such a player
-- out of hand order and advance the PKO watermark past earlier busts.
--
-- PROVED in PostgreSQL 17 against byte-exact captures of the live bodies:
-- scripts/dev/probe-a-bust-is-ranked-by-when-it-happened-pg17.sh runs every
-- scenario against the old bodies (each FIXED behaviour must fail there, on a
-- probe assertion), then applies this file twice and runs them all again.
--
-- One transaction (CLAUDE.md production DDL policy). The preflight refuses to
-- apply over any body, owner, grant or setting it was not reviewed against,
-- including the three functions it reads without replacing
-- (fn_ca_latest_committed_knockout_candidate, the generation the doors bind;
-- fn_prepare_tournament_place_obligations, whose ladder rule is copied;
-- fn_bounty_obligation_has_complete_marker, which proves a head closed). Each
-- replaced body is accepted as the live body or as this file's own result, so
-- a second apply is a proven no-op; the postflight proves the result.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_settle_tournament_places(uuid,uuid)')
       AND md5(p.prosrc) IN ('d0262f4928b12eea1cc5e9175cbf2737', 'a451a9a3205185ee4b284ea8d8a44f35')
       AND p.proowner = 'postgres'::regrole
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
       AND NOT p.proretset AND p.prorettype = 'jsonb'::regtype
       AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
       AND p.proconfig::text = '{search_path=public,statement_timeout=30s}'
  ) THEN
    RAISE EXCEPTION 'Source function body or authority changed; review before applying: public.fn_settle_tournament_places(uuid,uuid)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)')
       AND md5(p.prosrc) IN ('f596d731cacf8d7e62a4549204ce73fc', '66de5a1bd9a520a6afdfd36c82c83908')
       AND p.proowner = 'postgres'::regrole
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
       AND NOT p.proretset AND p.prorettype = 'jsonb'::regtype
       AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
       AND p.proconfig::text = '{"search_path=public, pg_temp"}'
  ) THEN
    RAISE EXCEPTION 'Source function body or authority changed; review before applying: public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)')
       AND md5(p.prosrc) IN ('590f0f782e127288f33763bbab8c89f0', '29e95c342e7ada09715bc7aa1d248c6d')
       AND p.proowner = 'postgres'::regrole
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
       AND NOT p.proretset AND p.prorettype = 'jsonb'::regtype
       AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
       AND p.proconfig::text = '{"search_path=public, pg_temp"}'
  ) THEN
    RAISE EXCEPTION 'Source function body or authority changed; review before applying: public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)')
       AND md5(p.prosrc) IN ('b4937067d9bf337e1466095b9e1d5424', '66b721eb896d927f2fedb0b9c739d0fb')
       AND p.proowner = 'postgres'::regrole
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
       AND NOT p.proretset AND p.prorettype = 'jsonb'::regtype
       AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
       AND p.proconfig::text = '{"search_path=public, pg_temp"}'
  ) THEN
    RAISE EXCEPTION 'Source function body or authority changed; review before applying: public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)')
       AND md5(p.prosrc) IN ('876456f79250a307292dc6f2ae1564f3', 'a908e937ed1fd193603d383bbfabebc0')
       AND p.proowner = 'postgres'::regrole
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
       AND NOT p.proretset AND p.prorettype = 'jsonb'::regtype
       AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
       AND p.proconfig::text = '{"search_path=public, pg_temp"}'
  ) THEN
    RAISE EXCEPTION 'Source function body or authority changed; review before applying: public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_normalize_tournament_final_standings(uuid)')
       AND md5(p.prosrc) IN ('ad865880f99bc28896bec03c66ae55a9', '45b06c3f8be02940d130c427d5a32519')
       AND p.proowner = 'postgres'::regrole
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
       AND NOT p.proretset AND p.prorettype = 'jsonb'::regtype
       AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
       AND p.proconfig::text = '{search_path=public}'
  ) THEN
    RAISE EXCEPTION 'Source function body or authority changed; review before applying: public.fn_normalize_tournament_final_standings(uuid)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_ca_tournament_finished_but_not_completed(integer)')
       AND md5(p.prosrc) IN ('e1eebfe28f393f2617c0a1ac93c2583a', '6f153669e4b6b149bfccd36ad575bda8')
       AND p.proowner = 'postgres'::regrole
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
       AND NOT p.proretset AND p.prorettype = 'jsonb'::regtype
       AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
       AND p.proconfig::text = '{search_path=public,statement_timeout=60s}'
  ) THEN
    RAISE EXCEPTION 'Source function body or authority changed; review before applying: public.fn_ca_tournament_finished_but_not_completed(integer)'
      USING ERRCODE = '55000';
  END IF;
  -- Read, not replaced: the generation the doors bind, the ladder rule the
  -- normalizer prices with, and the marker that proves a bounty head closed.
  -- Any of them changing means this was not the change that was reviewed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_ca_latest_committed_knockout_candidate(uuid,uuid)')
       AND md5(p.prosrc) = '0602827901be20bbb6e0dce6ece17f94'
  ) THEN
    RAISE EXCEPTION 'A function this change reads was redefined; review before applying: public.fn_ca_latest_committed_knockout_candidate(uuid,uuid)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_prepare_tournament_place_obligations(uuid,text)')
       AND md5(p.prosrc) = 'ca0abbc6d297f3009143676261d8cf19'
  ) THEN
    RAISE EXCEPTION 'A function this change reads was redefined; review before applying: public.fn_prepare_tournament_place_obligations(uuid,text)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_bounty_obligation_has_complete_marker(uuid)')
       AND md5(p.prosrc) = 'bd29069e8d07bedf84e24e57242c2afe'
  ) THEN
    RAISE EXCEPTION 'A function this change reads was redefined; review before applying: public.fn_bounty_obligation_has_complete_marker(uuid)'
      USING ERRCODE = '55000';
  END IF;
END;
$preflight$;

-- The finish: every place is ranked by when its bust happened, derived from the door's witnesses.
CREATE OR REPLACE FUNCTION public.fn_settle_tournament_places(p_tournament_id uuid, p_observed_winner_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_t record;
  v_ladder jsonb;
  v_payouts jsonb := '[]'::jsonb;
  v_status text;
  v_live_count integer;
  v_field_size integer;
  v_eliminated_count integer;
  v_sequenced_count integer;
  v_bubble_place integer;
  v_bubble_user_id uuid;
  v_bubble_amount numeric := 0;
  v_bubble_payout_count integer := 0;
  v_bubble_paid numeric := 0;
  v_bubble_ob_count integer := 0;
  v_bubble_ob public.tournament_obligations%ROWTYPE;
  v_bubble_result jsonb;
  v_winner public.tournament_players%ROWTYPE;
  v_row record;
  v_place integer;
  v_amount numeric;
  v_user_id uuid;
  v_ob public.tournament_obligations%ROWTYPE;
  v_evidence numeric;
  v_evidence_count integer;
  v_total_expected numeric := 0;
  v_winner_amount numeric := 0;
  v_result jsonb;
  v_guarantee_result jsonb;
  v_rows integer;
  v_unwitnessed_busts integer;
  v_misplaced_busts integer;
BEGIN
  -- Every rolling and terminal money authority enters one transaction lane
  -- before it can own an event, obligation, bank, or recipient row.
  PERFORM public.fn_ca_lock_settlement_lane_global();
  IF p_tournament_id IS NULL OR p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'place settlement requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  -- Canonical lock order. Re-locks inside owner-only callees are rows already
  -- owned by this transaction and therefore cannot invert a wait dependency.
  SELECT t.id, t.status, t.variant, t.tournament_type, t.is_premium_spin,
         t.satellite_target_id, t.satellite_target, t.prize_pool,
         t.bubble_protection, t.buy_in_amount, t.guaranteed_prize,
         t.prize_pool_finalized
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  v_status := upper(COALESCE(v_t.status,''));
  IF v_status NOT IN ('RUNNING','COMPLETING','COMPLETED') THEN
    RAISE EXCEPTION 'tournament % cannot settle from status %',
      p_tournament_id, v_t.status USING ERRCODE = '55000';
  END IF;
  IF lower(COALESCE(v_t.variant,'')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type,'')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is a satellite, not an ordinary cash ladder',
      p_tournament_id USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_payouts p
              WHERE p.tournament_id = p_tournament_id
                AND lower(COALESCE(p.source,'')) = 'final_table_deal')
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND o.kind = 'final_table_deal') THEN
    RAISE EXCEPTION
      'tournament % carries final-table-deal evidence; use the deal authority',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Funding the advertised guarantee is part of this settlement transaction,
  -- not a best-effort request made by the game process immediately beforehand.
  -- fn_apply_prize_guarantee re-locks the row already owned here and either
  -- debits the event-owned bank plus finalizes the pool, or raises. Prove its
  -- receipt against the refreshed row before deriving even the first place; a
  -- refusal therefore rolls back the overlay, every payout and the finish.
  IF v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool < 0
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool, 2) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent prize pool %',
      p_tournament_id, v_t.prize_pool USING ERRCODE = '22003';
  END IF;
  IF v_t.guaranteed_prize IS NOT NULL
     AND (v_t.guaranteed_prize::text IN ('NaN','Infinity','-Infinity')
       OR v_t.guaranteed_prize < 0
       OR v_t.guaranteed_prize IS DISTINCT FROM round(v_t.guaranteed_prize, 2)) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent guarantee %',
      p_tournament_id, v_t.guaranteed_prize USING ERRCODE = '22003';
  END IF;
  v_guarantee_result := public.fn_apply_prize_guarantee(
    p_tournament_id, 'engine.fn_settle_tournament_places');
  IF COALESCE((v_guarantee_result->>'ok')::boolean, false) IS NOT TRUE
     OR (COALESCE((v_guarantee_result->>'overlay')::numeric,0) > 0
         AND COALESCE(
           (v_guarantee_result->>'overlay_journaled')::boolean,false)
             IS NOT TRUE) THEN
    RAISE EXCEPTION 'tournament % guarantee funding refused: %',
      p_tournament_id, v_guarantee_result USING ERRCODE = 'P0404';
  END IF;

  SELECT t.id, t.status, t.variant, t.tournament_type, t.is_premium_spin,
         t.satellite_target_id, t.satellite_target, t.prize_pool,
         t.bubble_protection, t.buy_in_amount, t.guaranteed_prize,
         t.prize_pool_finalized
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF COALESCE(v_t.prize_pool_finalized, false) IS NOT TRUE
     OR v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool, 2)
     OR v_t.prize_pool < COALESCE(v_t.guaranteed_prize, 0)
     OR v_guarantee_result->>'prize_pool' IS NULL
     OR (v_guarantee_result->>'prize_pool')::numeric IS DISTINCT FROM v_t.prize_pool THEN
    RAISE EXCEPTION
      'tournament % guarantee funding did not produce one finalized locked pool: result %, pool %, guarantee %, finalized %',
      p_tournament_id, v_guarantee_result, v_t.prize_pool,
      v_t.guaranteed_prize, v_t.prize_pool_finalized USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.id FOR UPDATE;
  SELECT count(*) INTO v_field_size
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF EXISTS (SELECT 1 FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.status::text = 'registered') THEN
    RAISE EXCEPTION 'tournament % still has a registered unresolved player',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- The helper counts the final field, so derive only after the complete
  -- roster has joined the canonical tournament -> roster lock sequence.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',a.place,'amount',a.amount) ORDER BY a.place),'[]'::jsonb)
    INTO v_ladder
    FROM public.fn_ca_tournament_place_amounts(p_tournament_id) a;
  IF jsonb_array_length(v_ladder) = 0 THEN
    RAISE EXCEPTION 'tournament % derived an empty ladder', p_tournament_id
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO v_live_count FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text IN ('playing','winner');
  IF v_live_count > 1 THEN
    RAISE EXCEPTION 'tournament % still has % live players',
      p_tournament_id, v_live_count USING ERRCODE = '55000';
  ELSIF v_live_count = 1 THEN
    SELECT tp.* INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text IN ('playing','winner');
  ELSE
    -- The observed last survivor may already have crossed through
    -- `eliminated` in an all-in race. The committed transition sequence, not
    -- a wall clock, proves that this row was the final elimination.
    SELECT tp.* INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = p_observed_winner_id
       AND tp.status::text = 'eliminated'
       AND tp.elimination_sequence IS NOT NULL;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.id <> v_winner.id
         AND tp.elimination_sequence = v_winner.elimination_sequence
    ) THEN
      RAISE EXCEPTION
        'tournament % has an ambiguous final elimination witness',
        p_tournament_id USING ERRCODE = '23505';
    END IF;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
         AND (tp.elimination_sequence IS NULL
              OR tp.elimination_sequence > v_winner.elimination_sequence)
    ) THEN
      v_winner := NULL;
    END IF;
  END IF;
  IF v_winner.id IS NULL OR v_winner.user_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION 'observed winner % does not match locked winner % for tournament %',
      p_observed_winner_id, v_winner.user_id, p_tournament_id
      USING ERRCODE = '40001';
  END IF;

  -- Lock the whole set once, before validation or the ascending-place walk.
  PERFORM 1 FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
   ORDER BY o.kind, o.place NULLS LAST, o.id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
       AND (o.place IS NULL OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_ladder) a
          WHERE (a->>'place')::integer = o.place))
  ) THEN
    RAISE EXCEPTION
      'tournament % has a place obligation outside its derived ladder',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  IF v_status = 'COMPLETED' THEN
    IF v_winner.status::text <> 'winner' OR v_winner.position <> 1 THEN
      RAISE EXCEPTION
        'COMPLETED tournament % is not an exact replay: winner is not durable',
        p_tournament_id USING ERRCODE = '55000';
    END IF;
  ELSE
    -- Recorded finish positions are the engine's live witness. Never rebuild
    -- an all-busted field from timestamps. Promotion may fill first place, but
    -- it cannot displace another recorded first or vacate a ladder place.
    IF EXISTS (SELECT 1 FROM public.tournament_players tp
                WHERE tp.tournament_id = p_tournament_id
                  AND tp.position = 1
                  AND tp.user_id <> v_winner.user_id) THEN
      RAISE EXCEPTION 'tournament % assigns first place to another player',
        p_tournament_id USING ERRCODE = '23505';
    END IF;
    IF v_winner.position IS NOT NULL AND v_winner.position <> 1
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_ladder) a
                    WHERE (a->>'place')::integer = v_winner.position) THEN
      RAISE EXCEPTION
        'promoting winner % would vacate cash place % in tournament %',
        v_winner.user_id, v_winner.position, p_tournament_id
        USING ERRCODE = '55000';
    END IF;
    UPDATE public.tournament_players
       SET status = 'winner', position = 1,
           eliminated_at = NULL, elimination_sequence = NULL
     WHERE id = v_winner.id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION
        'tournament % could not promote exactly one winner',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    -- Final numeric positions are derived from the transition witness, not
    -- from the field size that happened to exist when each player busted.
    -- This is the root fix for late registration enlarging the field after an
    -- early elimination. Existing money evidence is never relabelled: a
    -- legacy event whose paid place would move fails closed for explicit
    -- adjudication instead of rewriting settled history.
    SELECT count(*), count(tp.elimination_sequence),
           count(DISTINCT tp.elimination_sequence)
      INTO v_eliminated_count, v_sequenced_count, v_rows
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated';
    IF v_eliminated_count <> v_field_size - 1
       OR v_sequenced_count <> v_eliminated_count
       OR v_rows <> v_eliminated_count THEN
      RAISE EXCEPTION
        'tournament % has no complete durable elimination sequence (%/% of %)',
        p_tournament_id, v_sequenced_count, v_rows, v_eliminated_count
        USING ERRCODE = 'P0404';
    END IF;

    /* A BUST IS RANKED BY WHEN IT HAPPENED (2026-09-11). Places were
       numbered in elimination_sequence order, which a trigger stamps when
       the knockout door RECORDS a bust, so a bust the door recorded hours
       late was paid a place it did not finish in. Each eliminated row is now
       ranked by when its bust happened, derived in the statement that uses
       it from what the door proved: the commit time of the accepted hand of
       the player's latest 'eliminated' knockout generation, plus one
       microsecond per earlier rank in that hand (smaller hand-start stack
       first, then user id - the rule the door stamps eliminated_at with).
       Busts in different hands are ordered by those hands' commit times. A
       row with no such witness keeps its eliminated_at; a row with neither
       is refused, never guessed. Equal times fall back to
       elimination_sequence, then id. elimination_sequence alone still names
       the last elimination, and so the winner, above. The same order decides
       whether anything moves, so a ladder already in true order is left
       exactly as it is. */
    WITH busts AS (
      SELECT tp.id, tp.position, tp.elimination_sequence,
             COALESCE((
               SELECT a.committed_at
                      + (SELECT count(*)
                           FROM public.tournament_knockout_candidates s
                          WHERE s.tournament_id = c.tournament_id
                            AND s.table_id = c.table_id
                            AND s.hand_number = c.hand_number
                            AND s.hand_id = c.hand_id
                            AND (s.stack_before, s.eliminated_user_id)
                                < (c.stack_before, c.eliminated_user_id))::integer
                        * interval '1 microsecond'
                 FROM (SELECT k.tournament_id, k.table_id, k.hand_number,
                              k.hand_id, k.stack_before, k.eliminated_user_id
                         FROM public.tournament_knockout_candidates k
                        WHERE k.tournament_id = tp.tournament_id
                          AND k.eliminated_user_id = tp.user_id
                          AND k.state = 'eliminated'
                        ORDER BY k.hand_number DESC, k.id DESC
                        LIMIT 1) c
                 JOIN public.hand_atomic_commits a
                   ON a.table_id = c.table_id
                  AND a.hand_number = c.hand_number
                  AND a.hand_id = c.hand_id
             ), tp.eliminated_at) AS bust_at
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
    ),
    ranked AS (
      SELECT b.id, b.position, b.bust_at,
             row_number() OVER (
               ORDER BY b.bust_at DESC, b.elimination_sequence DESC, b.id ASC
             )::integer + 1 AS expected_position
        FROM busts b
    )
    SELECT count(*) FILTER (WHERE ranked.bust_at IS NULL),
           count(*) FILTER (WHERE ranked.position IS DISTINCT FROM ranked.expected_position)
      INTO v_unwitnessed_busts, v_misplaced_busts
      FROM ranked;
    IF v_unwitnessed_busts > 0 THEN
      RAISE EXCEPTION
        'tournament % has % eliminated player(s) with no bust witness and no eliminated_at',
        p_tournament_id, v_unwitnessed_busts USING ERRCODE = 'P0404';
    END IF;

    IF v_misplaced_busts > 0 THEN
      IF EXISTS (
        SELECT 1 FROM public.tournament_payouts p
         WHERE p.tournament_id = p_tournament_id
           AND p."position" IS NOT NULL
      ) OR EXISTS (
        SELECT 1 FROM public.tournament_obligations o
         WHERE o.tournament_id = p_tournament_id
           AND o.kind = 'place'
      ) THEN
        /* Paid places are never relabelled. A COMPLETING event whose
           places are exactly the recording-order ladder was settled by the
           rule this replaces, and is replayed as it was paid, not refused. */
        IF v_status <> 'COMPLETING' OR EXISTS (
          SELECT 1
            FROM (
              SELECT tp.position,
                     row_number() OVER (
                       ORDER BY tp.elimination_sequence DESC, tp.id ASC
                     )::integer + 1 AS expected_position
                FROM public.tournament_players tp
               WHERE tp.tournament_id = p_tournament_id
                 AND tp.status::text = 'eliminated'
            ) recorded
           WHERE recorded.position IS DISTINCT FROM recorded.expected_position
        ) THEN
          RAISE EXCEPTION
            'tournament % needs a late-entry position normalization but already carries settled place evidence',
            p_tournament_id USING ERRCODE = 'P0404';
        END IF;
      ELSE
        UPDATE public.tournament_players tp
           SET position = NULL
         WHERE tp.tournament_id = p_tournament_id
           AND tp.status::text = 'eliminated';

        WITH busts AS (
        SELECT tp.id, tp.position, tp.elimination_sequence,
               COALESCE((
                 SELECT a.committed_at
                        + (SELECT count(*)
                             FROM public.tournament_knockout_candidates s
                            WHERE s.tournament_id = c.tournament_id
                              AND s.table_id = c.table_id
                              AND s.hand_number = c.hand_number
                              AND s.hand_id = c.hand_id
                              AND (s.stack_before, s.eliminated_user_id)
                                  < (c.stack_before, c.eliminated_user_id))::integer
                          * interval '1 microsecond'
                   FROM (SELECT k.tournament_id, k.table_id, k.hand_number,
                                k.hand_id, k.stack_before, k.eliminated_user_id
                           FROM public.tournament_knockout_candidates k
                          WHERE k.tournament_id = tp.tournament_id
                            AND k.eliminated_user_id = tp.user_id
                            AND k.state = 'eliminated'
                          ORDER BY k.hand_number DESC, k.id DESC
                          LIMIT 1) c
                   JOIN public.hand_atomic_commits a
                     ON a.table_id = c.table_id
                    AND a.hand_number = c.hand_number
                    AND a.hand_id = c.hand_id
               ), tp.eliminated_at) AS bust_at
          FROM public.tournament_players tp
         WHERE tp.tournament_id = p_tournament_id
           AND tp.status::text = 'eliminated'
        ),
        ranked AS (
          SELECT b.id,
                 row_number() OVER (
                   ORDER BY b.bust_at DESC, b.elimination_sequence DESC, b.id ASC
                 )::integer + 1 AS expected_position
            FROM busts b
        )
        UPDATE public.tournament_players tp
           SET position = ranked.expected_position
          FROM ranked
         WHERE tp.id = ranked.id;
      END IF;
    END IF;
  END IF;

  -- Derive the single pool-funded bubble promise after standings are final.
  -- The percentage helper has already reserved this exact amount from its
  -- ladder. Satellites never enter this authority: their bubble is paid the
  -- residual that cannot buy a full seat by the satellite settle path.
  SELECT max((a->>'place')::integer) + 1
    INTO v_bubble_place
    FROM jsonb_array_elements(v_ladder) a;
  IF COALESCE(v_t.bubble_protection, false)
     AND v_bubble_place IS NOT NULL
     AND v_bubble_place <= v_field_size THEN
    IF v_t.buy_in_amount IS NULL
       OR v_t.buy_in_amount::text IN ('NaN','Infinity','-Infinity')
       OR v_t.buy_in_amount <= 0
       OR v_t.buy_in_amount IS DISTINCT FROM round(v_t.buy_in_amount, 2) THEN
      RAISE EXCEPTION 'tournament % has invalid bubble buy-in %',
        p_tournament_id, v_t.buy_in_amount USING ERRCODE = '22003';
    END IF;
    v_bubble_amount := round(v_t.buy_in_amount, 2);
    IF v_bubble_amount > v_t.prize_pool THEN
      RAISE EXCEPTION 'tournament % bubble amount % exceeds pool %',
        p_tournament_id, v_bubble_amount, v_t.prize_pool
        USING ERRCODE = '23514';
    END IF;

    SELECT count(*), min(tp.user_id::text)::uuid
      INTO v_rows, v_bubble_user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_bubble_place
       AND tp.status::text = 'eliminated';
    IF v_rows <> 1 OR v_bubble_user_id IS NULL THEN
      RAISE EXCEPTION 'tournament % has no single eliminated stone bubble at place %',
        p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
    END IF;
  END IF;

  SELECT count(*), COALESCE(sum(p.amount), 0)
    INTO v_bubble_payout_count, v_bubble_paid
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection';
  SELECT count(*) INTO v_bubble_ob_count
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind = 'bubble_protection';

  IF v_bubble_amount = 0 THEN
    IF v_bubble_payout_count <> 0 OR v_bubble_paid <> 0
       OR v_bubble_ob_count <> 0 THEN
      RAISE EXCEPTION 'tournament % carries bubble evidence but no bubble is due',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSE
    IF v_bubble_paid > v_bubble_amount
       OR EXISTS (
         SELECT 1 FROM public.tournament_payouts p
          WHERE p.tournament_id = p_tournament_id
            AND p.source = 'bubble_protection'
            AND (p.user_id IS DISTINCT FROM v_bubble_user_id
              OR p."position" IS NOT NULL
              OR p.amount IS NULL
              OR p.amount::text IN ('NaN','Infinity','-Infinity')
              OR p.amount <= 0
              OR p.amount IS DISTINCT FROM round(p.amount, 2)
              OR p.idempotency_key IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM public.wallet_credit_idempotency k
                 WHERE k.key = p.idempotency_key
                   AND k.user_id = p.user_id
                   AND k.amount = p.amount))) THEN
      RAISE EXCEPTION 'tournament % has malformed bubble payout evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT * INTO v_bubble_ob
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'bubble_protection'
       AND o.user_id = v_bubble_user_id;
    IF v_bubble_ob_count > 0
       AND (v_bubble_ob_count <> 1 OR v_bubble_ob.id IS NULL
         OR v_bubble_ob.place IS NOT NULL
         OR v_bubble_ob.amount_owed IS DISTINCT FROM v_bubble_amount
         OR v_bubble_ob.amount_paid IS DISTINCT FROM v_bubble_paid
         OR v_bubble_ob.amount_paid < 0
         OR v_bubble_ob.amount_paid > v_bubble_ob.amount_owed
         OR (v_bubble_ob.amount_paid = v_bubble_ob.amount_owed) IS DISTINCT FROM
            (v_bubble_ob.settled_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'tournament % has malformed bubble obligation evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    IF v_bubble_ob_count = 0
       AND (v_bubble_payout_count <> 0 OR v_bubble_paid <> 0) THEN
      RAISE EXCEPTION 'tournament % has bubble money without its debt record',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    IF v_status = 'COMPLETED'
       AND (v_bubble_ob_count <> 1
         OR v_bubble_paid IS DISTINCT FROM v_bubble_amount
         OR v_bubble_ob.amount_paid IS DISTINCT FROM v_bubble_amount
         OR v_bubble_ob.settled_at IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM public.tournament_players tp
            WHERE tp.tournament_id = p_tournament_id
              AND tp.user_id = v_bubble_user_id
              AND tp.position = v_bubble_place
              AND tp.prize IS NOT DISTINCT FROM v_bubble_amount)) THEN
      RAISE EXCEPTION 'COMPLETED tournament % has no exact bubble replay',
        p_tournament_id USING ERRCODE = '55000';
    END IF;
  END IF;

  -- Anything paid from the prize bank outside the derived ladder makes a full
  -- structure payout unsafe. Bounty/seat sources belong to other authorities.
  IF EXISTS (
    SELECT 1 FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND COALESCE(p.source,'') NOT IN
           ('bounty','own_bounty','mystery_bounty','mystery_bounty_residual',
            'bounty_residual','satellite_seat','bubble_protection')
       AND (p."position" IS NULL OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_ladder) a
          WHERE (a->>'place')::integer = p."position"))
  ) THEN
    RAISE EXCEPTION 'tournament % has prize evidence outside its derived ladder',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Obligation-shaped wallet identity with no exact payout row is mixed
  -- evidence. It is checked globally before any place can move.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_obligations o
      JOIN public.wallet_credit_idempotency k
        ON k.key LIKE 'tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ':%'
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_payouts p
          WHERE p.idempotency_key = k.key
            AND p.tournament_id = p_tournament_id
            AND p.user_id = k.user_id AND p.amount = k.amount)
  ) THEN
    RAISE EXCEPTION
      'tournament % has wallet-credit identity without payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Preflight every place before settling the first one.
  FOR v_row IN
    SELECT (a->>'place')::integer AS place,
           (a->>'amount')::numeric AS amount, tp.user_id,
           tp.prize AS cached_prize
      FROM jsonb_array_elements(v_ladder) a
      LEFT JOIN public.tournament_players tp
        ON tp.tournament_id = p_tournament_id
       AND tp.position = (a->>'place')::integer
     ORDER BY (a->>'place')::integer
  LOOP
    v_place := v_row.place; v_amount := v_row.amount; v_user_id := v_row.user_id;
    IF v_user_id IS NULL THEN
      RAISE EXCEPTION 'tournament % has no finisher for cash place %',
        p_tournament_id, v_place USING ERRCODE = '23502';
    END IF;
    IF v_amount::text IN ('NaN','Infinity','-Infinity') OR v_amount < 0
       OR v_amount IS DISTINCT FROM round(v_amount,2) THEN
      RAISE EXCEPTION 'tournament % derived invalid amount % for place %',
        p_tournament_id, v_amount, v_place USING ERRCODE = '22003';
    END IF;
    v_total_expected := v_total_expected + v_amount;
    IF v_place = 1 THEN v_winner_amount := v_amount; END IF;
    IF v_status = 'COMPLETED'
       AND v_row.cached_prize IS DISTINCT FROM v_amount THEN
      RAISE EXCEPTION
        'COMPLETED tournament %, place % has stale prize cache % (expected %)',
        p_tournament_id, v_place, v_row.cached_prize, v_amount
        USING ERRCODE = '55000';
    END IF;

    -- Each payout row is also required to name an exact wallet-credit identity.
    IF EXISTS (
      SELECT 1 FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id AND p."position" = v_place
         AND (p.user_id IS DISTINCT FROM v_user_id OR p.amount IS NULL
           OR p.amount::text IN ('NaN','Infinity','-Infinity') OR p.amount < 0
           OR p.amount IS DISTINCT FROM round(p.amount,2)
           OR p.idempotency_key IS NULL OR NOT EXISTS (
             SELECT 1 FROM public.wallet_credit_idempotency k
              WHERE k.key = p.idempotency_key AND k.user_id = p.user_id
                AND k.amount = p.amount))
    ) THEN
      RAISE EXCEPTION
        'tournament %, place % has mixed/malformed/wrong-recipient evidence',
        p_tournament_id, v_place USING ERRCODE = 'P0404';
    END IF;
    SELECT count(*), COALESCE(sum(p.amount),0)
      INTO v_evidence_count, v_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id AND p."position" = v_place;
    v_evidence := round(v_evidence,2);
    IF v_evidence > v_amount THEN
      RAISE EXCEPTION 'tournament %, place % records % above entitlement %',
        p_tournament_id, v_place, v_evidence, v_amount USING ERRCODE = '23514';
    END IF;

    v_ob := NULL;
    SELECT * INTO v_ob FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'place' AND o.place = v_place;
    IF FOUND THEN
      IF v_ob.user_id IS DISTINCT FROM v_user_id OR v_ob.amount_owed IS NULL
         OR v_ob.amount_paid IS NULL
         OR v_ob.amount_owed::text IN ('NaN','Infinity','-Infinity')
         OR v_ob.amount_paid::text IN ('NaN','Infinity','-Infinity')
         OR v_ob.amount_owed IS DISTINCT FROM round(v_ob.amount_owed,2)
         OR v_ob.amount_paid IS DISTINCT FROM round(v_ob.amount_paid,2)
         OR v_ob.amount_owed < 0 OR v_ob.amount_paid < 0
         OR v_ob.amount_paid > v_ob.amount_owed
         OR v_ob.amount_owed > v_amount
         OR v_ob.amount_paid IS DISTINCT FROM v_evidence THEN
        RAISE EXCEPTION 'tournament %, place % has incompatible obligation',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;
    END IF;

    IF v_amount = 0 THEN
      -- Zero-valued ladder places are standings, not debts.
      IF v_evidence <> 0 OR (v_ob.id IS NOT NULL
         AND (v_ob.amount_owed <> 0 OR v_ob.amount_paid <> 0)) THEN
        RAISE EXCEPTION 'zero-value place % in tournament % carries money evidence',
          v_place, p_tournament_id USING ERRCODE = '23514';
      END IF;
    ELSIF v_status = 'COMPLETED' THEN
      IF v_ob.id IS NULL OR v_ob.amount_owed IS DISTINCT FROM v_amount
         OR v_ob.amount_paid IS DISTINCT FROM v_amount
         OR v_evidence IS DISTINCT FROM v_amount THEN
        RAISE EXCEPTION 'COMPLETED tournament %, place % is not an exact replay',
          p_tournament_id, v_place USING ERRCODE = '55000';
      END IF;
    END IF;
  END LOOP;

  IF round(v_total_expected + v_bubble_amount, 2)
       IS DISTINCT FROM v_t.prize_pool THEN
    RAISE EXCEPTION
      'tournament % ladder % plus bubble % does not equal locked pool %',
      p_tournament_id, v_total_expected, v_bubble_amount, v_t.prize_pool
      USING ERRCODE = '23514';
  END IF;

  IF v_status <> 'COMPLETED' THEN
    -- Materialize the bubble and the entire positive ladder before the first
    -- wallet credit. The payment walk is driven from one complete locked debt
    -- set, so failure on any recipient rolls every obligation and credit back.
    IF v_bubble_amount > 0 AND v_bubble_ob_count = 0 THEN
      INSERT INTO public.tournament_obligations
        (tournament_id,kind,place,user_id,amount_owed,amount_paid,source,settled_at)
      VALUES
        (p_tournament_id,'bubble_protection',NULL,v_bubble_user_id,
         v_bubble_amount,0,'engine.fn_settle_tournament_places',NULL)
      RETURNING * INTO v_bubble_ob;
      v_bubble_ob_count := 1;
    END IF;

    FOR v_row IN
      SELECT (a->>'place')::integer AS place,
             (a->>'amount')::numeric AS amount, tp.user_id
        FROM jsonb_array_elements(v_ladder) a
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id
         AND tp.position = (a->>'place')::integer
       WHERE (a->>'amount')::numeric > 0
       ORDER BY (a->>'place')::integer
    LOOP
      SELECT COALESCE(sum(p.amount),0) INTO v_evidence
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p."position" = v_row.place;

      UPDATE public.tournament_obligations o
         SET amount_owed = v_row.amount,
             source = COALESCE(o.source, 'engine.fn_settle_tournament_places'),
             updated_at = now()
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'place' AND o.place = v_row.place;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows = 0 THEN
        INSERT INTO public.tournament_obligations
          (tournament_id,kind,place,user_id,amount_owed,amount_paid,source,settled_at)
        VALUES
          (p_tournament_id,'place',v_row.place,v_row.user_id,v_row.amount,
           v_evidence,'engine.fn_settle_tournament_places',
           CASE WHEN v_evidence = v_row.amount THEN now() ELSE NULL END);
      ELSIF v_rows <> 1 THEN
        RAISE EXCEPTION 'tournament %, place % matched % obligations',
          p_tournament_id, v_row.place, v_rows USING ERRCODE = '23505';
      END IF;
    END LOOP;

    -- Re-lock/prove the complete set immediately before any raw payer runs.
    PERFORM 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind IN ('bubble_protection','place')
     ORDER BY o.kind, o.place NULLS LAST, o.id FOR UPDATE;

    IF v_bubble_amount > 0 THEN
      v_bubble_result := public.fn_ca_settle_tournament_bubble_raw(
        p_tournament_id, v_bubble_user_id, v_bubble_amount);
    END IF;

    FOR v_row IN
      SELECT (a->>'place')::integer AS place,
             (a->>'amount')::numeric AS amount, tp.user_id
        FROM jsonb_array_elements(v_ladder) a
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id
         AND tp.position = (a->>'place')::integer
       WHERE (a->>'amount')::numeric > 0
       ORDER BY (a->>'place')::integer
    LOOP
      v_result := public.fn_ca_settle_tournament_place_raw(
        p_tournament_id,v_row.place,v_row.user_id,v_row.amount);
      IF COALESCE((v_result->>'fully_settled')::boolean,false) IS NOT TRUE THEN
        RAISE EXCEPTION 'tournament %, place % returned a partial settlement',
          p_tournament_id, v_row.place USING ERRCODE = 'P0404';
      END IF;
    END LOOP;

    -- tournament_players.prize is presentation cache, stamped only from the
    -- successfully settled DB ladder and in this same transaction.
    UPDATE public.tournament_players SET prize = 0
     WHERE tournament_id = p_tournament_id;
    FOR v_row IN SELECT (a->>'place')::integer AS place,
                         (a->>'amount')::numeric AS amount
                   FROM jsonb_array_elements(v_ladder) a
    LOOP
      UPDATE public.tournament_players SET prize = v_row.amount
       WHERE tournament_id = p_tournament_id AND position = v_row.place;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'could not stamp one prize cache for tournament %, place %',
          p_tournament_id, v_row.place USING ERRCODE = 'P0404';
      END IF;
    END LOOP;

    IF v_bubble_amount > 0 THEN
      UPDATE public.tournament_players
         SET prize = v_bubble_amount
       WHERE tournament_id = p_tournament_id
         AND user_id = v_bubble_user_id
         AND position = v_bubble_place;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION
          'could not stamp one bubble prize cache for tournament %, place %',
          p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
      END IF;
    END IF;

    IF v_status = 'RUNNING' THEN
      UPDATE public.tournaments SET status = 'COMPLETING'
       WHERE id = p_tournament_id AND status = 'RUNNING';
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'tournament % lost its RUNNING finish claim',
          p_tournament_id USING ERRCODE = '40001';
      END IF;
      v_status := 'COMPLETING';
    END IF;
  END IF;

  IF v_bubble_amount > 0 AND v_status = 'COMPLETED' THEN
    -- Exact replay only: the completed preflight above proved this call cannot
    -- move money, while the raw helper proves every durable receipt again.
    v_bubble_result := public.fn_ca_settle_tournament_bubble_raw(
      p_tournament_id, v_bubble_user_id, v_bubble_amount);
  END IF;

  IF v_bubble_amount > 0 AND NOT EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = v_bubble_user_id
       AND tp.position = v_bubble_place
       AND tp.prize IS NOT DISTINCT FROM v_bubble_amount
  ) THEN
    RAISE EXCEPTION
      'post-settlement bubble prize-cache proof failed for tournament %, place %',
      p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
  END IF;

  -- Prove the durable end-state and build the presentation-only receipt.
  FOR v_row IN
    SELECT (a->>'place')::integer AS place,
           (a->>'amount')::numeric AS amount, tp.user_id,
           tp.prize AS cached_prize
      FROM jsonb_array_elements(v_ladder) a
      JOIN public.tournament_players tp
        ON tp.tournament_id = p_tournament_id
       AND tp.position = (a->>'place')::integer
     ORDER BY (a->>'place')::integer
  LOOP
    IF v_row.cached_prize IS DISTINCT FROM v_row.amount THEN
      RAISE EXCEPTION 'post-settlement prize-cache proof failed for tournament %, place %',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;
    IF v_row.amount > 0 THEN
      v_ob := NULL;
      SELECT * INTO v_ob FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'place' AND o.place = v_row.place;
      SELECT COALESCE(sum(p.amount),0) INTO v_evidence
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p."position" = v_row.place AND p.user_id = v_row.user_id;
      IF v_ob.id IS NULL OR v_ob.user_id IS DISTINCT FROM v_row.user_id
         OR v_ob.amount_owed IS DISTINCT FROM v_row.amount
         OR v_ob.amount_paid IS DISTINCT FROM v_row.amount
         OR v_evidence IS DISTINCT FROM v_row.amount THEN
        RAISE EXCEPTION 'post-settlement proof failed for tournament %, place %',
          p_tournament_id, v_row.place USING ERRCODE = 'P0404';
      END IF;
    END IF;
    v_payouts := v_payouts || jsonb_build_object(
      'place',v_row.place,'user_id',v_row.user_id,'amount',v_row.amount);
  END LOOP;

  RETURN jsonb_build_object(
    'ok',true,
    'fully_settled',true,
    'status',v_status,
    'payouts',v_payouts,
    'bubble_protection',CASE WHEN v_bubble_amount > 0 THEN
      jsonb_build_object('user_id',v_bubble_user_id,'position',v_bubble_place,
                         'amount',v_bubble_amount)
      ELSE 'null'::jsonb END,
    'winner_amount',v_winner_amount);
END;
$function$;

-- The non-bounty write half: eliminated_at is the bust, and a bust that cannot be proved is refused.
CREATE OR REPLACE FUNCTION public.fn_eliminate_player_legacy_candidate_20260907(p_tournament_id uuid, p_user_id uuid, p_position integer, p_prize numeric, p_bubble_refund numeric DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_p public.tournament_players%ROWTYPE;
  v_changed integer;
  v_released_tables uuid[] := ARRAY[]::uuid[];
  v_bust_at timestamptz;
  v_bust_hand bigint;
  v_bust_captured_at timestamptz;
BEGIN
  IF p_position < 2 OR p_prize IS NULL OR p_prize < 0
     OR p_bubble_refund IS NULL OR p_bubble_refund < 0 THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_place_or_prize');
  END IF;
  IF p_bubble_refund <> 0 THEN
    RETURN jsonb_build_object('ok',false,'reason','bubble_refund_requires_finalized_batch');
  END IF;
  SELECT * INTO v_t FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','tournament_not_found'); END IF;
  IF v_t.status <> 'RUNNING' THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_running');
  END IF;
  IF COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
     OR COALESCE(v_t.is_mystery_bounty,false) THEN
    RETURN jsonb_build_object('ok',false,'reason','bounty_requires_outbox_claim');
  END IF;
  SELECT * INTO v_p FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','player_not_found'); END IF;
  IF v_p.status = 'winner' THEN
    RETURN jsonb_build_object('ok',false,'reason','player_is_winner');
  END IF;
  IF v_p.status = 'eliminated' THEN
    IF v_p.position IS DISTINCT FROM p_position
       OR round(COALESCE(v_p.prize,0),2) <> round(p_prize,2) THEN
      RETURN jsonb_build_object('ok',false,'reason','elimination_identity_conflict');
    END IF;
    RETURN jsonb_build_object('ok',true,'already',true,'position',v_p.position,'prize',v_p.prize);
  END IF;
  IF v_p.status <> 'playing' OR COALESCE(v_p.chips,0) > 0 THEN
    RETURN jsonb_build_object('ok',false,'reason','not_busted');
  END IF;
  /* A BUST IS RANKED BY WHEN IT HAPPENED (2026-09-11). eliminated_at was
     now(), the moment the door ACCEPTED a bust, so a bust the door refused
     for a while - an orphaned generation, a stale seat - was stamped later
     than busts that came after it. It is now the time of the bust: the
     commit time of the accepted hand of the generation the calling door has
     just bound and proved (the latest committed zero-stack generation), plus
     one microsecond per earlier rank in that hand - smaller hand-start stack
     first (it busts first and finishes lower), then user id. That is the
     rule fn_settle_tournament_places ranks places by: busts in different
     hands are ordered by those hands' commit times. A bust whose hand cannot
     be read is refused, never stamped with the clock; so is a generation the
     player provably played on from - a posted rebuy leg after it AND a later
     hand of this event that deals the player in - since its hand is then not
     the bust and nothing here can say which one is. */
  SELECT a.committed_at
         + (SELECT count(*)
              FROM public.tournament_knockout_candidates s
             WHERE s.tournament_id=c.tournament_id
               AND s.table_id=c.table_id
               AND s.hand_number=c.hand_number
               AND s.hand_id=c.hand_id
               AND (s.stack_before,s.eliminated_user_id)
                   <(c.stack_before,c.eliminated_user_id))::integer
           * interval '1 microsecond',
         c.hand_number,c.created_at
    INTO v_bust_at,v_bust_hand,v_bust_captured_at
    FROM public.tournament_knockout_candidates c
    JOIN public.hand_atomic_commits a
      ON a.table_id=c.table_id
     AND a.hand_number=c.hand_number
     AND a.hand_id=c.hand_id
   WHERE c.id=public.fn_ca_latest_committed_knockout_candidate(
           p_tournament_id,p_user_id)
     AND c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_user_id
     AND c.state='pending';
  IF v_bust_at IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','knockout_bust_time_unproven');
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.from_entity_id=p_user_id
          AND l.tournament_id=p_tournament_id
          AND l.category='rebuy'
          AND l.from_type='player_wallet'
          AND l.to_type='prize_liability'
          AND l.status='posted'
          AND l.amount>0
          AND l.created_at>v_bust_captured_at)
     AND EXISTS (
       SELECT 1 FROM public.hand_history h
        WHERE h.tournament_id=p_tournament_id
          AND h.hand_number>v_bust_hand
          AND (h.players @> jsonb_build_array(jsonb_build_object(
                 'userId',p_user_id::text))
               OR h.players @> jsonb_build_array(jsonb_build_object(
                 'user_id',p_user_id::text)))) THEN
    RETURN jsonb_build_object('ok',false,'reason','knockout_bust_time_unproven',
                              'detail','played_on_after_a_rebuy');
  END IF;
  UPDATE public.tournament_players
     SET status='eliminated',position=p_position,prize=round(p_prize,2),eliminated_at=v_bust_at
   WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     AND status='playing' AND COALESCE(chips,0)<=0;
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  IF v_changed <> 1 THEN
    RAISE EXCEPTION 'zero-stack elimination CAS changed % rows',v_changed
      USING ERRCODE='serialization_failure';
  END IF;

  WITH released AS (
    UPDATE public.table_seats s SET left_at=now()
      FROM public.tables tb
     WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id
       AND s.user_id=p_user_id AND s.left_at IS NULL
    RETURNING s.table_id
  ) SELECT COALESCE(array_agg(DISTINCT table_id),ARRAY[]::uuid[])
      INTO v_released_tables FROM released;
  UPDATE public.tables tb SET current_players=(
    SELECT count(*) FROM public.table_seats s WHERE s.table_id=tb.id AND s.left_at IS NULL)
   WHERE tb.id=ANY(v_released_tables);
  PERFORM public.fn_sync_seat_first_player_count(p_tournament_id);

  RETURN jsonb_build_object('ok',true,'claimed',true,'position',p_position,
                            'prize',round(p_prize,2),'bubble_refund',0);
END;
$function$;

-- The bounty write half: the same stamp and the same refusals.
CREATE OR REPLACE FUNCTION public.fn_claim_bounty_legacy_candidate_20260907(p_tournament_id uuid, p_eliminated_user_id uuid, p_position integer, p_prize numeric, p_table_id uuid, p_hand_id uuid, p_hand_number bigint, p_seat_joined_at timestamp with time zone, p_knocker_user_id uuid, p_claimants jsonb, p_bubble_refund numeric DEFAULT 0, p_allow_existing_eliminated boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_player public.tournament_players%ROWTYPE;
  v_candidate public.tournament_knockout_candidates%ROWTYPE;
  v_atomic public.hand_atomic_commits%ROWTYPE;
  v_settlement_at timestamptz;
  v_settlement_hand_text text;
  v_settlement_hand_id uuid;
  v_mode text;
  v_claimants jsonb;
  v_input_claimants jsonb;
  v_knocker uuid;
  v_head numeric;
  v_hand_created_at timestamptz;
  v_position integer;
  v_prize numeric;
  v_claimed boolean := false;
  v_existing public.tournament_bounty_obligations%ROWTYPE;
  v_obligation_id uuid;
  v_activation_generation bigint := 0;
  v_pko_watermark bigint;
  v_bounty_blocked text := NULL;
  v_bust_at timestamptz;
BEGIN
  IF p_tournament_id IS NULL OR p_eliminated_user_id IS NULL
     OR p_table_id IS NULL OR p_hand_id IS NULL OR p_hand_number IS NULL
     OR p_hand_number<1000000 OR p_seat_joined_at IS NULL
     OR p_bubble_refund IS NULL OR p_bubble_refund<0 THEN
    RETURN jsonb_build_object('ok',false,'reason','missing_identity');
  END IF;
  IF p_bubble_refund<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','bubble_refund_requires_finalized_batch');
  END IF;

  IF p_claimants IS NOT NULL THEN
    IF jsonb_typeof(p_claimants)<>'array' OR jsonb_array_length(p_claimants)=0
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_claimants) e
          WHERE coalesce(e->>'user_id','')
                  !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             OR coalesce(e->>'weight','') !~ '^[0-9]+([.][0-9]+)?$'
             OR (e->>'weight')::numeric<=0
       ) THEN
      RETURN jsonb_build_object('ok',false,'reason','invalid_claimants');
    END IF;
    SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'weight',1)
                     ORDER BY user_id::text)
      INTO v_input_claimants
      FROM (
        SELECT DISTINCT (e->>'user_id')::uuid AS user_id
          FROM jsonb_array_elements(p_claimants) e
      ) q;
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;

  -- A hand triple is the immutable replay key. Two legitimate bounties may
  -- have the same player and seat_joined_at after a same-chair rebuy.
  SELECT * INTO v_existing
    FROM public.tournament_bounty_obligations o
   WHERE o.tournament_id=p_tournament_id
     AND o.table_id=p_table_id
     AND o.hand_id=p_hand_id
     AND o.hand_number=p_hand_number
     AND o.eliminated_user_id=p_eliminated_user_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.table_id IS DISTINCT FROM p_table_id
       OR v_existing.hand_id IS DISTINCT FROM p_hand_id
       OR v_existing.seat_joined_at IS DISTINCT FROM p_seat_joined_at
       OR v_existing.bubble_refund IS DISTINCT FROM round(p_bubble_refund,2)
       OR v_existing.position IS DISTINCT FROM p_position
       OR v_existing.prize IS DISTINCT FROM round(p_prize,2)
       OR (p_knocker_user_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(v_existing.claimants) c
              WHERE c->>'user_id'=p_knocker_user_id::text))
       OR (v_input_claimants IS NOT NULL
           AND v_existing.claimants IS DISTINCT FROM v_input_claimants) THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','obligation_identity_conflict');
    END IF;
    IF v_existing.state='settled'
       AND NOT public.fn_bounty_obligation_has_complete_marker(v_existing.id) THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','settled_marker_incomplete',
        'obligation_id',v_existing.id);
    END IF;
    RETURN jsonb_build_object(
      'ok',true,'already',true,'claimed',false,
      'mode',v_existing.mode,'state',v_existing.state,
      'activation_generation',v_existing.activation_generation,
      'obligation_id',v_existing.id);
  END IF;

  IF NOT (coalesce(v_t.is_bounty,false) OR coalesce(v_t.is_pko,false)
          OR coalesce(v_t.is_mystery_bounty,false)) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_bounty_tournament');
  END IF;
  IF upper(coalesce(v_t.status,''))<>'RUNNING'
     AND NOT (p_allow_existing_eliminated
              AND upper(coalesce(v_t.status,''))='COMPLETING') THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_lifecycle_not_claimable',
      'status',v_t.status);
  END IF;

  SELECT * INTO v_player FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.user_id=p_eliminated_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','player_not_found');
  END IF;
  IF coalesce(v_player.chips,0)>0 THEN
    RETURN jsonb_build_object('ok',false,'reason','player_has_chips');
  END IF;
  IF v_player.status<>'playing' THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','status_not_claimable','status',v_player.status);
  END IF;
  IF p_position IS NULL OR p_position<2 OR p_prize IS NULL OR p_prize<0 THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_place_or_prize');
  END IF;
  v_position:=p_position;
  v_prize:=p_prize;

  SELECT a.* INTO v_atomic
    FROM public.hand_atomic_commits a
   WHERE a.table_id=p_table_id
     AND a.hand_number=p_hand_number
     AND a.hand_id=p_hand_id;
  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.hand_atomic_commits a
       WHERE a.table_id=p_table_id AND a.hand_number=p_hand_number
    ) THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','atomic_knockout_history_identity_conflict');
    END IF;
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_evidence_required');
  END IF;

  v_settlement_hand_text:=v_atomic.stack_result->>'hand_id';
  IF coalesce(v_settlement_hand_text,'')
       !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_atomic.stack_result->>'table_id'<>p_table_id::text
     OR coalesce(v_atomic.stack_result->>'hand_number','')
          !~ '^[0-9]+$'
     OR (v_atomic.stack_result->>'hand_number')::bigint<>p_hand_number
     OR coalesce(v_atomic.stack_result->'written'
                   ->>p_eliminated_user_id::text,'')
          !~ '^-?[0-9]+([.][0-9]+)?$'
     OR (v_atomic.stack_result->'written'
           ->>p_eliminated_user_id::text)::numeric<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_candidate_identity_conflict');
  END IF;
  v_settlement_hand_id:=v_settlement_hand_text::uuid;

  SELECT c.* INTO v_candidate
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.table_id=p_table_id
     AND c.hand_number=p_hand_number
     AND c.hand_id=p_hand_id
     AND c.eliminated_user_id=p_eliminated_user_id;
  IF NOT FOUND
     OR v_candidate.seat_joined_at IS DISTINCT FROM p_seat_joined_at THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_candidate_identity_conflict');
  END IF;

  SELECT k.completed_at INTO v_settlement_at
    FROM public.settlement_idempotency_keys k
   WHERE k.table_id=p_table_id
     AND k.hand_id=v_settlement_hand_id
     AND k.status='succeeded'
     AND k.completed_at IS NOT NULL
     AND k.completed_at>=p_seat_joined_at
     AND coalesce(k.result->>'hand_number','') ~ '^[0-9]+$'
     AND (k.result->>'hand_number')::bigint=p_hand_number
     AND k.result->>'table_id'=p_table_id::text
     AND k.result->'written' ? p_eliminated_user_id::text
     AND coalesce(k.result->'written'->>p_eliminated_user_id::text,'')
           ~ '^-?[0-9]+([.][0-9]+)?$'
     AND (k.result->'written'->>p_eliminated_user_id::text)::numeric=0;
  IF v_settlement_at IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','accepted_zero_settlement_not_found');
  END IF;

  SELECT h.created_at INTO v_hand_created_at
    FROM public.hand_history h
   WHERE h.id=p_hand_id
     AND h.table_id=p_table_id
     AND h.hand_number=p_hand_number
     AND h.hand_number>=1000000
     AND h.created_at>=v_settlement_at
     AND h.created_at>=p_seat_joined_at
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(coalesce(h.players,'[]'::jsonb)) player
        WHERE coalesce(player->>'userId',player->>'user_id')=
                p_eliminated_user_id::text
          AND coalesce(player->>'stack','') ~ '^-?[0-9]+([.][0-9]+)?$'
          AND (player->>'stack')::numeric=0
     );
  IF v_hand_created_at IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','exact_knockout_history_not_found');
  END IF;

  v_claimants:=public.fn_exact_tournament_knockout_claimants(
    p_tournament_id,p_hand_id,p_eliminated_user_id);
  IF v_claimants IS NULL OR jsonb_array_length(v_claimants)=0 THEN
    /* A PLACE IS NOT A BOUNTY (2026-09-10).
       fn_exact_tournament_knockout_claimants returns NULL when it cannot
       name the exact winner of the last pot the busted player was eligible
       for, and it is right to refuse to guess. That is a reason not to PAY
       a bounty. It is not a reason to withhold a finishing place from a
       player who provably busted - refusing here left 33 busts unrecorded
       across nine events and held their prize escrow for days. */
    v_bounty_blocked:='exact_pot_claimants_not_found';
    v_claimants:='[]'::jsonb;
  END IF;
  SELECT (e->>'user_id')::uuid INTO v_knocker
    FROM jsonb_array_elements(v_claimants) e
   ORDER BY e->>'user_id' LIMIT 1;
  IF v_bounty_blocked IS NULL AND p_knocker_user_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_claimants) e
        WHERE e->>'user_id'=p_knocker_user_id::text
     ) THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_knocker');
  END IF;
  IF v_bounty_blocked IS NULL AND v_input_claimants IS NOT NULL
     AND v_input_claimants IS DISTINCT FROM v_claimants THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','claimants_do_not_match_exact_pot');
  END IF;

  v_mode:=CASE
    WHEN coalesce(v_t.is_mystery_bounty,false)
         AND v_t.mystery_bounty_stage='active' THEN 'mystery_chest'
    WHEN coalesce(v_t.is_pko,false) THEN 'pko'
    WHEN coalesce(v_t.is_mystery_bounty,false) THEN 'mystery_pre'
    ELSE 'regular'
  END;
  v_activation_generation:=CASE WHEN v_mode='mystery_chest'
    THEN v_t.mystery_bounty_activation_generation ELSE 0 END;
  IF v_mode='mystery_chest' AND (
       v_activation_generation<=0 OR NOT EXISTS (
         SELECT 1 FROM public.tournament_mystery_activation_receipts ar
          WHERE ar.tournament_id=p_tournament_id
            AND ar.activation_generation=v_activation_generation
       )) THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','mystery_activation_evidence_missing');
  END IF;

  IF v_mode='pko' THEN
    SELECT w.last_settled_hand_number INTO v_pko_watermark
      FROM public.tournament_pko_settlement_watermarks w
     WHERE w.tournament_id=p_tournament_id FOR UPDATE;
    IF v_pko_watermark IS NOT NULL AND p_hand_number<v_pko_watermark THEN
      /* The watermark keeps PKO bounties in payment order and cannot be
         rewound without letting settled bounties re-settle, so a bust
         behind it can never be paid in order. The player still busted and
         the place is still theirs: record it, and leave the head in the
         pool for fn_finalize_bounty_pool to resolve as residual. */
      v_bounty_blocked:=COALESCE(v_bounty_blocked,'pko_order_already_advanced');
    END IF;
  END IF;

  IF v_bounty_blocked IS NULL AND v_mode='pko' AND EXISTS (
    SELECT 1 FROM public.tournament_bounty_obligations prior
     WHERE prior.tournament_id=p_tournament_id
       AND prior.mode='pko' AND prior.state='pending'
       AND (prior.hand_number<p_hand_number
            OR (prior.hand_number=p_hand_number
                AND prior.eliminated_user_id::text<
                    p_eliminated_user_id::text))
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(prior.claimants) c
          WHERE c->>'user_id'=p_eliminated_user_id::text
       )
  ) THEN
    RETURN jsonb_build_object('ok',false,'reason','pending_pko_predecessor');
  END IF;

  IF v_bounty_blocked IS NULL AND v_mode='pko' AND EXISTS (
    SELECT 1
      FROM public.hand_history h
      CROSS JOIN LATERAL
        jsonb_array_elements(coalesce(h.players,'[]'::jsonb)) hp
     WHERE h.id=p_hand_id
       AND coalesce(hp->>'userId',hp->>'user_id','')
             ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND coalesce(hp->>'userId',hp->>'user_id')<>
             p_eliminated_user_id::text
       AND coalesce(hp->>'stack','') ~ '^-?[0-9]+([.][0-9]+)?$'
       AND (hp->>'stack')::numeric<=0
       AND public.fn_exact_tournament_knockout_claimants(
             p_tournament_id,h.id,
             coalesce(hp->>'userId',hp->>'user_id')::uuid)
             @> jsonb_build_array(jsonb_build_object(
                  'user_id',p_eliminated_user_id,'weight',1))
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_bounty_obligations predecessor
          WHERE predecessor.tournament_id=p_tournament_id
            AND predecessor.hand_number=p_hand_number
            AND predecessor.eliminated_user_id=
                coalesce(hp->>'userId',hp->>'user_id')::uuid
            AND predecessor.state='settled'
       )
  ) THEN
    RETURN jsonb_build_object('ok',false,'reason','same_hand_pko_predecessor');
  END IF;

  v_head:=coalesce(nullif(v_player.current_bounty,0),
                   nullif(v_t.bounty_amount,0));
  IF coalesce(v_head,0)<=0 THEN
    v_bounty_blocked:=COALESCE(v_bounty_blocked,'exact_head_value_not_found');
  END IF;

  /* A BUST IS RANKED BY WHEN IT HAPPENED (2026-09-11). eliminated_at was
     now(), the moment this claim was accepted, so a bust accepted late was
     stamped later than busts that came after it. It is now the time of the
     bust, by the rule the non-bounty door stamps and
     fn_settle_tournament_places ranks with: the commit time of the accepted
     hand this claim is bound to, plus one microsecond per earlier rank in
     that hand - smaller hand-start stack first, then user id. A bust whose
     hand cannot be read is refused, never stamped with the clock; so is a
     generation the player provably played on from - a posted rebuy leg
     after it AND a later hand of this event that deals the player in - since
     its hand is then not the bust and nothing here can say which one is. */
  SELECT a.committed_at
         + (SELECT count(*)
              FROM public.tournament_knockout_candidates s
             WHERE s.tournament_id=c.tournament_id
               AND s.table_id=c.table_id
               AND s.hand_number=c.hand_number
               AND s.hand_id=c.hand_id
               AND (s.stack_before,s.eliminated_user_id)
                   <(c.stack_before,c.eliminated_user_id))::integer
           * interval '1 microsecond'
    INTO v_bust_at
    FROM public.tournament_knockout_candidates c
    JOIN public.hand_atomic_commits a
      ON a.table_id=c.table_id
     AND a.hand_number=c.hand_number
     AND a.hand_id=c.hand_id
   WHERE c.id=v_candidate.id
     AND c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_eliminated_user_id
     AND c.state='pending';
  IF v_bust_at IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','knockout_bust_time_unproven');
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.from_entity_id=p_eliminated_user_id
          AND l.tournament_id=p_tournament_id
          AND l.category='rebuy'
          AND l.from_type='player_wallet'
          AND l.to_type='prize_liability'
          AND l.status='posted'
          AND l.amount>0
          AND l.created_at>v_candidate.created_at)
     AND EXISTS (
       SELECT 1 FROM public.hand_history h
        WHERE h.tournament_id=p_tournament_id
          AND h.hand_number>p_hand_number
          AND (h.players @> jsonb_build_array(jsonb_build_object(
                 'userId',p_eliminated_user_id::text))
               OR h.players @> jsonb_build_array(jsonb_build_object(
                 'user_id',p_eliminated_user_id::text)))) THEN
    RETURN jsonb_build_object('ok',false,'reason','knockout_bust_time_unproven',
                              'detail','played_on_after_a_rebuy');
  END IF;

  UPDATE public.tournament_players tp
     SET status='eliminated',position=p_position,prize=p_prize,
         eliminated_at=v_bust_at
   WHERE tp.tournament_id=p_tournament_id
     AND tp.user_id=p_eliminated_user_id
     AND tp.status='playing' AND tp.chips<=0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bounty elimination CAS missed after locked claim'
      USING ERRCODE='serialization_failure';
  END IF;
  v_claimed:=true;

  IF v_bounty_blocked IS NULL THEN
  INSERT INTO public.tournament_bounty_obligations(
    tournament_id,eliminated_user_id,table_id,hand_id,hand_number,
    settlement_completed_at,seat_joined_at,position,prize,bubble_refund,
    mode,activation_generation,head_amount,knocker_user_id,claimants,
    next_attempt_at)
  VALUES (
    p_tournament_id,p_eliminated_user_id,p_table_id,p_hand_id,p_hand_number,
    v_settlement_at,p_seat_joined_at,v_position,round(v_prize,2),0,
    v_mode,v_activation_generation,round(v_head,2),v_knocker,v_claimants,
    CASE WHEN v_mode='mystery_chest' THEN now()+interval '30 seconds'
         ELSE now() END)
  RETURNING id INTO v_obligation_id;
  ELSE
    /* The bust is recorded and placed above. The head could not be
       attributed, so no obligation is written: fn_tournament_has_unsettled_bounties
       only sees obligations that EXIST, so the event can finish, and the
       head stays in tournaments.bounty_pool for fn_finalize_bounty_pool to
       resolve as residual with its own completion receipt. This row is the
       record that it happened - severity `warning`, so
       fn_ca_financial_alert_to_incident (which promotes only `critical`)
       does not raise a board item per bust. A listed fact, not an alarm. */
    INSERT INTO public.financial_alerts(severity,source,message,context)
    VALUES ('warning',
      'fn_claim_tournament_bounty_elimination.bounty_head_not_attributed',
      'A bust was recorded and placed, but its bounty head could not be '
        ||'attributed ('||v_bounty_blocked||'); the head stays in the '
        ||'bounty pool as residual.',
      jsonb_build_object('tournament_id',p_tournament_id,
        'eliminated_user_id',p_eliminated_user_id,'table_id',p_table_id,
        'hand_id',p_hand_id,'hand_number',p_hand_number,
        'position',v_position,'head_amount',round(coalesce(v_head,0),2),
        'mode',v_mode,'reason',v_bounty_blocked));
  END IF;

  UPDATE public.table_seats s
     SET left_at=coalesce(s.left_at,now())
   WHERE s.table_id=p_table_id AND s.user_id=p_eliminated_user_id
     AND s.joined_at=p_seat_joined_at AND s.left_at IS NULL;
  UPDATE public.tables tb
     SET current_players=(
       SELECT count(*) FROM public.table_seats s
        WHERE s.table_id=p_table_id AND s.left_at IS NULL)
   WHERE tb.id=p_table_id;
  PERFORM public.fn_sync_seat_first_player_count(p_tournament_id);

  UPDATE public.tournament_bounty_obligations o
     SET state='settled',settled_at=now()
   WHERE o.id=v_obligation_id
     AND public.fn_bounty_obligation_has_complete_marker(o.id);

  RETURN jsonb_build_object(
    'ok',true,'already',false,'claimed',v_claimed,'mode',v_mode,
    'bounty_blocked',v_bounty_blocked,
    'state',(SELECT o.state FROM public.tournament_bounty_obligations o
              WHERE o.id=v_obligation_id),
    'activation_generation',v_activation_generation,'bubble_refund',0,
    'obligation_id',v_obligation_id);
END;
$function$;

-- The non-bounty door: a generation a rebuy paid for is not a live bust.
CREATE OR REPLACE FUNCTION public.fn_eliminate_tournament_player_atomic(p_tournament_id uuid, p_user_id uuid, p_position integer, p_prize numeric, p_bubble_refund numeric DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_player public.tournament_players%ROWTYPE;
  v_candidate public.tournament_knockout_candidates%ROWTYPE;
  v_atomic public.hand_atomic_commits%ROWTYPE;
  v_live public.table_seats%ROWTYPE;
  v_evidence_stack numeric;
  v_settlement_hand_text text;
  v_settlement_hand_id uuid;
  v_live_count integer;
  v_changed integer;
  v_result jsonb;
  v_rebought_generations uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_position IS NULL OR p_position<2 OR p_prize IS NULL OR p_prize<0
     OR p_bubble_refund IS NULL OR p_bubble_refund<0 THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_place_or_prize');
  END IF;
  IF p_bubble_refund<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','bubble_refund_requires_finalized_batch');
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  IF v_t.status<>'RUNNING' THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_running');
  END IF;
  IF coalesce(v_t.is_bounty,false) OR coalesce(v_t.is_pko,false)
     OR coalesce(v_t.is_mystery_bounty,false) THEN
    RETURN jsonb_build_object('ok',false,'reason','bounty_requires_outbox_claim');
  END IF;

  SELECT * INTO v_player FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','player_not_found');
  END IF;
  IF v_player.status='winner' THEN
    RETURN jsonb_build_object('ok',false,'reason','player_is_winner');
  END IF;
  IF v_player.status NOT IN ('playing','eliminated')
     OR (v_player.status='playing' AND coalesce(v_player.chips,0)>0) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_busted');
  END IF;

  PERFORM 1
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_user_id
   ORDER BY c.hand_number,c.id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','knockout_candidate_required');
  END IF;

  -- The owner-only resolver selects this player's latest immutable entry
  -- generation and already proves both durable halves of its accepted hand.
  -- Re-read every identity here so this transaction is independently bound to
  -- candidate(history hand) -> atomic(internal settlement hand) -> receipt.
  SELECT c.* INTO v_candidate
    FROM public.tournament_knockout_candidates c
   WHERE c.id=public.fn_ca_latest_committed_knockout_candidate(
     p_tournament_id,p_user_id);
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','committed_knockout_candidate_not_found');
  END IF;

  SELECT a.* INTO v_atomic
    FROM public.hand_atomic_commits a
   WHERE a.table_id=v_candidate.table_id
     AND a.hand_number=v_candidate.hand_number
     AND a.hand_id=v_candidate.hand_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_candidate_missing');
  END IF;
  v_settlement_hand_text:=v_atomic.stack_result->>'hand_id';
  -- The settlement owner uses md5(... )::uuid for its stable internal key;
  -- validate PostgreSQL's canonical UUID shape without inventing RFC nibbles.
  IF coalesce(v_settlement_hand_text,'')
       !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_atomic.stack_result->>'table_id'<>v_candidate.table_id::text
     OR coalesce(v_atomic.stack_result->>'hand_number','')
          !~ '^[0-9]+$'
     OR (v_atomic.stack_result->>'hand_number')::bigint<>
          v_candidate.hand_number
     OR coalesce(v_atomic.stack_result->'written'->>p_user_id::text,'')
          !~ '^-?[0-9]+([.][0-9]+)?$'
     OR (v_atomic.stack_result->'written'->>p_user_id::text)::numeric<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_candidate_identity_conflict');
  END IF;
  v_settlement_hand_id:=v_settlement_hand_text::uuid;

  SELECT (k.result->'written'->>p_user_id::text)::numeric
    INTO v_evidence_stack
    FROM public.settlement_idempotency_keys k
   WHERE k.table_id=v_candidate.table_id
     AND k.hand_id=v_settlement_hand_id
     AND k.status='succeeded'
     AND k.completed_at IS NOT NULL
     AND k.result->>'table_id'=v_candidate.table_id::text
     AND coalesce(k.result->>'hand_number','') ~ '^[0-9]+$'
     AND (k.result->>'hand_number')::bigint=v_candidate.hand_number
     AND coalesce(k.result->'written'->>p_user_id::text,'')
           ~ '^-?[0-9]+([.][0-9]+)?$';
  IF NOT FOUND OR v_evidence_stack<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','exact_knockout_settlement_receipt_missing');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_knockout_candidates c
     WHERE c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_user_id
       AND c.hand_number>v_candidate.hand_number
  ) THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','latest_knockout_evidence_chain_conflict');
  END IF;
  /* A GENERATION A REBUY PAID FOR IS NOT A LIVE BUST (2026-09-11).
     The 2026-09-08/09 rebuy chain bought players back in without marking the
     busted generation 'rebought', so each left an older 'pending' row, and
     this check then refused every later, real bust of the same player for
     ever. A pending generation is proven bought back - not a bust anybody still
     owes a place - when a posted 'rebuy' leg moved this player's own wallet
     into this event's prize liability AFTER that generation was captured and
     BEFORE the player's next generation was: the chips busted at the next
     hand are the chips that leg paid for. Only such rows are resolved to
     'rebought', and only in the transaction that records the newer bust. A
     leg outside that window proves nothing, a generation in any other state
     is not touched, and anything unproven is refused exactly as before. */
  SELECT COALESCE(array_agg(c.id ORDER BY c.hand_number,c.id),ARRAY[]::uuid[])
    INTO v_rebought_generations
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_user_id
     AND c.hand_number<v_candidate.hand_number
     AND c.state='pending'
     AND EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.from_entity_id=p_user_id
          AND l.tournament_id=p_tournament_id
          AND l.category='rebuy'
          AND l.from_type='player_wallet'
          AND l.to_type='prize_liability'
          AND l.status='posted'
          AND l.amount>0
          AND l.created_at>c.created_at
          AND l.created_at<(
            SELECT n.created_at
              FROM public.tournament_knockout_candidates n
             WHERE n.tournament_id=p_tournament_id
               AND n.eliminated_user_id=p_user_id
               AND n.hand_number>c.hand_number
             ORDER BY n.hand_number,n.id
             LIMIT 1));
  IF EXISTS (
    SELECT 1 FROM public.tournament_knockout_candidates c
     WHERE c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_user_id
       AND c.hand_number<v_candidate.hand_number
       AND c.state<>'rebought'
       AND c.id<>ALL(v_rebought_generations)
  ) THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','unresolved_knockout_generation_chain');
  END IF;

  IF (v_player.status='playing' AND v_candidate.state<>'pending')
     OR (v_player.status='eliminated' AND v_candidate.state<>'eliminated') THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','knockout_generation_state_mismatch',
      'player_state',v_player.status,'candidate_state',v_candidate.state);
  END IF;
  IF v_candidate.state='pending'
     AND v_candidate.rebuy_prompt_until IS NOT NULL
     AND v_candidate.rebuy_prompt_until>clock_timestamp() THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','rebuy_decision_open',
      'rebuy_prompt_until',v_candidate.rebuy_prompt_until);
  END IF;

  PERFORM 1
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_user_id AND s.left_at IS NULL
   ORDER BY s.id FOR UPDATE OF s;
  SELECT count(*) INTO v_live_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_user_id AND s.left_at IS NULL;
  IF v_live_count>1 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','knockout_generation_has_multiple_live_seats');
  END IF;
  IF v_live_count=1 THEN
    SELECT s.* INTO v_live
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id
       AND s.user_id=p_user_id AND s.left_at IS NULL;
    IF v_live.stack IS DISTINCT FROM 0
       OR v_live.table_id IS DISTINCT FROM v_candidate.table_id
       OR v_live.id IS DISTINCT FROM v_candidate.seat_id
       OR v_live.joined_at IS DISTINCT FROM v_candidate.seat_joined_at THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','knockout_generation_has_new_live_seat');
    END IF;
  END IF;

  v_result:=public.fn_eliminate_player_legacy_candidate_20260907(
    p_tournament_id,p_user_id,p_position,p_prize,p_bubble_refund);
  IF coalesce((v_result->>'ok')::boolean,false)
     AND v_player.status='playing' THEN
    UPDATE public.tournament_knockout_candidates c
       SET state='eliminated',
           resolved_at=coalesce(c.resolved_at,clock_timestamp())
     WHERE c.id=v_candidate.id AND c.state='pending';
    GET DIAGNOSTICS v_changed=ROW_COUNT;
    IF v_changed<>1 THEN
      RAISE EXCEPTION 'knockout generation changed while elimination committed'
        USING ERRCODE='serialization_failure';
    END IF;
  END IF;
  -- The proven older generations close with the bust that proved them.
  IF coalesce((v_result->>'ok')::boolean,false)
     AND cardinality(v_rebought_generations)>0 THEN
    UPDATE public.tournament_knockout_candidates c
       SET state='rebought',resolved_at=clock_timestamp()
     WHERE c.id=ANY(v_rebought_generations)
       AND c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_user_id
       AND c.state='pending';
    GET DIAGNOSTICS v_changed=ROW_COUNT;
    IF v_changed<>cardinality(v_rebought_generations) THEN
      RAISE EXCEPTION 'a bought-back knockout generation changed while elimination committed'
        USING ERRCODE='serialization_failure';
    END IF;
    v_result:=v_result||jsonb_build_object(
      'rebought_generations',to_jsonb(v_rebought_generations));
  END IF;
  RETURN v_result;
END;
$function$;

-- The bounty door: the same, and only once that generation's head is closed.
CREATE OR REPLACE FUNCTION public.fn_claim_tournament_bounty_elimination(p_tournament_id uuid, p_eliminated_user_id uuid, p_position integer, p_prize numeric, p_table_id uuid, p_hand_id uuid, p_hand_number bigint, p_seat_joined_at timestamp with time zone, p_knocker_user_id uuid, p_claimants jsonb, p_bubble_refund numeric DEFAULT 0, p_allow_existing_eliminated boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_player public.tournament_players%ROWTYPE;
  v_candidate public.tournament_knockout_candidates%ROWTYPE;
  v_atomic public.hand_atomic_commits%ROWTYPE;
  v_live public.table_seats%ROWTYPE;
  v_evidence_stack numeric;
  v_settlement_hand_text text;
  v_settlement_hand_id uuid;
  v_live_count integer;
  v_changed integer;
  v_result jsonb;
  v_rebought_generations uuid[] := ARRAY[]::uuid[];
BEGIN
  -- Exact replay is permitted after the player, seat and tournament have moved
  -- on. The immutable obligation itself is the receipt, and the private core
  -- verifies every caller-supplied field against it.
  IF p_tournament_id IS NULL OR p_eliminated_user_id IS NULL
     OR p_hand_number IS NULL THEN
    RETURN public.fn_claim_bounty_legacy_candidate_20260907(
      p_tournament_id,p_eliminated_user_id,p_position,p_prize,p_table_id,
      p_hand_id,p_hand_number,p_seat_joined_at,p_knocker_user_id,p_claimants,
      p_bubble_refund,p_allow_existing_eliminated);
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_bounty_obligations o
     WHERE o.tournament_id=p_tournament_id
       AND o.table_id=p_table_id
       AND o.hand_id=p_hand_id
       AND o.hand_number=p_hand_number
       AND o.eliminated_user_id=p_eliminated_user_id
  ) THEN
    RETURN public.fn_claim_bounty_legacy_candidate_20260907(
      p_tournament_id,p_eliminated_user_id,p_position,p_prize,p_table_id,
      p_hand_id,p_hand_number,p_seat_joined_at,p_knocker_user_id,p_claimants,
      p_bubble_refund,p_allow_existing_eliminated);
  END IF;

  SELECT * INTO v_player FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.user_id=p_eliminated_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','player_not_found');
  END IF;

  PERFORM 1
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_eliminated_user_id
   ORDER BY c.hand_number,c.id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','knockout_candidate_required');
  END IF;

  SELECT c.* INTO v_candidate
    FROM public.tournament_knockout_candidates c
   WHERE c.id=public.fn_ca_latest_committed_knockout_candidate(
     p_tournament_id,p_eliminated_user_id);
  IF NOT FOUND
     OR v_candidate.table_id IS DISTINCT FROM p_table_id
     OR v_candidate.hand_id IS DISTINCT FROM p_hand_id
     OR v_candidate.hand_number IS DISTINCT FROM p_hand_number
     OR v_candidate.seat_joined_at IS DISTINCT FROM p_seat_joined_at THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','bounty_claim_is_not_latest_knockout_hand');
  END IF;

  SELECT a.* INTO v_atomic
    FROM public.hand_atomic_commits a
   WHERE a.table_id=v_candidate.table_id
     AND a.hand_number=v_candidate.hand_number
     AND a.hand_id=v_candidate.hand_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_candidate_missing');
  END IF;
  v_settlement_hand_text:=v_atomic.stack_result->>'hand_id';
  IF coalesce(v_settlement_hand_text,'')
       !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_atomic.stack_result->>'table_id'<>v_candidate.table_id::text
     OR coalesce(v_atomic.stack_result->>'hand_number','')
          !~ '^[0-9]+$'
     OR (v_atomic.stack_result->>'hand_number')::bigint<>
          v_candidate.hand_number
     OR coalesce(v_atomic.stack_result->'written'
                   ->>p_eliminated_user_id::text,'')
          !~ '^-?[0-9]+([.][0-9]+)?$'
     OR (v_atomic.stack_result->'written'
           ->>p_eliminated_user_id::text)::numeric<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_candidate_identity_conflict');
  END IF;
  v_settlement_hand_id:=v_settlement_hand_text::uuid;

  SELECT (k.result->'written'
            ->>p_eliminated_user_id::text)::numeric
    INTO v_evidence_stack
    FROM public.settlement_idempotency_keys k
   WHERE k.table_id=v_candidate.table_id
     AND k.hand_id=v_settlement_hand_id
     AND k.status='succeeded'
     AND k.completed_at IS NOT NULL
     AND k.result->>'table_id'=v_candidate.table_id::text
     AND coalesce(k.result->>'hand_number','') ~ '^[0-9]+$'
     AND (k.result->>'hand_number')::bigint=v_candidate.hand_number
     AND coalesce(k.result->'written'
                   ->>p_eliminated_user_id::text,'')
           ~ '^-?[0-9]+([.][0-9]+)?$';
  IF NOT FOUND OR v_evidence_stack<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','exact_knockout_settlement_receipt_missing');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_knockout_candidates c
     WHERE c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_eliminated_user_id
       AND c.hand_number>v_candidate.hand_number
  ) THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','latest_knockout_evidence_chain_conflict');
  END IF;
  /* A GENERATION A REBUY PAID FOR IS NOT A LIVE BUST (2026-09-11).
     The 2026-09-08/09 rebuy chain bought players back in without marking the
     busted generation 'rebought', so each left an older 'pending' row, and
     this check then refused every later, real bust of the same player for
     ever. The non-bounty door's rule applies here too: a pending generation
     is proven bought back when a posted 'rebuy' leg moved this player's own
     wallet into this event's prize liability AFTER that generation was
     captured and BEFORE the player's next generation was. A bounty adds one
     condition: the older generation's head must already be closed. A bounty
     rebuy settles the replaced generation's head before the purchase
     completes (fn_ca_settle_bounty_rebuy_generation_v1), so a proven
     generation is resolved only when no bounty obligation names its hand or
     its chair, or every one that does is settled with its complete marker.
     A generation with no obligation never had a head claimed; resolving it
     claims none either, so no head can be paid twice. An obligation that is
     still owed would be collected against a player this claim is about to
     record under a newer head, so that generation stays refused. Only proven
     rows are resolved, only in the transaction that records the newer bust;
     anything unproven is refused exactly as before. */
  SELECT COALESCE(array_agg(c.id ORDER BY c.hand_number,c.id),ARRAY[]::uuid[])
    INTO v_rebought_generations
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_eliminated_user_id
     AND c.hand_number<v_candidate.hand_number
     AND c.state='pending'
     AND EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.from_entity_id=p_eliminated_user_id
          AND l.tournament_id=p_tournament_id
          AND l.category='rebuy'
          AND l.from_type='player_wallet'
          AND l.to_type='prize_liability'
          AND l.status='posted'
          AND l.amount>0
          AND l.created_at>c.created_at
          AND l.created_at<(
            SELECT n.created_at
              FROM public.tournament_knockout_candidates n
             WHERE n.tournament_id=p_tournament_id
               AND n.eliminated_user_id=p_eliminated_user_id
               AND n.hand_number>c.hand_number
             ORDER BY n.hand_number,n.id
             LIMIT 1))
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_bounty_obligations o
        WHERE o.tournament_id=p_tournament_id
          AND o.eliminated_user_id=p_eliminated_user_id
          AND (o.hand_number=c.hand_number
               OR o.seat_joined_at=c.seat_joined_at)
          AND NOT (o.state='settled'
                   AND public.fn_bounty_obligation_has_complete_marker(o.id)));
  IF EXISTS (
    SELECT 1 FROM public.tournament_knockout_candidates c
     WHERE c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_eliminated_user_id
       AND c.hand_number<v_candidate.hand_number
       AND c.state<>'rebought'
       AND c.id<>ALL(v_rebought_generations)
  ) THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','unresolved_knockout_generation_chain');
  END IF;
  IF v_candidate.state<>'pending' THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','knockout_generation_state_mismatch',
      'player_state',v_player.status,'candidate_state',v_candidate.state);
  END IF;
  IF v_candidate.rebuy_prompt_until IS NOT NULL
     AND v_candidate.rebuy_prompt_until>clock_timestamp() THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','rebuy_decision_open',
      'rebuy_prompt_until',v_candidate.rebuy_prompt_until);
  END IF;

  PERFORM 1
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_eliminated_user_id AND s.left_at IS NULL
   ORDER BY s.id FOR UPDATE OF s;
  SELECT count(*) INTO v_live_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_eliminated_user_id AND s.left_at IS NULL;
  IF v_live_count>1 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','knockout_generation_has_multiple_live_seats');
  END IF;
  IF v_live_count=1 THEN
    SELECT s.* INTO v_live
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id
       AND s.user_id=p_eliminated_user_id AND s.left_at IS NULL;
    IF v_live.stack IS DISTINCT FROM 0
       OR v_live.table_id IS DISTINCT FROM v_candidate.table_id
       OR v_live.id IS DISTINCT FROM v_candidate.seat_id
       OR v_live.joined_at IS DISTINCT FROM v_candidate.seat_joined_at THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','knockout_generation_has_new_live_seat');
    END IF;
  END IF;

  v_result:=public.fn_claim_bounty_legacy_candidate_20260907(
    p_tournament_id,p_eliminated_user_id,p_position,p_prize,p_table_id,
    p_hand_id,p_hand_number,p_seat_joined_at,p_knocker_user_id,p_claimants,
    p_bubble_refund,p_allow_existing_eliminated);
  IF coalesce((v_result->>'ok')::boolean,false)
     AND coalesce((v_result->>'claimed')::boolean,false)
  THEN
    UPDATE public.tournament_knockout_candidates c
       SET state='eliminated',
           resolved_at=coalesce(c.resolved_at,clock_timestamp())
     WHERE c.id=v_candidate.id AND c.state='pending';
    GET DIAGNOSTICS v_changed=ROW_COUNT;
    IF v_changed<>1 THEN
      RAISE EXCEPTION
        'bounty knockout generation changed while claim committed'
        USING ERRCODE='serialization_failure';
    END IF;
  END IF;
  -- The proven older generations close with the bust that proved them.
  IF coalesce((v_result->>'ok')::boolean,false)
     AND coalesce((v_result->>'claimed')::boolean,false)
     AND cardinality(v_rebought_generations)>0 THEN
    UPDATE public.tournament_knockout_candidates c
       SET state='rebought',resolved_at=clock_timestamp()
     WHERE c.id=ANY(v_rebought_generations)
       AND c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_eliminated_user_id
       AND c.state='pending';
    GET DIAGNOSTICS v_changed=ROW_COUNT;
    IF v_changed<>cardinality(v_rebought_generations) THEN
      RAISE EXCEPTION
        'a bought-back knockout generation changed while the bounty claim committed'
        USING ERRCODE='serialization_failure';
    END IF;
    v_result:=v_result||jsonb_build_object(
      'rebought_generations',to_jsonb(v_rebought_generations));
  END IF;
  RETURN v_result;
END;
$function$;

-- The standings normalizer: a moved place is re-priced in the same write; only place money holds it.
CREATE OR REPLACE FUNCTION public.fn_normalize_tournament_final_standings(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status              text;
  v_player_count        integer := 0;
  v_ranked_count        integer := 0;
  v_distinct_positions integer := 0;
  v_min_position        integer := 0;
  v_max_position        integer := 0;
  v_winner_count        integer := 0;
  v_winner_place_one    integer := 0;
  v_nonterminal_count   integer := 0;
  v_missing_bust_time   integer := 0;
  v_negative_prizes     integer := 0;
  v_evidence_invalid    integer := 0;
  v_orphan_payout_keys  integer := 0;
  v_canonical_mismatches integer := 0;
  v_updated             integer := 0;
  v_batch_exists        boolean := false;
  v_failure             text;
  v_failure_state       text;
  v_t                   record;
  v_struct              jsonb := '[]'::jsonb;
  v_trimmed             jsonb := '[]'::jsonb;
  v_prices              jsonb := '{}'::jsonb;
  v_reprice             jsonb := '{}'::jsonb;
  v_price_failure       text;
  v_pool_cents          bigint := 0;
  v_remaining_cents     bigint := 0;
  v_expected_cents      bigint := 0;
  v_total_bp            bigint := 0;
  v_price_places        integer := 0;
  v_price_distinct      integer := 0;
  v_price_first         integer := 0;
  v_price_last          integer := 0;
  v_reprice_rows        integer := 0;
  v_repriced            integer := 0;
  v_price_mismatches    integer := 0;
  v_money_payouts       integer := 0;
  v_money_obligations   integer := 0;
  r                     record;
BEGIN
  IF p_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_id_required',
                              'retryable', false);
  END IF;

  SELECT t.status INTO v_status
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found',
                              'retryable', false);
  END IF;
  IF v_status NOT IN ('COMPLETING', 'COMPLETED') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_completing',
                              'status', v_status, 'retryable', false);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id AND p.source = 'final_table_deal'
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'final_table_deal'
  ) THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'final_table_deal_has_its_own_standings',
                              'retryable', false);
  END IF;

  PERFORM 1
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.id
   FOR UPDATE;

  SELECT count(*), count(tp.position), count(DISTINCT tp.position),
         COALESCE(min(tp.position), 0), COALESCE(max(tp.position), 0),
         count(*) FILTER (WHERE tp.status = 'winner'),
         count(*) FILTER (WHERE tp.status = 'winner' AND tp.position = 1),
         count(*) FILTER (WHERE tp.status NOT IN ('winner', 'eliminated')),
         count(*) FILTER (WHERE tp.status = 'eliminated' AND tp.eliminated_at IS NULL),
         count(*) FILTER (WHERE round(COALESCE(tp.prize, 0) * 100)::bigint < 0)
    INTO v_player_count, v_ranked_count, v_distinct_positions,
         v_min_position, v_max_position, v_winner_count,
         v_winner_place_one, v_nonterminal_count, v_missing_bust_time,
         v_negative_prizes
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;

  IF v_player_count = 0 OR v_winner_count <> 1 OR v_winner_place_one <> 1
     OR v_nonterminal_count <> 0 OR v_missing_bust_time <> 0
     OR v_negative_prizes <> 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'final_result_is_not_proven',
      'players', v_player_count, 'winners', v_winner_count,
      'winner_at_place_one', v_winner_place_one,
      'nonterminal_players', v_nonterminal_count,
      'eliminated_without_time', v_missing_bust_time,
      'negative_prizes', v_negative_prizes, 'retryable', false);
  END IF;

  /* A generic obligation-key payout is classifiable only while its exact
     durable obligation still exists. Silently ignoring an orphan would let a
     deleted place obligation look unpaid and allocate the same chips again;
     guessing that every generic key is a place would instead misclassify
     Bubble Protection and final-table deals. Refuse both ambiguities before
     this result-only function can renumber a single row. */
  SELECT count(*) INTO v_orphan_payout_keys
    FROM (
      SELECT p.idempotency_key
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.idempotency_key LIKE
             'tourney:' || p_tournament_id::text || ':obl:%'
         AND NOT EXISTS (
           SELECT 1
             FROM public.tournament_obligations o
            WHERE o.tournament_id = p_tournament_id
              AND p.idempotency_key LIKE
                  'tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ':%'
         )
       GROUP BY p.idempotency_key
      HAVING abs(round(sum(p.amount), 2)) > 0.005
    ) orphaned;
  IF v_orphan_payout_keys > 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'unattributed_obligation_key_evidence',
      'keys', v_orphan_payout_keys, 'retryable', false);
  END IF;

  /* Chronology is the result authority: the champion is first and eliminated
     rows run from latest bust in second through earliest bust in last. A
     provisional place/prize is only an estimate. Historical payout evidence
     may prove that a canonical result was already paid; it may never redefine
     that result. Any paid player/place that disagrees requires manual review
     because this function neither claws money back nor moves it to a different
     recipient. */
  WITH eliminated AS (
    SELECT tp.id, tp.user_id,
           v_player_count - (row_number() OVER (
             ORDER BY tp.eliminated_at ASC, tp.id ASC
           ))::integer + 1 AS canonical_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status = 'eliminated'
  ),
  canonical AS (
    SELECT tp.id, tp.user_id, 1 AS canonical_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND tp.status = 'winner'
    UNION ALL
    SELECT e.id, e.user_id, e.canonical_position FROM eliminated e
  ),
  evidence AS (
    SELECT p.position, p.user_id
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND (p.source IN ('structure', 'reconcile', 'hu_shortfall',
                         'late_reg_adjustment', 'clawback', 'spin_backpay',
                         'overlay_backpay')
            OR public.fn_tournament_payout_key_is_place_evidence(
                 p.tournament_id, p.idempotency_key))
     GROUP BY p.position, p.user_id
    HAVING abs(round(sum(p.amount), 2)) > 0.005
  )
  SELECT count(*) INTO v_evidence_invalid
    FROM evidence e
   WHERE e.position IS NULL OR NOT EXISTS (
     SELECT 1 FROM canonical c
      WHERE c.canonical_position = e.position AND c.user_id = e.user_id);
  IF v_evidence_invalid > 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'paid_positions_do_not_match_final_results',
      'invalid_payout_groups', v_evidence_invalid, 'retryable', false);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.tournament_place_settlement_batches b
     WHERE b.tournament_id = p_tournament_id
  ) INTO v_batch_exists;

  WITH eliminated AS (
    SELECT tp.id,
           v_player_count - (row_number() OVER (
             ORDER BY tp.eliminated_at ASC, tp.id ASC
           ))::integer + 1 AS canonical_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status = 'eliminated'
  ),
  canonical AS (
    SELECT tp.id, 1 AS canonical_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND tp.status = 'winner'
    UNION ALL
    SELECT e.id, e.canonical_position FROM eliminated e
  )
  SELECT count(*) INTO v_canonical_mismatches
    FROM canonical c
    JOIN public.tournament_players tp ON tp.id = c.id
   WHERE tp.position IS DISTINCT FROM c.canonical_position;

  /* A prepared or completed result is immutable. It may be observed when it
     is already exact, but this repair door never rewrites it. */
  IF v_batch_exists OR v_status = 'COMPLETED' THEN
    IF v_ranked_count = v_player_count
       AND v_distinct_positions = v_player_count
       AND v_min_position = 1 AND v_max_position = v_player_count
       AND v_canonical_mismatches = 0 THEN
      RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                                'players', v_player_count, 'updated', 0,
                                'already_normalized', true, 'retryable', false);
    END IF;
    RETURN jsonb_build_object('ok', false,
                              'reason', 'frozen_final_standings_are_invalid',
                              'retryable', false);
  END IF;

  IF v_canonical_mismatches = 0 THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'players', v_player_count, 'updated', 0,
                              'already_normalized', true, 'retryable', false);
  END IF;

  /* A MOVED PLACE IS RE-PRICED IN THE SAME WRITE (2026-09-11).
     This renumbered positions and left tp.prize where it was, so the prize a
     player was provisionally stamped with at one place travelled with them to
     another, and fn_prepare_tournament_place_obligations - which demands that
     every paid place holds exactly its structure amount - then refused the
     event for ever with recorded_prize_disagrees_with_structure. Every row
     this assignment moves is priced here with prepare's own rule: the
     structure trimmed to the field, bp = round(percentage * 100), each place
     least(remaining, round(pool_cents * bp / total_bp)), the last paid place
     takes the remainder, a Spin's drawn ladder by spin_multiplier. A place
     outside the ladder is worth zero. Satellites pay seats, not this ladder,
     and are renumbered exactly as before.
     It prices only while no PLACE money has moved for the event. A payout
     from the place ladder (any source but a bounty or a satellite seat) or a
     place or Bubble Protection obligation means a place was paid or promised
     against the old order; re-pricing under it could pay a place twice or
     take one back, so that is refused, loudly, and nothing is renumbered.
     Bounty money is paid by its own authority for a knockout, not for a
     place, and does not hold the ladder. (A prepared batch already returned
     above as frozen.) A ladder that cannot be derived is refused the same
     way rather than guessed. */
  SELECT round(COALESCE(t.prize_pool, 0), 2) AS prize_pool,
         round(COALESCE(t.guaranteed_prize, 0), 2) AS guaranteed_prize,
         COALESCE(t.prize_pool_finalized, false) AS prize_pool_finalized,
         t.payout_structure, t.variant, t.tournament_type,
         t.satellite_target_id, t.spin_multiplier
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;

  IF NOT (lower(COALESCE(v_t.variant, '')) = 'satellite'
          OR upper(COALESCE(v_t.tournament_type, '')) = 'SATELLITE'
          OR v_t.satellite_target_id IS NOT NULL) THEN
    IF NOT v_t.prize_pool_finalized
       OR v_t.prize_pool + 0.005 < v_t.guaranteed_prize THEN
      v_price_failure := 'prize_pool_is_not_funded_and_finalized';
    ELSE
      v_pool_cents := round(v_t.prize_pool * 100)::bigint;
    END IF;

    IF v_price_failure IS NULL AND v_pool_cents > 0 THEN
      BEGIN
        IF lower(COALESCE(v_t.variant, '')) = 'spin'
           OR upper(COALESCE(v_t.tournament_type, '')) = 'SPIN' THEN
          IF v_t.spin_multiplier IS NULL OR v_t.spin_multiplier <= 0 THEN
            v_price_failure := 'spin_multiplier_is_not_persisted';
          ELSE
            SELECT l.structure INTO v_struct
              FROM public.spin_payout_ladder l
             WHERE l.multiplier = v_t.spin_multiplier;
            IF NOT FOUND THEN
              v_price_failure := 'spin_multiplier_has_no_canonical_ladder';
            END IF;
          END IF;
        ELSE
          v_struct := public.fn_safe_jsonb_array(v_t.payout_structure);
        END IF;
        IF v_price_failure IS NULL AND (jsonb_array_length(v_struct) = 0 OR EXISTS (
          SELECT 1
            FROM jsonb_array_elements(v_struct) e
           WHERE jsonb_typeof(e) <> 'object'
              OR COALESCE(e->>'place', '') !~ '^[1-9][0-9]*$'
              OR COALESCE(e->>'percentage', '') !~ '^[0-9]+([.][0-9]+)?$'
              OR (e->>'percentage')::numeric < 0
        )) THEN
          v_price_failure := 'payout_structure_is_invalid';
        END IF;
        IF v_price_failure IS NULL THEN
          SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'place')::integer), '[]'::jsonb)
            INTO v_trimmed
            FROM jsonb_array_elements(v_struct) e
           WHERE (e->>'place')::integer <= v_player_count;

          SELECT count(*), count(DISTINCT (e->>'place')::integer),
                 COALESCE(min((e->>'place')::integer), 0),
                 COALESCE(max((e->>'place')::integer), 0),
                 COALESCE(sum(round((e->>'percentage')::numeric * 100)::bigint), 0)
            INTO v_price_places, v_price_distinct, v_price_first, v_price_last,
                 v_total_bp
            FROM jsonb_array_elements(v_trimmed) e;

          IF v_price_places = 0 OR v_price_distinct <> v_price_places
             OR v_price_first <> 1 OR v_price_last <> v_price_places
             OR v_total_bp <= 0 THEN
            v_price_failure := 'payout_places_are_not_contiguous';
          END IF;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_price_failure := 'payout_structure_is_invalid';
      END;

      IF v_price_failure IS NULL THEN
        v_remaining_cents := v_pool_cents;
        FOR r IN
          SELECT (e->>'place')::integer AS place,
                 round((e->>'percentage')::numeric * 100)::bigint AS bp
            FROM jsonb_array_elements(v_trimmed) e
           ORDER BY (e->>'place')::integer
        LOOP
          IF r.place = v_price_last THEN
            v_expected_cents := GREATEST(v_remaining_cents, 0);
          ELSE
            v_expected_cents := GREATEST(
              LEAST(v_remaining_cents, round(v_pool_cents * r.bp::numeric / v_total_bp)::bigint), 0);
          END IF;
          v_remaining_cents := v_remaining_cents - v_expected_cents;
          v_prices := v_prices || jsonb_build_object(r.place::text, v_expected_cents);
        END LOOP;
      END IF;
    END IF;

    WITH eliminated AS (
      SELECT tp.id, tp.position AS old_position,
             round(COALESCE(tp.prize, 0) * 100)::bigint AS old_cents,
             v_player_count - (row_number() OVER (
               ORDER BY tp.eliminated_at ASC, tp.id ASC
             ))::integer + 1 AS canonical_position
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status = 'eliminated'
    )
    SELECT count(*),
           COALESCE(jsonb_object_agg(e.id::text,
             COALESCE((v_prices->>e.canonical_position::text)::bigint, 0)), '{}'::jsonb)
      INTO v_reprice_rows, v_reprice
      FROM eliminated e
     WHERE e.old_position IS DISTINCT FROM e.canonical_position
       AND (v_price_failure IS NOT NULL
            OR e.old_cents <> COALESCE((v_prices->>e.canonical_position::text)::bigint, 0));

    IF v_reprice_rows > 0 AND v_price_failure IS NOT NULL THEN
      RAISE WARNING 'tournament %: % moved place(s) cannot be priced (%); final standings left as they were',
        p_tournament_id, v_reprice_rows, v_price_failure;
      RETURN jsonb_build_object('ok', false, 'reason', 'moved_places_cannot_be_priced',
                                'detail', v_price_failure, 'rows', v_reprice_rows,
                                'retryable', false);
    END IF;

    IF v_reprice_rows > 0 THEN
      SELECT count(*) INTO v_money_payouts
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND COALESCE(p.source, '') NOT IN ('bounty', 'own_bounty', 'mystery_bounty',
                                            'mystery_bounty_residual', 'bounty_residual',
                                            'satellite_seat');
      SELECT count(*) INTO v_money_obligations
        FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind IN ('place', 'bubble_protection');
      IF v_money_payouts > 0 OR v_money_obligations > 0 THEN
        RAISE WARNING 'tournament %: % moved place(s) would be re-priced after place money moved (% place payout row(s), % place or bubble obligation(s)); refused, final standings left as they were',
          p_tournament_id, v_reprice_rows, v_money_payouts, v_money_obligations;
        RETURN jsonb_build_object('ok', false,
                                  'reason', 'moved_places_cannot_be_repriced_after_money_moved',
                                  'rows', v_reprice_rows, 'payouts', v_money_payouts,
                                  'obligations', v_money_obligations, 'retryable', false);
      END IF;
    END IF;
  END IF;

  BEGIN
    /* Clear every eliminated position first. Besides making the assignment
       deterministic even when the old ladder happened to be contiguous-but-
       wrong, this prevents the collision watcher from logging transient swaps.
       Both statements live in this exception subtransaction and therefore
       publish together or roll back together. */
    UPDATE public.tournament_players tp
       SET position = NULL
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status = 'eliminated';

    WITH assignments AS (
      SELECT tp.id,
             v_player_count - (row_number() OVER (
               ORDER BY tp.eliminated_at ASC, tp.id ASC
             ))::integer + 1 AS position
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status = 'eliminated'
    )
    UPDATE public.tournament_players tp
       SET position = a.position
      FROM assignments a
     WHERE tp.id = a.id AND tp.position IS DISTINCT FROM a.position;
    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_reprice_rows > 0 THEN
      UPDATE public.tournament_players tp
         SET prize = round((v_reprice->>tp.id::text)::numeric / 100, 2)
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status = 'eliminated'
         AND v_reprice ? tp.id::text;
      GET DIAGNOSTICS v_repriced = ROW_COUNT;
      SELECT count(*) INTO v_price_mismatches
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status = 'eliminated'
         AND v_reprice ? tp.id::text
         AND round(COALESCE(tp.prize, 0) * 100)::bigint
             <> COALESCE((v_prices->>tp.position::text)::bigint, 0);
      IF v_repriced <> v_reprice_rows OR v_price_mismatches <> 0 THEN
        RAISE EXCEPTION USING
          MESSAGE = 'the moved places were not re-priced to the ladder',
          ERRCODE = '23514';
      END IF;
    END IF;

    SELECT count(*), count(tp.position), count(DISTINCT tp.position),
           COALESCE(min(tp.position), 0), COALESCE(max(tp.position), 0),
           count(*) FILTER (WHERE tp.status = 'winner'),
           count(*) FILTER (WHERE tp.status = 'winner' AND tp.position = 1),
           count(*) FILTER (WHERE tp.status NOT IN ('winner', 'eliminated'))
      INTO v_player_count, v_ranked_count, v_distinct_positions,
           v_min_position, v_max_position, v_winner_count,
           v_winner_place_one, v_nonterminal_count
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id;

    WITH eliminated AS (
      SELECT tp.id,
             v_player_count - (row_number() OVER (
               ORDER BY tp.eliminated_at ASC, tp.id ASC
             ))::integer + 1 AS canonical_position
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status = 'eliminated'
    )
    SELECT count(*) INTO v_canonical_mismatches
      FROM eliminated e
      JOIN public.tournament_players tp ON tp.id = e.id
     WHERE tp.position IS DISTINCT FROM e.canonical_position;
    IF v_player_count = 0 OR v_ranked_count <> v_player_count
       OR v_distinct_positions <> v_player_count
       OR v_min_position <> 1 OR v_max_position <> v_player_count
       OR v_winner_count <> 1 OR v_winner_place_one <> 1
       OR v_nonterminal_count <> 0 OR v_canonical_mismatches <> 0 THEN
      RAISE EXCEPTION USING
        MESSAGE = 'the complete final-standings assignment did not validate',
        ERRCODE = '23514';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_failure = MESSAGE_TEXT,
                            v_failure_state = RETURNED_SQLSTATE;
  END;

  IF v_failure IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'standings_write_aborted',
                              'detail', v_failure, 'sqlstate', v_failure_state,
                              'retryable', v_failure_state IN ('40001', '40P01', '55P03'));
  END IF;
  RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                            'players', v_player_count, 'updated', v_updated,
                            'repriced', v_repriced, 'retryable', false);
END;
$function$;

-- The unfinished-finish alarm (cron 304) counts from when the last bust was recorded.
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_finished_but_not_completed(p_minutes integer DEFAULT 15)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_count   int := 0;
  v_sample  jsonb := '[]'::jsonb;
  v_open    boolean;
  v_cutoff  interval := make_interval(mins => GREATEST(COALESCE(p_minutes, 15), 1));
BEGIN
  WITH stuck AS (
    SELECT t.id AS tournament_id,
           t.name,
           t.started_at,
           (SELECT count(*) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id
               AND tp.status IN ('playing', 'active', 'registered')) AS alive,
           -- When the last bust was RECORDED. eliminated_at is the time of
           -- the bust (20260911062048), and a bust can be recorded long after
           -- it happened; the knockout door's own recording time is the
           -- resolved_at of the generation it consumed. Rows recorded without
           -- a generation still carry their recording time in eliminated_at.
           GREATEST(
             (SELECT max(tp.eliminated_at) FROM public.tournament_players tp
               WHERE tp.tournament_id = t.id AND tp.eliminated_at IS NOT NULL),
             (SELECT max(c.resolved_at) FROM public.tournament_knockout_candidates c
               WHERE c.tournament_id = t.id AND c.state = 'eliminated')) AS last_elimination,
           (SELECT count(*) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id) AS entrants
      FROM public.tournaments t
     WHERE t.status = 'RUNNING'
       AND COALESCE(t.variant, '') <> 'satellite'
       AND upper(COALESCE(t.tournament_type, '')) <> 'SATELLITE'
  )
  SELECT count(*),
         COALESCE(jsonb_agg(jsonb_build_object(
           'tournament_id', tournament_id,
           'name', left(COALESCE(name, ''), 60),
           'entrants', entrants,
           'alive', alive,
           'last_elimination', last_elimination,
           'stuck_for_minutes', round(extract(epoch FROM (now() - last_elimination)) / 60.0, 1))
           ORDER BY last_elimination), '[]'::jsonb)
    INTO v_count, v_sample
    FROM stuck
   WHERE alive <= 1
     AND last_elimination IS NOT NULL
     AND last_elimination < now() - v_cutoff;

  IF v_count > 0 THEN
    SELECT EXISTS (
      SELECT 1 FROM public.financial_alerts fa
       WHERE fa.source = 'fn_ca_tournament_finished_but_not_completed'
         AND COALESCE(fa.resolved, false) = false
    ) INTO v_open;

    IF NOT v_open THEN
      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES (
        'critical',
        'fn_ca_tournament_finished_but_not_completed',
        format(
          '%s tournament(s) have one player or fewer left and have not completed '
          || 'for over %s minute(s). Their winners are unpaid, and every other payout '
          || 'check on this database only judges COMPLETED tournaments, so nothing '
          || 'else can see them. Healthy tournaments settle within 20s of the final '
          || 'elimination (p99 over 4,242 events).',
          v_count, GREATEST(COALESCE(p_minutes, 15), 1)),
        jsonb_build_object(
          'checked_at', now(),
          'threshold_minutes', GREATEST(COALESCE(p_minutes, 15), 1),
          'tournaments', v_sample,
          'cause', 'elimination sweep overruns on a saturated engine thread - '
                || 'see docs/HANDOFF_CURRENT_STATE.md section 16 (P0/P1) and '
                || 'docs/changelog/2026-09-07-the-collapse-was-not-the-reload-storm.md')
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'checked_at', now(),
    'threshold_minutes', GREATEST(COALESCE(p_minutes, 15), 1),
    'stuck', v_count,
    'tournaments', v_sample
  );
END;
$function$;

-- Restate the current authority explicitly; no new caller is admitted.
REVOKE ALL ON FUNCTION public.fn_settle_tournament_places(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_places(uuid,uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_normalize_tournament_final_standings(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_normalize_tournament_final_standings(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_finished_but_not_completed(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_finished_but_not_completed(integer)
  TO service_role;

DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_settle_tournament_places(uuid,uuid)')
       AND md5(p.prosrc) IN ('a451a9a3205185ee4b284ea8d8a44f35')
       AND p.proowner = 'postgres'::regrole
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
       AND NOT p.proretset AND p.prorettype = 'jsonb'::regtype
       AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
       AND p.proconfig::text = '{search_path=public,statement_timeout=30s}'
  ) THEN
    RAISE EXCEPTION 'Reviewed function body or authority changed during migration: public.fn_settle_tournament_places(uuid,uuid)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)')
       AND md5(p.prosrc) IN ('66de5a1bd9a520a6afdfd36c82c83908')
       AND p.proowner = 'postgres'::regrole
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
       AND NOT p.proretset AND p.prorettype = 'jsonb'::regtype
       AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
       AND p.proconfig::text = '{"search_path=public, pg_temp"}'
  ) THEN
    RAISE EXCEPTION 'Reviewed function body or authority changed during migration: public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)')
       AND md5(p.prosrc) IN ('29e95c342e7ada09715bc7aa1d248c6d')
       AND p.proowner = 'postgres'::regrole
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
       AND NOT p.proretset AND p.prorettype = 'jsonb'::regtype
       AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
       AND p.proconfig::text = '{"search_path=public, pg_temp"}'
  ) THEN
    RAISE EXCEPTION 'Reviewed function body or authority changed during migration: public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)')
       AND md5(p.prosrc) IN ('66b721eb896d927f2fedb0b9c739d0fb')
       AND p.proowner = 'postgres'::regrole
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
       AND NOT p.proretset AND p.prorettype = 'jsonb'::regtype
       AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
       AND p.proconfig::text = '{"search_path=public, pg_temp"}'
  ) THEN
    RAISE EXCEPTION 'Reviewed function body or authority changed during migration: public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)')
       AND md5(p.prosrc) IN ('a908e937ed1fd193603d383bbfabebc0')
       AND p.proowner = 'postgres'::regrole
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
       AND NOT p.proretset AND p.prorettype = 'jsonb'::regtype
       AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
       AND p.proconfig::text = '{"search_path=public, pg_temp"}'
  ) THEN
    RAISE EXCEPTION 'Reviewed function body or authority changed during migration: public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_normalize_tournament_final_standings(uuid)')
       AND md5(p.prosrc) IN ('45b06c3f8be02940d130c427d5a32519')
       AND p.proowner = 'postgres'::regrole
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
       AND NOT p.proretset AND p.prorettype = 'jsonb'::regtype
       AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
       AND p.proconfig::text = '{search_path=public}'
  ) THEN
    RAISE EXCEPTION 'Reviewed function body or authority changed during migration: public.fn_normalize_tournament_final_standings(uuid)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_ca_tournament_finished_but_not_completed(integer)')
       AND md5(p.prosrc) IN ('6f153669e4b6b149bfccd36ad575bda8')
       AND p.proowner = 'postgres'::regrole
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
       AND NOT p.proretset AND p.prorettype = 'jsonb'::regtype
       AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
       AND p.proconfig::text = '{search_path=public,statement_timeout=60s}'
  ) THEN
    RAISE EXCEPTION 'Reviewed function body or authority changed during migration: public.fn_ca_tournament_finished_but_not_completed(integer)'
      USING ERRCODE = '55000';
  END IF;
END;
$postflight$;
COMMIT;

-- 20260912051956_the_stat_writer_says_which_path_it_is_on.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE STAT WRITER SAYS WHICH PATH IT IS ON.
--
-- WHAT HAPPENED. `ClubArenaStatsTriggerGap` raised and resolved 32 times on
-- the night of 2026-09-11, in a sawtooth about fifteen minutes wide. Its own
-- remediation text tells the reader to search the Postgres log for
-- "trg_ca_stats_live_from_hand:". There are ZERO such lines in 24 hours -
-- measured 2026-09-12 05:05 UTC - and the reason is not that the trigger is
-- failing silently. It is that the trigger CORRECTLY DECLINES:
--
--     IF coalesce(current_setting('app.atomic_hand_commit',true),'')='on'
--       THEN RETURN NEW; END IF;
--
-- is its first statement, and `fn_ca_commit_hand_settlement` sets that GUC
-- immediately before inserting the hand. Migration
-- 20260908042100_an_accepted_hand_is_one_commit_and_stats_leave_the_hot_path
-- put it there deliberately: five synchronous AFTER INSERT triggers on
-- hand_history were cancelling the hand they described (726 INSERTs cancelled
-- in one five-minute window on 2026-09-07), so their effects moved behind a
-- durable outbox. `fn_project_hand_side_effects` is the writer now, drained
-- from hand_projection_outbox by the engine (services/supabase/handProjection.ts),
-- and it IS running: 548,234 of the 548,235 hands in the 24 h to 2026-09-12
-- 05:00 UTC carry an atomic-commit receipt, and the outbox measured 0 deep.
--
-- So nothing here restores a writer, because none is missing. What is missing
-- is the SENTENCE that would have ended that investigation in one minute.
-- Three changes, all of them observability or permission, none of them a
-- change to what gets written:
--
--   1. The bypass branch SAYS SO. A branch that returns without writing and
--      without saying why is what made this expensive. It is rate limited to
--      one line per backend per ten minutes, because the path it sits on
--      carries ~550k hands a day and a per-hand log line is the hot-path cost
--      the 0908 migration existed to remove.
--
--   2. ca_stats_health() reports the ROLL CURSOR and the LIVE WRITER'S QUEUE.
--      Its window is hands aged 90 s to 3 m 30 s, which can only ever see the
--      newest hands, so "the 15-minute forward roll has not run" and "the live
--      writer is not writing" were the same observation. They are now two
--      numbers. The comment inside it said the trigger writes the stat row "in
--      the same transaction as the hand", which stopped being true on
--      2026-09-08 and is corrected here.
--
--   3. fn_process_hand_position_stats(jsonb,jsonb,jsonb) gets EXECUTE for
--      service_role. It holds `postgres=X/postgres` only, and
--      trg_hand_history_position_stats is SECURITY INVOKER, so on the LEGACY
--      (non-atomic) path every call is `permission denied for function
--      fn_process_hand_position_stats`, swallowed into a WARNING. Measured: 42
--      such warnings in 24 h. Every one of the four sampled hand ids has no
--      row in hand_history, so those transactions rolled back and no committed
--      hand has lost its positional aggregates - but the next one on that path
--      would, silently. The dominant path is unaffected either way, because
--      fn_project_hand_side_effects_after_post_commit_20260908 calls the same
--      function as SECURITY DEFINER owned by postgres.
--
--      This is a GRANT TO service_role, not a new SECURITY DEFINER and not a
--      grant to a browser role: 20260906231557_a_trigger_function_is_not_a_
--      browser_routine is the ruling on that, and its direction of travel is
--      REVOKE from anon/authenticated. service_role is neither, and GRANT does
--      not fire pgrst_ddl_watch (CLAUDE.md 2, rule 5), so only the two CREATE
--      OR REPLACEs and the COMMENTs below cost a schema reload - which is why
--      they are in ONE transaction.
--
-- NOT APPLIED BY ITS AUTHOR. The session that wrote this was instructed not to
-- apply migrations to production, and did not. Every object it names already
-- exists, so `check-migrations-applied.mjs` passes on the names; the BODIES
-- are what this changes. The engine change that ships beside it degrades
-- cleanly: StatsHealthMonitor reads `roll` and `liveWriter` defensively and
-- renders their absence as UNKNOWN, never as healthy, so it is correct before
-- and after this is applied.

BEGIN;

SET LOCAL lock_timeout = '250ms';

-- ---------------------------------------------------------------------------
-- 1. The bypass branch says so.
-- ---------------------------------------------------------------------------
-- Byte-for-byte the live body, plus the rate-limited line. The INSERTs, the
-- ON CONFLICT DO NOTHING clauses and the EXCEPTION WHEN OTHERS handler are
-- unchanged: a stats row must never be able to block a hand, which is the
-- whole reason that handler exists.
--
-- The rate limit is a session GUC holding an epoch second, guarded by a regex
-- before the cast so a garbage value can never raise from here. Under a
-- transaction-mode pooler the GUC belongs to the server backend rather than to
-- one client; that is fine, because it governs nothing but how often this line
-- is printed.
CREATE OR REPLACE FUNCTION public.trg_ca_stats_live_from_hand()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_said text;
BEGIN
  IF coalesce(current_setting('app.atomic_hand_commit',true),'')='on' THEN
    v_said := current_setting('app.ca_stats_bypass_said_at', true);
    IF v_said IS NULL OR v_said !~ '^[0-9]+$'
       OR (extract(epoch FROM clock_timestamp())::bigint - v_said::bigint) > 600 THEN
      PERFORM set_config('app.ca_stats_bypass_said_at',
                         extract(epoch FROM clock_timestamp())::bigint::text, false);
      RAISE WARNING 'trg_ca_stats_live_from_hand: declined by design (app.atomic_hand_commit=on); fn_project_hand_side_effects owns ca_hand_player_stat and ca_hand_player_idx on this path, drained from hand_projection_outbox. Latest hand %. This line is rate limited to one per backend per 10 minutes.', NEW.id;
    END IF;
    RETURN NEW;
  END IF;
  INSERT INTO public.ca_hand_player_idx(user_id,created_at,hand_id)
  SELECT DISTINCT (pl->>'userId')::uuid,NEW.created_at,NEW.id
    FROM jsonb_array_elements(coalesce(NEW.players,'[]'::jsonb)) pl
   WHERE pl->>'userId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ON CONFLICT DO NOTHING;
  INSERT INTO public.ca_hand_player_stat(
    user_id,hand_id,created_at,is_cash,tournament_id,game_variant,
    big_blind,small_blind,n_players,seat_position,my_blind,won_amt,is_winner,
    invested_actions,aggro_cnt,call_cnt,vpip,pfr,folded,three_bet,
    three_bet_opp,faced_three_bet,folded_to_three_bet,cbet_opp,cbet_made,
    showdown,hand_secs,profit)
  SELECT f.user_id,f.hand_id,f.created_at,f.is_cash,f.tournament_id,f.game_variant,
    f.big_blind,f.small_blind,f.n_players,f.seat_position,f.my_blind,f.won_amt,f.is_winner,
    f.invested_actions,f.aggro_cnt,f.call_cnt,f.vpip,f.pfr,f.folded,f.three_bet,
    f.three_bet_opp,f.faced_three_bet,f.folded_to_three_bet,f.cbet_opp,f.cbet_made,
    f.showdown,f.hand_secs,f.profit
    FROM public.ca_hand_player_facts_one(NEW.id,NULL) f
  ON CONFLICT (user_id,hand_id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_ca_stats_live_from_hand: % (hand %)',SQLERRM,NEW.id;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.trg_ca_stats_live_from_hand() IS
  'Writes ca_hand_player_stat + ca_hand_player_idx for a hand ONLY on the legacy path. '
  'When app.atomic_hand_commit is on (set by fn_ca_commit_hand_settlement, which is how '
  'essentially every hand is written since 20260908042100) this returns immediately and '
  'fn_project_hand_side_effects does the write instead, out of hand_projection_outbox. '
  'A gap in ca_hand_player_stat is therefore a question about that drain, not about this '
  'trigger: there will be no "trg_ca_stats_live_from_hand:" error line to find.';

COMMENT ON FUNCTION public.fn_project_hand_side_effects(uuid) IS
  'The live stats/projection writer on the atomic-commit path. Called by the engine over '
  'RPC from services/supabase/handProjection.ts, woken by NOTIFY hand_projection_outbox / '
  'Realtime, with a safety poll behind it. Writes ca_hand_player_stat, ca_hand_player_idx, '
  'club_member_daily_stats, player_stats and player_position_stats, then deletes the outbox '
  'row. If this stops, ca_roll_hand_stats_forward backfills ca_hand_player_stat within 15 '
  'minutes, which is why a stalled drain shows as a sawtooth rather than a flat line.';

-- ---------------------------------------------------------------------------
-- 2. The health read can tell the two writers apart.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ca_stats_health()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH idx AS (
    SELECT idx_ceil, backfill_complete, rows_indexed, updated_at
    FROM public.ca_hand_player_idx_state WHERE id
  ),
  -- The last three minutes of hands, less a 90 s grace for the write itself.
  --
  -- CORRECTED 2026-09-12. This comment used to end "because the trigger writes
  -- it in the same transaction as the hand". That has been false since
  -- 20260908042100: on the atomic-commit path trg_ca_stats_live_from_hand
  -- declines, and fn_project_hand_side_effects writes the row from the outbox
  -- in a LATER transaction. So a non-zero count here is "the projector has not
  -- caught up within 90 s", and the `liveWriter` and `roll` blocks below are
  -- what say which of the two writers is behind. Reading this count alone is
  -- how a 15-minute compensator came to drive a 60-second alarm.
  recent AS (
    SELECT count(*)::int AS hands,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM public.ca_hand_player_stat s WHERE s.hand_id = h.id
           ))::int AS without_stat
    FROM hand_history h
    WHERE h.created_at >= now() - interval '3 minutes 30 seconds'
      AND h.created_at <  now() - interval '90 seconds'
  ),
  -- The live writer's queue. Both reads are bounded on purpose: the outbox has
  -- been 100,888 rows deep (2026-09-10), and a health probe must not turn into
  -- a sequential scan on the day the thing it watches breaks. The depth is
  -- capped at 10,001 (`depthCapped` says when the true number is larger, which
  -- is itself the answer), and the oldest row is reached through the
  -- UNIQUE(hand_number) index: hand_number is a platform-wide monotonic
  -- sequence, so the lowest pending hand_number IS the oldest pending row.
  --
  -- MEASURED on production 2026-09-12 05:24 UTC, EXPLAIN (ANALYZE, BUFFERS) on
  -- the pair, with 35 rows pending: 76 shared buffer hits, 3.140 ms execution.
  -- The depth read is a bounded Seq Scan (the outbox carries bloat from ~550k
  -- rows a day passing through it); the oldest read is an Index Scan using
  -- hand_projection_outbox_hand_number_key. ca_stats_health() as a whole was
  -- ~150 ms before this.
  livew AS (
    SELECT
      (SELECT count(*)::int FROM (
         SELECT 1 FROM public.hand_projection_outbox LIMIT 10001) z) AS depth,
      (SELECT o.created_at FROM public.hand_projection_outbox o
        ORDER BY o.hand_number LIMIT 1) AS oldest_at
  ),
  -- The compensator's cursor. ca_roll_hand_stats_forward (Open Claw, every 15
  -- minutes) rolls ca_hand_player_stat forward to now() and records where it
  -- got to. If this is stale the backfill is not running, which is a different
  -- incident from the live writer stalling.
  roll AS (
    SELECT rolled_ceil, complete, updated_at
    FROM public.ca_hand_player_stat_state WHERE id
  ),
  repair AS (
    SELECT done, cursor_at, ceiling_at, hands_seen, rows_changed, updated_at
    FROM public.ca_hand_player_stat_repair_state WHERE id
  ),
  seatfill AS (
    SELECT done, cursor_at, rows_added FROM public.ca_idx_every_seat_state WHERE id
  ),
  audit AS (
    SELECT ran_at, hands, button_disagree, showdown_disagree, hands_without_stat,
           player_hands_without_idx, human_player_hands, human_without_facts,
           allin_showdown_7d, allin_showdown_without_equity_7d, duration_ms
    FROM public.ca_stats_witness_audit_log
    ORDER BY ran_at DESC LIMIT 1
  )
  SELECT jsonb_build_object(
    'checkedAt',            now(),
    'indexCeil',            (SELECT idx_ceil FROM idx),
    'indexLagSeconds',      (SELECT extract(epoch FROM (now() - idx_ceil))::numeric(12,1) FROM idx),
    'indexBackfillComplete',(SELECT backfill_complete FROM idx),
    'indexRows',            (SELECT rows_indexed FROM idx),
    'recentHands',          (SELECT hands FROM recent),
    'recentHandsWithoutStat', (SELECT without_stat FROM recent),
    'liveWriter', (SELECT jsonb_build_object(
                     'pending', depth,
                     'depthCapped', depth >= 10001,
                     'oldestPendingAt', oldest_at,
                     'oldestPendingAgeSeconds',
                       CASE WHEN oldest_at IS NULL THEN 0
                            ELSE extract(epoch FROM (now() - oldest_at))::numeric(12,1) END)
                   FROM livew),
    'roll', (SELECT jsonb_build_object(
               'ceilAt', rolled_ceil,
               'complete', complete,
               'updatedAt', updated_at,
               'lagSeconds',
                 CASE WHEN rolled_ceil IS NULL THEN NULL
                      ELSE extract(epoch FROM (now() - rolled_ceil))::numeric(12,1) END)
             FROM roll),
    'repair', (SELECT jsonb_build_object(
                 'done', done, 'cursorAt', cursor_at, 'ceilingAt', ceiling_at,
                 'handsSeen', hands_seen, 'rowsChanged', rows_changed, 'updatedAt', updated_at)
               FROM repair),
    'seatBackfill', (SELECT jsonb_build_object('done', done, 'cursorAt', cursor_at, 'rowsAdded', rows_added)
                     FROM seatfill),
    'evCoverage7d', (SELECT jsonb_build_object(
                       'allInShowdowns', allin_showdown_7d,
                       'withoutEquity', allin_showdown_without_equity_7d,
                       'ratio', CASE WHEN allin_showdown_7d > 0
                                     THEN round((allin_showdown_7d - allin_showdown_without_equity_7d)::numeric
                                                / allin_showdown_7d, 4)
                                     ELSE NULL END)
                     FROM audit),
    'lastAudit', (SELECT jsonb_build_object(
                    'ranAt', ran_at, 'hands', hands,
                    'buttonDisagree', button_disagree,
                    'showdownDisagree', showdown_disagree,
                    'handsWithoutStat', hands_without_stat,
                    'playerHandsWithoutIdx', player_hands_without_idx,
                    'humanPlayerHands', human_player_hands,
                    'humanWithoutFacts', human_without_facts,
                    'durationMs', duration_ms)
                  FROM audit)
  );
$function$;

-- A CREATE OR REPLACE on this database hands EXECUTE to PUBLIC/authenticated by
-- default and the [autorevoke] event trigger does not strip `authenticated`
-- (20260906231557_a_trigger_function_is_not_a_browser_routine spells this out).
-- ca_stats_health() is engine telemetry - it returns fleet-wide hand counts and
-- writer cursors - so it is closed explicitly here rather than left to whatever
-- the replace happened to do. This restates the ACL production already has
-- (postgres + service_role), so it changes nothing live and cannot drift later.
-- PUBLIC is named as well as anon, because anon inherits whatever PUBLIC holds
-- and revoking anon alone reads as a fix while doing nothing.
REVOKE ALL ON FUNCTION public.ca_stats_health()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_stats_health() TO service_role;

-- Same reasoning for the trigger function, with no GRANT: firing a trigger does
-- not check EXECUTE on the trigger function, so it needs none, and a browser
-- role holding one is the inert-but-flagged grant 20260906231557 closed.
REVOKE ALL ON FUNCTION public.trg_ca_stats_live_from_hand()
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The legacy path can reach the positional projector.
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.fn_process_hand_position_stats(jsonb, jsonb, jsonb)
  TO service_role;

-- ---------------------------------------------------------------------------
-- VERIFY. The migration asserts its own assumptions and aborts if the board
-- moved underneath it (CLAUDE.md 10.9, rule 4).
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_health jsonb;
  v_attached int;
  v_secdef boolean;
BEGIN
  -- The trigger is still the trigger, and still SECURITY DEFINER.
  SELECT count(*) INTO v_attached
    FROM pg_trigger t
   WHERE t.tgfoid = 'public.trg_ca_stats_live_from_hand()'::regprocedure
     AND NOT t.tgisinternal
     AND t.tgrelid = 'public.hand_history'::regclass;
  IF v_attached <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED: trg_ca_stats_live_from_hand is attached to hand_history % times, expected 1', v_attached;
  END IF;
  SELECT p.prosecdef INTO v_secdef
    FROM pg_proc p WHERE p.oid = 'public.trg_ca_stats_live_from_hand()'::regprocedure;
  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'VERIFY FAILED: trg_ca_stats_live_from_hand is no longer SECURITY DEFINER';
  END IF;

  -- The bypass has a compensating writer, and it is reachable by the engine.
  IF NOT has_function_privilege('service_role',
        'public.fn_project_hand_side_effects(uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED: service_role cannot execute fn_project_hand_side_effects - the atomic path would have NO stats writer';
  END IF;

  -- The grant landed, and it landed on service_role only. A browser role here
  -- is the thing 20260906231557 exists to keep out.
  IF NOT has_function_privilege('service_role',
        'public.fn_process_hand_position_stats(jsonb,jsonb,jsonb)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the position-stats grant did not land';
  END IF;
  IF has_function_privilege('anon',
        'public.fn_process_hand_position_stats(jsonb,jsonb,jsonb)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated',
        'public.fn_process_hand_position_stats(jsonb,jsonb,jsonb)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED: a browser role holds EXECUTE on fn_process_hand_position_stats';
  END IF;

  -- No browser role can reach the telemetry read or the trigger function.
  IF has_function_privilege('anon', 'public.ca_stats_health()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ca_stats_health()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED: a browser role holds EXECUTE on ca_stats_health';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.ca_stats_health()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED: service_role cannot execute ca_stats_health - the engine monitor would go blind';
  END IF;
  IF has_function_privilege('anon', 'public.trg_ca_stats_live_from_hand()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trg_ca_stats_live_from_hand()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED: a browser role holds EXECUTE on trg_ca_stats_live_from_hand';
  END IF;

  -- The health read answers, and answers with the two new blocks.
  v_health := public.ca_stats_health();
  IF v_health IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED: ca_stats_health() returned NULL';
  END IF;
  IF NOT (v_health ? 'liveWriter') OR NOT (v_health ? 'roll') THEN
    RAISE EXCEPTION 'VERIFY FAILED: ca_stats_health() is missing liveWriter/roll: %', v_health;
  END IF;
  IF (v_health->'liveWriter'->>'pending') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED: ca_stats_health().liveWriter.pending is null';
  END IF;
  -- Every key the engine already reads must survive this replace.
  IF NOT (v_health ? 'recentHands' AND v_health ? 'recentHandsWithoutStat'
          AND v_health ? 'indexLagSeconds' AND v_health ? 'lastAudit'
          AND v_health ? 'evCoverage7d' AND v_health ? 'repair'
          AND v_health ? 'seatBackfill' AND v_health ? 'indexCeil'
          AND v_health ? 'indexRows' AND v_health ? 'indexBackfillComplete'
          AND v_health ? 'checkedAt') THEN
    RAISE EXCEPTION 'VERIFY FAILED: ca_stats_health() lost a key the engine reads: %',
      (SELECT jsonb_agg(k) FROM jsonb_object_keys(v_health) k);
  END IF;
END;
$verify$;

COMMIT;

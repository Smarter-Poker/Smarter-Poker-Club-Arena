-- 20260922144812_a_members_profit_is_each_hands_own_net
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-22 14:48:12 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- club_member_daily_stats.profit (the club dashboard's per-member, per-table,
-- per-day result) was never written as the result of a hand. Every writer
-- derived it from STACK DELTAS between consecutive hand_history rows at the
-- same table, and counted a delta only when a heuristic called it
-- "attributable":
--
--   fn_project_hand_side_effects_after_post_commit_20260908  (every hand)
--   ca_rebuild_table_chunk     (every 15 minutes, via ca_drain_club_rebuild,
--                               from Smarter-Poker-World-Hub
--                               pages/api/cron/club-stats-maintenance.js)
--   ca_rebuild_club_member_stats_table                       (manual)
--
-- hand_history.players[].stack is the END-of-hand stack (measured on table
-- a7542a93: the delta equals that hand's own net in 179 of 180 consecutive
-- pairs). So the first hand a player plays at a table has no prior stack, its
-- delta is 0, and its result is dropped; a top-up between hands is
-- misjudged. Every one of 9 players at that table had a daily profit wrong by
-- exactly that. Measured over today's finished tables: 111 of 119
-- member-table rows differ from the real result, 1,573.65 chips in total.
--
-- fn_reconcile_club_member_daily_profit exists to paper over it: it rewrites
-- completed days from player_stats snapshots, which are 00:05-to-00:05 and
-- spread across tables by hand count. pg_cron runs it nightly
-- (reconcile-club-member-daily-profit) and the World Hub route calls it every
-- 15 minutes (1,041 PostgREST calls). It corrected 2,541 rows for
-- 2026-09-21, 3,115 for 09-20 and 7,107 for 09-19.
--
-- WHAT THIS CHANGES
--
-- The exact result of a hand for a seat is known the moment the hand is
-- accepted: what the seat won (hand_history.winners) minus what it put in
-- (the accepted-hand envelope, hand_atomic_commits.post_commit_payload ->
-- 'promo_playthrough', one entry per contributor, written in the same
-- transaction as the hand). MEASURED over the last hour: 8,794 of 8,794 cash
-- hands conserve to the cent (sum of seat results + rake + jackpot drop = 0),
-- every contributor is a seated player (7,281 of 7,281 hands), and no
-- tournament hand carries a contributor list.
--
--   1. All three writers record profit = won - contributed for every hand
--      that carries the envelope. A hand without one (tournament, diamond,
--      or legacy history before envelopes existed) keeps the old
--      derivation, so nothing without the envelope is guessed at anew.
--      hands_attributed counts an exact hand as attributed.
--   2. fn_reconcile_club_member_daily_profit stops rewriting from the first
--      day that is exact end to end, 2026-09-23. It still measures and logs
--      every club-day (reason 'exact_at_source', applied false), so the
--      comparison it used to act on becomes a report.
--
-- Nothing else moves: hands_played, hands_won, total_won, biggest pots,
-- topup_total, club_member_table_state and club_hand_daily_shard are
-- untouched. No money path is involved; the projection reads the envelope
-- its own caller has just completed.
--
-- HOW: pg_temp.ca_patch, the sanctioned apply-time textual edit with an
-- exact-match-count assertion. Every marker was counted on the live bodies
-- before writing this (each exactly 1; none of the new names present).
--
-- @live-proof: (SELECT position('exact_net' in p.prosrc) > 0 AND position('v_promo' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_project_hand_side_effects_after_post_commit_20260908')
-- @live-proof: (SELECT position('exact_net' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'ca_rebuild_table_chunk')
-- @live-proof: (SELECT position('exact_net' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'ca_rebuild_club_member_stats_table')
-- @live-proof: (SELECT position('exact_at_source' in p.prosrc) > 0 AND position('p_date < v_exact_from' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_reconcile_club_member_daily_profit')
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE FUNCTION pg_temp.ca_patch(p_fn text, p_from text, p_to text, p_expected integer DEFAULT 1)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_def text; v_n integer; v_procs integer;
BEGIN
  SELECT count(*) INTO v_procs FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fn;
  IF v_procs <> 1 THEN
    RAISE EXCEPTION 'ca_patch: % has % overloads in public (expected exactly 1)', p_fn, v_procs;
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fn;
  v_n := (length(v_def) - length(replace(v_def, p_from, ''))) / length(p_from);
  IF v_n <> p_expected THEN
    RAISE EXCEPTION 'ca_patch: marker in % found % times, expected %: %', p_fn, v_n, p_expected, left(p_from, 120);
  END IF;
  EXECUTE replace(v_def, p_from, p_to);
END $$;

-- ---------------------------------------------------------------------------
-- 1. THE LIVE PROJECTION (every accepted hand)
-- ---------------------------------------------------------------------------

SELECT pg_temp.ca_patch('fn_project_hand_side_effects_after_post_commit_20260908',
$w1a$  v_diamond boolean;
BEGIN
$w1a$,
$w1b$  v_diamond boolean;
  v_promo jsonb;
BEGIN
$w1b$);

-- Read the contributor list once. It is normalised here, in plpgsql, so that
-- no SQL expression below ever asks the length of something that is not an
-- array: only a non-empty array survives, anything else is NULL.
SELECT pg_temp.ca_patch('fn_project_hand_side_effects_after_post_commit_20260908',
$w2a$  v_date := (v_h.created_at AT TIME ZONE 'UTC')::date;
$w2a$,
$w2b$  v_date := (v_h.created_at AT TIME ZONE 'UTC')::date;

  -- A seat's result for THIS hand is what it won minus what it put in. The
  -- accepted-hand envelope lists every contributor's chips in, written in the
  -- same transaction as the hand. No envelope list, no exact figure.
  SELECT c.post_commit_payload->'promo_playthrough' INTO v_promo
    FROM public.hand_atomic_commits c
   WHERE c.hand_id = v_h.id;
  IF jsonb_typeof(v_promo) IS DISTINCT FROM 'array' THEN
    v_promo := NULL;
  ELSIF v_promo = '[]'::jsonb THEN
    v_promo := NULL;
  END IF;
$w2b$);

SELECT pg_temp.ca_patch('fn_project_hand_side_effects_after_post_commit_20260908',
$w3a$                  ELSE b.adjacent AND (b.stack-b.last_stack)<=b.won+0.001 END AS attributable
        FROM base b CROSS JOIN agg a
$w3a$,
$w3b$                  ELSE b.adjacent AND (b.stack-b.last_stack)<=b.won+0.001 END AS attributable,
             CASE WHEN v_promo IS NOT NULL
                  THEN b.won - COALESCE((SELECT sum((x->>'wagered')::numeric)
                                           FROM jsonb_array_elements(v_promo) x
                                          WHERE lower(x->>'user_id') = b.uid::text), 0)
             END AS exact_net
        FROM base b CROSS JOIN agg a
$w3b$);

SELECT pg_temp.ca_patch('fn_project_hand_side_effects_after_post_commit_20260908',
$w4a$           CASE WHEN v_tourney THEN 0 WHEN calc.attributable THEN 1 ELSE 0 END,
$w4a$,
$w4b$           CASE WHEN v_tourney THEN 0 WHEN calc.exact_net IS NOT NULL OR calc.attributable THEN 1 ELSE 0 END,
$w4b$);

SELECT pg_temp.ca_patch('fn_project_hand_side_effects_after_post_commit_20260908',
$w5a$           CASE WHEN v_tourney THEN 0 WHEN calc.attributable THEN calc.delta ELSE 0 END,
$w5a$,
$w5b$           CASE WHEN v_tourney THEN 0 WHEN calc.exact_net IS NOT NULL THEN calc.exact_net
                WHEN calc.attributable THEN calc.delta ELSE 0 END,
$w5b$);

-- ---------------------------------------------------------------------------
-- 2. THE CHUNKED REBUILD (ca_drain_club_rebuild, every 15 minutes)
-- ---------------------------------------------------------------------------

SELECT pg_temp.ca_patch('ca_rebuild_table_chunk',
$r1a$              WHERE w->>'userId' = pl->>'userId'), 0) AS won
  FROM seq s
$r1a$,
$r1b$              WHERE w->>'userId' = pl->>'userId'), 0) AS won,
    (SELECT CASE WHEN jsonb_typeof(hac.post_commit_payload->'promo_playthrough') = 'array'
                 THEN CASE WHEN hac.post_commit_payload->'promo_playthrough' <> '[]'::jsonb
                           THEN COALESCE((SELECT sum((x->>'wagered')::numeric)
                                            FROM jsonb_array_elements(hac.post_commit_payload->'promo_playthrough') x
                                           WHERE lower(x->>'user_id') = lower(pl->>'userId')), 0)
                      END
            END
       FROM hand_atomic_commits hac
      WHERE hac.hand_id = s.id) AS wagered
  FROM seq s
$r1b$);

SELECT pg_temp.ca_patch('ca_rebuild_table_chunk',
$r2a$           m.won, m.pot_size, m.delta,
$r2a$,
$r2b$           m.won, m.pot_size, m.delta,
           m.won - m.wagered AS exact_net,
$r2b$);

SELECT pg_temp.ca_patch('ca_rebuild_table_chunk',
$r3a$    count(*) FILTER (WHERE attributable),
    count(*) FILTER (WHERE won > 0),
    sum(won),
    coalesce(sum(delta) FILTER (WHERE attributable), 0),
$r3a$,
$r3b$    count(*) FILTER (WHERE exact_net IS NOT NULL OR attributable),
    count(*) FILTER (WHERE won > 0),
    sum(won),
    coalesce(sum(CASE WHEN exact_net IS NOT NULL THEN exact_net
                      WHEN attributable THEN delta ELSE 0 END), 0),
$r3b$);

-- ---------------------------------------------------------------------------
-- 3. THE WHOLE-TABLE REBUILD (manual)
-- ---------------------------------------------------------------------------

SELECT pg_temp.ca_patch('ca_rebuild_club_member_stats_table',
$t1a$    SELECT hh.hand_number, hh.created_at, coalesce(hh.pot_size, 0) AS pot_size,
$t1a$,
$t1b$    SELECT hh.id AS hand_id, hh.hand_number, hh.created_at, coalesce(hh.pot_size, 0) AS pot_size,
$t1b$);

SELECT pg_temp.ca_patch('ca_rebuild_club_member_stats_table',
$t2a$                WHERE w->>'userId' = p->>'userId'), 0) AS won
    FROM hseq h
$t2a$,
$t2b$                WHERE w->>'userId' = p->>'userId'), 0) AS won,
      (SELECT CASE WHEN jsonb_typeof(hac.post_commit_payload->'promo_playthrough') = 'array'
                   THEN CASE WHEN hac.post_commit_payload->'promo_playthrough' <> '[]'::jsonb
                             THEN COALESCE((SELECT sum((x->>'wagered')::numeric)
                                              FROM jsonb_array_elements(hac.post_commit_payload->'promo_playthrough') x
                                             WHERE lower(x->>'user_id') = lower(p->>'userId')), 0)
                        END
              END
         FROM hand_atomic_commits hac
        WHERE hac.hand_id = h.hand_id) AS wagered
    FROM hseq h
$t2b$);

SELECT pg_temp.ca_patch('ca_rebuild_club_member_stats_table',
$t3a$      m.won, m.pot_size, m.delta,
$t3a$,
$t3b$      m.won, m.pot_size, m.delta,
      m.won - m.wagered AS exact_net,
$t3b$);

SELECT pg_temp.ca_patch('ca_rebuild_club_member_stats_table',
$t4a$    count(*) FILTER (WHERE attributable),
    count(*) FILTER (WHERE won > 0),
    sum(won),
    coalesce(sum(delta) FILTER (WHERE attributable), 0),
$t4a$,
$t4b$    count(*) FILTER (WHERE exact_net IS NOT NULL OR attributable),
    count(*) FILTER (WHERE won > 0),
    sum(won),
    coalesce(sum(CASE WHEN exact_net IS NOT NULL THEN exact_net
                      WHEN attributable THEN delta ELSE 0 END), 0),
$t4b$);

-- ---------------------------------------------------------------------------
-- 4. THE RECONCILER RECORDS A DAY THAT IS EXACT; IT NO LONGER REWRITES IT
-- ---------------------------------------------------------------------------

SELECT pg_temp.ca_patch('fn_reconcile_club_member_daily_profit',
$c1a$  v_cutover  date := DATE '2026-08-20';
$c1a$,
$c1b$  v_cutover  date := DATE '2026-08-20';
  -- The first day every writer records each hand's own net
  -- (20260922144812). From it there is nothing to correct: the day is
  -- measured and logged, never rewritten.
  v_exact_from date := DATE '2026-09-23';
$c1b$);

SELECT pg_temp.ca_patch('fn_reconcile_club_member_daily_profit',
$c2a$    IF (v_check ->> 'conserves')::boolean THEN
$c2a$,
$c2b$    IF (v_check ->> 'conserves')::boolean AND p_date < v_exact_from THEN
$c2b$);

SELECT pg_temp.ca_patch('fn_reconcile_club_member_daily_profit',
$c3a$            (v_check ->> 'tolerance')::numeric,
            (v_check ->> 'conserves')::boolean,
            CASE WHEN (v_check ->> 'conserves')::boolean THEN 'conserves'
$c3a$,
$c3b$            (v_check ->> 'tolerance')::numeric,
            (v_check ->> 'conserves')::boolean AND p_date < v_exact_from,
            CASE WHEN p_date >= v_exact_from THEN 'exact_at_source'
                 WHEN (v_check ->> 'conserves')::boolean THEN 'conserves'
$c3b$);

-- ---------------------------------------------------------------------------
-- VERIFY, both directions
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_src     text;
  v_hands   integer;
  v_broken  integer;
  v_outside integer;
BEGIN
  -- 1. The new behaviour is in every writer.
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_project_hand_side_effects_after_post_commit_20260908';
  IF position('WHEN calc.exact_net IS NOT NULL THEN calc.exact_net' in v_src) = 0
     OR position('ELSIF v_promo = ''[]''::jsonb THEN' in v_src) = 0 THEN
    RAISE EXCEPTION 'the live projection does not record the exact net';
  END IF;
  -- THE OTHER DIRECTION: a hand without an envelope keeps its old figure,
  -- it is not silently zeroed.
  IF position('WHEN calc.attributable THEN calc.delta ELSE 0 END' in v_src) = 0 THEN
    RAISE EXCEPTION 'the live projection lost its fallback for hands without an envelope';
  END IF;

  FOREACH v_src IN ARRAY ARRAY['ca_rebuild_table_chunk', 'ca_rebuild_club_member_stats_table'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = v_src
                      AND position('WHEN exact_net IS NOT NULL THEN exact_net' in p.prosrc) > 0
                      AND position('WHEN attributable THEN delta ELSE 0 END' in p.prosrc) > 0
                      AND position('coalesce(sum(delta) FILTER (WHERE attributable), 0)' in p.prosrc) = 0) THEN
      RAISE EXCEPTION '% does not record the exact net with its fallback', v_src;
    END IF;
  END LOOP;

  -- 2. The reconciler stands down only where the source is exact, and keeps
  --    its guarded correction for the days before.
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_reconcile_club_member_daily_profit';
  IF position('IF (v_check ->> ''conserves'')::boolean AND p_date < v_exact_from THEN' in v_src) = 0
     OR position('THEN ''exact_at_source''' in v_src) = 0
     OR position('v_exact_from date := DATE ''2026-09-23''' in v_src) = 0 THEN
    RAISE EXCEPTION 'the reconciler does not stand down for exact days';
  END IF;
  IF position('IS DISTINCT FROM (f.share' in v_src) = 0 OR position('SET profit = f.share' in v_src) = 0 THEN
    RAISE EXCEPTION 'the reconciler lost its guarded correction for the days before 2026-09-23';
  END IF;

  -- 3. The data the new figure rests on, read on live hands: every cash hand
  --    with a contributor list conserves to the cent, and every contributor
  --    is a seated player (the projection writes one row per seated player).
  SELECT count(*),
         count(*) FILTER (WHERE abs(z.net + z.cut) > 0.005),
         sum(z.outside)
    INTO v_hands, v_broken, v_outside
    FROM (
      SELECT coalesce(h.rake_amount, 0) + coalesce(h.bbj_amount, 0) AS cut,
             (SELECT coalesce(sum((w->>'amount')::numeric), 0)
                FROM jsonb_array_elements(coalesce(h.winners, '[]'::jsonb)) w)
           - (SELECT coalesce(sum((x->>'wagered')::numeric), 0)
                FROM jsonb_array_elements(c.post_commit_payload->'promo_playthrough') x) AS net,
             (SELECT count(*)
                FROM jsonb_array_elements(c.post_commit_payload->'promo_playthrough') x
               WHERE NOT EXISTS (
                 SELECT 1 FROM jsonb_array_elements(coalesce(h.players, '[]'::jsonb)) pl
                  WHERE lower(pl->>'userId') = lower(x->>'user_id')
                    AND pl->>'stack' IS NOT NULL)) AS outside
        FROM public.hand_history h
        JOIN public.hand_atomic_commits c ON c.hand_id = h.id
       WHERE h.created_at > now() - interval '30 minutes'
         AND jsonb_typeof(c.post_commit_payload->'promo_playthrough') = 'array'
         AND c.post_commit_payload->'promo_playthrough' <> '[]'::jsonb
    ) z;
  IF v_hands = 0 THEN
    RAISE EXCEPTION 'no cash hand with a contributor list in 30 minutes: the proof would say nothing';
  END IF;
  IF v_broken > 0 OR v_outside > 0 THEN
    RAISE EXCEPTION '% of % hands do not conserve, % contributors are not seated', v_broken, v_hands, v_outside;
  END IF;
  RAISE NOTICE 'exact net verified on % live cash hands', v_hands;
END
$verify$;

COMMIT;

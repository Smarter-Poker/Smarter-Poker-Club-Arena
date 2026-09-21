-- A hand that ended preflop has no board to record.
--
-- WHAT WAS WRONG. fn_rake_law_violations decides a cash hand's board is
-- MISSING from the record with this test:
--
--     board_n = 0 AND (has_showdown OR agg >= 4)
--
-- where agg counts every action in ('call','raise','bet','allin','all-in').
-- The second disjunct is a PROXY for "a flop must have been dealt", and it is
-- simply not one. Four calls and raises before the flop is an ordinary
-- multiway preflop pot: a limp, a raise, two calls, a three-bet and the hand
-- is already over the threshold without a single card on the table. So the
-- check reported "the board was not recorded" for hands that correctly had no
-- board, because nobody ever saw a flop.
--
-- MEASURED, on every row this finding has ever produced. The stream began
-- 2026-09-19 15:37:37Z (before that the writer's NULL hit a NOT NULL column
-- and no rake_law row could be written at all - 20260919153843) and by
-- 2026-09-21 02:00Z it had filed 61 hands. Of those 61:
--
--     took rake .................... 0
--     took a BBJ drop .............. 0
--     reached a showdown ........... 0
--     had ANY post-flop action ..... 0
--
-- Every one ended preflop, and every one correctly took nothing. The rate was
-- steady at one to three an hour against ~5,000 cash hands an hour, so this
-- was not a burst - it was the check's normal output.
--
-- WHY IT MATTERED, because "a warning nobody should act on" understates it.
-- The board caps a source at 25 open incidents and then diverts the rest into
-- a single DETECTOR STORM row. ledger_reconcile_log:board_not_recorded reached
-- that cap: 15 individual rows plus a storm row that had swallowed 28 more
-- findings. A true over-rake filed by this same source would have landed in
-- that storm row and been read as more of the same. A false positive that
-- reaches the storm cap is not noise, it is a place for a real finding to hide.
--
-- THE FIX IS AT THE CAUSE, not a filter over the output and not a job that
-- closes the rows afterwards (CLAUDE.md 10.11, 10.12). Every action the engine
-- writes already carries the street it happened on - "stage":"preflop" on the
-- action, and "street" on its captured publicNode. The check had the fact it
-- needed in the record it was already reading, and consulted a head-count
-- instead. So the proxy is replaced by the record:
--
--     played_past_preflop  - some action names flop, turn or river
--     streets_unreadable   - the hand HAS actions and not one of them names a
--                            stage at all
--
-- and the finding becomes
--
--     board_n = 0 AND (has_showdown OR played_past_preflop OR streets_unreadable)
--
-- streets_unreadable is deliberate and is the third outcome law 10.86 rule 1
-- demands: a record whose streets cannot be read is NOT quietly passed as
-- "ended preflop", it is reported as the evidence gap this finding is named
-- for. Absence of stage is not absence of a flop.
--
-- BOTH GENUINE DETECTIONS SURVIVE. A showdown with no board is still a
-- finding (no variant here can show down on an empty board), and play that
-- continued past preflop with no board recorded is still a finding - that one
-- is now detected from the record rather than guessed at from a count.
--
-- NOT VACUOUS, which is the other way to get this wrong (10.84: an empty alert
-- group reads as coverage). Measured over the 26,243 cash hands dealt in the
-- six hours to 2026-09-21 02:30Z: 9,662 hands are detected as played past
-- preflop, every one of them with a board of three cards or more, and 14 hands
-- carry a board with no post-flop action - preflop all-ins that ran out, which
-- is correct and is why has_showdown stays a separate disjunct. Over the same
-- window the old rule flagged 4 hands and the new rule flags 0.
--
-- agg is removed rather than left unused: it was a jsonb scan of every action
-- of every cash hand in the window, and this was its only reader.
--
-- This migration carries DDL, so it is refused inside the :50-:03 break window
-- and it reloads the PostgREST schema cache once. It is one transaction.
--
-- @live-proof: (SELECT count(*) FROM public.fn_rake_law_violations('6 hours'::interval) WHERE kind = 'board_not_recorded' AND NOT EXISTS (SELECT 1 FROM public.hand_history x WHERE x.id = hand_id AND (x.showdown IS NOT NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(x.actions,'[]'::jsonb)) a WHERE lower(COALESCE(a->>'stage','')) IN ('flop','turn','river'))))) = 0
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '170s';

DO $refuse_unexpected_source$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('public.fn_rake_law_violations(interval)')
      AND md5(pg_get_functiondef(p.oid)) = '14112cd4618e295336bf78954e77fe53'
      AND pg_get_userbyid(p.proowner) = 'postgres'
      AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
  ) THEN
    RAISE EXCEPTION 'refusing: fn_rake_law_violations is not the definition this fix was written against';
  END IF;
END;
$refuse_unexpected_source$;

CREATE OR REPLACE FUNCTION public.fn_rake_law_violations(p_window interval DEFAULT '01:00:00'::interval)
 RETURNS TABLE(kind text, hand_id uuid, table_id uuid, occurred_at timestamp with time zone, small_blind numeric, big_blind numeric, pot numeric, rake numeric, allowed numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH h AS (
    SELECT hh.id, hh.table_id, hh.created_at,
           COALESCE(hh.rake_amount, 0) AS rake,
           COALESCE(rr.bbj_contribution, hh.bbj_amount, 0) AS bbj,
           hh.pot_size AS pot,
           t.small_blind AS sb, t.big_blind AS bb, t.club_id, t.id AS tid,
           t.max_players AS seats,
           lower(COALESCE(hh.game_variant, t.game_variant::text)) AS variant,
           COALESCE(rr.num_players, jsonb_array_length(CASE WHEN jsonb_typeof(hh.players) = 'array' THEN hh.players END)) AS dealt,
           COALESCE(array_length(hh.community_cards, 1), 0)
             + COALESCE(array_length(hh.community_cards2, 1), 0) AS board_n,
           hh.showdown IS NOT NULL AS has_showdown,
           /* The record says which street each action happened on. Read it,
              rather than guessing a flop from how many people put chips in:
              an ordinary multiway preflop pot clears any such count. */
           EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(hh.actions, '[]'::jsonb)) a
                    WHERE lower(COALESCE(a->>'stage', '')) IN ('flop','turn','river')
                       OR lower(COALESCE(a->'publicNode'->>'street', '')) IN ('flop','turn','river'))
             AS played_past_preflop,
           /* "I cannot tell" is its own outcome and must not be filed as
              "ended preflop": a hand with actions, none of which names a
              stage, is an unreadable record and stays a finding. */
           (jsonb_array_length(COALESCE(hh.actions, '[]'::jsonb)) > 0
             AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(hh.actions, '[]'::jsonb)) a
                              WHERE NULLIF(btrim(COALESCE(a->>'stage', '')), '') IS NOT NULL))
             AS streets_unreadable,
           CASE WHEN t.rake_percent >= 0 THEN t.rake_percent
                WHEN c.default_rake_percent >= 0 THEN c.default_rake_percent END AS ov_pct,
           CASE WHEN t.rake_cap_bb >= 0 THEN t.rake_cap_bb
                WHEN c.rake_cap >= 0 THEN c.rake_cap END AS ov_cap_bb,
           c.bbj_rake_enabled
      FROM public.hand_history hh
      JOIN public.tables t ON t.id = hh.table_id
      LEFT JOIN public.clubs c ON c.id = t.club_id
      LEFT JOIN public.rake_records rr ON rr.hand_id = hh.id
     WHERE hh.created_at > now() - p_window
       AND hh.created_at < now() - interval '5 minutes'
       AND t.tournament_id IS NULL
       AND hh.tournament_id IS NULL
  ), f AS (
    SELECT h.*, e.rake AS exp_rake
      FROM h
      CROSS JOIN LATERAL public.fn_effective_rake(h.bb, h.pot, h.dealt, true, h.sb, h.ov_pct, h.ov_cap_bb, h.seats) e
     WHERE h.board_n >= 3 AND h.dealt IS NOT NULL
  ), fb AS (
    SELECT f.*, public.fn_effective_bbj_drop(f.bb, f.dealt, true, f.club_id, f.tid, f.variant, f.sb, f.pot, f.rake) AS exp_bbj
      FROM f
  ), h0 AS (
    SELECT hh.id, hh.table_id, hh.created_at, hh.pot_size AS pot,
           t.small_blind AS sb, t.big_blind AS bb
      FROM public.hand_history hh
      JOIN public.tables t ON t.id = hh.table_id
     WHERE hh.created_at > now() - p_window
       AND hh.created_at < now() - interval '5 minutes'
       AND t.tournament_id IS NULL
       AND COALESCE(hh.rake_amount, 0) = 0
       AND hh.showdown IS NOT NULL
       AND COALESCE(array_length(hh.community_cards, 1), 0)
             + COALESCE(array_length(hh.community_cards2, 1), 0) < 3
  )
  SELECT 'over_spec', id, table_id, created_at, sb, bb, pot, rake, exp_rake
    FROM fb WHERE rake > exp_rake + 0.005
  UNION ALL
  SELECT 'under_spec', id, table_id, created_at, sb, bb, pot, rake, exp_rake
    FROM fb WHERE rake < exp_rake - 0.005
  UNION ALL
  SELECT 'bbj_over_spec', id, table_id, created_at, sb, bb, pot, bbj, exp_bbj
    FROM fb WHERE bbj > exp_bbj + 0.005
  UNION ALL
  SELECT 'bbj_under_spec', id, table_id, created_at, sb, bb, pot, bbj, exp_bbj
    FROM fb WHERE bbj < exp_bbj - 0.005
  UNION ALL
  SELECT 'no_flop_no_drop', id, table_id, created_at, sb, bb, pot, rake, 0::numeric
    FROM h WHERE board_n = 0 AND NOT has_showdown AND rake + bbj > 0.005
  UNION ALL
  SELECT 'board_not_recorded', id, table_id, created_at, sb, bb, pot, rake, NULL::numeric
    FROM h WHERE board_n = 0 AND (has_showdown OR played_past_preflop OR streets_unreadable)
  UNION ALL
  SELECT 'impossible_showdown', id, table_id, created_at, sb, bb, pot, 0::numeric, NULL::numeric
    FROM h0
  UNION ALL
  SELECT 'players_not_recorded', id, table_id, created_at, sb, bb, pot, rake, NULL::numeric
    FROM h WHERE dealt IS NULL AND board_n >= 3
  UNION ALL
  SELECT 'bbj_club_switch_ignored', id, table_id, created_at, sb, bb, pot, bbj, 0::numeric
    FROM h WHERE bbj_rake_enabled IS FALSE AND bbj > 0.005;
$function$;

DO $prove_it$
DECLARE
  v_regress bigint;
BEGIN
  /* 1. Every hand this finding has already filed must stop flagging - and
        must stop because it ended preflop, not because the rule went blind. */
  SELECT count(*) INTO v_regress
    FROM (SELECT DISTINCT (l.metadata->>'hand_id')::uuid AS hid
            FROM public.ledger_reconcile_log l
           WHERE l.entity_type = 'rake_law'
             AND l.metadata->>'kind' = 'board_not_recorded') q
    JOIN public.hand_history hh ON hh.id = q.hid
   WHERE hh.showdown IS NOT NULL
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(hh.actions, '[]'::jsonb)) a
                  WHERE lower(COALESCE(a->>'stage', '')) IN ('flop','turn','river')
                     OR lower(COALESCE(a->'publicNode'->>'street', '')) IN ('flop','turn','river'))
      OR (jsonb_array_length(COALESCE(hh.actions, '[]'::jsonb)) > 0
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(hh.actions, '[]'::jsonb)) a
                           WHERE NULLIF(btrim(COALESCE(a->>'stage', '')), '') IS NOT NULL));
  IF v_regress <> 0 THEN
    RAISE EXCEPTION 'refusing: % already-filed board_not_recorded hands would still flag, so they are not all preflop-only and this is not the whole cause', v_regress;
  END IF;

  /* 2. And the new rule must be able to see a flop at all. A finding that can
        never fire is not a fixed finding, it is a deleted one. */
  IF NOT EXISTS (
    SELECT 1 FROM public.hand_history hh
     JOIN public.tables t ON t.id = hh.table_id
    WHERE hh.created_at > now() - interval '3 hours'
      AND t.tournament_id IS NULL AND hh.tournament_id IS NULL
      AND COALESCE(array_length(hh.community_cards, 1), 0) >= 3
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(hh.actions, '[]'::jsonb)) a
                   WHERE lower(COALESCE(a->>'stage', '')) IN ('flop','turn','river'))
  ) THEN
    RAISE EXCEPTION 'refusing: no cash hand in the last three hours reads as played past preflop, so this rule cannot detect a flop and would silence the finding rather than correct it';
  END IF;

  RAISE NOTICE 'board_not_recorded now reads the street off the record; both proofs passed';
END;
$prove_it$;
COMMIT;

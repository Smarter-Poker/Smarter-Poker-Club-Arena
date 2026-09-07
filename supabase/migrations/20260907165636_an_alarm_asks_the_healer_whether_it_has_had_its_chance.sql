-- ═══════════════════════════════════════════════════════════════════════════
--  AN ALARM ASKS THE HEALER WHETHER IT HAS HAD ITS CHANCE
--  BBJ build plan phase 5.5 (docs/BBJ-BUILD-PLAN.md)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `fn_rake_bbj_audit` has raised **24 CRITICAL money alerts in seven days**,
-- 2026-08-31 to 2026-09-07, between one and twenty violations each. Every one
-- of them was `I7_raked_hand_never_banked` and nothing else. Every one of them
-- was wrong.
--
-- Six hands were pulled from the two most recent alerts and followed. All six
-- have a `rake_records` row, source `atomic_distribute_rake`:
--
--   hand      rake   settled at   banked at   delay
--   ────────────────────────────────────────────────
--   7120595   1.50   19:01:40     19:52:00    50.3m
--   7120815   1.30   19:01:42     19:52:00    50.3m
--   7120518   7.50   19:01:42     19:52:00    50.3m
--   7120723   7.50   19:01:42     19:52:00    50.3m
--   7120486   1.35   19:01:42     19:52:00    50.3m
--   7362461   7.50   04:20:00     04:52:00    32.0m
--
-- Banked at **:52:00**, every one. That is `rake-repair-unbanked-hourly`
-- (jobid 268, schedule `52 * * * *`) doing exactly its job.
--
-- THE ARITHMETIC OF A FALSE ALARM. `fn_rake_bbj_invariants` gave the healer
-- fifteen minutes:
--
--   v_heal_grace timestamptz := now() - interval '15 minutes';
--
-- and the comment above that line reads: "Self-healing checks: must outlast the
-- healers' own grace + a cycle, or the alarm reports the net's patience as a
-- failure." The comment is right. The number is wrong. The audit runs at `:38`;
-- its healer runs at `:52`. **Every hand that failed to bank between the last
-- repair at :52 and the audit's cutoff at :23 - thirty-one minutes of every
-- hour - was reported as a critical money violation and then quietly banked
-- fourteen minutes later.**
--
-- The BBJ half of the same function never fired once, because ITS healer
-- (`ca-bbj-repair-unbanked-15m`) runs every fifteen minutes and fits inside the
-- same constant. One grace, two healers, two cadences: the constant was sized
-- for the fast one and applied to the slow one.
--
-- CLAUDE.md 10.84: "an alarm that is always on is an alarm that gets muted."
-- This one has been on, at CRITICAL, hourly, for a week - on the same channel
-- that would carry a genuine missing-rake incident.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS CHANGES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. **The alarm asks, instead of guessing.** `v_heal_grace` is no longer a
--    literal. Each self-healing check reads ITS OWN healer's last successful
--    completion out of `cron.job_run_details` and flags only hands that healer
--    has actually seen and failed to fix. If the schedule changes tomorrow the
--    alarm follows it, because it is reading the schedule rather than
--    remembering a number somebody measured against it once. (CLAUDE.md 1.1.7:
--    derive from the box, never from a literal.)
--
--    Minus ten minutes, because each healer skips hands younger than five
--    minutes of its own accord - a hand the healer deliberately passed over is
--    not a hand it failed on - plus five minutes of margin.
--
-- 2. **"I could not tell" is not "healed".** If `cron.job_run_details` cannot
--    be read, or the healer has never run, the grace falls back to two hours -
--    older than any healer cadence here, so the check cannot false-alarm - and
--    `grace_source` in the detail says `fallback` rather than pretending to a
--    precision it does not have (10.86 rule 1). A healer that has genuinely
--    stopped still gets reported, one audit cycle later.
--
-- 3. **The slow healer stops being slow.** `rake-repair-unbanked-hourly` moves
--    from `52 * * * *` to `2,17,32,47 * * * *` - the same fifteen-minute cadence
--    its BBJ sibling has always had. Worst-case time between a hand losing its
--    rake and the net catching it drops from 60 minutes to 15. The offsets keep
--    every run clear of the :55-:00 maintenance freeze, where `zz_freeze_guard`
--    would refuse the write anyway (CLAUDE.md section 13), and clear of the
--    audit at :38 so the audit always reads a healer that ran six minutes ago.
--
-- Verified after applying: both checks report `grace_source: cron` with a
-- `grace_until` taken from the healers' real last runs (16:35:02 and 16:42:01),
-- and both return zero violations.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS DOES **NOT** FIX, stated plainly (CLAUDE.md 10.11)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The false alarm is fixed at its cause. The thing it was falsely alarming
-- ABOUT is real and is NOT fixed here, and this header is the record of it.
--
-- Measured over 36 hours: **74 hands, 172.99 chips of rake** were banked by the
-- hourly repairer rather than by the engine - about 49 hands and 115 chips a
-- day. For every one of those hands, `hand_history` was written and then
-- NOTHING after it: no `rake_records`, no `bbj_contributions`, and no
-- `pending_fee_distributions` claim either. The engine does not fail the rake
-- step, it never reaches it. Confirmed on all six sampled hands - their BBJ
-- contribution rows also carry `:52:00`, so post-hand step 8c did not run
-- either.
--
-- No chips are destroyed: the repairer banks every one. What IS destroyed is
-- the per-player attribution. `fn_rake_repair_unbanked` calls
-- `atomic_distribute_rake` with `p_contributions => NULL`, because nothing on
-- disk holds the eligible-contribution map once the engine is gone -
-- `hand_history` carries `players` and `pots` and no per-player contribution.
-- All six sampled hands have zero `rake_attributions` rows. So roughly 115
-- chips of rake basis a day earns nobody VIP points, agent commission or
-- rakeback, and the repair function's own alert says so in as many words:
-- "Attribution not invented: contributions were lost with the engine."
--
-- It is NOT invented here either (10.9 test 1: read, do not assume; and a
-- reconstruction that disagrees with the witness is wrong). The two candidate
-- fixes both cost something real and the choice is Dan's:
--
--   (a) Write-ahead the `pending_fee_distributions` claim BEFORE the first
--       `atomic_distribute_rake` attempt, the way phase 2.1 already does for
--       jackpot payouts, and resolve it on success. Complete fix - the map
--       survives the engine. Costs one insert and one update per raked hand:
--       ~103,000 extra round trips a day on 51,733 raked hands, on an engine
--       that is ONE core and where horse Monte Carlo is already 90% of it.
--       That is the same trade phase 4.1 REFUSED for the drill claim, and
--       refusing it there and taking it here would need saying out loud.
--   (b) Carry the contribution map on the `hand_history` row that is already
--       being written at step 8a. Zero extra round trips; costs a jsonb column
--       on a 3.6 GB table taking 221,000 rows a day (~4% more growth), and the
--       repairer can then attribute properly.
--
-- Recommendation: (b). It puts the map where the witness already is, and the
-- storage is bounded by the retention policy that already prunes horse-only
-- hands at seven days.
--
-- ROLLBACK: the previous definition of fn_rake_bbj_invariants is in the
-- migration that introduced I7; the schedule is
-- `SELECT cron.alter_job(268, schedule => '52 * * * *');`

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_rake_bbj_invariants(p_hours integer DEFAULT 2)
RETURNS TABLE(check_name text, violations bigint, detail jsonb)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_since timestamptz := now() - make_interval(hours => GREATEST(COALESCE(p_hours, 2), 1));
  -- Rule checks: settlement is not instant, but nothing heals a broken rule.
  v_grace timestamptz := now() - interval '5 minutes';
  /* Self-healing checks: ASK the healer when it last ran instead of guessing.
     A hand the healer has not yet seen is not a hand the healer failed on, and
     a fifteen-minute literal against an hourly healer is what turned this
     check into 24 critical false alarms in a week. */
  v_bbj_heal   timestamptz;
  v_rake_heal  timestamptz;
  v_bbj_src    text := 'cron';
  v_rake_src   text := 'cron';
  v_min_dealt integer;
  v_inelig text[];
BEGIN
  SELECT r.bbj_min_players_dealt, r.bbj_ineligible_variants INTO v_min_dealt, v_inelig
    FROM public.ca_rake_rules r WHERE r.id = 1;

  BEGIN
    SELECT max(d.end_time) INTO v_bbj_heal
      FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
     WHERE j.jobname = 'ca-bbj-repair-unbanked-15m' AND d.status = 'succeeded';
    SELECT max(d.end_time) INTO v_rake_heal
      FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
     WHERE j.jobname = 'rake-repair-unbanked-hourly' AND d.status = 'succeeded';
  EXCEPTION WHEN OTHERS THEN
    v_bbj_heal := NULL; v_rake_heal := NULL;
  END;

  /* Each healer skips hands younger than five minutes of its own accord, so
     subtract that plus five minutes of margin. A NULL - unreadable, or a
     healer that has never run - is "I could not tell", and the safe answer to
     that is a window older than any cadence here rather than a guess. */
  IF v_bbj_heal IS NULL THEN
    v_bbj_heal := now() - interval '2 hours'; v_bbj_src := 'fallback';
  ELSE
    v_bbj_heal := v_bbj_heal - interval '10 minutes';
  END IF;
  IF v_rake_heal IS NULL THEN
    v_rake_heal := now() - interval '2 hours'; v_rake_src := 'fallback';
  ELSE
    v_rake_heal := v_rake_heal - interval '10 minutes';
  END IF;

  RETURN QUERY
  WITH scope AS (
    SELECT r.hand_id, r.rake_amount, COALESCE(r.bbj_contribution, 0) AS bbj,
           r.pot_size, r.num_players, r.rake_method, r.player_contributions,
           r.created_at,
           t.id AS tid, t.small_blind, t.big_blind, t.club_id,
           lower(COALESCE(hh.game_variant, t.game_variant::text)) AS variant,
           COALESCE(array_length(hh.community_cards, 1), 0) AS board
      FROM rake_records r
      JOIN tables t ON t.id = r.table_id
      LEFT JOIN hand_history hh ON hh.id = r.hand_id
     WHERE r.source = 'atomic_distribute_rake'
       AND r.created_at >= v_since AND r.created_at < v_grace
       AND t.tournament_id IS NULL AND r.is_tournament IS NOT TRUE
  )
  SELECT 'I1_drop_under_3_dealt'::text, count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'n', num_players)) FILTER (WHERE true), '[]'::jsonb)
    FROM (SELECT hand_id, num_players FROM scope
           WHERE bbj > 0 AND num_players IS NOT NULL AND num_players < v_min_dealt LIMIT 20) x
  UNION ALL
  SELECT 'I2_drop_on_ineligible_variant', count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'variant', variant)), '[]'::jsonb)
    FROM (SELECT hand_id, variant FROM scope
           WHERE bbj > 0 AND variant = ANY (v_inelig) LIMIT 20) x
  UNION ALL
  SELECT 'I3_deductions_exceed_pot', count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'pot', pot_size, 'take', take)), '[]'::jsonb)
    FROM (SELECT hand_id, pot_size, rake_amount + bbj AS take FROM scope
           WHERE pot_size IS NOT NULL AND pot_size > 0
             AND rake_amount + bbj > pot_size + 0.001 LIMIT 20) x
  UNION ALL
  SELECT 'I4_eligible_flop_no_drop', count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'n', num_players, 'board', board, 'expected', expected)), '[]'::jsonb)
    FROM (SELECT s.hand_id, s.num_players, s.board,
                 public.fn_effective_bbj_drop(s.big_blind, s.num_players, s.board >= 3, s.club_id,
                                              s.tid, s.variant, s.small_blind, s.pot_size, s.rake_amount) AS expected
            FROM scope s
           WHERE s.bbj = 0 AND s.board >= 3
             AND public.fn_effective_bbj_drop(s.big_blind, s.num_players, s.board >= 3, s.club_id,
                                              s.tid, s.variant, s.small_blind, s.pot_size, s.rake_amount) > 0
           LIMIT 20) x
  UNION ALL
  SELECT 'I5_drop_not_banked_to_pool', count(*)::bigint,
         jsonb_build_object('grace_until', v_bbj_heal, 'grace_source', v_bbj_src,
                            'healer', 'ca-bbj-repair-unbanked-15m',
                            'hands', COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'bbj', bbj)), '[]'::jsonb))
    FROM (SELECT s.hand_id, s.bbj FROM scope s
           WHERE s.bbj > 0 AND s.hand_id IS NOT NULL
             AND s.created_at < v_bbj_heal          -- the healer has SEEN this hand
             AND NOT EXISTS (SELECT 1 FROM bbj_contributions b
                              WHERE b.hand_id = s.hand_id
                                AND abs(b.amount - s.bbj) <= 0.01) LIMIT 20) x
  UNION ALL
  SELECT 'I6_ledger_not_reconciled', count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'rake', rake_amount, 'alloc', alloc)), '[]'::jsonb)
    FROM (SELECT s.hand_id, s.rake_amount,
                 (SELECT COALESCE(SUM(ra.weighted_rake_credit), 0)
                    FROM rake_attributions ra WHERE ra.hand_id = s.hand_id) AS alloc
            FROM scope s
           WHERE s.rake_method = 'WEIGHTED_CONTRIBUTED' AND s.rake_amount > 0
             AND s.hand_id IS NOT NULL AND s.player_contributions IS NOT NULL
             AND round((SELECT COALESCE(SUM(ra.weighted_rake_credit), 0)
                          FROM rake_attributions ra WHERE ra.hand_id = s.hand_id), 2)
                 <> round(s.rake_amount, 2) LIMIT 20) x
  UNION ALL
  SELECT 'I7_raked_hand_never_banked', count(*)::bigint,
         jsonb_build_object('grace_until', v_rake_heal, 'grace_source', v_rake_src,
                            'healer', 'rake-repair-unbanked-hourly',
                            'hands', COALESCE(jsonb_agg(jsonb_build_object('hand', id, 'rake', rake_amount)), '[]'::jsonb))
    FROM (SELECT hh.id, hh.rake_amount
            FROM hand_history hh
            JOIN tables t ON t.id = hh.table_id
           WHERE hh.tournament_id IS NULL AND t.tournament_id IS NULL
             AND t.club_id IS NOT NULL AND hh.rake_amount > 0
             AND hh.created_at >= v_since
             AND hh.created_at < v_rake_heal        -- the healer has SEEN this hand
             AND NOT EXISTS (SELECT 1 FROM rake_records rr WHERE rr.hand_id = hh.id)
             AND NOT EXISTS (SELECT 1 FROM rake_records rr2
                              WHERE rr2.table_id = hh.table_id
                                AND rr2.created_at BETWEEN hh.created_at - interval '2 hours'
                                                       AND hh.created_at + interval '12 hours'
                                AND rr2.metadata->>'hand_number' = hh.hand_number::text)
           LIMIT 20) x;
END $function$;

SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'rake-repair-unbanked-hourly'),
  schedule => '2,17,32,47 * * * *');

DO $$
DECLARE v_sched text; v_i5 jsonb; v_i7 jsonb;
BEGIN
  SELECT schedule INTO v_sched FROM cron.job WHERE jobname = 'rake-repair-unbanked-hourly';
  IF v_sched <> '2,17,32,47 * * * *' THEN
    RAISE EXCEPTION 'the rake healer did not take the new cadence: %', v_sched;
  END IF;

  SELECT detail INTO v_i5 FROM public.fn_rake_bbj_invariants(2)
   WHERE check_name = 'I5_drop_not_banked_to_pool';
  SELECT detail INTO v_i7 FROM public.fn_rake_bbj_invariants(2)
   WHERE check_name = 'I7_raked_hand_never_banked';

  /* The whole point is that the grace comes from the healer, not a constant.
     If both fell back, this function cannot see cron and the change is inert. */
  IF v_i5->>'grace_source' = 'fallback' AND v_i7->>'grace_source' = 'fallback' THEN
    RAISE EXCEPTION 'neither healer could be read from cron.job_run_details; the grace is still a guess: % / %', v_i5, v_i7;
  END IF;
END $$;

COMMIT;

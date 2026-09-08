-- ═══════════════════════════════════════════════════════════════════════════
--  A ZERO THAT ONLY MEANS THE HEALER GOT THERE FIRST
--  BBJ phase 5 deep dive: closing a gap I opened an hour earlier
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Migration 20260907165636 made `I7_raked_hand_never_banked` wait for its
-- healer before flagging a hand. That was right, and it ended 24 CRITICAL false
-- alarms in a week. **It was also wrong, in a way I did not see until the deep
-- dive, and this migration is the correction.**
--
-- I7 is now silent whenever the repair job gets there first. The repair job
-- gets there first almost every time. So:
--
--   I7_raked_hand_never_banked            0
--   hands a healer actually rescued      27, worth 58.77 chips  (last 2 hours)
--
-- A reader of I7 alone would conclude the live path is healthy. It is dropping
-- a hand's entire post-hand tail every few minutes. That is precisely the shape
-- CLAUDE.md 10.86 forbids - a signal answering confidently when it cannot tell -
-- and I built it into the very check I had just rescued from the same fault.
--
-- IT ALSO BREAKS SOMEBODY ELSE'S EXIT CRITERION. `docs/BAND-AIDS-REGISTER.md`
-- TIER 1 #5 says `fn_rake_repair_unbanked` may be deleted when
-- "`I7_raked_hand_never_banked` returns zero for 30 days **with the repair job
-- off**". The clause is careful and still correct - but anyone reading I7 with
-- the job ON now sees a zero that means nothing at all, and 10.12 landed hours
-- ago to say that a repair job firing is a P0 rather than a success. The number
-- that says how often it fires had just been removed.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE FIX: COUNT THE RESCUE, BESIDE THE LOSS, WITH ITS OWN NAME
-- ═══════════════════════════════════════════════════════════════════════════
--
--   I7_raked_hand_never_banked        the healer SAW these and did not fix
--                                     them. A genuine loss. Raises.
--   I8_rake_banked_late_by_a_healer   the healer rescued these. The live path
--                                     failed this many times. Never raises.
--
-- I8 carries `violations = 0` deliberately. `fn_rake_bbj_audit` alerts on
-- `SUM(violations) > 0`, so a non-zero count here would restore an hourly alert
-- with a permanently non-zero body - the exact thing 20260907165636 removed,
-- rebuilt one row along (10.86 rule 4: a fix that leaves the same trap one level
-- up has not landed). The migration ASSERTS the zero for that reason.
--
-- What I8 measures, and why the five-minute line: a `rake_records` row written
-- more than five minutes after its `hand_history` row was not written by the
-- engine that settled the hand. Five minutes is not a guess - it is the window
-- `fn_rake_repair_unbanked` itself refuses to touch (`hh.created_at < now() -
-- interval '5 minutes'`), so anything past it is a hand the engine had already
-- given up on.
--
-- WHAT IS STILL NOT FIXED, and it is now somebody's P0 rather than mine to
-- describe again: the engine writes `hand_history` and then does not reach
-- `atomic_distribute_rake` or `logBBJCollection` at all - no error, no
-- `pending_fee_distributions` claim, no `postHandTasks.*_failed` alert in seven
-- days. The healer banks the rake later with `p_contributions => NULL`, so
-- those hands earn nobody VIP points, agent commission or rakeback. The root
-- fix and the delete-when are already written down by another agent in
-- BAND-AIDS-REGISTER TIER 1 #5 - "bank the fee in the same statement that
-- removes it from the pot" - and this migration does not attempt it. It makes
-- the cost of not attempting it impossible to miss.
--
-- ROLLBACK: the previous definition is in
--   20260907165636_an_alarm_asks_the_healer_whether_it_has_had_its_chance.sql

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
           r.created_at, hh.created_at AS hand_at,
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
             AND s.created_at < v_bbj_heal
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
                            'means', 'the healer has SEEN these hands and did not fix them - a genuine loss. Hands the healer DID rescue are counted by I8, which is the number that says how often the live path failed.',
                            'hands', COALESCE(jsonb_agg(jsonb_build_object('hand', id, 'rake', rake_amount)), '[]'::jsonb))
    FROM (SELECT hh.id, hh.rake_amount
            FROM hand_history hh
            JOIN tables t ON t.id = hh.table_id
           WHERE hh.tournament_id IS NULL AND t.tournament_id IS NULL
             AND t.club_id IS NOT NULL AND hh.rake_amount > 0
             AND hh.created_at >= v_since
             AND hh.created_at < v_rake_heal
             AND NOT EXISTS (SELECT 1 FROM rake_records rr WHERE rr.hand_id = hh.id)
             AND NOT EXISTS (SELECT 1 FROM rake_records rr2
                              WHERE rr2.table_id = hh.table_id
                                AND rr2.created_at BETWEEN hh.created_at - interval '2 hours'
                                                       AND hh.created_at + interval '12 hours'
                                AND rr2.metadata->>'hand_number' = hh.hand_number::text)
           LIMIT 20) x
  UNION ALL
  /* I8: HOW OFTEN THE LIVE PATH FAILED, which I7 deliberately cannot say.
     Making I7 wait for its healer (20260907165636) was right for alarming and
     wrong for measuring: with the repair job ON, I7 now reads zero while the
     engine drops a hand's whole post-hand tail every few minutes, and
     BAND-AIDS-REGISTER TIER 1 #5 uses I7 returning zero as the criterion for
     deleting the repair job. A zero that only means "the healer got there
     first" is exactly the signal CLAUDE.md 10.86 forbids.
     So the rescue is COUNTED, beside the loss, with its own name. It carries
     violations 0 on purpose: it must never raise on its own (that is the
     hourly critical this phase just removed), and under CLAUDE.md 10.12 every
     one of these is a P0 to be read, not paged on. */
  SELECT 'I8_rake_banked_late_by_a_healer', 0::bigint,
         jsonb_build_object(
           'hands', (SELECT count(*) FROM scope s
                      WHERE s.hand_at IS NOT NULL
                        AND s.created_at - s.hand_at > interval '5 minutes'),
           'chips', (SELECT COALESCE(round(sum(s.rake_amount), 2), 0) FROM scope s
                      WHERE s.hand_at IS NOT NULL
                        AND s.created_at - s.hand_at > interval '5 minutes'),
           'window_hours', p_hours,
           'means', 'rake the engine took from a pot and did not itself bank; a healer wrote the row later, with p_contributions NULL, so these hands earn nobody VIP points, agent commission or rakeback. CLAUDE.md 10.12: a repair job firing is a P0, not a success. Root fix and delete-when: BAND-AIDS-REGISTER TIER 1 #5.',
           'raises', 'never - this is a measurement, not an alarm. I7 is the alarm.');
END $function$;

/* SELF-CONTAINED, because a rebuild from these files must produce the same
   security posture as production. `CREATE OR REPLACE` keeps the grants the
   function already has, so on THIS database the revoke from 20260907171547
   still stands and these two statements are a no-op. Replayed on a fresh
   database the CREATE alone would hand `fn_rake_bbj_invariants` - per-hand rake
   and jackpot violations - to any caller with no account.
   check-definer-authorization refused this migration until they were here, and
   it was right to. */
REVOKE ALL ON FUNCTION public.fn_rake_bbj_invariants(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rake_bbj_invariants(integer) TO service_role;

DO $$
DECLARE v_i7 jsonb; v_i8 jsonb; v_rows int;
BEGIN
  SELECT count(*) INTO v_rows FROM public.fn_rake_bbj_invariants(2);
  IF v_rows <> 8 THEN
    RAISE EXCEPTION 'expected 8 invariant rows, got %', v_rows;
  END IF;

  SELECT detail INTO v_i7 FROM public.fn_rake_bbj_invariants(2)
   WHERE check_name = 'I7_raked_hand_never_banked';
  SELECT detail INTO v_i8 FROM public.fn_rake_bbj_invariants(2)
   WHERE check_name = 'I8_rake_banked_late_by_a_healer';

  IF v_i7->>'grace_source' = 'fallback' THEN
    RAISE EXCEPTION 'the healer is unreadable, so I7 is guessing again: %', v_i7;
  END IF;
  IF v_i8 IS NULL OR v_i8->>'hands' IS NULL THEN
    RAISE EXCEPTION 'I8 did not measure anything: %', v_i8;
  END IF;

  /* I8 must never make the audit raise. fn_rake_bbj_audit alerts on
     SUM(violations) > 0, so a non-zero here would restore the hourly alert
     this phase removed. */
  IF (SELECT violations FROM public.fn_rake_bbj_invariants(2)
       WHERE check_name = 'I8_rake_banked_late_by_a_healer') <> 0 THEN
    RAISE EXCEPTION 'I8 must carry zero violations or it becomes an alarm';
  END IF;

  IF has_function_privilege('anon', 'public.fn_rake_bbj_invariants(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_rake_bbj_invariants(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can read the rake and jackpot violations';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_rake_bbj_invariants(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the audit can no longer run the invariants';
  END IF;
END $$;

COMMIT;

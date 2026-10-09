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
  /* THE GRACE BELONGS TO THE WRITER, NOT TO A REPAIR SCHEDULE (2026-09-22).
     I5 and I7 used to ask the job scheduler when a repair job last ran. A
     retired job answered NULL, the fallback was now() - 2 hours, and with
     p_hours = 2 that window is empty, so I5 read zero by construction. The
     rake and the BBJ drop of an accepted hand are owed by its post-commit
     envelope, committed with the hand, and banked in one transaction by
     fn_ca_process_hand_post_commit_obligations. Five minutes is that
     writer's own bound: a hand still owed after it is I9, a hand owed by
     nothing is I7. */
  v_min_dealt integer;
  v_inelig text[];
BEGIN
  SELECT r.bbj_min_players_dealt, r.bbj_ineligible_variants INTO v_min_dealt, v_inelig
    FROM public.ca_rake_rules r WHERE r.id = 1;

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
         jsonb_build_object('grace_until', v_grace, 'grace_source', 'writer',
                            'owner', 'fn_ca_process_hand_post_commit_obligations',
                            'hands', COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'bbj', bbj)), '[]'::jsonb))
    FROM (SELECT s.hand_id, s.bbj FROM scope s
           WHERE s.bbj > 0 AND s.hand_id IS NOT NULL
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
         jsonb_build_object('grace_until', v_grace, 'grace_source', 'writer',
                            'owner', 'fn_ca_process_hand_post_commit_obligations',
                            'means', 'a raked cash hand older than five minutes with no rake record and no pending post-commit envelope owing it. Nothing durable will bank it, so this is a genuine loss. The accepted-hand door commits the rake obligation with the hand and fn_ca_process_hand_post_commit_obligations banks it in one transaction, so this reads zero unless a writer broke.',
                            'hands', COALESCE(jsonb_agg(jsonb_build_object('hand', id, 'rake', rake_amount)), '[]'::jsonb))
    FROM (SELECT hh.id, hh.rake_amount
            FROM hand_history hh
            JOIN tables t ON t.id = hh.table_id
           WHERE hh.tournament_id IS NULL AND t.tournament_id IS NULL
             AND t.club_id IS NOT NULL AND hh.rake_amount > 0
             AND hh.created_at >= v_since
             AND hh.created_at < v_grace
             AND NOT EXISTS (SELECT 1 FROM rake_records rr WHERE rr.hand_id = hh.id)
             AND NOT EXISTS (SELECT 1 FROM rake_records rr2
                              WHERE rr2.table_id = hh.table_id
                                AND rr2.created_at BETWEEN hh.created_at - interval '2 hours'
                                                       AND hh.created_at + interval '12 hours'
                                AND rr2.metadata->>'hand_number' = hh.hand_number::text)
             AND NOT EXISTS (SELECT 1 FROM hand_atomic_commits c
                              WHERE c.hand_id = hh.id
                                AND c.post_commit_payload IS NOT NULL
                                AND c.post_commit_completed_at IS NULL)
           LIMIT 20) x
  UNION ALL
  SELECT 'I9_rake_owed_by_a_pending_envelope', count(*)::bigint,
         jsonb_build_object('grace_until', v_grace,
                            'owner', 'fn_ca_process_hand_post_commit_obligations',
                            'means', 'an accepted hand whose post-commit envelope still owes its rake or BBJ drop more than five minutes after the hand committed. Late, not lost: the envelope is the record, and only fn_ca_process_hand_post_commit_obligations may bank it, with the contributions that attribute it. Nothing else banks it, so a hand stays here until the engine or its successor drains the envelope.',
                            'hands', COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'table', table_id,
                                               'hand_number', hand_number, 'committed_at', committed_at)), '[]'::jsonb))
    FROM (SELECT c.hand_id, c.table_id, c.hand_number, c.committed_at
            FROM hand_atomic_commits c
           WHERE c.post_commit_payload IS NOT NULL
             AND c.post_commit_completed_at IS NULL
             AND c.committed_at < v_grace
             AND (jsonb_typeof(c.post_commit_payload->'rake') = 'object'
                  OR jsonb_typeof(c.post_commit_payload->'bbj_contribution') = 'object')
           ORDER BY c.committed_at
           LIMIT 20) x
  UNION ALL
  /* I8: HOW LATE THE LIVE PATH BANKED. A measurement beside the two alarms:
     I7 says a raked hand is owed by nothing, I9 says an envelope still owes
     it, and I8 counts the hands whose rake landed more than five minutes after
     the hand. It carries violations 0 on purpose: lateness that has already
     resolved is read, not paged on. */
  SELECT 'I8_rake_banked_late', 0::bigint,
         jsonb_build_object(
           'hands', (SELECT count(*) FROM scope s
                      WHERE s.hand_at IS NOT NULL
                        AND s.created_at - s.hand_at > interval '5 minutes'),
           'chips', (SELECT COALESCE(round(sum(s.rake_amount), 2), 0) FROM scope s
                      WHERE s.hand_at IS NOT NULL
                        AND s.created_at - s.hand_at > interval '5 minutes'),
           'window_hours', p_hours,
           'means', 'rake banked more than five minutes after its hand was recorded: an envelope that completed late. Counted here, never raised.',
           'raises', 'never - this is a measurement, not an alarm. I7 and I9 are the alarms.');
END $function$

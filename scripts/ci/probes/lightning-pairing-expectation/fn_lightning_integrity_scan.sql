CREATE OR REPLACE FUNCTION public.fn_lightning_integrity_scan(p_cluster_id uuid DEFAULT NULL::uuid, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_max_hands      constant integer := 20000;
  c_max_sessions   constant integer := 5000;
  c_max_clusters   constant integer := 50;
  c_max_signals    constant integer := 500;
  c_pair_min_hands constant integer := 30;
  c_pair_min_ratio constant numeric := 2.0;
  c_flow_min_hands constant integer := 30;
  c_flow_min_z     constant numeric := 4.0;
  c_flow_min_gross_bb constant numeric := 50;
  c_long_max_score constant integer := 69;
  c_flow_min_dir   constant numeric := 0.8;
  c_flow_min_win   constant numeric := 0.8;
  c_join_window_s  constant integer := 10;
  c_join_min       constant integer := 3;
  c_long_hours     constant numeric := 12;
  c_link_min_hands constant integer := 5;
  v_now      timestamptz := clock_timestamp();
  v_to       timestamptz;
  v_from     timestamptz;
  v_clamped  boolean := false;
  v_cluster  uuid;
  v_hands    integer;
  v_sessions integer;
  v_scanned  integer := 0;
  v_hand_sum bigint := 0;
  v_budget   boolean := false;
  v_counts   jsonb := '{}'::jsonb;
  v_part     jsonb;
  v_mirrored integer := 0;
  v_n        integer;
  v_bb       numeric;
BEGIN
  v_to := LEAST(coalesce(p_to, date_trunc('hour', v_now)), v_now);
  v_from := coalesce(p_from, v_to - interval '24 hours');
  IF v_from >= v_to THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'INVALID_WINDOW', 'window_from', v_from, 'window_to', v_to);
  END IF;
  IF v_to - v_from > interval '7 days' THEN
    v_from := v_to - interval '7 days';
    v_clamped := true;
  END IF;

  FOR v_cluster IN
    SELECT x.cluster_id FROM (
      SELECT p_cluster_id AS cluster_id WHERE p_cluster_id IS NOT NULL
      UNION
      SELECT DISTINCT lh.cluster_id FROM public.lightning_hand lh
       WHERE p_cluster_id IS NULL AND lh.formed_at >= v_from AND lh.formed_at < v_to
    ) x ORDER BY x.cluster_id LIMIT c_max_clusters
  LOOP
    v_scanned := v_scanned + 1;
    -- FINDINGS EXTEND, NEVER DUPLICATE (2026-10-09, Phase 11 remediation).
    -- One scan or engine report of a Cluster at a time: overlapping runs
    -- (the sweep, an operator, a retry) wait for each other here, so the
    -- extend-or-insert below and the mirror's check see each other's rows.
    -- Clusters are taken in cluster_id order, so two scans cannot deadlock.
    PERFORM pg_advisory_xact_lock(hashtext('lightning-integrity:' || v_cluster::text));
    SELECT cg.bb INTO v_bb FROM public.cash_games cg WHERE cg.id = v_cluster;

    SELECT count(*) INTO v_hands FROM (
      SELECT 1 FROM public.lightning_hand lh
       WHERE lh.cluster_id = v_cluster AND lh.formed_at >= v_from AND lh.formed_at < v_to
         AND lh.settled_at IS NOT NULL
       LIMIT c_max_hands + 1) q;
    IF v_hands > c_max_hands THEN v_budget := true; v_hands := c_max_hands; END IF;
    v_hand_sum := v_hand_sum + v_hands;

    -- PAIR SIGNALS: one pass over the shared hands feeds four patterns.
    WITH h AS MATERIALIZED (
      SELECT lh.hand_id, lh.formed_at FROM public.lightning_hand lh
       WHERE lh.cluster_id = v_cluster AND lh.formed_at >= v_from AND lh.formed_at < v_to
         AND lh.settled_at IS NOT NULL
       ORDER BY lh.formed_at DESC, lh.hand_id
       LIMIT c_max_hands
    ), hp AS MATERIALIZED (
      SELECT p.hand_id, p.player_id, coalesce(p.net_result, 0) AS net, h.formed_at
        FROM public.lightning_hand_player p JOIN h ON h.hand_id = p.hand_id
    ), per AS (
      SELECT hp.player_id, count(*) AS hands FROM hp GROUP BY 1
    ), pairs AS MATERIALIZED (
      SELECT a.player_id AS pa, b.player_id AS pb,
             count(*) AS together,
             count(*) FILTER (WHERE sign(a.net) * sign(b.net) < 0) AS opposed,
             count(*) FILTER (WHERE a.net < 0 AND b.net > 0) AS b_won,
             coalesce(sum(LEAST(abs(a.net), abs(b.net))) FILTER (WHERE sign(a.net) * sign(b.net) < 0), 0) AS gross,
             coalesce(sum(CASE WHEN a.net < 0 AND b.net > 0 THEN LEAST(-a.net, b.net)
                               WHEN a.net > 0 AND b.net < 0 THEN -LEAST(a.net, -b.net)
                               ELSE 0 END), 0) AS net_to_b
        FROM hp a JOIN hp b ON b.hand_id = a.hand_id AND b.player_id > a.player_id
       GROUP BY 1, 2
    ), pres AS MATERIALIZED (
      -- WHO WAS IN THE POOL, AND WHEN: every pool session of the Cluster
      -- open at some moment of the window (bounded like the session scan).
      SELECT ps.player_id, ps.entered_at, ps.exited_at
        FROM public.lightning_pool_session ps
       WHERE ps.cluster_id = v_cluster
         AND ps.entered_at < v_to AND ps.entered_at >= v_from - interval '7 days'
         AND (ps.exited_at IS NULL OR ps.exited_at > v_from)
       ORDER BY ps.entered_at DESC, ps.id
       LIMIT c_max_sessions
    ), pool AS (
      -- THE POOL'S SIZE AT EACH HAND, by one ordered sweep: an entry adds
      -- one, an exit takes one away, and a hand reads the running total
      -- after every entry and exit at or before its formation.
      SELECT q.hand_id, q.present FROM (
        SELECT e.hand_id, sum(e.d) OVER (ORDER BY e.t, e.k ROWS UNBOUNDED PRECEDING) AS present
          FROM (SELECT pr_.entered_at AS t, 1 AS d, 0 AS k, NULL::uuid AS hand_id FROM pres pr_
                UNION ALL
                SELECT pr_.exited_at, -1, 0, NULL::uuid FROM pres pr_ WHERE pr_.exited_at IS NOT NULL
                UNION ALL
                SELECT h.formed_at, 0, 1, h.hand_id FROM h) e) q
       WHERE q.hand_id IS NOT NULL
    ), hw AS MATERIALIZED (
      -- THE CHANCE A RANDOM SEATING PUTS A GIVEN OTHER PLAYER OF THE POOL
      -- IN THIS HAND: (players in the hand - 1) / (players in the pool - 1).
      SELECT hp.hand_id, hp.player_id, hp.formed_at,
             (sz.n - 1)::numeric / GREATEST(GREATEST(pl.present, sz.n) - 1, 1) AS w
        FROM hp
        JOIN (SELECT hp2.hand_id, count(*) AS n FROM hp hp2 GROUP BY 1) sz ON sz.hand_id = hp.hand_id
        JOIN pool pl ON pl.hand_id = hp.hand_id
    ), ex AS (
      -- THE CO-PRESENCE EXPECTATION of a candidate pair: over A's hands
      -- formed while B was in the pool, and B's while A was, averaged.
      SELECT d.pa, d.pb, sum(hw.w) / 2 AS expected,
             count(*) FILTER (WHERE d.x = d.pa) AS hands_a_copresent,
             count(*) FILTER (WHERE d.x = d.pb) AS hands_b_copresent
        FROM (SELECT pr.pa AS x, pr.pb AS y, pr.pa, pr.pb FROM pairs pr WHERE pr.together >= c_pair_min_hands
              UNION ALL
              SELECT pr.pb, pr.pa, pr.pa, pr.pb FROM pairs pr WHERE pr.together >= c_pair_min_hands) d
        JOIN hw ON hw.player_id = d.x
        JOIN pres s ON s.player_id = d.y AND s.entered_at <= hw.formed_at
                   AND (s.exited_at IS NULL OR s.exited_at > hw.formed_at)
       GROUP BY d.pa, d.pb
    ), scored AS (
      SELECT pr.*, pa_.hands AS hands_a, pb_.hands AS hands_b,
             coalesce(ex.expected, pa_.hands::numeric * pb_.hands::numeric / GREATEST(v_hands, 1)) AS expected,
             CASE WHEN ex.expected IS NOT NULL THEN 'co_presence' ELSE 'whole_window' END AS expectation,
             ex.hands_a_copresent, ex.hands_b_copresent
        FROM pairs pr
        JOIN per pa_ ON pa_.player_id = pr.pa
        JOIN per pb_ ON pb_.player_id = pr.pb
        LEFT JOIN ex ON ex.pa = pr.pa AND ex.pb = pr.pb
    ), cand AS (
      SELECT 'PAIRING_CONCENTRATION'::text AS pattern, s.pa, s.pb,
             LEAST(100, GREATEST(0, round(50 + 25 * log(2, (s.together / GREATEST(s.expected, 0.000001)) / c_pair_min_ratio))))::integer AS score,
             jsonb_build_object('hands_together', s.together, 'hands_a', s.hands_a, 'hands_b', s.hands_b,
                                'hands_in_window', v_hands, 'expected_together', round(s.expected, 2),
                                'expectation', s.expectation,
                                'hands_a_while_b_present', s.hands_a_copresent,
                                'hands_b_while_a_present', s.hands_b_copresent,
                                'concentration_ratio', round(s.together / GREATEST(s.expected, 0.000001), 3),
                                'share_of_fewer', round(s.together::numeric / LEAST(s.hands_a, s.hands_b), 3),
                                'min_hands', c_pair_min_hands, 'min_ratio', c_pair_min_ratio) AS evidence
        FROM scored s
       WHERE s.together >= c_pair_min_hands
         AND s.together >= c_pair_min_ratio * s.expected
      UNION ALL
      SELECT 'CHIP_FLOW', s.pa, s.pb,
             LEAST(100, round(60 * abs(s.net_to_b) / s.gross + 0.8 * LEAST(s.opposed, 50)))::integer,
             jsonb_build_object('hands_together', s.together, 'opposed_hands', s.opposed,
                                'gross_flow', s.gross, 'net_flow', abs(s.net_to_b),
                                'direction_ratio', round(abs(s.net_to_b) / s.gross, 4),
                                'receiver_win_share', round(GREATEST(s.b_won, s.opposed - s.b_won)::numeric / s.opposed, 4),
                                'receiver', CASE WHEN s.net_to_b > 0 THEN s.pb ELSE s.pa END,
                                'sender', CASE WHEN s.net_to_b > 0 THEN s.pa ELSE s.pb END,
                                'min_opposed_hands', c_flow_min_hands, 'min_direction', c_flow_min_dir,
                                'min_win_share', c_flow_min_win,
                                'win_z', round((GREATEST(s.b_won, s.opposed - s.b_won) - s.opposed / 2.0) / sqrt(s.opposed / 4.0), 3),
                                'gross_bb', CASE WHEN coalesce(v_bb, 0) > 0 THEN round(s.gross / v_bb, 2) END,
                                'min_z', c_flow_min_z, 'min_gross_bb', c_flow_min_gross_bb)
        FROM scored s
       WHERE s.opposed >= c_flow_min_hands AND s.gross > 0
         AND abs(s.net_to_b) / s.gross >= c_flow_min_dir
         AND GREATEST(s.b_won, s.opposed - s.b_won)::numeric / s.opposed >= c_flow_min_win
         AND (GREATEST(s.b_won, s.opposed - s.b_won) - s.opposed / 2.0) / sqrt(s.opposed / 4.0) >= c_flow_min_z
         AND s.gross >= c_flow_min_gross_bb * coalesce(v_bb, 0)
      UNION ALL
      SELECT 'DEVICE_OVERLAP', s.pa, s.pb, 60,
             jsonb_build_object('hands_together', s.together, 'shared_ip_addresses', d.n,
                                'source', 'user_sessions', 'min_hands', c_link_min_hands)
        FROM scored s
        CROSS JOIN LATERAL (
          SELECT count(DISTINCT ua.ip_address) AS n
            FROM public.user_sessions ua
            JOIN public.user_sessions ub ON ub.ip_address = ua.ip_address
           WHERE ua.user_id = s.pa AND ub.user_id = s.pb AND ua.ip_address IS NOT NULL) d
       WHERE s.together >= c_link_min_hands AND d.n > 0
      UNION ALL
      SELECT 'ACCOUNT_RELATIONSHIP', s.pa, s.pb, 50,
             jsonb_build_object('hands_together', s.together, 'relationship', 'referral',
                                'referrer', CASE WHEN ra.referred_by = s.pb THEN s.pb ELSE s.pa END,
                                'referred', CASE WHEN ra.referred_by = s.pb THEN s.pa ELSE s.pb END,
                                'source', 'profiles.referred_by', 'min_hands', c_link_min_hands)
        FROM scored s
        LEFT JOIN public.profiles ra ON ra.id = s.pa
        LEFT JOIN public.profiles rb ON rb.id = s.pb
       WHERE s.together >= c_link_min_hands
         AND (ra.referred_by = s.pb OR rb.referred_by = s.pa)
    ), capped AS (
      SELECT cand.*, row_number() OVER (PARTITION BY cand.pattern ORDER BY cand.score DESC, cand.pa, cand.pb) AS rn
        FROM cand
    ), k AS (
      SELECT c.pattern, c.pa, c.pb, c.score,
             c.evidence || jsonb_build_object('latest_score', c.score, 'latest_window_start', v_from,
                                              'latest_window_end', v_to) AS evidence
        FROM capped c WHERE c.rn <= c_max_signals
    ), cur AS (
      -- THE SUBJECT'S FINDING: the newest row of the same Cluster, pattern
      -- and subject whose window meets this one. It is extended; its status
      -- (an operator's review) is never touched.
      SELECT DISTINCT ON (k.pattern, k.pa, k.pb) t.id, k.pattern, k.pa, k.pb
        FROM k JOIN public.lightning_integrity_signal t
          ON t.cluster_id = v_cluster AND t.pattern_type = k.pattern AND t.player_a = k.pa
         AND t.player_b IS NOT DISTINCT FROM k.pb
         AND t.window_end >= v_from AND t.window_start <= v_to
       ORDER BY k.pattern, k.pa, k.pb, t.window_end DESC, t.id DESC
    ), ext AS (
      UPDATE public.lightning_integrity_signal t
         SET window_start = LEAST(t.window_start, v_from),
             window_end = GREATEST(t.window_end, v_to),
             suspicion_score = GREATEST(t.suspicion_score, k.score),
             severity = CASE WHEN GREATEST(t.suspicion_score, k.score) >= 70 THEN 'high'
                             WHEN GREATEST(t.suspicion_score, k.score) >= 40 THEN 'medium' ELSE 'low' END,
             evidence = k.evidence, updated_at = now()
        FROM cur JOIN k ON k.pattern = cur.pattern AND k.pa = cur.pa AND k.pb IS NOT DISTINCT FROM cur.pb
       WHERE t.id = cur.id
         AND (t.window_start, t.window_end, t.suspicion_score::integer, t.evidence)
             IS DISTINCT FROM (LEAST(t.window_start, v_from), GREATEST(t.window_end, v_to),
                               GREATEST(t.suspicion_score::integer, k.score), k.evidence)
      RETURNING t.pattern_type
    ), ins AS (
      INSERT INTO public.lightning_integrity_signal AS t
        (cluster_id, pattern_type, source, player_a, player_b, window_start, window_end,
         suspicion_score, severity, evidence)
      SELECT v_cluster, k.pattern, 'scan', k.pa, k.pb, v_from, v_to, k.score,
             CASE WHEN k.score >= 70 THEN 'high' WHEN k.score >= 40 THEN 'medium' ELSE 'low' END,
             k.evidence
        FROM k
       WHERE NOT EXISTS (SELECT 1 FROM cur WHERE cur.pattern = k.pattern AND cur.pa = k.pa
                                             AND cur.pb IS NOT DISTINCT FROM k.pb)
      ON CONFLICT (cluster_id, pattern_type, window_start, window_end, player_a, player_b) DO NOTHING
      RETURNING t.pattern_type
    ), up AS (
      SELECT ext.pattern_type FROM ext UNION ALL SELECT ins.pattern_type FROM ins
    )
    SELECT coalesce(jsonb_object_agg(u.pattern_type, u.n), '{}'::jsonb) INTO v_part
      FROM (SELECT up.pattern_type, count(*) AS n FROM up GROUP BY 1) u;
    SELECT coalesce(jsonb_object_agg(k, coalesce((v_counts ->> k)::integer, 0) + coalesce((v_part ->> k)::integer, 0)), '{}'::jsonb)
      INTO v_counts
      FROM (SELECT jsonb_object_keys(v_counts) UNION SELECT jsonb_object_keys(v_part)) x(k);

    -- POOL SESSION SIGNALS.
    SELECT count(*) INTO v_sessions FROM (
      SELECT 1 FROM public.lightning_pool_session ps
       WHERE ps.cluster_id = v_cluster AND ps.entered_at >= v_from AND ps.entered_at < v_to
       LIMIT c_max_sessions + 1) q;
    IF v_sessions > c_max_sessions THEN v_budget := true; END IF;

    WITH s AS MATERIALIZED (
      SELECT ps.id, ps.player_id, ps.entered_at, ps.exited_at,
             -- ONLY WHAT THE PLAYER DID: an entry within the pattern's window
             -- of an epoch start (the conversion entering everyone, the
             -- unfreeze) is the system's; only Stop Playing and standing up
             -- from the anchor seat are the player's own exits.
             NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch ce
                          WHERE ce.cluster_id = ps.cluster_id
                            AND ce.started_at BETWEEN ps.entered_at - make_interval(secs => c_join_window_s)
                                                  AND ps.entered_at + make_interval(secs => c_join_window_s)) AS own_entry,
             coalesce(ps.exit_reason IN ('stop_playing', 'anchor_seat_left'), false) AS own_exit
        FROM public.lightning_pool_session ps
       WHERE ps.cluster_id = v_cluster AND ps.entered_at >= v_from AND ps.entered_at < v_to
       ORDER BY ps.entered_at DESC, ps.id
       LIMIT c_max_sessions
    ), per AS (
      SELECT s.player_id, count(*) AS sessions FROM s GROUP BY 1
    ), joint AS (
      SELECT a.player_id AS pa, b.player_id AS pb,
             count(DISTINCT a.id) AS joint_a, count(DISTINCT b.id) AS joint_b
        FROM s a
        JOIN s b ON b.player_id > a.player_id
                AND b.entered_at BETWEEN a.entered_at - make_interval(secs => c_join_window_s)
                                     AND a.entered_at + make_interval(secs => c_join_window_s)
                AND a.exited_at IS NOT NULL AND b.exited_at IS NOT NULL
                AND a.own_entry AND b.own_entry AND a.own_exit AND b.own_exit
                AND b.exited_at BETWEEN a.exited_at - make_interval(secs => c_join_window_s)
                                    AND a.exited_at + make_interval(secs => c_join_window_s)
       GROUP BY 1, 2
    ), cand AS (
      SELECT 'COORDINATED_JOIN_LEAVE'::text AS pattern, j.pa, j.pb,
             LEAST(100, 40 + 10 * LEAST(j.joint_a, j.joint_b))::integer AS score,
             jsonb_build_object('joint_sessions', LEAST(j.joint_a, j.joint_b),
                                'sessions_a', pa_.sessions, 'sessions_b', pb_.sessions,
                                'within_seconds', c_join_window_s, 'min_joint', c_join_min,
                                'player_initiated_only', true) AS evidence
        FROM joint j
        JOIN per pa_ ON pa_.player_id = j.pa
        JOIN per pb_ ON pb_.player_id = j.pb
       WHERE LEAST(j.joint_a, j.joint_b) >= c_join_min
         AND LEAST(j.joint_a, j.joint_b)::numeric / LEAST(pa_.sessions, pb_.sessions) >= 0.5
      UNION ALL
      SELECT 'SESSION_LENGTH', l.player_id, NULL::uuid,
             LEAST(c_long_max_score, round(50 + (l.hours - c_long_hours) * 10 / 3))::integer,
             jsonb_build_object('longest_session_hours', round(l.hours, 2), 'pool_session_id', l.id,
                                'still_open', l.open, 'min_hours', c_long_hours)
        FROM (
          SELECT DISTINCT ON (ps.player_id) ps.player_id, ps.id, ps.exited_at IS NULL AS open,
                 extract(epoch FROM (coalesce(ps.exited_at, v_to) - ps.entered_at)) / 3600 AS hours
            FROM (SELECT x.* FROM public.lightning_pool_session x
                   WHERE x.cluster_id = v_cluster
                     AND x.entered_at >= v_from - interval '7 days' AND x.entered_at < v_to
                     AND (x.exited_at IS NULL OR x.exited_at > v_from)
                     AND coalesce(x.exited_at, v_to) - x.entered_at >= c_long_hours * interval '1 hour'
                   ORDER BY x.entered_at DESC, x.id
                   LIMIT c_max_sessions) ps
           ORDER BY ps.player_id, coalesce(ps.exited_at, v_to) - ps.entered_at DESC, ps.id
        ) l
       WHERE l.hours >= c_long_hours
    ), capped AS (
      SELECT cand.*, row_number() OVER (PARTITION BY cand.pattern ORDER BY cand.score DESC, cand.pa, cand.pb) AS rn
        FROM cand
    ), k AS (
      SELECT c.pattern, c.pa, c.pb, c.score,
             c.evidence || jsonb_build_object('latest_score', c.score, 'latest_window_start', v_from,
                                              'latest_window_end', v_to) AS evidence
        FROM capped c WHERE c.rn <= c_max_signals
    ), cur AS (
      -- THE SUBJECT'S FINDING: the newest row of the same Cluster, pattern
      -- and subject whose window meets this one. It is extended; its status
      -- (an operator's review) is never touched.
      SELECT DISTINCT ON (k.pattern, k.pa, k.pb) t.id, k.pattern, k.pa, k.pb
        FROM k JOIN public.lightning_integrity_signal t
          ON t.cluster_id = v_cluster AND t.pattern_type = k.pattern AND t.player_a = k.pa
         AND t.player_b IS NOT DISTINCT FROM k.pb
         AND t.window_end >= v_from AND t.window_start <= v_to
       ORDER BY k.pattern, k.pa, k.pb, t.window_end DESC, t.id DESC
    ), ext AS (
      UPDATE public.lightning_integrity_signal t
         SET window_start = LEAST(t.window_start, v_from),
             window_end = GREATEST(t.window_end, v_to),
             suspicion_score = GREATEST(t.suspicion_score, k.score),
             severity = CASE WHEN GREATEST(t.suspicion_score, k.score) >= 70 THEN 'high'
                             WHEN GREATEST(t.suspicion_score, k.score) >= 40 THEN 'medium' ELSE 'low' END,
             evidence = k.evidence, updated_at = now()
        FROM cur JOIN k ON k.pattern = cur.pattern AND k.pa = cur.pa AND k.pb IS NOT DISTINCT FROM cur.pb
       WHERE t.id = cur.id
         AND (t.window_start, t.window_end, t.suspicion_score::integer, t.evidence)
             IS DISTINCT FROM (LEAST(t.window_start, v_from), GREATEST(t.window_end, v_to),
                               GREATEST(t.suspicion_score::integer, k.score), k.evidence)
      RETURNING t.pattern_type
    ), ins AS (
      INSERT INTO public.lightning_integrity_signal AS t
        (cluster_id, pattern_type, source, player_a, player_b, window_start, window_end,
         suspicion_score, severity, evidence)
      SELECT v_cluster, k.pattern, 'scan', k.pa, k.pb, v_from, v_to, k.score,
             CASE WHEN k.score >= 70 THEN 'high' WHEN k.score >= 40 THEN 'medium' ELSE 'low' END,
             k.evidence
        FROM k
       WHERE NOT EXISTS (SELECT 1 FROM cur WHERE cur.pattern = k.pattern AND cur.pa = k.pa
                                             AND cur.pb IS NOT DISTINCT FROM k.pb)
      ON CONFLICT (cluster_id, pattern_type, window_start, window_end, player_a, player_b) DO NOTHING
      RETURNING t.pattern_type
    ), up AS (
      SELECT ext.pattern_type FROM ext UNION ALL SELECT ins.pattern_type FROM ins
    )
    SELECT coalesce(jsonb_object_agg(u.pattern_type, u.n), '{}'::jsonb) INTO v_part
      FROM (SELECT up.pattern_type, count(*) AS n FROM up GROUP BY 1) u;
    SELECT coalesce(jsonb_object_agg(k, coalesce((v_counts ->> k)::integer, 0) + coalesce((v_part ->> k)::integer, 0)), '{}'::jsonb)
      INTO v_counts
      FROM (SELECT jsonb_object_keys(v_counts) UNION SELECT jsonb_object_keys(v_part)) x(k);

    -- THE EXISTING PAIR STORE: each CHIP_FLOW finding once, in the duel
    -- scan's convention, so it reaches the operator queue and case evidence.
    INSERT INTO public.ca_collusion_signals
      (window_days, user_a, user_b, hands_together, gross_flow, net_flow, direction_ratio, both_cert, detail)
    SELECT GREATEST(1, ceil(extract(epoch FROM (t.window_end - t.window_start)) / 86400))::integer,
           (t.evidence ->> 'receiver')::uuid, (t.evidence ->> 'sender')::uuid,
           (t.evidence ->> 'hands_together')::integer,
           (t.evidence ->> 'gross_flow')::numeric, (t.evidence ->> 'net_flow')::numeric,
           (t.evidence ->> 'direction_ratio')::numeric,
           public.fn_ca_is_cert_account((t.evidence ->> 'receiver')::uuid)
             AND public.fn_ca_is_cert_account((t.evidence ->> 'sender')::uuid),
           jsonb_build_object(
             'signal', 'lightning_chip_flow',
             'since', t.window_start,
             'until', t.window_end,
             'cluster_id', v_cluster,
             'lightning_signal_id', t.id,
             'lightning_key', v_cluster::text || ':' || t.player_a::text || ':' || t.player_b::text || ':' || t.id::text,
             'opposed_hands', (t.evidence ->> 'opposed_hands')::integer,
             'note', 'Lightning: hands_together is Lightning hands both played; gross_flow and net_flow '
                     || 'are chips between the pair over the hands they finished with opposite results; '
                     || 'direction_ratio is net over gross. Telemetry only - no automatic action taken')
      FROM public.lightning_integrity_signal t
     WHERE t.cluster_id = v_cluster AND t.pattern_type = 'CHIP_FLOW'
       AND t.window_start <= v_from AND t.window_end >= v_to
       AND NOT EXISTS (
         SELECT 1 FROM public.ca_collusion_signals x
          WHERE (x.detail ->> 'signal') = 'lightning_chip_flow'
            AND (x.detail ->> 'lightning_signal_id') = t.id::text)
    ON CONFLICT ((detail ->> 'lightning_signal_id')) WHERE ((detail ->> 'signal') = 'lightning_chip_flow') DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_mirrored := v_mirrored + v_n;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'window_from', v_from,
    'window_to', v_to,
    'window_clamped', v_clamped,
    'clusters_scanned', v_scanned,
    'hands_scanned', v_hand_sum,
    'budget_hit', v_budget,
    'written', v_counts,
    'chip_flow_mirrored', v_mirrored,
    'engine_reported', jsonb_build_array('DECISION_LATENCY', 'TIMING_CORRELATION'),
    'thresholds', jsonb_build_object(
      'pair_min_hands', c_pair_min_hands, 'pair_min_ratio', c_pair_min_ratio,
      'flow_min_opposed_hands', c_flow_min_hands, 'flow_min_direction', c_flow_min_dir,
      'flow_min_win_share', c_flow_min_win, 'join_window_seconds', c_join_window_s,
      'join_min_sessions', c_join_min, 'long_session_hours', c_long_hours,
      'link_min_hands', c_link_min_hands, 'max_hands', c_max_hands,
      'max_sessions', c_max_sessions, 'max_clusters', c_max_clusters,
      'flow_min_z', c_flow_min_z, 'flow_min_gross_bb', c_flow_min_gross_bb,
      'long_session_max_score', c_long_max_score, 'pairing_expectation', 'co_presence',
      'join_leave_counts', 'player_initiated', 'findings', 'extend_per_subject'));
END
$function$

-- A CLEARED PAIR STAYS CLEARED, AND 'dismissed' WAS NEVER A STATUS.
--
-- Phase 2 verification pass, same day. Probing every new write path inside a
-- rolled-back transaction found two defects in the phase 2 work itself.
--
-- 1. fn_ca_dismiss_collusion_pair COULD NEVER HAVE WORKED. It wrote
--    status = 'dismissed'. collusion_tracking's own check constraint allows
--    open | reviewed | cleared | actioned, so every use of the Clear button
--    would have thrown a raw constraint violation at the operator. I inherited
--    the word from detect_collusion_pairs, which has always filtered
--    `status <> 'dismissed'` - a predicate that is TRUE for every row in the
--    table, because no row can ever hold that value. That filter has never
--    excluded anything.
--
-- 2. AND THAT MATTERS FAR MORE THAN THE TYPO, because of what the table
--    actually holds:
--
--      cleared   169,523      open   7
--
--    169,519 of those carry the note "Auto-cleared 2026-08-18: both players
--    are house-run AI horses, which cannot collude with each other. Detector
--    fixed at write time in smarter-poker-workers edf5691." The detector used
--    to raise horse-versus-horse pairs, that was fixed at the source, and the
--    bad rows were closed out. Not one of them was reviewed by a person
--    (reviewed_by is NULL on all 169,523).
--
--    So the phase 2 scoping fix - which correctly stopped filtering by
--    club_members and started asking where the hands were played - was reading
--    through a filter that let every auto-cleared row back in, and would have
--    shown this club's operator 5,591 pairs that a known detector bug had
--    already accounted for. Replacing "0 pairs, wrongly" with "5,591 pairs,
--    wrongly" is not an improvement.
--
--    The queue is the rows the detector left OPEN. For this club that is zero,
--    and zero is the truth. The count of what was cleared in the window is
--    returned alongside it, so an operator can see that the screen ran and
--    closed itself rather than wondering where the numbers went.
--
--    NOTE ON THE HORSE LAW (CLAUDE.md 10.5). This does not exclude horses from
--    anything. The horse-versus-horse ruling was made by the team that owns
--    the detector, at write time, and is recorded in the row. Re-surfacing rows
--    they closed would be second-guessing that ruling from a page that has no
--    standing to make it.
--
-- 3. The second group was labelled "win rate" while carrying every pattern that
--    is not CHIP_DUMP. There are seven pattern types, and three of the seven
--    rows currently open on the estate are TIMING_CORRELATION - which that
--    label would have called a win-rate outlier. It is `screening` now, and
--    every row already carries its own pattern_type.

CREATE OR REPLACE FUNCTION public.detect_collusion_pairs(
  p_club_id   uuid,
  p_threshold numeric DEFAULT 0.75,
  p_min_hands integer DEFAULT 5
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_analyzed   bigint;
  v_players    integer;
  v_dump       jsonb;
  v_dump_total integer;
  v_screen       jsonb;
  v_screen_total integer;
  v_cleared    integer;
  v_cap        constant integer := 50;
BEGIN
  IF NOT fn_ca_can_review_integrity(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  -- club_hand_daily is the maintained per-hand rollup; counting hand_history
  -- for the same answer cost 448ms against its 75ms.
  SELECT coalesce(sum(d.hands), 0)
    INTO v_analyzed
    FROM club_hand_daily d
   WHERE d.club_id = p_club_id
     AND d.stat_date > current_date - 30;

  SELECT count(DISTINCT ts.user_id)::integer
    INTO v_players
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
   WHERE t.club_id = p_club_id AND ts.user_id IS NOT NULL;

  WITH club_players AS MATERIALIZED (
    SELECT DISTINCT ts.user_id
      FROM table_seats ts
      JOIN tables t ON t.id = ts.table_id
     WHERE t.club_id = p_club_id AND ts.user_id IS NOT NULL
  ),
  in_scope AS (
    SELECT ct.player_a, ct.player_b, ct.pattern_type, ct.suspicion_score,
           ct.evidence, coalesce(ct.status, 'open') AS status
      FROM collusion_tracking ct
     WHERE ct.scan_date > current_date - 30
       AND EXISTS (SELECT 1 FROM club_players p WHERE p.user_id = ct.player_a)
       AND EXISTS (SELECT 1 FROM club_players p WHERE p.user_id = ct.player_b)
  ),
  paired AS (
    SELECT s.player_a, s.player_b, s.pattern_type,
           max(s.suspicion_score) AS score,
           coalesce(max((s.evidence->>'hands_together')::numeric),
                    max((s.evidence->>'hands')::numeric), 0)::integer AS hands_together,
           (array_agg(s.evidence ORDER BY s.suspicion_score DESC))[1] AS evidence
      FROM in_scope s
     WHERE s.status = 'open'
     GROUP BY s.player_a, s.player_b, s.pattern_type
    HAVING max(s.suspicion_score) >= p_threshold * 100
       AND coalesce(max((s.evidence->>'hands_together')::numeric),
                    max((s.evidence->>'hands')::numeric), p_min_hands) >= p_min_hands
  ),
  ranked AS (
    SELECT p.pattern_type,
           row_number() OVER (PARTITION BY (p.pattern_type = 'CHIP_DUMP') ORDER BY p.score DESC) AS rn,
           jsonb_build_object(
             'dumper_id', p.player_a,
             'receiver_id', p.player_b,
             'pattern_type', p.pattern_type,
             'hands_together', p.hands_together,
             'score', p.score,
             'chip_flow_ratio', round(p.score / 100.0, 2),
             'severity', CASE WHEN p.score >= 90 THEN 'high'
                              WHEN p.score >= 75 THEN 'medium'
                              ELSE 'low' END,
             'evidence', p.evidence) AS payload
      FROM paired p
  )
  SELECT
    count(*) FILTER (WHERE pattern_type = 'CHIP_DUMP')::integer,
    count(*) FILTER (WHERE pattern_type <> 'CHIP_DUMP')::integer,
    coalesce(jsonb_agg(payload) FILTER (WHERE pattern_type = 'CHIP_DUMP' AND rn <= v_cap), '[]'::jsonb),
    coalesce(jsonb_agg(payload) FILTER (WHERE pattern_type <> 'CHIP_DUMP' AND rn <= v_cap), '[]'::jsonb),
    (SELECT count(DISTINCT (player_a, player_b))::integer FROM in_scope WHERE status <> 'open')
    INTO v_dump_total, v_screen_total, v_dump, v_screen, v_cleared
  FROM ranked;

  RETURN jsonb_build_object(
    'analyzed_hands', coalesce(v_analyzed, 0),
    'club_players', coalesce(v_players, 0),
    'window_days', 30,
    'threshold', p_threshold,
    'cap', v_cap,
    'closed_pairs', coalesce(v_cleared, 0),
    'chip_dump', jsonb_build_object('total', coalesce(v_dump_total, 0), 'pairs', coalesce(v_dump, '[]'::jsonb)),
    'screening', jsonb_build_object('total', coalesce(v_screen_total, 0), 'pairs', coalesce(v_screen, '[]'::jsonb)),
    'generated_at', now());
END;
$$;

REVOKE ALL ON FUNCTION public.detect_collusion_pairs(uuid, numeric, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.detect_collusion_pairs(uuid, numeric, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.detect_collusion_pairs(uuid, numeric, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.detect_collusion_pairs(uuid, numeric, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_dismiss_collusion_pair(
  p_club_id  uuid,
  p_player_a uuid,
  p_player_b uuid,
  p_note     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF NOT fn_ca_can_review_integrity(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM table_seats ts JOIN tables t ON t.id = ts.table_id
     WHERE t.club_id = p_club_id AND ts.user_id = p_player_a
  ) OR NOT EXISTS (
    SELECT 1 FROM table_seats ts JOIN tables t ON t.id = ts.table_id
     WHERE t.club_id = p_club_id AND ts.user_id = p_player_b
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pair_did_not_play_here', 'updated', 0);
  END IF;

  -- 'cleared', not 'dismissed'. The check constraint on this table allows
  -- open | reviewed | cleared | actioned, and the word this function used to
  -- write is in none of them.
  UPDATE collusion_tracking ct
     SET status = 'cleared',
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         notes = nullif(btrim(coalesce(p_note, '')), ''),
         updated_at = now()
   WHERE ct.scan_date > current_date - 30
     AND coalesce(ct.status, 'open') = 'open'
     AND ((ct.player_a = p_player_a AND ct.player_b = p_player_b)
       OR (ct.player_a = p_player_b AND ct.player_b = p_player_a));

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN jsonb_build_object('ok', v_updated > 0, 'updated', v_updated);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_ca_dismiss_collusion_pair(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_dismiss_collusion_pair(uuid, uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_dismiss_collusion_pair(uuid, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_dismiss_collusion_pair(uuid, uuid, uuid, text) TO service_role;

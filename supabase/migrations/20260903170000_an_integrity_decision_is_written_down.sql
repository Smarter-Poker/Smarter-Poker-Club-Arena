-- AN INTEGRITY DECISION IS WRITTEN DOWN.
--
-- Phase 2 of the club operations upgrade. Four pages, and on three of them a
-- control reported success while writing nothing at all:
--
--   * Anti-Cheat "Submit Review" ran a client UPDATE on anti_cheat_flags. That
--     table has one policy for `authenticated` (read your own flags) and no
--     UPDATE policy, so PostgREST returned 204 with zero rows and no error, and
--     the page said "Flag reviewed successfully". No decision has ever been
--     recorded.
--   * Dispute "Start Review" and "Escalate" ran client UPDATEs on `disputes`,
--     which carries exactly one policy - SELECT. Zero rows, an exception, and
--     "Failed to start review". The open -> under_review transition has never
--     been reachable, so the page's own `under_review` filter can never fill.
--   * The Anti-Cheat page sent the club SLUG into every uuid argument (it takes
--     the route param and never resolves it), so every query answered 22P02 and
--     every catch block turned that into an empty state. The page has always
--     shown six zeros and the words "Club Is Clean". That half is a client fix;
--     what is here is the half that has to exist for the fixed client to have
--     anything to read.
--
-- WHAT THIS ADDS
--
-- One gate, `fn_ca_can_review_integrity`, so five functions cannot drift apart
-- about who may look. It is the club's owner (by clubs.owner_id or by role),
-- co-owner, admin, or a platform admin - the same set the two existing
-- detectors already enforce inline, and the set the anti_cheat_events RLS
-- policy already uses. The navigation registry moves anti-cheat from 'staff' to
-- 'control' in the same change, because an agent could open a page on which
-- every single read raises.
--
-- THE FLAGS HAVE NO CLUB, AND CANNOT BE GIVEN ONE. All fourteen rows in
-- anti_cheat_flags carry club_id NULL *and* table_id NULL: they are
-- multi_account flags about a person, raised platform-side, with nothing to
-- derive a club from. So this does not backfill an invented club. It scopes a
-- flag to a club the way phase 1 scoped a player report - the flag belongs to
-- your operators when the flagged player is one of your members - and it does
-- that inside a SECURITY DEFINER function rather than by opening the table with
-- a new RLS policy.
--
-- THE COLLUSION TAB WAS MEASURING THE WRONG THING, TWICE. detect_collusion_pairs
-- required BOTH players to hold a club_members row in the club being viewed.
-- Measured on the largest club on the estate: 38,267 tracking rows in the
-- window, 0 pairs. Scope it by where the hands were actually played - both
-- players sat at one of this club's tables - and the same window yields 5,591
-- pairs. That is not a queue anybody can work, and shipping it as one would
-- replace a false "Club Is Clean" with a false "5,591 suspected colluders".
--
-- The reason is that two different detectors write into one table:
--
--   CHIP_DUMP           3 pairs   evidence: hands, loser_loss_ratio, pot_volume
--   WIN_RATE_ANOMALY    5,588 pairs  evidence: bb_per_100, direction, hands_together
--
-- The page's own copy says "one-directional chip flow" and "chip-dumping
-- patterns" - that is CHIP_DUMP, three pairs, an actionable queue. A win-rate
-- outlier is a screening signal, not an accusation, and it now returns as its
-- own group with its own total so it can be shown as what it is.
--
-- `net_chips_transferred` is dropped from the payload: zero of the 169,530
-- tracking rows carry that evidence key, so COALESCE made it a column of
-- zeroes, and the CSV exported the same zeroes. The evidence each detector
-- actually recorded is passed through instead.
--
-- COST. collusion_tracking had one index - its primary key - and the page scans
-- it by scan_date on every visit. Two indexes here, sized to the query.

-- ── One gate for every integrity surface ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_can_review_integrity(p_club_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT p_club_id IS NOT NULL
     AND auth.uid() IS NOT NULL
     AND (
       coalesce(fn_is_platform_admin(), false)
       OR EXISTS (SELECT 1 FROM clubs c WHERE c.id = p_club_id AND c.owner_id = auth.uid())
       OR EXISTS (
         SELECT 1 FROM club_members cm
          WHERE cm.club_id = p_club_id
            AND cm.user_id = auth.uid()
            AND cm.role IN ('owner', 'co_owner', 'admin')
            AND coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')
       )
     );
$$;

REVOKE ALL ON FUNCTION public.fn_ca_can_review_integrity(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_can_review_integrity(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_can_review_integrity(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_can_review_integrity(uuid) TO service_role;

-- ── The flags a club may see, and the decision it may record ────────────────
CREATE OR REPLACE FUNCTION public.fn_club_anti_cheat_flags(
  p_club_id uuid,
  p_status  text DEFAULT 'open',
  p_limit   integer DEFAULT 50
)
RETURNS TABLE (
  id uuid,
  player_id uuid,
  club_id uuid,
  table_id uuid,
  flag_type text,
  reason text,
  severity text,
  status text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_notes text,
  flagged_at timestamptz,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT fn_ca_can_review_integrity(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT f.id, f.player_id, f.club_id, f.table_id, f.flag_type, f.reason, f.severity,
         f.status, f.reviewed_by, f.reviewed_at, f.review_notes, f.flagged_at, f.created_at
    FROM anti_cheat_flags f
   WHERE (
           f.club_id = p_club_id
           OR (f.club_id IS NULL AND EXISTS (
                 SELECT 1 FROM club_members cm
                  WHERE cm.club_id = p_club_id AND cm.user_id = f.player_id))
         )
     AND (p_status IS NULL OR p_status = 'all' OR coalesce(f.status, 'open') = p_status)
   ORDER BY coalesce(f.flagged_at, f.created_at) DESC
   LIMIT greatest(1, least(coalesce(p_limit, 50), 200));
END;
$$;

REVOKE ALL ON FUNCTION public.fn_club_anti_cheat_flags(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_club_anti_cheat_flags(uuid, text, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_club_anti_cheat_flags(uuid, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_anti_cheat_flags(uuid, text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_review_anti_cheat_flag(
  p_club_id uuid,
  p_flag_id uuid,
  p_status  text,
  p_notes   text DEFAULT NULL
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

  IF coalesce(p_status, '') NOT IN ('reviewed', 'dismissed', 'actioned') THEN
    RAISE EXCEPTION 'a flag can only be reviewed, dismissed or actioned'
      USING ERRCODE = '22023';
  END IF;

  UPDATE anti_cheat_flags f
     SET status = p_status,
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         review_notes = nullif(btrim(coalesce(p_notes, '')), '')
   WHERE f.id = p_flag_id
     AND (
           f.club_id = p_club_id
           OR (f.club_id IS NULL AND EXISTS (
                 SELECT 1 FROM club_members cm
                  WHERE cm.club_id = p_club_id AND cm.user_id = f.player_id))
         );

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- Zero rows is a failure, not a quiet success. It is the exact shape the old
  -- client UPDATE hid.
  IF v_updated = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'flag_not_in_this_club', 'updated', 0);
  END IF;

  INSERT INTO anti_cheat_events (club_id, player_id, event_type, details, triggered_by)
  SELECT p_club_id, f.player_id, 'flag_' || p_status,
         jsonb_build_object('flag_id', f.id, 'flag_type', f.flag_type,
                            'severity', f.severity, 'notes', f.review_notes),
         auth.uid()
    FROM anti_cheat_flags f
   WHERE f.id = p_flag_id;

  RETURN jsonb_build_object('ok', true, 'updated', v_updated, 'status', p_status);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_review_anti_cheat_flag(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_review_anti_cheat_flag(uuid, uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_review_anti_cheat_flag(uuid, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_review_anti_cheat_flag(uuid, uuid, text, text) TO service_role;

-- ── The overview numbers, in the shape the page actually reads ──────────────
-- The old body returned total_hands_analyzed, flagged_players, active_
-- investigations, collusion_alerts, bot_suspicions, chip_dumping_alerts and
-- last_scan. The page reads open_flags, blocks_24h, active_sessions,
-- by_severity and by_type. Not one key matched, five of the seven were the
-- literal 0, and fmt(undefined) renders "0", so the panel has always been six
-- zeros. It was also the only one of the three detectors that was not SECURITY
-- DEFINER and carried no authorization check of its own.
-- The old one returned `json`, so a replace cannot change the type. Dropped and
-- recreated inside this transaction: no session sees a gap, and the grants
-- below re-establish what the drop takes away.
DROP FUNCTION IF EXISTS public.get_anti_cheat_stats(uuid);

CREATE OR REPLACE FUNCTION public.get_anti_cheat_stats(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_open        integer;
  v_enforcement integer;
  v_seated      integer;
  v_severity    jsonb;
  v_type        jsonb;
BEGIN
  IF NOT fn_ca_can_review_integrity(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  WITH scoped AS (
    SELECT coalesce(f.severity, 'unknown') AS severity,
           coalesce(f.flag_type, 'unknown') AS flag_type
      FROM anti_cheat_flags f
     WHERE coalesce(f.status, 'open') = 'open'
       AND (
             f.club_id = p_club_id
             OR (f.club_id IS NULL AND EXISTS (
                   SELECT 1 FROM club_members cm
                    WHERE cm.club_id = p_club_id AND cm.user_id = f.player_id))
           )
  )
  SELECT
    (SELECT count(*) FROM scoped)::integer,
    (SELECT coalesce(jsonb_object_agg(x.severity, x.n), '{}'::jsonb)
       FROM (SELECT severity, count(*) AS n FROM scoped GROUP BY 1) x),
    (SELECT coalesce(jsonb_object_agg(y.flag_type, y.n), '{}'::jsonb)
       FROM (SELECT flag_type, count(*) AS n FROM scoped GROUP BY 1) y)
    INTO v_open, v_severity, v_type;

  SELECT count(*)::integer
    INTO v_enforcement
    FROM anti_cheat_events e
   WHERE e.club_id = p_club_id
     AND e.created_at > now() - interval '24 hours'
     AND (e.event_type ILIKE '%kick%' OR e.event_type ILIKE '%block%'
          OR e.event_type ILIKE '%ban%' OR e.event_type ILIKE '%flag_actioned%');

  SELECT count(DISTINCT ts.user_id)::integer
    INTO v_seated
    FROM table_seats ts
    JOIN tables tb ON tb.id = ts.table_id
   WHERE tb.club_id = p_club_id
     AND ts.left_at IS NULL
     AND ts.user_id IS NOT NULL
     AND tb.status IN ('running', 'waiting', 'active');

  RETURN jsonb_build_object(
    'open_flags', coalesce(v_open, 0),
    'blocks_24h', coalesce(v_enforcement, 0),
    'active_sessions', coalesce(v_seated, 0),
    'by_severity', coalesce(v_severity, '{}'::jsonb),
    'by_type', coalesce(v_type, '{}'::jsonb),
    'generated_at', now());
END;
$$;

REVOKE ALL ON FUNCTION public.get_anti_cheat_stats(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_anti_cheat_stats(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_anti_cheat_stats(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_anti_cheat_stats(uuid) TO service_role;

-- ── Collusion: the club's own hands, and the two detectors kept apart ───────
CREATE INDEX IF NOT EXISTS idx_collusion_tracking_window
  ON public.collusion_tracking (scan_date DESC, pattern_type)
  WHERE status <> 'dismissed';

CREATE INDEX IF NOT EXISTS idx_collusion_tracking_pair
  ON public.collusion_tracking (player_a, player_b);

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
  v_analyzed   integer;
  v_players    integer;
  v_dump       jsonb;
  v_dump_total integer;
  v_rate       jsonb;
  v_rate_total integer;
  v_cap        constant integer := 50;
BEGIN
  IF NOT fn_ca_can_review_integrity(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_analyzed
    FROM hand_history hh
    JOIN tables t ON t.id = hh.table_id
   WHERE t.club_id = p_club_id
     AND hh.created_at > now() - interval '30 days';

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
  scoped AS (
    SELECT ct.player_a, ct.player_b, ct.pattern_type, ct.suspicion_score, ct.evidence
      FROM collusion_tracking ct
     WHERE ct.scan_date > current_date - 30
       AND coalesce(ct.status, 'open') <> 'dismissed'
       AND EXISTS (SELECT 1 FROM club_players p WHERE p.user_id = ct.player_a)
       AND EXISTS (SELECT 1 FROM club_players p WHERE p.user_id = ct.player_b)
  ),
  paired AS (
    SELECT s.player_a, s.player_b, s.pattern_type,
           max(s.suspicion_score) AS score,
           coalesce(max((s.evidence->>'hands_together')::numeric),
                    max((s.evidence->>'hands')::numeric), 0)::integer AS hands_together,
           (array_agg(s.evidence ORDER BY s.suspicion_score DESC))[1] AS evidence
      FROM scoped s
     GROUP BY s.player_a, s.player_b, s.pattern_type
    HAVING max(s.suspicion_score) >= p_threshold * 100
       AND coalesce(max((s.evidence->>'hands_together')::numeric),
                    max((s.evidence->>'hands')::numeric), p_min_hands) >= p_min_hands
  )
  SELECT
    count(*) FILTER (WHERE pattern_type = 'CHIP_DUMP')::integer,
    count(*) FILTER (WHERE pattern_type <> 'CHIP_DUMP')::integer,
    coalesce(jsonb_agg(payload) FILTER (WHERE pattern_type = 'CHIP_DUMP' AND rn <= v_cap), '[]'::jsonb),
    coalesce(jsonb_agg(payload) FILTER (WHERE pattern_type <> 'CHIP_DUMP' AND rn <= v_cap), '[]'::jsonb)
    INTO v_dump_total, v_rate_total, v_dump, v_rate
  FROM (
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
  ) ranked;

  RETURN jsonb_build_object(
    'analyzed_hands', coalesce(v_analyzed, 0),
    'club_players', coalesce(v_players, 0),
    'window_days', 30,
    'threshold', p_threshold,
    'cap', v_cap,
    'chip_dump', jsonb_build_object('total', coalesce(v_dump_total, 0), 'pairs', coalesce(v_dump, '[]'::jsonb)),
    'win_rate', jsonb_build_object('total', coalesce(v_rate_total, 0), 'pairs', coalesce(v_rate, '[]'::jsonb)),
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

  -- Both players must have played at this club, or this club has no standing
  -- to clear the pair.
  IF NOT EXISTS (
    SELECT 1 FROM table_seats ts JOIN tables t ON t.id = ts.table_id
     WHERE t.club_id = p_club_id AND ts.user_id = p_player_a
  ) OR NOT EXISTS (
    SELECT 1 FROM table_seats ts JOIN tables t ON t.id = ts.table_id
     WHERE t.club_id = p_club_id AND ts.user_id = p_player_b
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pair_did_not_play_here', 'updated', 0);
  END IF;

  UPDATE collusion_tracking ct
     SET status = 'dismissed',
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         notes = nullif(btrim(coalesce(p_note, '')), ''),
         updated_at = now()
   WHERE ct.scan_date > current_date - 30
     AND coalesce(ct.status, 'open') <> 'dismissed'
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

-- ── The two dispute transitions that have never worked ─────────────────────
CREATE OR REPLACE FUNCTION public.fn_dispute_start_review(p_dispute_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_club   uuid;
  v_status text;
BEGIN
  SELECT d.club_id, coalesce(d.status, 'open') INTO v_club, v_status
    FROM disputes d WHERE d.id = p_dispute_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispute not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT fn_ca_can_review_integrity(v_club) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;
  IF v_status <> 'open' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_open', 'status', v_status);
  END IF;

  UPDATE disputes
     SET status = 'under_review',
         assigned_to = auth.uid(),
         updated_at = now()
   WHERE id = p_dispute_id;

  RETURN jsonb_build_object('ok', true, 'status', 'under_review', 'assigned_to', auth.uid());
END;
$$;

REVOKE ALL ON FUNCTION public.fn_dispute_start_review(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_dispute_start_review(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_dispute_start_review(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_dispute_start_review(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_dispute_escalate(p_dispute_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_club   uuid;
  v_status text;
BEGIN
  SELECT d.club_id, coalesce(d.status, 'open') INTO v_club, v_status
    FROM disputes d WHERE d.id = p_dispute_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispute not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT fn_ca_can_review_integrity(v_club) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;
  IF v_status IN ('resolved', 'escalated') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_' || v_status, 'status', v_status);
  END IF;

  UPDATE disputes
     SET status = 'escalated',
         assigned_to = coalesce(assigned_to, auth.uid()),
         resolution = coalesce(nullif(btrim(coalesce(p_note, '')), ''), resolution),
         updated_at = now()
   WHERE id = p_dispute_id;

  RETURN jsonb_build_object('ok', true, 'status', 'escalated');
END;
$$;

REVOKE ALL ON FUNCTION public.fn_dispute_escalate(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_dispute_escalate(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_dispute_escalate(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_dispute_escalate(uuid, text) TO service_role;

COMMENT ON FUNCTION public.fn_ca_can_review_integrity(uuid) IS
  'The one gate for club integrity surfaces: club owner (by owner_id or by role), co-owner, admin, or platform admin. Shared by the flag list, the flag review, the club stats, the collusion detector and both dispute transitions so they cannot drift about who may look.';

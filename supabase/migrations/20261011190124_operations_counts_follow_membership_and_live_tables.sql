-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.ca_club_operations_overview(uuid)'::regprocedure) = 'f37429f441b5a31bceb13700d6b8d015' AND (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.ca_club_activity(uuid,integer)'::regprocedure) = 'c9d199dd6f2a4be40aa3846acabb5c98' AND (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_club_bomb_pot_report(uuid,integer)'::regprocedure) = 'db2daf3cd7367513cf219d75ea1377ba' AND (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_bomb_pot_rollup_day(uuid,date)'::regprocedure) = 'f8b2e4eda1ee5c7d75243f1448566ea2' AND (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.ca_club_dashboard_stats(uuid)'::regprocedure) = '0d64c2d9d5f63a68418ce21c4442b8f0'
-- Qualified club operations overview, activity and bomb-pot reporting repairs.
-- Version reserved by scripts/new-migration.mjs; exact live preimages read 2026-10-11.
-- Personnel readings follow the maintained roster. Financial sums stay unchanged.
BEGIN;
SET LOCAL lock_timeout = '3s';
DO $migration$
DECLARE v_definition text; v_old text; v_new text; v_post text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_definition FROM pg_proc
    WHERE oid = 'public.ca_club_operations_overview(uuid)'::regprocedure;
  IF md5(v_definition) <> 'ff2f0b8132efc1c1091594d230c990d6'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.ca_club_operations_overview(uuid)'::regprocedure)
       <> '56fce10a30115b2d8b84891229af5de7' THEN
    RAISE EXCEPTION 'Club operations overview changed; re-read and requalify its current definition';
  END IF;
  v_old := $old$  SELECT count(*) FILTER (
           WHERE coalesce(cm.status, 'active') NOT IN ('banned', 'suspended', 'pending')),
         count(*) FILTER (WHERE cm.status = 'pending'),
         count(*) FILTER (
           WHERE cm.created_at > now() - interval '7 days'
             AND coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')),
         coalesce(sum(cm.chip_balance) FILTER (
           WHERE coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')), 0)
    INTO v_members, v_pending, v_new7, v_member_chips
    FROM club_members cm
   WHERE cm.club_id = p_club_id;$old$;
  v_new := $new$  SELECT count(DISTINCT cm.user_id) FILTER (
           WHERE coalesce(cm.status, 'approved') IN ('active', 'approved')
             AND NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = cm.user_id AND pr.status = 'deleted')),
         count(*) FILTER (WHERE cm.status = 'pending'),
         count(DISTINCT cm.user_id) FILTER (
           WHERE cm.created_at > now() - interval '7 days'
             AND coalesce(cm.status, 'approved') IN ('active', 'approved')
             AND NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = cm.user_id AND pr.status = 'deleted')),
         coalesce(sum(cm.chip_balance) FILTER (
           WHERE coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')), 0)
    INTO v_members, v_pending, v_new7, v_member_chips
    FROM club_members cm
   WHERE cm.club_id = p_club_id;$new$;
  IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Club operations predicate must occur exactly once';
  END IF;
  v_definition := replace(v_definition,v_old,v_new);
  v_old := $old$  SELECT count(DISTINCT ts.user_id)
    INTO v_seated
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
   WHERE t.club_id = p_club_id
     AND ts.left_at IS NULL
     AND ts.user_id IS NOT NULL
     AND t.status IN ('running', 'waiting', 'active');$old$;
  v_new := $new$  SELECT count(DISTINCT ts.user_id)
    INTO v_seated
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
   WHERE (t.club_id = p_club_id OR ts.club_id = p_club_id)
     AND ts.left_at IS NULL
     AND ts.user_id IS NOT NULL
     AND t.status IN ('running', 'waiting')
     AND EXISTS (SELECT 1 FROM club_members cm
                  WHERE cm.club_id = p_club_id AND cm.user_id = ts.user_id
                    AND coalesce(cm.status, 'approved') IN ('active', 'approved'))
     AND NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = ts.user_id AND pr.status = 'deleted');$new$;
  IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Club operations predicate must occur exactly once';
  END IF;
  v_definition := replace(v_definition,v_old,v_new);
  v_old := $old$  SELECT count(*)
    INTO v_online
    FROM (
      SELECT ts.user_id
        FROM table_seats ts
        JOIN tables t ON t.id = ts.table_id
       WHERE t.club_id = p_club_id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
      UNION
      SELECT cm.user_id
        FROM club_members cm
       WHERE cm.club_id = p_club_id AND EXISTS (SELECT 1 FROM public.profiles pp WHERE pp.id = cm.user_id AND coalesce(pp.is_online, false) AND pp.last_seen > now() - interval '5 minutes')
    ) x;$old$;
  v_new := $new$  SELECT count(*)
    INTO v_online
    FROM (
      SELECT ts.user_id
        FROM table_seats ts
        JOIN tables t ON t.id = ts.table_id
       WHERE (t.club_id = p_club_id OR ts.club_id = p_club_id)
         AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
         AND t.status IN ('running', 'waiting')
         AND EXISTS (SELECT 1 FROM club_members cm
                      WHERE cm.club_id = p_club_id AND cm.user_id = ts.user_id
                        AND coalesce(cm.status, 'approved') IN ('active', 'approved'))
         AND NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = ts.user_id AND pr.status = 'deleted')
      UNION
      SELECT cm.user_id
        FROM club_members cm
       WHERE cm.club_id = p_club_id
         AND coalesce(cm.status, 'approved') IN ('active', 'approved')
         AND NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = cm.user_id AND pr.status = 'deleted')
         AND EXISTS (SELECT 1 FROM public.profiles pp WHERE pp.id = cm.user_id AND coalesce(pp.is_online, false) AND pp.last_seen > now() - interval '5 minutes')
    ) x;$new$;
  IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Club operations predicate must occur exactly once';
  END IF;
  v_definition := replace(v_definition,v_old,v_new);
  v_old := $old$  SELECT coalesce(d.hands, 0), coalesce(d.rake, 0)
    INTO v_hands_today, v_rake_today
    FROM club_hand_daily d
   WHERE d.club_id = p_club_id
     AND d.stat_date = (now() AT TIME ZONE 'UTC')::date;

  IF NOT FOUND THEN
    v_hands_today := 0;
    v_rake_today := 0;
  END IF;$old$;
  v_new := $new$  SELECT coalesce((
           SELECT d.hands FROM club_hand_daily d
            WHERE d.club_id = p_club_id
              AND d.stat_date = (now() AT TIME ZONE 'UTC')::date), 0),
         coalesce((
           SELECT d.rake FROM ca_club_rake_daily d
            WHERE d.club_id = p_club_id
              AND d.stat_date = (now() AT TIME ZONE 'UTC')::date), 0)
    INTO v_hands_today, v_rake_today;$new$;
  IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Club operations predicate must occur exactly once';
  END IF;
  v_definition := replace(v_definition,v_old,v_new);
  v_old := $old$   WHERE f.club_id = p_club_id AND coalesce(f.status, 'open') = 'open';$old$;
  v_new := $new$   WHERE coalesce(f.status, 'open') = 'open'
     AND (f.club_id = p_club_id OR
          (f.club_id IS NULL AND EXISTS (
             SELECT 1 FROM club_members cm
              WHERE cm.club_id = p_club_id AND cm.user_id = f.player_id)));$new$;
  IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Club operations predicate must occur exactly once';
  END IF;
  v_definition := replace(v_definition,v_old,v_new);
  EXECUTE v_definition;
  SELECT prosrc INTO v_post FROM pg_proc WHERE oid='public.ca_club_operations_overview(uuid)'::regprocedure;
  IF md5(v_post) <> 'f37429f441b5a31bceb13700d6b8d015' THEN
    RAISE EXCEPTION 'Club operations overview postimage differs from qualified source';
  END IF;
END $migration$;
-- The activity feed scopes the indexed hand branch before sorting the last
-- forty-eight hours. Live read-only equivalent query qualified separately.
DO $activity$
DECLARE v_definition text; v_old text; v_new text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_definition FROM pg_proc
    WHERE oid = 'public.ca_club_activity(uuid,integer)'::regprocedure;
  IF md5(v_definition) <> '6e4702f9aa88dabc1e472a399df319f1'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.ca_club_activity(uuid,integer)'::regprocedure)
       <> '50002a220d610b93ed9b368e619e321c' THEN
    RAISE EXCEPTION 'Club activity changed; re-read and requalify its current definition';
  END IF;
  v_old := $old$JOIN tables t ON t.id = hh.table_id
     WHERE t.club_id = p_club_id$old$;
  v_new := $new$WHERE hh.table_id = ANY(ARRAY(SELECT t.id FROM tables t WHERE t.club_id = p_club_id))$new$;
  IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Club activity hand predicate must occur exactly once';
  END IF;
  EXECUTE replace(v_definition,v_old,v_new);
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.ca_club_activity(uuid,integer)'::regprocedure)
     <> 'c9d199dd6f2a4be40aa3846acabb5c98' THEN
    RAISE EXCEPTION 'Club activity postimage differs from qualified source';
  END IF;
END $activity$;
DO $bomb$
DECLARE v_definition text; v_old text; v_new text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_definition FROM pg_proc WHERE oid='public.fn_club_bomb_pot_report(uuid,integer)'::regprocedure;
  IF md5(v_definition) <> 'a37016388c8957533a8a7f1e0b610065'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_club_bomb_pot_report(uuid,integer)'::regprocedure) <> '635cce48ca50b92c3ef235be220d7dc8' THEN
    RAISE EXCEPTION 'Bomb pot reporting source changed; re-read and requalify public.fn_club_bomb_pot_report(uuid,integer)';
  END IF;
  v_old := $old$JOIN public.tables t ON t.id = h.table_id
         WHERE t.club_id = p_club_id$old$;
  v_new := $new$WHERE h.table_id = ANY(ARRAY(SELECT t.id FROM public.tables t WHERE t.club_id = p_club_id))$new$;
  IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Bomb pot reporting predicate must occur exactly once';
  END IF;
  EXECUTE replace(v_definition,v_old,v_new);
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_club_bomb_pot_report(uuid,integer)'::regprocedure) <> 'db2daf3cd7367513cf219d75ea1377ba' THEN
    RAISE EXCEPTION 'Bomb pot reporting postimage differs from qualified source';
  END IF;
END $bomb$;
DO $bomb$
DECLARE v_definition text; v_old text; v_new text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_definition FROM pg_proc WHERE oid='public.fn_ca_bomb_pot_rollup_day(uuid,date)'::regprocedure;
  IF md5(v_definition) <> '78e78fee19b842a9b54ed9703784551e'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_bomb_pot_rollup_day(uuid,date)'::regprocedure) <> '6689c8e2239d64a0d5dad645dc69a282' THEN
    RAISE EXCEPTION 'Bomb pot reporting source changed; re-read and requalify public.fn_ca_bomb_pot_rollup_day(uuid,date)';
  END IF;
  v_old := $old$JOIN public.tables t ON t.id = h.table_id
     WHERE t.club_id = p_club_id$old$;
  v_new := $new$WHERE h.table_id = ANY(ARRAY(SELECT t.id FROM public.tables t WHERE t.club_id = p_club_id))$new$;
  IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Bomb pot reporting predicate must occur exactly once';
  END IF;
  EXECUTE replace(v_definition,v_old,v_new);
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_bomb_pot_rollup_day(uuid,date)'::regprocedure) <> 'f8b2e4eda1ee5c7d75243f1448566ea2' THEN
    RAISE EXCEPTION 'Bomb pot reporting postimage differs from qualified source';
  END IF;
END $bomb$;
-- The full dashboard shares the roster's personnel definition; all other
-- daily/weekly financial statistics and their date boundaries stay unchanged.
DO $dashboard$
DECLARE v_definition text; v_old text; v_new text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_definition FROM pg_proc WHERE oid='public.ca_club_dashboard_stats(uuid)'::regprocedure;
  IF md5(v_definition) <> 'f82002cb3b36a4454a9f6e17af141985'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.ca_club_dashboard_stats(uuid)'::regprocedure) <> 'e9df60b641c83580253c29cac60f53bd' THEN
    RAISE EXCEPTION 'Club dashboard source changed; re-read and requalify its current definition';
  END IF;
  v_old := $old$    'total_members', (
      SELECT count(*) FROM club_members cm
      WHERE cm.club_id = p_club_id
        AND coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')
    ),
$old$;
  v_new := $new$    'total_members', (
      SELECT count(DISTINCT cm.user_id) FROM club_members cm
      WHERE cm.club_id = p_club_id
        AND coalesce(cm.status, 'approved') IN ('active', 'approved')
        AND NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = cm.user_id AND pr.status = 'deleted')
    ),
$new$;
  IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Club dashboard personnel predicate must occur exactly once';
  END IF;
  v_definition := replace(v_definition,v_old,v_new);
  v_old := $old$    'online_now', (
      SELECT count(*) FROM (
        SELECT ts.user_id
        FROM table_seats ts
        JOIN tables t ON t.id = ts.table_id
        WHERE t.club_id = p_club_id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
        UNION
        SELECT cm.user_id FROM club_members cm
        WHERE cm.club_id = p_club_id
          AND EXISTS (SELECT 1 FROM public.profiles pp WHERE pp.id = cm.user_id AND coalesce(pp.is_online, false) AND pp.last_seen > now() - interval '5 minutes')
      ) x
    ),
$old$;
  v_new := $new$    'online_now', (
      SELECT count(*) FROM (
        SELECT ts.user_id
        FROM table_seats ts
        JOIN tables t ON t.id = ts.table_id
        WHERE (t.club_id = p_club_id OR ts.club_id = p_club_id)
          AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
          AND t.status IN ('running', 'waiting')
          AND EXISTS (SELECT 1 FROM club_members cm
                       WHERE cm.club_id = p_club_id AND cm.user_id = ts.user_id
                         AND coalesce(cm.status, 'approved') IN ('active', 'approved'))
          AND NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = ts.user_id AND pr.status = 'deleted')
        UNION
        SELECT cm.user_id FROM club_members cm
        WHERE cm.club_id = p_club_id
          AND coalesce(cm.status, 'approved') IN ('active', 'approved')
          AND NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = cm.user_id AND pr.status = 'deleted')
          AND EXISTS (SELECT 1 FROM public.profiles pp WHERE pp.id = cm.user_id AND coalesce(pp.is_online, false) AND pp.last_seen > now() - interval '5 minutes')
      ) x
    ),
$new$;
  IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Club dashboard personnel predicate must occur exactly once';
  END IF;
  v_definition := replace(v_definition,v_old,v_new);
  v_old := $old$    'new_this_week', (
      SELECT count(*) FROM club_members cm
      WHERE cm.club_id = p_club_id AND cm.created_at > now() - interval '7 days'
    ),
$old$;
  v_new := $new$    'new_this_week', (
      SELECT count(DISTINCT cm.user_id) FROM club_members cm
      WHERE cm.club_id = p_club_id AND cm.created_at > now() - interval '7 days'
        AND coalesce(cm.status, 'approved') IN ('active', 'approved')
        AND NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = cm.user_id AND pr.status = 'deleted')
    ),
$new$;
  IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Club dashboard personnel predicate must occur exactly once';
  END IF;
  v_definition := replace(v_definition,v_old,v_new);
  v_old := $old$    'seated_now', (
      SELECT count(DISTINCT ts.user_id)
      FROM table_seats ts JOIN tables t ON t.id = ts.table_id
      WHERE t.club_id = p_club_id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
    ),
$old$;
  v_new := $new$    'seated_now', (
      SELECT count(DISTINCT ts.user_id)
      FROM table_seats ts JOIN tables t ON t.id = ts.table_id
      WHERE (t.club_id = p_club_id OR ts.club_id = p_club_id)
        AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
        AND t.status IN ('running', 'waiting')
        AND EXISTS (SELECT 1 FROM club_members cm
                     WHERE cm.club_id = p_club_id AND cm.user_id = ts.user_id
                       AND coalesce(cm.status, 'approved') IN ('active', 'approved'))
        AND NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = ts.user_id AND pr.status = 'deleted')
    ),
$new$;
  IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Club dashboard personnel predicate must occur exactly once';
  END IF;
  v_definition := replace(v_definition,v_old,v_new);
  EXECUTE v_definition;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.ca_club_dashboard_stats(uuid)'::regprocedure) <> '0d64c2d9d5f63a68418ce21c4442b8f0' THEN
    RAISE EXCEPTION 'Club dashboard postimage differs from qualified source';
  END IF;
END $dashboard$;
COMMIT;

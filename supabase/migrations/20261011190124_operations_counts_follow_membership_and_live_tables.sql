-- Operations readings follow accepted membership and live table presence.
-- Version reserved with scripts/new-migration.mjs.
-- Correct membership/presence counts, cash rake source and inherited integrity counts; no wallet, ledger, grant or role changes.
-- Live preimage read from kuklfnapbkmacvwxktbh on 2026-10-11.
BEGIN;
SET LOCAL lock_timeout = '3s';
DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
  v_post text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_definition
    FROM pg_proc p WHERE p.oid = 'public.ca_club_operations_overview(uuid)'::regprocedure;
  IF md5(v_definition) <> 'ff2f0b8132efc1c1091594d230c990d6'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.ca_club_operations_overview(uuid)'::regprocedure)
       <> '56fce10a30115b2d8b84891229af5de7' THEN
    RAISE EXCEPTION 'Club operations overview changed; re-read and requalify its current definition';
  END IF;
  v_old := $old$WHERE cm.created_at > now() - interval '7 days'
             AND coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')$old$;
  v_new := $new$WHERE cm.created_at > now() - interval '7 days'
             AND coalesce(cm.status, 'active') NOT IN ('banned', 'suspended', 'pending')$new$;
  IF (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Club operations counting predicate must occur exactly once';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  v_old := $old$WHERE t.club_id = p_club_id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
      UNION$old$;
  v_new := $new$WHERE t.club_id = p_club_id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
         AND t.status IN ('running', 'waiting', 'active')
      UNION$new$;
  IF (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Club operations counting predicate must occur exactly once';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  v_old := $old$WHERE cm.club_id = p_club_id AND EXISTS (SELECT 1 FROM public.profiles pp$old$;
  v_new := $new$WHERE cm.club_id = p_club_id
         AND coalesce(cm.status, 'active') IN ('active', 'approved', 'automatic')
         AND EXISTS (SELECT 1 FROM public.profiles pp$new$;
  IF (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Club operations counting predicate must occur exactly once';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
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
  IF (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Club operations rake predicate must occur exactly once';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  v_old := $old$   WHERE f.club_id = p_club_id AND coalesce(f.status, 'open') = 'open';$old$;
  v_new := $new$   WHERE coalesce(f.status, 'open') = 'open'
     AND (f.club_id = p_club_id OR
          (f.club_id IS NULL AND EXISTS (
             SELECT 1 FROM club_members cm
              WHERE cm.club_id = p_club_id AND cm.user_id = f.player_id)));$new$;
  IF (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Club operations inherited integrity predicate must occur exactly once';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  EXECUTE v_definition;
  SELECT prosrc INTO v_post FROM pg_proc
    WHERE oid = 'public.ca_club_operations_overview(uuid)'::regprocedure;
  IF md5(v_post) <> '0cc301a559126c36a249454976733a4c' THEN
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
COMMIT;

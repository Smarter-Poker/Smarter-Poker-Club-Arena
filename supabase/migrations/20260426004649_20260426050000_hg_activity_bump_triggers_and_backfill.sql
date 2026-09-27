-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260426004649 "20260426050000_hg_activity_bump_triggers_and_backfill"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3ee8901e0e1fc7b900a080f553fe607b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- See migration 20260426050000_hg_activity_bump_triggers_and_backfill.sql notes
-- (full description in commit). Same content as previous attempt with the
-- correct column name (responded_at) for commander_home_rsvps.

CREATE OR REPLACE FUNCTION public.fn_hg_trg_bump_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_group_id uuid;
BEGIN
  v_group_id := COALESCE(
    (CASE WHEN TG_OP = 'DELETE' THEN OLD.group_id ELSE NEW.group_id END)
  );
  IF v_group_id IS NOT NULL THEN
    UPDATE public.commander_home_groups
       SET last_activity_at = NOW()
     WHERE id = v_group_id
       AND (last_activity_at IS NULL OR last_activity_at < NOW());
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_hg_trg_bump_activity_via_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_group_id uuid;
  v_post_id  uuid := COALESCE(
    (CASE WHEN TG_OP = 'DELETE' THEN OLD.post_id ELSE NEW.post_id END)
  );
BEGIN
  IF v_post_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT group_id INTO v_group_id FROM public.commander_home_posts WHERE id = v_post_id;
  IF v_group_id IS NOT NULL THEN
    UPDATE public.commander_home_groups
       SET last_activity_at = NOW()
     WHERE id = v_group_id
       AND (last_activity_at IS NULL OR last_activity_at < NOW());
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_hg_trg_bump_activity_via_game()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_group_id uuid;
  v_game_id  uuid := COALESCE(
    (CASE WHEN TG_OP = 'DELETE' THEN OLD.game_id ELSE NEW.game_id END)
  );
BEGIN
  IF v_game_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT group_id INTO v_group_id FROM public.commander_home_games WHERE id = v_game_id;
  IF v_group_id IS NOT NULL THEN
    UPDATE public.commander_home_groups
       SET last_activity_at = NOW()
     WHERE id = v_group_id
       AND (last_activity_at IS NULL OR last_activity_at < NOW());
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_hg_bump_on_post ON public.commander_home_posts;
CREATE TRIGGER trg_hg_bump_on_post
  AFTER INSERT OR UPDATE ON public.commander_home_posts
  FOR EACH ROW EXECUTE FUNCTION public.fn_hg_trg_bump_activity();

DROP TRIGGER IF EXISTS trg_hg_bump_on_game ON public.commander_home_games;
CREATE TRIGGER trg_hg_bump_on_game
  AFTER INSERT OR UPDATE ON public.commander_home_games
  FOR EACH ROW EXECUTE FUNCTION public.fn_hg_trg_bump_activity();

DROP TRIGGER IF EXISTS trg_hg_bump_on_member ON public.commander_home_members;
CREATE TRIGGER trg_hg_bump_on_member
  AFTER INSERT OR UPDATE ON public.commander_home_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_hg_trg_bump_activity();

DROP TRIGGER IF EXISTS trg_hg_bump_on_comment ON public.commander_home_post_comments;
CREATE TRIGGER trg_hg_bump_on_comment
  AFTER INSERT ON public.commander_home_post_comments
  FOR EACH ROW EXECUTE FUNCTION public.fn_hg_trg_bump_activity_via_post();

DROP TRIGGER IF EXISTS trg_hg_bump_on_rsvp ON public.commander_home_rsvps;
CREATE TRIGGER trg_hg_bump_on_rsvp
  AFTER INSERT OR UPDATE ON public.commander_home_rsvps
  FOR EACH ROW EXECUTE FUNCTION public.fn_hg_trg_bump_activity_via_game();

DROP TRIGGER IF EXISTS trg_hg_bump_on_reservation ON public.commander_home_seat_reservations;
CREATE TRIGGER trg_hg_bump_on_reservation
  AFTER INSERT OR UPDATE ON public.commander_home_seat_reservations
  FOR EACH ROW EXECUTE FUNCTION public.fn_bump_group_activity_on_reservation();

-- Backfill (uses responded_at for rsvps)
WITH activity AS (
  SELECT g.id AS group_id, GREATEST(
    g.created_at,
    COALESCE((SELECT MAX(created_at) FROM commander_home_posts WHERE group_id = g.id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(created_at) FROM commander_home_games WHERE group_id = g.id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(joined_at)  FROM commander_home_members WHERE group_id = g.id AND status = 'approved'),
             '-infinity'::timestamptz),
    COALESCE((SELECT MAX(c.created_at) FROM commander_home_post_comments c
              JOIN commander_home_posts p ON p.id = c.post_id WHERE p.group_id = g.id),
             '-infinity'::timestamptz),
    COALESCE((SELECT MAX(r.responded_at) FROM commander_home_rsvps r
              JOIN commander_home_games gm ON gm.id = r.game_id WHERE gm.group_id = g.id),
             '-infinity'::timestamptz)
  ) AS computed_activity
  FROM commander_home_groups g
)
UPDATE public.commander_home_groups g
   SET last_activity_at = a.computed_activity
  FROM activity a
 WHERE g.id = a.group_id
   AND (g.last_activity_at IS NULL OR g.last_activity_at < a.computed_activity);

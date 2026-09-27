-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721185147 "agent_player_counts_trigger_reconcile_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a32a81ca66d14072da21c7570cca31e3 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Task #56: keep agents.total_players / active_player_count accurate.
-- Players link to an agent via club_members.agent_id (= the agent's user_id) scoped
-- by club_id. The counters were unmaintained and drifted (stored sum 90 vs actual
-- 184 across 6 agents). Fix = a recompute-on-change AFTER trigger + a one-time
-- reconcile. Recompute (not delta arithmetic) is self-healing and simple.

CREATE OR REPLACE FUNCTION public.fn_sync_agent_player_counts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  -- Recompute the OLD agent bucket (UPDATE/DELETE moving a player away).
  IF (TG_OP = 'UPDATE' OR TG_OP = 'DELETE') AND OLD.agent_id IS NOT NULL THEN
    UPDATE agents a SET
      total_players = (SELECT count(*) FROM club_members cm
                       WHERE cm.agent_id = OLD.agent_id AND cm.club_id = OLD.club_id),
      active_player_count = (SELECT count(*) FROM club_members cm
                       WHERE cm.agent_id = OLD.agent_id AND cm.club_id = OLD.club_id AND cm.is_active IS TRUE)
    WHERE a.user_id = OLD.agent_id AND a.club_id = OLD.club_id;
  END IF;

  -- Recompute the NEW agent bucket (INSERT/UPDATE moving a player in / toggling active).
  IF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') AND NEW.agent_id IS NOT NULL
     AND NOT (TG_OP = 'UPDATE' AND NEW.agent_id = OLD.agent_id AND NEW.club_id = OLD.club_id
              AND NEW.agent_id IS NOT DISTINCT FROM OLD.agent_id) THEN
    UPDATE agents a SET
      total_players = (SELECT count(*) FROM club_members cm
                       WHERE cm.agent_id = NEW.agent_id AND cm.club_id = NEW.club_id),
      active_player_count = (SELECT count(*) FROM club_members cm
                       WHERE cm.agent_id = NEW.agent_id AND cm.club_id = NEW.club_id AND cm.is_active IS TRUE)
    WHERE a.user_id = NEW.agent_id AND a.club_id = NEW.club_id;
  ELSIF TG_OP = 'UPDATE' AND NEW.agent_id IS NOT NULL THEN
    -- Same agent bucket, but is_active (or another watched col) changed -> recompute it.
    UPDATE agents a SET
      total_players = (SELECT count(*) FROM club_members cm
                       WHERE cm.agent_id = NEW.agent_id AND cm.club_id = NEW.club_id),
      active_player_count = (SELECT count(*) FROM club_members cm
                       WHERE cm.agent_id = NEW.agent_id AND cm.club_id = NEW.club_id AND cm.is_active IS TRUE)
    WHERE a.user_id = NEW.agent_id AND a.club_id = NEW.club_id;
  END IF;

  RETURN NULL; -- AFTER trigger
END;
$function$;

DROP TRIGGER IF EXISTS trg_sync_agent_player_counts ON public.club_members;
CREATE TRIGGER trg_sync_agent_player_counts
AFTER INSERT OR DELETE OR UPDATE OF agent_id, club_id, is_active ON public.club_members
FOR EACH ROW EXECUTE FUNCTION public.fn_sync_agent_player_counts();

-- One-time reconcile of all current agent rows.
UPDATE agents a SET
  total_players = (SELECT count(*) FROM club_members cm
                   WHERE cm.agent_id = a.user_id AND cm.club_id = a.club_id),
  active_player_count = (SELECT count(*) FROM club_members cm
                   WHERE cm.agent_id = a.user_id AND cm.club_id = a.club_id AND cm.is_active IS TRUE);

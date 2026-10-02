-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820183936 "vip_points_trigger_must_not_reject_rake"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3feee1a378db06fbedf43141c78f97d1 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- A MALFORMED CONTRIBUTION COULD REJECT THE RAKE RECORD ITSELF.
--
-- fn_award_vip_points_from_rake is a trigger on rake_records. It guards the
-- uuid key (`BEGIN uid := k::uuid; EXCEPTION ... CONTINUE`) but not the value:
-- `v::numeric` on a non-numeric string raises, and because this runs inside the
-- INSERT, the whole rake_records write fails. The rake for that hand is then
-- never banked at all — strictly worse than the downstream problem, since
-- losing the record loses the rake, the rakeback and the audit trail together.
--
-- VIP points are a loyalty nicety. They must never be able to reject money.
-- The value cast now degrades to skipping that one contributor, matching how
-- the key cast already behaves.

CREATE OR REPLACE FUNCTION public.fn_award_vip_points_from_rake()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE k text; v text; pts bigint; uid uuid;
BEGIN
  IF NEW.player_contributions IS NULL OR jsonb_typeof(NEW.player_contributions) <> 'object' THEN
    RETURN NEW;
  END IF;
  FOR k, v IN SELECT * FROM jsonb_each_text(NEW.player_contributions) LOOP
    BEGIN uid := k::uuid; EXCEPTION WHEN others THEN CONTINUE; END;
    -- Same treatment for the value: a bad contribution skips the contributor,
    -- it does not abort the rake insert.
    BEGIN
      pts := floor(COALESCE(v::numeric, 0))::bigint;   -- 1 pt per rake chip
    EXCEPTION WHEN others THEN
      CONTINUE;
    END;
    IF pts > 0 THEN
      INSERT INTO vip_points_ledger (user_id, points, reason, source_type, source_id)
      VALUES (uid, pts, 'Rake generated', 'rake', NEW.id)
      ON CONFLICT (user_id, source_type, source_id) DO NOTHING;
      IF FOUND THEN
        INSERT INTO vip_points (user_id, current_points, lifetime_points)
        VALUES (uid, pts, pts)
        ON CONFLICT (user_id) DO UPDATE SET
          current_points  = vip_points.current_points + pts,
          lifetime_points = vip_points.lifetime_points + pts,
          updated_at = now();
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END; $function$;

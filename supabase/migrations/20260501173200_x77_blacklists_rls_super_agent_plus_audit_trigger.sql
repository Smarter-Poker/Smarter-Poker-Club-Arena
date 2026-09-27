-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260501173200 "x77_blacklists_rls_super_agent_plus_audit_trigger"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 96cfc6f0f7619356505bc8a126cd7864 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 77 fix #1: blacklists RLS allowed only ('owner', 'admin') roles to
-- write/delete bans, but production de-facto admin role is 'super_agent'
-- (R72 fix already canonicalized this in API role checks). RLS hadn't been
-- updated, so super_agents could SELECT bans but not write — moderation
-- tooling was blocked at the database layer.
DROP POLICY IF EXISTS blacklists_insert ON public.blacklists;
DROP POLICY IF EXISTS blacklists_delete ON public.blacklists;

CREATE POLICY blacklists_insert ON public.blacklists
  FOR INSERT TO authenticated
  WITH CHECK (
    banned_by = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM club_members cm
      WHERE cm.club_id = blacklists.club_id
        AND cm.user_id = (SELECT auth.uid())
        AND cm.role::text = ANY (ARRAY['owner', 'admin', 'super_agent'])
    )
  );

CREATE POLICY blacklists_delete ON public.blacklists
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM club_members cm
      WHERE cm.club_id = blacklists.club_id
        AND cm.user_id = (SELECT auth.uid())
        AND cm.role::text = ANY (ARRAY['owner', 'admin', 'super_agent'])
    )
  );

-- Round 77 fix #2: blacklists is written directly from the React client
-- (BlacklistManagerPage). That bypasses server-side auditLogger.js so no
-- anti_cheat_events row was being written. Fire a database-side trigger
-- that mirrors every ban into anti_cheat_events for forensic review.
-- DELETE → status='unbanned' so the audit captures both directions.
CREATE OR REPLACE FUNCTION public.fn_blacklists_audit() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO anti_cheat_events (
      event_type, player_id, club_id, details, triggered_by, created_at
    ) VALUES (
      'player_banned',
      NEW.user_id,
      NEW.club_id,
      jsonb_build_object(
        'reason', NEW.reason,
        'banned_by', NEW.banned_by,
        'banned_at', NEW.banned_at,
        'expires_at', NEW.expires_at,
        'union_id', NEW.union_id,
        'source', 'blacklists_trigger'
      ),
      NEW.banned_by::text,
      now()
    );
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO anti_cheat_events (
      event_type, player_id, club_id, details, triggered_by, created_at
    ) VALUES (
      'player_unbanned',
      OLD.user_id,
      OLD.club_id,
      jsonb_build_object(
        'previous_reason', OLD.reason,
        'originally_banned_by', OLD.banned_by,
        'originally_banned_at', OLD.banned_at,
        'source', 'blacklists_trigger'
      ),
      COALESCE((SELECT auth.uid()::text), 'system'),
      now()
    );
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS trg_blacklists_audit ON public.blacklists;
CREATE TRIGGER trg_blacklists_audit
  AFTER INSERT OR DELETE ON public.blacklists
  FOR EACH ROW EXECUTE FUNCTION public.fn_blacklists_audit();


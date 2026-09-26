-- Cosmetic edits need a signal after profiles left the WAL publication.
-- A profile receives frequent financial/statistical writes; only a real change
-- to the seven displayed appearance fields emits. No profile values travel in
-- the signal: each consumer re-reads its permitted projection under normal RLS.
-- Existing gameplay sockets, money commands and publication membership stay intact.
BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '30s';

CREATE POLICY "players receive their own appearance signal"
ON realtime.messages FOR SELECT TO authenticated
USING (extension = 'broadcast' AND (SELECT realtime.topic()) =
  'profile-appearance:' || (SELECT auth.uid())::text);

CREATE POLICY "readable tables receive appearance signals"
ON realtime.messages FOR SELECT TO authenticated
USING (extension = 'broadcast' AND EXISTS (
  SELECT 1 FROM public.tables t
  WHERE t.id = (SELECT CASE
    WHEN realtime.topic() ~ '^table-appearance:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN split_part(realtime.topic(), ':', 2)::uuid ELSE NULL END)
));

CREATE FUNCTION public.fn_publish_profile_appearance_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_table_id uuid;
  v_signal jsonb := jsonb_build_object('user_id', NEW.id);
BEGIN
  -- The source edit is authoritative. An unavailable signal transport must
  -- not roll back a profile or a surrounding transaction. Rejoin/visibility
  -- reads recover the persisted appearance without any background repair job.
  BEGIN
    PERFORM realtime.send(v_signal, 'appearance_changed',
      'profile-appearance:' || NEW.id::text, true);
    FOR v_table_id IN
      SELECT DISTINCT s.table_id FROM public.table_seats s
      WHERE s.user_id = NEW.id AND s.left_at IS NULL
    LOOP
      PERFORM realtime.send(v_signal, 'appearance_changed',
        'table-appearance:' || v_table_id::text, true);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Appearance signal delivery failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_publish_profile_appearance_change()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER profile_appearance_changed
AFTER UPDATE OF avatar_url, arena_avatar_url, use_avatar_as_profile_pic,
  is_vip, vip_expires_at, equipped_frame, equipped_aura ON public.profiles
FOR EACH ROW WHEN (
  ROW(OLD.avatar_url, OLD.arena_avatar_url, OLD.use_avatar_as_profile_pic,
      OLD.is_vip, OLD.vip_expires_at, OLD.equipped_frame, OLD.equipped_aura)
  IS DISTINCT FROM
  ROW(NEW.avatar_url, NEW.arena_avatar_url, NEW.use_avatar_as_profile_pic,
      NEW.is_vip, NEW.vip_expires_at, NEW.equipped_frame, NEW.equipped_aura)
)
EXECUTE FUNCTION public.fn_publish_profile_appearance_change();

COMMENT ON FUNCTION public.fn_publish_profile_appearance_change() IS
'Private appearance invalidation for the owner and occupied tables; no financial/statistical row replication or profile values.';
COMMIT;

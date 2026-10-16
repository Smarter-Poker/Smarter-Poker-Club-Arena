-- Private metadata is restricted to the actual owner or active/approved members.
-- The former SECURITY DEFINER reader accepted pending/removed memberships.
-- Public and service reads, own-session fields and the entire return body stay intact.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_lightning_pool_status(uuid)'::regprocedure)) = '6343609223db5145447ebfc4909fa2f7')
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='20s';
DO $migration$
DECLARE before_def text; after_def text;
 old_scope constant text := $old$     AND (v_service
          OR NOT coalesce(((cg.ruleset_snapshot -> 'options') ->> 'is_private')::boolean, false)
          OR EXISTS (SELECT 1 FROM public.club_members cm
                      WHERE cm.club_id = cg.club_id AND cm.user_id = v_uid));$old$;
 new_scope constant text := $new$     AND (v_service
          OR (NOT coalesce(((cg.ruleset_snapshot -> 'options') ->> 'is_private')::boolean, false)
              AND NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = cg.club_id AND c.is_public = false))
          OR EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = cg.club_id AND c.owner_id = v_uid)
          OR EXISTS (SELECT 1 FROM public.club_members cm
                      WHERE cm.club_id = cg.club_id AND cm.user_id = v_uid
                        AND cm.status IN ('active', 'approved')));$new$;
BEGIN
 before_def := pg_get_functiondef('public.fn_lightning_pool_status(uuid)'::regprocedure);
 IF md5(before_def) <> '7862bd41b9a4b2a7b45c8087bd6ddb13' THEN
   RAISE EXCEPTION 'private Lightning pool status predecessor mismatch; nothing changed';
 END IF;
 IF (length(before_def)-length(replace(before_def,old_scope,'')))/length(old_scope) <> 1 THEN
   RAISE EXCEPTION 'private Lightning pool status scope anchor mismatch; nothing changed';
 END IF;
 after_def := replace(before_def,old_scope,new_scope);
 EXECUTE after_def;
END
$migration$;
COMMIT;

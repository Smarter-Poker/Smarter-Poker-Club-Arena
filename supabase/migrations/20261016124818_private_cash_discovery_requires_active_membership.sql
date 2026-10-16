-- Private cash discovery must not treat an unapproved request as admission.
-- Public-game visibility is unchanged. Private games retain their actual owner,
-- active/approved members and the existing service-role RLS bypass.
-- Native witness: scripts/dev/test-lightning-private-discovery.sh.
-- @live-proof: (SELECT qual LIKE '%is_private%' AND qual LIKE '%status%' AND qual LIKE '%active%' AND qual LIKE '%approved%' AND qual LIKE '%owner_id%' AND roles=ARRAY['authenticated']::name[] FROM pg_policies WHERE schemaname='public' AND tablename='cash_games' AND policyname='cash_games_read')
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $guard$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public'
   AND tablename='cash_games' AND policyname='cash_games_read'
   AND cmd='SELECT' AND roles=ARRAY['authenticated']::name[]
   AND md5(qual)='f1ff2b6f7d2976ab5a3c7deab313d9c5')
 THEN RAISE EXCEPTION 'cash_games_read predecessor changed; inspect before applying'; END IF;
END $guard$;
ALTER POLICY cash_games_read ON public.cash_games TO authenticated
USING (
 NOT coalesce((ruleset_snapshot->'options'->>'is_private')::boolean,false)
 OR EXISTS(SELECT 1 FROM public.clubs c
   WHERE c.id=cash_games.club_id AND c.owner_id=(SELECT auth.uid()))
 OR EXISTS(SELECT 1 FROM public.club_members cm
   WHERE cm.club_id=cash_games.club_id AND cm.user_id=(SELECT auth.uid())
     AND cm.status IN ('active','approved'))
);
COMMIT;

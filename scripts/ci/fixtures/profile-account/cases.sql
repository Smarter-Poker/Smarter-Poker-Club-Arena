-- High-frequency and internal changes are not account edits.
UPDATE public.profiles SET total_hands_played=total_hands_played+1,last_seen=now(),horse_status='seated';
UPDATE public.profiles SET settings=settings || '{"internal_revision":9,"soundVolume":40,"handWonNotifications":true}'::jsonb, diamonds=diamonds, bio=bio;
DO $$ BEGIN IF EXISTS(SELECT FROM public.deliveries) THEN RAISE EXCEPTION 'unrelated or unchanged write emitted'; END IF; END $$;
-- One mixed source update gives one identity-only signal with exact domains.
UPDATE public.profiles SET bio='new bio', diamonds=diamonds+7, settings=jsonb_set(settings,'{theme}','"auto"') WHERE id='aaaaaaaa-1111-2222-3333-444444444444';
DO $$ BEGIN
 IF (SELECT count(*) FROM public.deliveries) <> 1 THEN RAISE EXCEPTION 'account signal missing or duplicated'; END IF;
 IF EXISTS(SELECT FROM public.deliveries WHERE payload <> '{"user_id":"aaaaaaaa-1111-2222-3333-444444444444","domains":["metadata","settings","diamonds"]}'::jsonb OR event <> 'account_changed' OR topic <> 'profile-account:aaaaaaaa-1111-2222-3333-444444444444' OR NOT private) THEN RAISE EXCEPTION 'private minimal payload or domains incorrect'; END IF;
END $$;
-- RLS and the persisted reread are exercised as the actual browser role.
SET ROLE authenticated;
SET request.jwt.claim.sub='aaaaaaaa-1111-2222-3333-444444444444';
SET realtime.topic='profile-account:aaaaaaaa-1111-2222-3333-444444444444';
DO $$ BEGIN
 IF (SELECT count(*) FROM realtime.messages) <> 1 THEN RAISE EXCEPTION 'owner denied or non-broadcast exposed'; END IF;
 IF (SELECT count(id) FROM public.profiles) <> 1 OR (SELECT diamonds FROM public.profiles WHERE id=auth.uid()) <> 7 THEN RAISE EXCEPTION 'authorized consumer cannot reread source'; END IF;
 BEGIN INSERT INTO realtime.messages VALUES('broadcast'); RAISE EXCEPTION 'client can forge a signal'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
UPDATE public.profiles SET bio='browser edit' WHERE id=auth.uid();
SET realtime.topic='profile-account:bbbbbbbb-1111-2222-3333-444444444444';
DO $$ BEGIN IF EXISTS(SELECT FROM realtime.messages) THEN RAISE EXCEPTION 'other account signal exposed'; END IF; END $$;
SET realtime.topic='profile-account:not-a-uuid';
DO $$ BEGIN IF EXISTS(SELECT FROM realtime.messages) THEN RAISE EXCEPTION 'malformed topic exposed'; END IF; END $$;
RESET ROLE;
DO $$ BEGIN
 IF (SELECT count(*) FROM public.deliveries) <> 2 THEN RAISE EXCEPTION 'authenticated source edit did not emit'; END IF;
 IF (SELECT payload->'domains' FROM public.deliveries OFFSET 1 LIMIT 1) <> '["metadata"]'::jsonb THEN RAISE EXCEPTION 'metadata edit over-emitted domains'; END IF;
END $$;
SET ROLE anon;
SET realtime.topic='profile-account:aaaaaaaa-1111-2222-3333-444444444444';
DO $$ BEGIN IF EXISTS(SELECT FROM realtime.messages) THEN RAISE EXCEPTION 'anonymous signal access'; END IF; END $$;
RESET ROLE;
-- Rolling back source persistence rolls back the signal in the same transaction.
BEGIN;
UPDATE public.profiles SET diamonds=99 WHERE id='aaaaaaaa-1111-2222-3333-444444444444';
ROLLBACK;
DO $$ BEGIN IF (SELECT count(*) FROM public.deliveries) <> 2 OR (SELECT diamonds FROM public.profiles WHERE id='aaaaaaaa-1111-2222-3333-444444444444') <> 7 THEN RAISE EXCEPTION 'rollback lost atomicity'; END IF; END $$;
SET account.fail_send='yes';
UPDATE public.profiles SET diamonds=8 WHERE id='aaaaaaaa-1111-2222-3333-444444444444';
DO $$ BEGIN
 IF (SELECT diamonds FROM public.profiles WHERE id='aaaaaaaa-1111-2222-3333-444444444444') <> 8 THEN RAISE EXCEPTION 'notification outage rolled back source'; END IF;
 IF (SELECT count(*) FROM public.deliveries) <> 2 THEN RAISE EXCEPTION 'outage invented delivery'; END IF;
 IF has_function_privilege('authenticated','public.fn_publish_profile_account_change()','EXECUTE') OR has_function_privilege('anon','public.fn_publish_profile_account_change()','EXECUTE') THEN RAISE EXCEPTION 'trigger exposed directly'; END IF;
END $$;
SELECT 'profile-account-acceptance-passed';

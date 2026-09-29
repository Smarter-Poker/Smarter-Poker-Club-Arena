-- Unrelated financial/statistical writes and same-value cosmetic writes emit nothing.
UPDATE public.profiles SET diamonds = diamonds + 5, private_email = 'private@example.invalid';
UPDATE public.profiles SET arena_avatar_url = arena_avatar_url;
DO $$ BEGIN IF EXISTS(SELECT FROM public.deliveries) THEN RAISE EXCEPTION 'unchanged appearance emitted'; END IF; END $$;
UPDATE public.profiles SET arena_avatar_url='/after.webp',equipped_frame='gold' WHERE id='aaaaaaaa-1111-2222-3333-444444444444';
DO $$ BEGIN
 IF (SELECT count(*) FROM public.deliveries) <> 2 THEN RAISE EXCEPTION 'profile appearance signal missing or duplicated'; END IF;
 IF EXISTS(SELECT FROM public.deliveries WHERE payload <> '{"user_id":"aaaaaaaa-1111-2222-3333-444444444444"}'::jsonb OR event <> 'appearance_changed' OR NOT private) THEN RAISE EXCEPTION 'private or minimal payload contract failed'; END IF;
 IF NOT EXISTS(SELECT FROM public.deliveries WHERE topic='profile-appearance:aaaaaaaa-1111-2222-3333-444444444444') OR NOT EXISTS(SELECT FROM public.deliveries WHERE topic='table-appearance:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') THEN RAISE EXCEPTION 'wrong recipients'; END IF;
END $$;
-- RLS is exercised as the browser role, including a table it cannot read.
SET ROLE authenticated;
SET request.jwt.claim.sub='aaaaaaaa-1111-2222-3333-444444444444';
SET realtime.topic='profile-appearance:aaaaaaaa-1111-2222-3333-444444444444';
DO $$ BEGIN IF (SELECT count(*) FROM realtime.messages) <> 1 THEN RAISE EXCEPTION 'owner topic not readable or presence leaked'; END IF; END $$;
SET realtime.topic='profile-appearance:bbbbbbbb-1111-2222-3333-444444444444';
DO $$ BEGIN IF EXISTS(SELECT FROM realtime.messages) THEN RAISE EXCEPTION 'other account topic exposed'; END IF; END $$;
SET realtime.topic='table-appearance:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
DO $$ BEGIN IF (SELECT count(*) FROM realtime.messages) <> 1 THEN RAISE EXCEPTION 'readable table refused'; END IF; END $$;
SET realtime.topic='table-appearance:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
DO $$ BEGIN IF EXISTS(SELECT FROM realtime.messages) THEN RAISE EXCEPTION 'unreadable table exposed'; END IF; END $$;
SET realtime.topic='table-appearance:not-a-uuid';
DO $$ BEGIN IF EXISTS(SELECT FROM realtime.messages) THEN RAISE EXCEPTION 'malformed topic exposed'; END IF; END $$;
DO $$ BEGIN
 BEGIN INSERT INTO realtime.messages VALUES('broadcast'); RAISE EXCEPTION 'client can forge signal';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET ROLE anon;
SET realtime.topic='profile-appearance:aaaaaaaa-1111-2222-3333-444444444444';
DO $$ BEGIN IF EXISTS(SELECT FROM realtime.messages) THEN RAISE EXCEPTION 'anonymous signal access'; END IF; END $$;
RESET ROLE;
SET appearance.fail_send='yes';
UPDATE public.profiles SET arena_avatar_url='/durable-during-outage.webp' WHERE id='aaaaaaaa-1111-2222-3333-444444444444';
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM public.profiles WHERE arena_avatar_url='/durable-during-outage.webp') THEN RAISE EXCEPTION 'provider outage rolled back source edit'; END IF;
 IF (SELECT count(*) FROM public.deliveries) <> 2 THEN RAISE EXCEPTION 'provider failure invented delivery'; END IF;
 IF has_function_privilege('authenticated','public.fn_publish_profile_appearance_change()','EXECUTE') OR has_function_privilege('anon','public.fn_publish_profile_appearance_change()','EXECUTE') THEN RAISE EXCEPTION 'trigger function exposed to browsers'; END IF;
END $$;
SELECT 'profile-appearance-acceptance-passed';

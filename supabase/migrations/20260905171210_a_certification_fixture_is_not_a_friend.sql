-- 20260905171210_a_certification_fixture_is_not_a_friend.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Dan, 2026-09-05, looking at his own friends list: "WHAT ARE
-- crest_cert_854825cjxkf0?"
--
-- They are club-creation certification fixtures. Every run of
-- .github/workflows/club-create-certification.yml signs up a throwaway account
-- (`club-create-cert-<ms>-<rand>@smarter-poker.invalid`, username
-- `crest_cert_<stamp>`), has it create a club, proves the flow works, then
-- retires the club and tries to delete the account.
--
-- Two things then happen, and both are working as designed:
--
--   1. `trg_auto_connect_dan` on public.profiles friends EVERY new profile to
--      the founder, in both directions, accepted. That is a deliberate feature -
--      it is why the founder has 1,309 friends - and it fires for the fixture
--      exactly as it does for a real signup.
--   2. The account delete then FAILS, and correctly. Probed on production:
--      `chip_ledger_performed_by_fkey` refuses it, because the fixture performed
--      chip-ledger entries when it created its club. A money ledger must keep
--      who performed each row; deleting the actor is not an option and must not
--      become one.
--
-- So the fixture cannot be removed, and the friendship it was given cannot be
-- justified. The fix is not to give it one. `.invalid` is reserved by RFC 2606
-- and can never be deliverable, so an address in that domain is scaffolding by
-- construction - it cannot be a person.
--
-- HORSES ARE PLAYERS (10.5). This predicate is checked against production
-- before it is used: 9 accounts match `%@smarter-poker.invalid`, of which
-- ZERO are horses. Horses live under horses.smarter.poker, hydra.smarter.poker,
-- horse.ai and bot.smarter.poker, and every one of them keeps its auto-connect,
-- its friendship and everything downstream of it. This excludes test
-- scaffolding, not players.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.auto_connect_to_dan_bekavac()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  dan_id UUID := '47965354-0e56-43ef-931c-ddaab82af765';
BEGIN
  -- Skip if this IS Dan's own profile row
  IF NEW.id = dan_id THEN
    RETURN NEW;
  END IF;

  -- A certification fixture is not a friend (2026-09-05). The harness signs up
  -- a throwaway account under the reserved .invalid TLD, and its cleanup cannot
  -- delete it afterwards because the account touched chip_ledger. Without this
  -- the founder's friends list collects one row per CI run, for ever.
  -- Deliberately narrow: only this reserved domain, which cannot be a person.
  IF EXISTS (
    SELECT 1 FROM auth.users u
     WHERE u.id = NEW.id AND u.email LIKE '%@smarter-poker.invalid'
  ) THEN
    RETURN NEW;
  END IF;

  -- Set session flag to suppress notification triggers during auto-connect
  PERFORM set_config('app.suppress_friend_notifications', 'true', true);

  -- Bidirectional accepted friendship: new user -> Dan
  INSERT INTO public.friendships (user_id, friend_id, status)
  VALUES (NEW.id, dan_id, 'accepted')
  ON CONFLICT (user_id, friend_id) DO NOTHING;

  -- Bidirectional accepted friendship: Dan -> new user
  INSERT INTO public.friendships (user_id, friend_id, status)
  VALUES (dan_id, NEW.id, 'accepted')
  ON CONFLICT (user_id, friend_id) DO NOTHING;

  -- Auto-follow Dan (new user follows Dan's social feed)
  INSERT INTO public.social_follows (follower_id, following_id)
  VALUES (NEW.id, dan_id)
  ON CONFLICT (follower_id, following_id) DO NOTHING;

  -- Clear the suppression flag
  PERFORM set_config('app.suppress_friend_notifications', 'false', true);

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.auto_connect_to_dan_bekavac() IS
  'Every new profile becomes the founder''s friend, both ways, accepted - the deliberate feature behind his friend count. Skips the founder himself and, since 2026-09-05, accounts under the reserved @smarter-poker.invalid domain used by the club-create certification harness, whose fixtures cannot be deleted afterwards because they touch chip_ledger.';

-- Remove the ones already collected. These reference accounts that exist and
-- must keep existing (the ledger names them), so this deletes the RELATIONSHIP
-- only - no account, no ledger row, nothing a person owns.
DELETE FROM public.friendships f
 WHERE f.user_id IN (SELECT id FROM auth.users WHERE email LIKE '%@smarter-poker.invalid')
    OR f.friend_id IN (SELECT id FROM auth.users WHERE email LIKE '%@smarter-poker.invalid');

DELETE FROM public.social_follows sf
 WHERE sf.follower_id IN (SELECT id FROM auth.users WHERE email LIKE '%@smarter-poker.invalid')
    OR sf.following_id IN (SELECT id FROM auth.users WHERE email LIKE '%@smarter-poker.invalid');

-- No horse may be caught by the predicate this migration introduces, now or
-- when it next runs.
DO $$
DECLARE v_horses bigint; v_left bigint;
BEGIN
  SELECT count(*) INTO v_horses
    FROM auth.users a JOIN public.profiles p ON p.id = a.id
   WHERE a.email LIKE '%@smarter-poker.invalid' AND coalesce(p.is_horse, false);
  IF v_horses <> 0 THEN
    RAISE EXCEPTION 'HORSES ARE PLAYERS: % horse(s) carry a @smarter-poker.invalid address, so this predicate would deny them an auto-connect. Do not ship it.', v_horses;
  END IF;

  SELECT count(*) INTO v_left
    FROM public.friendships f
   WHERE f.user_id IN (SELECT id FROM auth.users WHERE email LIKE '%@smarter-poker.invalid')
      OR f.friend_id IN (SELECT id FROM auth.users WHERE email LIKE '%@smarter-poker.invalid');
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'certification fixtures still hold % friendship row(s)', v_left;
  END IF;
END $$;

COMMIT;

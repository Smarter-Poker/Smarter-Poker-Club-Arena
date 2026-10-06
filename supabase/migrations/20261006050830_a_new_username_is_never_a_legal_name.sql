-- Applied to production as version 20261006051125 (match by name). A rolled-back
-- sign-up probe right after: full name "Probe Person", username Player<id9>.
--
-- A NEW USERNAME IS NEVER A LEGAL NAME
--
-- Ruling 25 (docs/DIAMOND-RULINGS.md): a person's legal name and email are
-- readable only by them and platform staff. handle_new_user() gave a new
-- account without a chosen poker alias the username REGEXP_REPLACE(full name)
-- - "Jane Doe" became @JaneDoe - or, failing that, the local part of their
-- email. The username is the most public field there is (profile URL, every
-- table, every feed), so every Google sign-up without an alias published its
-- legal name, and the rest part of their email. Read 2026-10-06: 15 human
-- usernames are exactly the owner's legal name with spaces removed.
--
-- Now: the chosen poker alias, else 'Player' and the first nine hex digits of
-- the account id - public, changeable in Edit Profile, and unique by
-- construction (the old random Player<0..9999> fallback could collide on the
-- unique lower(username) index and fail the sign-up). The reserved-name
-- fallback below it is unchanged. Existing usernames are not renamed: a
-- username is a profile URL, and its owner can change it.
--
-- One function, pinned by md5; the fragment must occur exactly once; CREATE
-- OR REPLACE keeps the trigger, owner, grants and settings.
--
-- @live-proof: (SELECT position('REGEXP_REPLACE(resolved_full_name' in p.prosrc) = 0 AND position('''Player'' || LEFT(REPLACE(NEW.id::text, ''-'', ''''), 9)' in p.prosrc) > 0 FROM pg_proc p WHERE p.oid = 'public.handle_new_user()'::regprocedure)
--
-- Never apply between :50 and :03 UTC.

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $do$
DECLARE
  v_fn regprocedure := 'public.handle_new_user()'::regprocedure;
  v_def text := pg_get_functiondef('public.handle_new_user()'::regprocedure);
  v_old text := $o$        NULLIF(REGEXP_REPLACE(resolved_full_name, '[^a-zA-Z0-9]', '', 'g'), ''),
        SPLIT_PART(COALESCE(NEW.email, ''), '@', 1),
        'Player' || FLOOR(RANDOM() * 10000)::TEXT
$o$;
  v_new text := $n$        -- Never the legal name or the email's local part (ruling 25):
        -- a public handle the owner can change, unique by construction.
        'Player' || LEFT(REPLACE(NEW.id::text, '-', ''), 9)
$n$;
  v_next text;
BEGIN
  IF md5(v_def) <> 'e4ae3309ad1b563e22a532ce4718e4cf' THEN
    RAISE EXCEPTION 'handle_new_user changed since 2026-10-06 (md5 %); re-read before applying', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'handle_new_user must contain the username derivation exactly once';
  END IF;
  v_next := replace(v_def, v_old, v_new);
  EXECUTE v_next;
  IF md5(pg_get_functiondef(v_fn)) <> md5(v_next) THEN
    RAISE EXCEPTION 'handle_new_user post-image mismatch';
  END IF;
END $do$;

COMMIT;

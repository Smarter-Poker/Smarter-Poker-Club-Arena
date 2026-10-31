#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pgbin="${PG_BIN:-${PG17_BINDIR:-/opt/homebrew/opt/postgresql@17/bin}}"
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/Volumes/SmarterWork/agent-work}}/player-preferences.XXXXXX")"
cleanup() { "$pgbin/pg_ctl" -D "$work/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
mkdir "$work/socket"
"$pgbin/initdb" -D "$work/data" -U fixture_admin --auth-local=trust --auth-host=reject --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$work/data" -l "$work/postgres.log" -o "-h '' -k '$work/socket' -p 57648" -w start >/dev/null
psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$work/socket" -p 57648 -U fixture_admin -d postgres)
"${psql[@]}" <<'SQL'
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
INSERT INTO auth.users VALUES ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated;
SQL
"${psql[@]}" -f "$repo/supabase/migrations/20261027173138_player_page_filter_preferences_persist_per_account.sql"
"${psql[@]}" <<'SQL'
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
INSERT INTO public.user_page_preferences VALUES ('11111111-1111-4111-8111-111111111111','history:filter','"mine"');
INSERT INTO public.user_page_preferences VALUES ('11111111-1111-4111-8111-111111111111','history:filter','"all"')
ON CONFLICT(user_id,preference_key) DO UPDATE SET value=excluded.value;
INSERT INTO public.user_page_preferences VALUES ('11111111-1111-4111-8111-111111111111','history:sort','"recent"');
DO $$ BEGIN
 IF (SELECT count(*) FROM public.user_page_preferences) <> 2 OR
    (SELECT value FROM public.user_page_preferences WHERE preference_key='history:filter') <> '"all"'::jsonb THEN
   RAISE EXCEPTION 'independent preferences or upsert failed';
 END IF;
 BEGIN
   UPDATE public.user_page_preferences SET user_id='22222222-2222-4222-8222-222222222222';
   RAISE EXCEPTION 'cross-account reassignment accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
   INSERT INTO public.user_page_preferences VALUES ('22222222-2222-4222-8222-222222222222','history:filter','"mine"');
   RAISE EXCEPTION 'cross-account insert accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
   INSERT INTO public.user_page_preferences VALUES ('11111111-1111-4111-8111-111111111111','', 'true');
   RAISE EXCEPTION 'empty key accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
   INSERT INTO public.user_page_preferences VALUES ('11111111-1111-4111-8111-111111111111','oversized',to_jsonb(repeat('x',17000)));
   RAISE EXCEPTION 'oversized value accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.user_page_preferences) THEN RAISE EXCEPTION 'another account can read preferences'; END IF;
 UPDATE public.user_page_preferences SET value='false';
 IF FOUND THEN RAISE EXCEPTION 'another account can overwrite preferences'; END IF;
END $$;
RESET ROLE;
SET ROLE anon;
DO $$ BEGIN
 BEGIN
   PERFORM 1 FROM public.user_page_preferences;
   RAISE EXCEPTION 'anonymous read accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
DELETE FROM auth.users WHERE id='11111111-1111-4111-8111-111111111111';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.user_page_preferences) THEN RAISE EXCEPTION 'deleted account left preference residue'; END IF;
END $$;
SQL
echo 'PLAYER_PREFERENCES PASS: durable upsert, independent controls, account isolation, invalid input, anonymous refusal'

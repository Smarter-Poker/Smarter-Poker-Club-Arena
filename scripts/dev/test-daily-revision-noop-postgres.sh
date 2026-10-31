#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
parent="${DATA_CONSOLE_PG_SCRATCH_PARENT:-${RUNNER_TEMP:-}}"
[ -n "$parent" ] && [ -d "$parent" ] || { echo 'Owned native scratch required' >&2; exit 1; }
pgbin="${PG17_BINDIR:-/opt/homebrew/opt/postgresql@17/bin}"
work="$(mktemp -d "$parent/daily-noop.XXXXXX")"
trap '"$pgbin/pg_ctl" -D "$work/data" -m immediate -w stop >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
mkdir "$work/socket"
"$pgbin/initdb" -D "$work/data" -U postgres --auth-local=trust --auth-host=reject --no-locale -E UTF8 >/dev/null
if ! "$pgbin/pg_ctl" -D "$work/data" -l "$work/postgres.log" -o "-h '' -k '$work/socket' -p 57653" -w start >/dev/null; then cat "$work/postgres.log" >&2; exit 1; fi
psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$work/socket" -p 57653 -U postgres -d postgres)
fixture="$work/fixture"
mkdir "$fixture"
cat > "$fixture/setup.sql" <<'FIXTURE_SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA realtime;
CREATE TABLE realtime.captured(payload jsonb,event text,topic text,private boolean);
CREATE FUNCTION realtime.send(payload jsonb,event text,topic text,private boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('fixture.fail_send',true)='true' THEN RAISE EXCEPTION 'fixture transport outage'; END IF;
 INSERT INTO realtime.captured VALUES(payload,event,topic,private);
END $$;
CREATE TABLE public.profiles(id uuid PRIMARY KEY,diamonds integer NOT NULL DEFAULT 0);
CREATE TABLE public.user_daily_challenges(id uuid PRIMARY KEY,user_id uuid,challenge_id text,
 progress integer NOT NULL DEFAULT 0,completed boolean NOT NULL DEFAULT false,
 challenge_name_snapshot text,diamond_reward_snapshot integer);
CREATE TABLE public.challenge_streak_state(user_id uuid PRIMARY KEY,current_streak_length integer);
CREATE TABLE public.daily_challenge_dashboard_revisions(user_id uuid PRIMARY KEY,revision bigint,updated_at timestamptz);
CREATE TABLE public.fixture_financial_state(balance numeric NOT NULL);
INSERT INTO public.fixture_financial_state VALUES(123.45);
FIXTURE_SQL
cat > "$fixture/seed.sql" <<'FIXTURE_SQL'
CREATE TRIGGER mission_revision AFTER INSERT OR UPDATE OR DELETE ON public.user_daily_challenges
 FOR EACH ROW EXECUTE FUNCTION public.bump_daily_challenge_dashboard_revision();
CREATE TRIGGER diamond_revision AFTER UPDATE ON public.profiles
 FOR EACH ROW WHEN (OLD.diamonds IS DISTINCT FROM NEW.diamonds)
 EXECUTE FUNCTION public.bump_daily_challenge_dashboard_revision();
CREATE TRIGGER streak_revision AFTER INSERT OR UPDATE OR DELETE ON public.challenge_streak_state
 FOR EACH ROW EXECUTE FUNCTION public.bump_daily_challenge_dashboard_revision();
INSERT INTO public.profiles VALUES('10000000-0000-0000-0000-000000000001',0),('10000000-0000-0000-0000-000000000002',0);
INSERT INTO public.user_daily_challenges VALUES('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','hands',0,false,'Hands',8);
TRUNCATE realtime.captured;
FIXTURE_SQL
cat > "$fixture/quiet.sql" <<'FIXTURE_SQL'
BEGIN;
DO $$ DECLARE before_row jsonb; BEGIN
 SELECT to_jsonb(r) INTO before_row FROM public.daily_challenge_dashboard_revisions r;
 FOR i IN 1..100 LOOP UPDATE public.user_daily_challenges SET progress=LEAST(progress+0,10); END LOOP;
 IF (SELECT to_jsonb(r) FROM public.daily_challenge_dashboard_revisions r) IS DISTINCT FROM before_row
  OR EXISTS(SELECT 1 FROM realtime.captured) THEN RAISE EXCEPTION 'Identical mission row produced revision work: % messages', (SELECT count(*) FROM realtime.captured); END IF;
 IF (SELECT balance FROM public.fixture_financial_state)<>123.45 THEN RAISE EXCEPTION 'Financial state changed'; END IF;
END $$;
ROLLBACK;
FIXTURE_SQL
cat > "$fixture/changed.sql" <<'FIXTURE_SQL'
BEGIN;
UPDATE public.user_daily_challenges SET progress=1;
UPDATE public.user_daily_challenges SET completed=true;
UPDATE public.user_daily_challenges SET completed=true;
UPDATE public.profiles SET diamonds=diamonds+8 WHERE id='10000000-0000-0000-0000-000000000001';
INSERT INTO public.challenge_streak_state VALUES('10000000-0000-0000-0000-000000000002',1);
UPDATE public.challenge_streak_state SET current_streak_length=2;
DELETE FROM public.challenge_streak_state;
DO $$ BEGIN
 IF (SELECT count(*) FROM realtime.captured WHERE event='daily_mission_revision_changed')<>6
  OR (SELECT count(*) FROM realtime.captured WHERE event='daily_mission_completed')<>1
  OR EXISTS(SELECT 1 FROM realtime.captured WHERE NOT private OR topic NOT LIKE 'daily-mission-%')
  OR (SELECT revision FROM public.daily_challenge_dashboard_revisions WHERE user_id='10000000-0000-0000-0000-000000000001')<>4
 THEN RAISE EXCEPTION 'Genuine mission event or completion coverage changed'; END IF;
END $$;
SAVEPOINT attempt;
UPDATE public.user_daily_challenges SET progress=2;
ROLLBACK TO attempt;
DO $$ BEGIN
 IF (SELECT count(*) FROM realtime.captured)<>7 THEN RAISE EXCEPTION 'Savepoint broadcast was retained'; END IF;
END $$;
SET LOCAL fixture.fail_send='true';
UPDATE public.user_daily_challenges SET progress=3;
DO $$ BEGIN
 IF (SELECT progress FROM public.user_daily_challenges)<>3 OR
  (SELECT revision FROM public.daily_challenge_dashboard_revisions WHERE user_id='10000000-0000-0000-0000-000000000001')<>5
 THEN RAISE EXCEPTION 'Transport outage rolled back authoritative change'; END IF;
 IF (SELECT balance FROM public.fixture_financial_state)<>123.45 THEN RAISE EXCEPTION 'Financial state changed'; END IF;
END $$;
ROLLBACK;
BEGIN;
DELETE FROM public.user_daily_challenges;
DO $$ BEGIN IF (SELECT count(*) FROM realtime.captured)<>1 THEN RAISE EXCEPTION 'Delete invalidation lost'; END IF; END $$;
ROLLBACK;
DO $$ BEGIN
 IF has_function_privilege('anon','public.bump_daily_challenge_dashboard_revision()','EXECUTE')
 OR has_function_privilege('authenticated','public.bump_daily_challenge_dashboard_revision()','EXECUTE')
 OR NOT has_function_privilege('service_role','public.bump_daily_challenge_dashboard_revision()','EXECUTE')
 THEN RAISE EXCEPTION 'Source authority changed'; END IF;
END $$;
FIXTURE_SQL
migrations=("$repo"/supabase/migrations/*_identical_daily_mission_rows_do_not_broadcast.sql)
[ "${#migrations[@]}" = 1 ] && [ -f "${migrations[0]}" ] || { echo 'Exact maintained migration required'; exit 1; }
migration="${migrations[0]}"
"${psql[@]}" -f "$fixture/setup.sql" -f "$repo/scripts/ci/fixtures/daily-mission-outbox-lock/bump_daily_challenge_dashboard_revision.sql"
"${psql[@]}" -c 'REVOKE ALL ON FUNCTION public.bump_daily_challenge_dashboard_revision() FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.bump_daily_challenge_dashboard_revision() TO service_role;'
[ "$("${psql[@]}" -At -c "SELECT md5(pg_get_functiondef('public.bump_daily_challenge_dashboard_revision()'::regprocedure))")" = 367863ecd73d5909ba2ed8701ba8b168 ]
"${psql[@]}" -f "$fixture/seed.sql"
if "${psql[@]}" -f "$fixture/quiet.sql" > "$work/before.log" 2>&1; then
  echo 'Unchanged mission regression unexpectedly passed before repair'; exit 1
fi
grep -q 'Identical mission row produced revision work' "$work/before.log"
# Every negative install is one self-aborting transaction; no altered source or ACL survives.
for drift in authority source; do
  {
    echo 'BEGIN;'
    if [ "$drift" = authority ]; then
      echo 'GRANT EXECUTE ON FUNCTION public.bump_daily_challenge_dashboard_revision() TO authenticated;'
    else
      echo "COMMENT ON FUNCTION public.bump_daily_challenge_dashboard_revision() IS 'fixture';"
      echo "ALTER FUNCTION public.bump_daily_challenge_dashboard_revision() SET search_path=pg_catalog;"
    fi
    cat "$migration"
  } > "$work/$drift.sql"
  if "${psql[@]}" -f "$work/$drift.sql" > "$work/$drift.log" 2>&1; then echo 'Drift admitted'; exit 1; fi
  grep -q DAILY_REVISION_NOOP_PREIMAGE_CHANGED "$work/$drift.log"
  [ "$("${psql[@]}" -At -c "SELECT md5(pg_get_functiondef('public.bump_daily_challenge_dashboard_revision()'::regprocedure))='367863ecd73d5909ba2ed8701ba8b168' AND NOT has_function_privilege('authenticated','public.bump_daily_challenge_dashboard_revision()','EXECUTE')")" = t ]
done
"${psql[@]}" -f "$migration" -f "$fixture/quiet.sql" -f "$fixture/changed.sql"
if "${psql[@]}" -f "$migration" > "$work/replay.log" 2>&1; then echo 'Migration replay admitted'; exit 1; fi
grep -q DAILY_REVISION_NOOP_PREIMAGE_CHANGED "$work/replay.log"
grep -q 'Identical mission row produced revision work: 100 messages' "$work/before.log"
postimage="$("${psql[@]}" -At -c "SELECT md5(pg_get_functiondef('public.bump_daily_challenge_dashboard_revision()'::regprocedure))")"
printf 'DAILY_REVISION_NOOP_RECEIPT {"preimage":"367863ecd73d5909ba2ed8701ba8b168","postimage":"%s","identicalUpdates":100,"beforePaidSourceSends":100,"afterPaidSourceSends":0,"afterRevisionWrites":0,"genuineChangeCasesPassed":true,"financialStateUnchanged":true,"productionCertificate":false}\n' "$postimage"
echo 'DAILY_REVISION_NOOP_POSTGRES PASS: actual fail-before/pass-after; zero revisions and paid sends for identical updates; genuine changes, completion, profile/streak, rollback, broadcast failure, ACL/config drift and replay refusal'

#!/usr/bin/env bash
# =============================================================================
#  A BARE PARK REQUEST IS NOT A MOVE IN FLIGHT - LIVE PROOF
# =============================================================================
#
# Red before, green after, against a throwaway PostgreSQL cluster on a unix
# socket. Never against production.
#
# smarter_private.f06_source_guard()'s `bound` check treats ANY
# non-acknowledged/non-withdrawn smarter_private.f06_operations row as a live
# move that must exclude every ordinary writer to its table - including a
# bare `park_requested` row with no manifest, no admission, no member, no
# attempt and no close/cleanup/abort evidence: a planned move whose table
# concluded before the move could manifest. The function's own
# elimination-dispatch fast path already treats exactly that shape as
# unbound; `bound` never got the same nuance. Production tournament
# bfcfaf17-2879-4e58-b8e1-1c749ceb3b2f sat RUNNING for nine days because of
# it - its own terminal settlement could not flip its winner's status.
#
# The pre-image below is pinned to the md5 of pg_get_functiondef/prosrc read
# from production (project kuklfnapbkmacvwxktbh) on 2026-09-27, immediately
# before the accompanying migration was written against it. A drifted live
# function fails the migration's own PREIMAGE assertion in production; this
# script's job is the behavioral proof, not preimage sourcing.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixtures="${repo_dir}/scripts/dev/fixtures/f06-bare-park-request"
migration="${repo_dir}/supabase/migrations/20260927201810_f06_source_guard_unbinds_bare_park_requests.sql"

PRODUCTION_PROSRC_MD5='be484837a5103b3c0ac78a1d6d5d0bf2'
POSTIMAGE_PROSRC_MD5='caf6acb7a30fbd6044c4262520e134ac'

if [[ ! -f "$migration" ]]; then
  echo "Missing migration: $migration" >&2
  exit 1
fi

preimage_md5="$(md5sum "${fixtures}/preimage-2026-09-27.prosrc.txt" | awk '{print $1}')"
if [[ "$preimage_md5" != "$PRODUCTION_PROSRC_MD5" ]]; then
  echo "Fixture preimage does not match the pinned production md5: ${preimage_md5}" >&2
  exit 1
fi

pg_bindir="${PG_BINDIR:-}"
if [[ -z "$pg_bindir" ]]; then
  for candidate in /usr/lib/postgresql/16/bin /usr/lib/postgresql/*/bin; do
    if [[ -x "${candidate}/initdb" ]]; then pg_bindir="$candidate"; break; fi
  done
fi
if [[ -z "$pg_bindir" ]] && command -v brew >/dev/null 2>&1; then
  pg_bindir="$(brew --prefix postgresql@16 2>/dev/null)/bin"
fi
if [[ ! -x "${pg_bindir}/initdb" ]]; then
  echo "No usable PostgreSQL initdb found (set PG_BINDIR)." >&2
  exit 1
fi

workdir="$(mktemp -d)"
trap '"${pg_bindir}/pg_ctl" -D "${workdir}/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$workdir"' EXIT

"${pg_bindir}/initdb" -D "${workdir}/data" -U postgres --auth=trust >"${workdir}/initdb.log" 2>&1
"${pg_bindir}/pg_ctl" -D "${workdir}/data" \
  -o "-k ${workdir} -p 55433 -c listen_addresses=''" -l "${workdir}/pg.log" start
psql() { "${pg_bindir}/psql" -h "${workdir}" -p 55433 -U postgres -v ON_ERROR_STOP=1 "$@"; }

psql -f "${fixtures}/schema.sql" >/dev/null

# Install the exact production pre-image (owner/ACL/config matched so the
# migration's own preimage DO block can be exercised unchanged).
{
  printf 'CREATE OR REPLACE FUNCTION smarter_private.f06_source_guard()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$'
  cat "${fixtures}/preimage-2026-09-27.prosrc.txt"
  printf '$function$;\n'
} | psql >/dev/null
psql -c "
  ALTER FUNCTION smarter_private.f06_source_guard() SECURITY DEFINER;
  ALTER FUNCTION smarter_private.f06_source_guard() SET search_path TO 'pg_catalog', 'public', 'smarter_private';
  REVOKE ALL ON FUNCTION smarter_private.f06_source_guard() FROM PUBLIC;
  CREATE TRIGGER trg_f06_source_guard_ts BEFORE INSERT OR UPDATE OR DELETE ON public.table_seats
    FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard();
  CREATE TRIGGER trg_f06_source_guard_tp BEFORE INSERT OR UPDATE OR DELETE ON public.tournament_players
    FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard();
" >/dev/null

actual_pre_md5="$(psql -t -A -c "select md5(prosrc) from pg_proc where proname='f06_source_guard'")"
if [[ "$actual_pre_md5" != "$PRODUCTION_PROSRC_MD5" ]]; then
  echo "FAIL: fixture pre-image md5 mismatch: ${actual_pre_md5}" >&2
  exit 1
fi

# --- Fixture: production's exact stuck tournament shape -------------------
psql -c "
  INSERT INTO public.tables (id, tournament_id) VALUES
    ('0cfc4303-76ae-4a5e-81ef-2be82cf5d8f0', 'bfcfaf17-2879-4e58-b8e1-1c749ceb3b2f');
  INSERT INTO public.table_seats (id, table_id, user_id, seat_number, left_at, stack, status, joined_at)
  VALUES ('84a24b05-c741-43c6-8e71-c0d4a4b0a7ba', '0cfc4303-76ae-4a5e-81ef-2be82cf5d8f0',
          'f9e96cd6-c8b8-4ddc-aea8-a6a81155158a', 3, NULL, 168000, 'active', now());
  INSERT INTO public.tournament_players (id, tournament_id, user_id, table_id, seat_number, status, chips, position)
  VALUES (gen_random_uuid(), 'bfcfaf17-2879-4e58-b8e1-1c749ceb3b2f', 'f9e96cd6-c8b8-4ddc-aea8-a6a81155158a',
          '0cfc4303-76ae-4a5e-81ef-2be82cf5d8f0', 3, 'playing', 168000, NULL);
  -- the exact abandoned bare park_requested row (break_id 544dc515...)
  INSERT INTO smarter_private.f06_operations
    (break_id, ordinal, tournament_id, source_table_id, lifecycle, boundary_id, origin_generation,
     state, manifest, revision, custody_id, custody_generation, cleanup_kind, close_receipt, created_at, abort_receipt_id)
  VALUES
    ('544dc515-bbbf-4337-8622-e177139bc09a', 75, 'bfcfaf17-2879-4e58-b8e1-1c749ceb3b2f',
     '0cfc4303-76ae-4a5e-81ef-2be82cf5d8f0', 292596, '345254b6-675a-4e80-9528-f693921f6e4d',
     'c37127ac-b35d-4f99-9b9c-ef3555afa697', 'park_requested', NULL, 1,
     '9288d4e1-4ce8-48c2-969e-7bd118848aa8', 'c37127ac-b35d-4f99-9b9c-ef3555afa697', NULL, NULL, now(), NULL);
  -- a second table with a GENUINELY bound op (a real manifest): must stay refused
  INSERT INTO public.tables (id, tournament_id) VALUES
    ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
  INSERT INTO public.table_seats (id, table_id, user_id, seat_number, left_at, stack, status, joined_at)
  VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
          '44444444-4444-4444-4444-444444444444', 1, NULL, 5000, 'active', now());
  INSERT INTO public.tournament_players (id, tournament_id, user_id, table_id, seat_number, status, chips, position)
  VALUES (gen_random_uuid(), '22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444',
          '11111111-1111-1111-1111-111111111111', 1, 'playing', 5000, NULL);
  INSERT INTO smarter_private.f06_operations
    (break_id, ordinal, tournament_id, source_table_id, lifecycle, boundary_id, origin_generation, state,
     manifest, revision, custody_id, custody_generation, cleanup_kind, close_receipt, created_at, abort_receipt_id)
  VALUES
    ('55555555-5555-5555-5555-555555555555', 1, '22222222-2222-2222-2222-222222222222',
     '11111111-1111-1111-1111-111111111111', 1, gen_random_uuid(), gen_random_uuid(), 'park_requested',
     '{\"seats\":[]}'::jsonb, 1, gen_random_uuid(), gen_random_uuid(), NULL, NULL, now(), NULL);
" >/dev/null

echo "--- RED (pre-image): the winner-flip write must fail with F06_SOURCE_EXCLUDED ---"
if psql -c "
  UPDATE public.tournament_players SET status='winner', position=1
   WHERE user_id='f9e96cd6-c8b8-4ddc-aea8-a6a81155158a';
" >/dev/null 2>"${workdir}/red.err"; then
  echo "FAIL: pre-image unexpectedly allowed the write" >&2
  exit 1
fi
grep -q 'F06_SOURCE_EXCLUDED' "${workdir}/red.err"
echo "OK: pre-image reproduces F06_SOURCE_EXCLUDED"

echo "--- Applying the migration ---"
psql -f "$migration" >/dev/null

actual_post_md5="$(psql -t -A -c "select md5(prosrc) from pg_proc where proname='f06_source_guard'")"
if [[ "$actual_post_md5" != "$POSTIMAGE_PROSRC_MD5" ]]; then
  echo "FAIL: post-image md5 mismatch: ${actual_post_md5}" >&2
  exit 1
fi

echo "--- GREEN (post-image): the same write must now succeed ---"
psql -c "
  UPDATE public.tournament_players SET status='winner', position=1
   WHERE user_id='f9e96cd6-c8b8-4ddc-aea8-a6a81155158a';
" >/dev/null
actual_status="$(psql -t -A -c "select status || ':' || position from public.tournament_players where user_id='f9e96cd6-c8b8-4ddc-aea8-a6a81155158a'")"
if [[ "$actual_status" != "winner:1" ]]; then
  echo "FAIL: winner flip did not persist: ${actual_status}" >&2
  exit 1
fi
echo "OK: bare park_requested no longer blocks the write"

echo "--- GREEN (post-image): a genuinely bound op (has a manifest) must still refuse ---"
if psql -c "
  UPDATE public.tournament_players SET status='winner', position=1
   WHERE user_id='44444444-4444-4444-4444-444444444444';
" >/dev/null 2>"${workdir}/still-refused.err"; then
  echo "FAIL: post-image no longer refuses a genuinely bound operation" >&2
  exit 1
fi
grep -q 'F06_SOURCE_EXCLUDED' "${workdir}/still-refused.err"
echo "OK: a genuinely bound operation still refuses"

echo "--- The abandoned f06_operations row itself was not mutated ---"
actual_state="$(psql -t -A -c "select state from smarter_private.f06_operations where break_id='544dc515-bbbf-4337-8622-e177139bc09a'")"
if [[ "$(echo "$actual_state" | xargs)" != "park_requested" ]]; then
  echo "FAIL: the row's own state changed: ${actual_state}" >&2
  exit 1
fi
echo "OK: no data was mutated - only the guard's reading of it changed"

echo "ALL PROOFS PASSED"

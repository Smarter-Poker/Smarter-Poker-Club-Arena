#!/usr/bin/env bash
# =============================================================================
#  THE TERMINAL FINISH IS NOT EXCLUDED BY A PARK THAT CAN NEVER BEGIN - PROOF
# =============================================================================
#
# Red before, green after, against a throwaway PostgreSQL cluster on a unix
# socket. Never against production. Harness derived from PR #5474.
#
# Migration: 20260928044311_the_terminal_finish_is_not_excluded_by_a_park_that_can_never.sql
# Pre-image: smarter_private.f06_source_guard() prosrc md5 be484837..., read
# from production 2026-09-28 (the fixture file below is that exact text).
#
# Run as a non-root user (initdb refuses root), e.g.
#   runuser -u postgres -- bash scripts/dev/probe-f06-terminal-finish-bare-park-pg16.sh
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixtures="${repo_dir}/scripts/dev/fixtures/f06-terminal-finish-bare-park"
migration="${repo_dir}/supabase/migrations/20260928044311_the_terminal_finish_is_not_excluded_by_a_park_that_can_never.sql"

PRODUCTION_PROSRC_MD5='be484837a5103b3c0ac78a1d6d5d0bf2'
POSTIMAGE_PROSRC_MD5='6af3955d0fce49b522b4ba3707a60891'

preimage_md5="$(md5sum "${fixtures}/preimage-2026-09-28.prosrc.txt" | awk '{print $1}')"
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
  -o "-k ${workdir} -p 55434 -c listen_addresses=''" -l "${workdir}/pg.log" start >/dev/null
psql() { "${pg_bindir}/psql" -h "${workdir}" -p 55434 -U postgres -X -q -v ON_ERROR_STOP=1 "$@"; }

psql -f "${fixtures}/schema.sql" >/dev/null
{
  printf 'CREATE OR REPLACE FUNCTION smarter_private.f06_source_guard()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$'
  cat "${fixtures}/preimage-2026-09-28.prosrc.txt"
  printf '$function$;\n'
} | psql >/dev/null
psql -c "
  ALTER FUNCTION smarter_private.f06_source_guard() SECURITY DEFINER;
  ALTER FUNCTION smarter_private.f06_source_guard() SET search_path TO 'pg_catalog', 'public', 'smarter_private';
  REVOKE ALL ON FUNCTION smarter_private.f06_source_guard() FROM PUBLIC;
  CREATE TRIGGER a00_f06_source_seat BEFORE INSERT OR UPDATE OR DELETE ON public.table_seats
    FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard();
  CREATE TRIGGER a00_f06_source_roster BEFORE INSERT OR UPDATE OR DELETE ON public.tournament_players
    FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard();
" >/dev/null

# --- Production's shape: bfcfaf17, winner alone on its last table ----------
T=bfcfaf17-2879-4e58-b8e1-1c749ceb3b2f
TABLE=0cfc4303-76ae-4a5e-81ef-2be82cf5d8f0
WINNER=f9e96cd6-c8b8-4ddc-aea8-a6a81155158a
SEAT=84a24b05-c741-43c6-8e71-c0d4a4b0a7ba
OTHER=22222222-2222-2222-2222-222222222222
psql -c "
  INSERT INTO public.tables (id, tournament_id) VALUES ('${TABLE}', '${T}');
  INSERT INTO public.table_seats (id, table_id, user_id, seat_number, left_at, stack, status, joined_at)
  VALUES ('${SEAT}', '${TABLE}', '${WINNER}', 3, NULL, 168000, 'active', now());
  INSERT INTO public.tournament_players (id, tournament_id, user_id, table_id, seat_number, status, chips, position)
  VALUES (gen_random_uuid(), '${T}', '${WINNER}', '${TABLE}', 3, 'playing', 168000, NULL);
  INSERT INTO smarter_private.f06_operations
    (break_id, ordinal, tournament_id, source_table_id, lifecycle, boundary_id, origin_generation,
     state, manifest, revision, custody_id, custody_generation, cleanup_kind, close_receipt, created_at, abort_receipt_id)
  VALUES ('544dc515-bbbf-4337-8622-e177139bc09a', 75, '${T}', '${TABLE}', 292596,
     '345254b6-675a-4e80-9528-f693921f6e4d', 'c37127ac-b35d-4f99-9b9c-ef3555afa697', 'park_requested', NULL, 2,
     '259546e8-0f5f-4cd6-b2f9-a530d0c430c8', '84e15465-49ea-4bc7-982c-307902f382a9', NULL, NULL, now(), NULL);
" >/dev/null

# The terminal settlement's authority, as fn_ca_open_tournament_seat_exit_authority
# opens it, for an event, an operation and a token.
authority() { # $1 tournament $2 operation (GUC) $3 operation (row)
  printf "SELECT set_config('app.tournament_seat_exit_token','aaaaaaaa-0000-4000-8000-000000000001',true);
SELECT set_config('app.tournament_seat_exit_operation','%s',true);
INSERT INTO public.tournament_seat_exit_authorizations(token,seat_id,tournament_id,user_id,operation)
VALUES ('aaaaaaaa-0000-4000-8000-000000000001','%s','%s','%s','%s');\n" "$2" "$SEAT" "$1" "$WINNER" "$3"
}
FLIP="UPDATE public.tournament_players SET status='winner', position=1 WHERE user_id='${WINNER}';"
EXIT="UPDATE public.table_seats SET left_at=now(), status='left' WHERE id='${SEAT}';"

expect_refused() { # $1 label $2 sql
  if printf 'BEGIN;\n%s\nROLLBACK;\n' "$2" | psql >/dev/null 2>"${workdir}/err"; then
    echo "FAIL: ${1}: the write was allowed" >&2; exit 1
  fi
  grep -q 'F06_SOURCE_EXCLUDED' "${workdir}/err" || { cat "${workdir}/err" >&2; echo "FAIL: ${1}: wrong refusal" >&2; exit 1; }
  echo "OK refused: ${1}"
}
expect_allowed() { # $1 label $2 sql
  printf 'BEGIN;\n%s\nROLLBACK;\n' "$2" | psql >/dev/null 2>"${workdir}/err" || { cat "${workdir}/err" >&2; echo "FAIL: ${1}: refused" >&2; exit 1; }
  echo "OK allowed: ${1}"
}

echo "--- RED: the live pre-image refuses the terminal settlement's winner flip ---"
expect_refused 'pre-image, terminal authority, winner flip' "$(authority "$T" terminal_finish terminal_finish)
${FLIP}"

echo "--- Applying the migration ---"
psql -f "$migration" >/dev/null
actual_post_md5="$(psql -t -A -c "select md5(prosrc) from pg_proc where oid='smarter_private.f06_source_guard()'::regprocedure")"
[[ "$actual_post_md5" == "$POSTIMAGE_PROSRC_MD5" ]] || { echo "FAIL: post-image md5 ${actual_post_md5}" >&2; exit 1; }

echo "--- GREEN: this event's terminal settlement passes the bare park ---"
expect_allowed 'terminal authority, winner flip and seat exit' "$(authority "$T" terminal_finish terminal_finish)
${FLIP}
${EXIT}"

echo "--- Every other writer is still excluded ---"
expect_refused 'no authority at all' "${FLIP}"
expect_refused 'no authority, seat exit' "${EXIT}"
expect_refused 'terminal GUC with no authorization row' "SELECT set_config('app.tournament_seat_exit_operation','terminal_finish',true);
SELECT set_config('app.tournament_seat_exit_token','aaaaaaaa-0000-4000-8000-000000000001',true);
${FLIP}"
expect_refused 'terminal authority of another event' "$(authority "$OTHER" terminal_finish terminal_finish)
${FLIP}"
expect_refused 'a move authority' "$(authority "$T" move move)
${FLIP}"
expect_refused 'terminal GUC over a move authorization row' "$(authority "$T" terminal_finish move)
${FLIP}"
expect_refused 'a park with a member (begin evidence)' "INSERT INTO smarter_private.f06_members(break_id) VALUES ('544dc515-bbbf-4337-8622-e177139bc09a');
$(authority "$T" terminal_finish terminal_finish)
${FLIP}"
expect_refused 'a begun park with a manifest' "UPDATE smarter_private.f06_operations SET state='begun', manifest='[]'::jsonb WHERE break_id='544dc515-bbbf-4337-8622-e177139bc09a';
$(authority "$T" terminal_finish terminal_finish)
${FLIP}"

state="$(psql -t -A -c "select state||':'||revision from smarter_private.f06_operations where break_id='544dc515-bbbf-4337-8622-e177139bc09a'")"
[[ "$state" == "park_requested:2" ]] || { echo "FAIL: the operation row changed: ${state}" >&2; exit 1; }
echo "ALL PROOFS PASSED"

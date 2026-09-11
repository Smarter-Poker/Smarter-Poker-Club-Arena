#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
resolver="$repo_dir/scripts/ops/lib/resolve-staged-or-promoted-migration.sh"
[[ -r "$resolver" ]] || {
  echo 'The staged-or-promoted migration resolver is unreadable.' >&2
  exit 66
}
# shellcheck source=../ops/lib/resolve-staged-or-promoted-migration.sh
# shellcheck disable=SC1091
source "$resolver"
migration="$(
  resolve_staged_or_promoted_migration \
    "$repo_dir/supabase/migrations" \
    stage_b_atomic_finish_precertification
)"

pg17_bin="${PG17_BINDIR:-}"
if [[ -z "$pg17_bin" ]] && command -v brew >/dev/null 2>&1; then
  pg17_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
if [[ ! -x "${pg17_bin}/initdb" ]] \
  || ! "${pg17_bin}/postgres" --version | grep -Eq ' 17\.'; then
  echo 'PostgreSQL 17 tools are required. Set PG17_BINDIR to their bin directory.' >&2
  exit 2
fi

probe_root="$(mktemp -d "${TMPDIR:-/tmp}/ca-finish-precert-pg17.XXXXXX")"
cluster_dir="${probe_root}/cluster"
socket_dir="${probe_root}/socket"
postgres_log="${probe_root}/postgres.log"
mkdir -p "$socket_dir"
port="$((55432 + ($$ % 8000)))"

cleanup() {
  if [[ -d "$cluster_dir" ]]; then
    "${pg17_bin}/pg_ctl" -D "$cluster_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "$probe_root" == "${TMPDIR:-/tmp}/ca-finish-precert-pg17."* ]]; then
    rm -rf "$probe_root"
  fi
}
trap cleanup EXIT

"${pg17_bin}/initdb" -D "$cluster_dir" --auth=trust --no-locale \
  --username=postgres >/dev/null
"${pg17_bin}/pg_ctl" -D "$cluster_dir" -l "$postgres_log" \
  -o "-k ${socket_dir} -p ${port}" -w start >/dev/null

psql_cmd=(
  "${pg17_bin}/psql" -X -v ON_ERROR_STOP=1
  -h "$socket_dir" -p "$port" -U postgres -d postgres
)

"${psql_cmd[@]}" >/dev/null <<'SQL'
CREATE TABLE public.engine_maintenance_break (
  id boolean PRIMARY KEY CHECK (id),
  enforce_freeze boolean NOT NULL,
  phase text NOT NULL,
  break_started_at timestamptz,
  break_ends_at timestamptz
);
INSERT INTO public.engine_maintenance_break
  VALUES (true,true,'counting_down',clock_timestamp(),clock_timestamp()+interval '10 minutes');
CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean
LANGUAGE sql VOLATILE AS $$ SELECT true $$;

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,
  status text NOT NULL,
  on_break boolean NOT NULL DEFAULT false,
  break_started_at timestamptz,
  break_ends_at timestamptz,
  ended_at timestamptz
);
ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_terminal_break_state_is_clear
  CHECK (
    upper(status) NOT IN ('COMPLETED','CANCELLED')
    OR (on_break IS FALSE AND break_started_at IS NULL AND break_ends_at IS NULL)
  );
CREATE FUNCTION public.fn_guard_terminal_tournament_break_state() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER aaa_guard_terminal_tournament_break_state
BEFORE INSERT OR UPDATE ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_terminal_tournament_break_state();

CREATE TABLE public.tournament_finish_receipts (
  tournament_id uuid PRIMARY KEY,
  winner_user_id uuid NOT NULL,
  finish_kind text NOT NULL,
  claim_source text NOT NULL,
  certified_at timestamptz,
  completed_at timestamptz,
  evidence jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.tournament_players (
  tournament_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status text NOT NULL,
  position integer
);
CREATE TABLE public.tournament_place_settlement_batches (
  tournament_id uuid PRIMARY KEY,
  settled_at timestamptz
);
CREATE TABLE public.tournament_final_table_deal_batches (
  tournament_id uuid PRIMARY KEY,
  chip_leader uuid,
  settled_at timestamptz
);
CREATE TABLE public.tournament_satellite_settlement_batches (
  tournament_id uuid PRIMARY KEY,
  settled_at timestamptz
);

CREATE TABLE public.tournament_obligations(id bigint);
CREATE TABLE public.tournament_payouts(id bigint);
CREATE TABLE public.tournament_escrow(id bigint);
CREATE TABLE public.rake_records(id bigint);
CREATE TABLE public.tournament_rake_settlements(id bigint);
CREATE TABLE public.tournament_bounty_completion_receipts(id bigint);
CREATE TABLE public.tournament_bounty_obligations(id bigint);
CREATE TABLE public.tournament_bounty_awards(id bigint);
CREATE TABLE public.tournament_bounty_award_recipients(id bigint);
CREATE TABLE public.tournament_bounties(id bigint);
CREATE TABLE public.tournament_satellite_entitlements(id bigint);
CREATE TABLE public.chip_ledger(id bigint);
CREATE TABLE public.engine_leader(heartbeat_at timestamptz);
CREATE TABLE public.engine_table_leases(heartbeat_at timestamptz);
CREATE TABLE public.engine_tournament_leases(heartbeat_at timestamptz);

CREATE FUNCTION public.fn_tournament_finish_kind(uuid) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT 'normal'::text $$;
CREATE FUNCTION public.fn_tournament_finish_readiness(uuid,uuid) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$
  SELECT jsonb_build_object(
    'ok',true,
    'reason',NULL,
    'failures','[]'::jsonb,
    'financials',jsonb_build_object('unsettled_obligations',0)
  )
$$;

INSERT INTO public.tournaments(id,status,ended_at) VALUES
  ('10000000-0000-4000-8000-000000000001','COMPLETED','2026-09-09T18:01:00Z'),
  ('10000000-0000-4000-8000-000000000002','COMPLETED','2026-09-09T18:02:00Z'),
  ('10000000-0000-4000-8000-000000000003','COMPLETED','2026-09-09T18:03:00Z'),
  ('10000000-0000-4000-8000-000000000004','COMPLETED','2026-09-09T18:04:00Z');
INSERT INTO public.tournament_players(tournament_id,user_id,status,position) VALUES
  ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','winner',1),
  ('10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','winner',1),
  ('10000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000003','winner',1),
  ('10000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000004','winner',1);
INSERT INTO public.tournament_place_settlement_batches(tournament_id,settled_at) VALUES
  ('10000000-0000-4000-8000-000000000001',clock_timestamp()),
  ('10000000-0000-4000-8000-000000000002',clock_timestamp()),
  ('10000000-0000-4000-8000-000000000004',clock_timestamp());
INSERT INTO public.tournament_finish_receipts(
  tournament_id,winner_user_id,finish_kind,claim_source,
  certified_at,completed_at,evidence,updated_at
) VALUES
  ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','normal','stage-a',null,null,null,clock_timestamp()),
  ('10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','normal','stage-a','2026-09-09T18:02:30Z','2026-09-09T18:02:00Z','{"ok":true,"preexisting":true}'::jsonb,'2026-09-09T18:02:30Z');
SQL

"${psql_cmd[@]}" -c \
  "INSERT INTO public.engine_leader VALUES (clock_timestamp());" >/dev/null
live_engine_log="${probe_root}/live-engine.log"
if "${psql_cmd[@]}" -f "$migration" >"$live_engine_log" 2>&1; then
  echo 'Precertification crossed a fresh engine authority heartbeat.' >&2
  exit 1
fi
grep -Fq 'requires every engine authority heartbeat to be stale' "$live_engine_log"
"${psql_cmd[@]}" -c 'DELETE FROM public.engine_leader;' >/dev/null

missing_claim_log="${probe_root}/missing-claim.log"
if "${psql_cmd[@]}" -f "$migration" >"$missing_claim_log" 2>&1; then
  echo 'Precertification invented a missing Stage-A finish claim.' >&2
  exit 1
fi
grep -Fq 'has no immutable Stage-A finish claim' "$missing_claim_log"
if [[ "$("${psql_cmd[@]}" -Atq -c \
  "SELECT certified_at IS NULL AND completed_at IS NULL AND evidence IS NULL FROM public.tournament_finish_receipts WHERE tournament_id='10000000-0000-4000-8000-000000000001';")" != 't' ]]; then
  echo 'A failed precertification left a partial certificate behind.' >&2
  exit 1
fi

"${psql_cmd[@]}" -c "
  INSERT INTO public.tournament_finish_receipts(
    tournament_id,winner_user_id,finish_kind,claim_source
  ) VALUES (
    '10000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000004',
    'normal','stage-a'
  );
" >/dev/null

"${psql_cmd[@]}" -f "$migration" >/dev/null
"${psql_cmd[@]}" -f "$migration" >/dev/null

if [[ "$("${psql_cmd[@]}" -Atq -c "
  SELECT count(*)
    FROM public.tournament_finish_receipts f
    JOIN public.tournaments t ON t.id=f.tournament_id
   WHERE f.tournament_id IN (
     '10000000-0000-4000-8000-000000000001',
     '10000000-0000-4000-8000-000000000004'
   )
     AND f.certified_at IS NOT NULL
     AND f.completed_at=t.ended_at
     AND f.evidence->>'ok'='true'
     AND (f.tournament_id,f.winner_user_id) IN (
       ('10000000-0000-4000-8000-000000000001'::uuid,
        '20000000-0000-4000-8000-000000000001'::uuid),
       ('10000000-0000-4000-8000-000000000004'::uuid,
        '20000000-0000-4000-8000-000000000004'::uuid)
     )
     AND f.finish_kind='normal'
     AND f.claim_source='stage-a';
")" != '2' ]]; then
  echo 'Precertification did not preserve and certify both exact Stage-A claims.' >&2
  exit 1
fi

if [[ "$("${psql_cmd[@]}" -Atq -c "
  SELECT evidence=jsonb_build_object('ok',true,'preexisting',true)
         AND certified_at='2026-09-09T18:02:30Z'::timestamptz
         AND completed_at='2026-09-09T18:02:00Z'::timestamptz
    FROM public.tournament_finish_receipts
   WHERE tournament_id='10000000-0000-4000-8000-000000000002';
")" != 't' ]]; then
  echo 'Precertification rewrote an existing complete certificate.' >&2
  exit 1
fi

if [[ "$("${psql_cmd[@]}" -Atq -c \
  "SELECT count(*) FROM public.tournament_finish_receipts WHERE tournament_id='10000000-0000-4000-8000-000000000003';")" != '0' ]]; then
  echo 'Precertification created a claim for a tournament outside the atomic cohort.' >&2
  exit 1
fi

echo 'PostgreSQL 17 Stage-A atomic finish precertification probe passed.'

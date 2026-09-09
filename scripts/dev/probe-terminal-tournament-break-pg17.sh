#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
migration="$(find "$repo_dir/supabase/migrations" -maxdepth 1 -type f \
  -name '*_terminal_tournaments_cannot_reenter_a_break.sql' -print)"
if [[ "$(printf '%s\n' "$migration" | sed '/^$/d' | wc -l | tr -d ' ')" != '1' ]]; then
  echo 'Expected exactly one terminal-tournament break migration.' >&2
  exit 1
fi

pg17_bin="${PG17_BINDIR:-}"
if [[ -z "$pg17_bin" ]] && command -v brew >/dev/null 2>&1; then
  pg17_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
if [[ ! -x "${pg17_bin}/initdb" ]] \
  || ! "${pg17_bin}/postgres" --version | grep -Eq ' 17\.'; then
  echo 'PostgreSQL 17 tools are required. Set PG17_BINDIR to their bin directory.' >&2
  exit 2
fi

probe_root="$(mktemp -d "${TMPDIR:-/tmp}/ca-terminal-break-pg17.XXXXXX")"
cluster_dir="${probe_root}/cluster"
socket_dir="${probe_root}/socket"
postgres_log="${probe_root}/postgres.log"
mkdir -p "$socket_dir"
port="$((45432 + ($$ % 10000)))"

cleanup() {
  if [[ -d "$cluster_dir" ]]; then
    "${pg17_bin}/pg_ctl" -D "$cluster_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "$probe_root" == "${TMPDIR:-/tmp}/ca-terminal-break-pg17."* ]]; then
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
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA IF NOT EXISTS public;
CREATE SCHEMA smarter_private;
CREATE SCHEMA realtime;
CREATE TABLE realtime.subscription(id bigint PRIMARY KEY);
CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,
  status text NOT NULL,
  on_break boolean NOT NULL DEFAULT false,
  break_started_at timestamptz,
  break_ends_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

/* Reproduce PostgreSQL's BEFORE-trigger visibility rule. The financial
   certificate sees NEW through its trigger arguments, while its readiness
   query sees the still-stored OLD tournament row. */
CREATE OR REPLACE FUNCTION public.fn_tournament_finish_readiness(
  p_tournament_id uuid,
  p_winner_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_failures jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_t FROM public.tournaments WHERE id=p_tournament_id;
  IF COALESCE(v_t.on_break,false) THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','terminal_break_flag_set'));
  END IF;
  IF p_tournament_id='10000000-0000-4000-8000-000000000007'::uuid THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','synthetic_financial_failure'));
  END IF;
  RETURN jsonb_build_object('ok',jsonb_array_length(v_failures)=0,
                            'reason',CASE WHEN jsonb_array_length(v_failures)=0
                                          THEN NULL ELSE v_failures->0->>'code' END,
                            'failures',v_failures);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_tournament_completed_certificate()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_ready jsonb;
  v_winner uuid := NEW.id;
BEGIN
  IF COALESCE(NEW.on_break,false) THEN
    RAISE EXCEPTION 'candidate completion retained a break';
  END IF;
  v_ready := public.fn_tournament_finish_readiness(NEW.id,v_winner);
  IF COALESCE((v_ready->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'completion was not ready: %',v_ready;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER zzzzzz_tournaments_financial_certificate
BEFORE UPDATE OF status ON public.tournaments
FOR EACH ROW
WHEN (NEW.status='COMPLETED' AND OLD.status IS DISTINCT FROM 'COMPLETED')
EXECUTE FUNCTION public.fn_guard_tournament_completed_certificate();

INSERT INTO public.tournaments(
  id,status,on_break,break_started_at,break_ends_at
) VALUES
  ('10000000-0000-4000-8000-000000000001','COMPLETED',true,now()-interval '5 min',now()),
  ('10000000-0000-4000-8000-000000000002','CANCELLED',true,now()-interval '5 min',now()),
  ('10000000-0000-4000-8000-000000000003','COMPLETED',false,now()-interval '1 hour',null),
  ('10000000-0000-4000-8000-000000000004','COMPLETING',true,now()-interval '1 min',null),
  ('10000000-0000-4000-8000-000000000005','COMPLETED',false,null,null),
  ('10000000-0000-4000-8000-000000000006','COMPLETING',true,now()-interval '1 min',null),
  ('10000000-0000-4000-8000-000000000007','COMPLETING',true,now()-interval '1 min',null);
SQL

old_row_log="${probe_root}/old-row-readiness.log"
if "${psql_cmd[@]}" -c \
  "UPDATE public.tournaments SET status='COMPLETED',on_break=false,break_started_at=NULL,break_ends_at=NULL WHERE id='10000000-0000-4000-8000-000000000004';" \
  >"$old_row_log" 2>&1; then
  echo 'The fixture did not reproduce BEFORE-trigger OLD-row visibility.' >&2
  exit 1
fi
grep -Fq 'terminal_break_flag_set' "$old_row_log"

"${psql_cmd[@]}" -f "$migration" >/dev/null
"${psql_cmd[@]}" -f "$migration" >/dev/null

if [[ "$("${psql_cmd[@]}" -Atq -c \
  "SELECT count(*) FROM public.tournament_terminal_break_normalization_receipts;")" != '3' ]]; then
  echo 'The migration did not preserve every dirty terminal preimage exactly once.' >&2
  exit 1
fi
if [[ "$("${psql_cmd[@]}" -Atq -c \
  "SELECT count(*) FROM public.tournaments WHERE status IN ('COMPLETED','CANCELLED') AND (on_break OR break_started_at IS NOT NULL OR break_ends_at IS NOT NULL);")" != '0' ]]; then
  echo 'A terminal tournament retained break state.' >&2
  exit 1
fi
if [[ "$("${psql_cmd[@]}" -Atq -c \
  "SELECT on_break::text || ':' || (break_started_at IS NOT NULL)::text FROM public.tournaments WHERE id='10000000-0000-4000-8000-000000000004';")" != 'true:true' ]]; then
  echo 'The repair changed a nonterminal break.' >&2
  exit 1
fi

if [[ "$("${psql_cmd[@]}" -Atq -c \
  "SELECT (public.fn_tournament_finish_readiness('10000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000006')->'failures') @> '[{\"code\":\"terminal_break_flag_set\"}]'::jsonb;")" != 't' ]]; then
  echo 'The ordinary readiness contract stopped flagging a stored COMPLETING break.' >&2
  exit 1
fi
if [[ "$("${psql_cmd[@]}" -Atq -c \
  "SELECT (smarter_private.fn_tournament_finish_readiness_for_terminal_candidate('10000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000006','COMPLETING',true,NULL,NULL)->'failures') @> '[{\"code\":\"terminal_break_flag_set\"}]'::jsonb;")" != 't' ]]; then
  echo 'The private adapter forgave a dirty NEW completion candidate.' >&2
  exit 1
fi

"${psql_cmd[@]}" >/dev/null <<'SQL'
UPDATE public.tournaments
   SET status='COMPLETED'
 WHERE id='10000000-0000-4000-8000-000000000004';
SQL
if [[ "$("${psql_cmd[@]}" -Atq -c \
  "SELECT on_break::text || ':' || (break_started_at IS NULL)::text || ':' || (break_ends_at IS NULL)::text FROM public.tournaments WHERE id='10000000-0000-4000-8000-000000000004';")" != 'false:true:true' ]]; then
  echo 'A legitimate terminal transition was not canonicalized.' >&2
  exit 1
fi

unrelated_failure_log="${probe_root}/unrelated-readiness-failure.log"
if "${psql_cmd[@]}" -c \
  "UPDATE public.tournaments SET status='COMPLETED' WHERE id='10000000-0000-4000-8000-000000000007';" \
  >"$unrelated_failure_log" 2>&1; then
  echo 'The terminal candidate adapter filtered an unrelated readiness failure.' >&2
  exit 1
fi
grep -Fq 'synthetic_financial_failure' "$unrelated_failure_log"

late_break_log="${probe_root}/late-break.log"
if "${psql_cmd[@]}" -c \
  "UPDATE public.tournaments SET on_break=true,break_started_at=now() WHERE id='10000000-0000-4000-8000-000000000004';" \
  >"$late_break_log" 2>&1; then
  echo 'A completed tournament re-entered a break.' >&2
  exit 1
fi
grep -Fq 'cannot re-enter a break' "$late_break_log"

receipt_mutation_log="${probe_root}/receipt-mutation.log"
if "${psql_cmd[@]}" -c \
  "UPDATE public.tournament_terminal_break_normalization_receipts SET normalized_at=now();" \
  >"$receipt_mutation_log" 2>&1; then
  echo 'A terminal break normalization receipt was mutable.' >&2
  exit 1
fi
grep -Fq 'normalization receipts are immutable' "$receipt_mutation_log"

if "${psql_cmd[@]}" -c \
  "SET ROLE service_role; SELECT * FROM public.tournament_terminal_break_normalization_receipts;" \
  >"${probe_root}/service-role-read.log" 2>&1; then
  echo 'service_role could read the private normalization receipt table.' >&2
  exit 1
fi

echo 'PostgreSQL 17 terminal tournament break-state probe passed.'

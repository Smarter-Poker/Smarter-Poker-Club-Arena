#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
migration="$repo_dir/supabase/migrations/20260908233129_daily_mission_users_do_not_share_one_long_transaction.sql"
fixture="$repo_dir/scripts/dev/fixtures/daily-mission-outbox-transaction-boundary-pg17-bootstrap.sql"

pg17_bin="${PG17_BINDIR:-}"
if [[ -z "$pg17_bin" ]] && command -v brew >/dev/null 2>&1; then
  pg17_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
if [[ ! -x "${pg17_bin}/initdb" ]] \
   || ! "${pg17_bin}/postgres" --version | grep -Eq ' 17[.]'; then
  echo 'PostgreSQL 17 tools are required. Set PG17_BINDIR to their bin directory.' >&2
  exit 2
fi

probe_root="$(mktemp -d "/tmp/ca-mission-boundary-pg17.XXXXXX")"
cluster_dir="${probe_root}/cluster"
socket_dir="${probe_root}/socket"
postgres_log="${probe_root}/postgres.log"
drain_log="${probe_root}/drain.log"
same_user_log="${probe_root}/same-user.log"
mkdir -p "$socket_dir"
port="$((38432 + ($$ % 10000)))"

cleanup() {
  if [[ -d "$cluster_dir" ]]; then
    "${pg17_bin}/pg_ctl" -D "$cluster_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "$probe_root" == "/tmp/ca-mission-boundary-pg17."* ]]; then
    rm -rf "$probe_root"
  fi
}
trap cleanup EXIT

"${pg17_bin}/initdb" -D "$cluster_dir" --auth=trust --no-locale \
  --username=postgres >/dev/null
if ! "${pg17_bin}/pg_ctl" -D "$cluster_dir" -l "$postgres_log" \
  -o "-k ${socket_dir} -p ${port} -c deadlock_timeout=100ms" \
  -w start >/dev/null; then
  sed -n '1,240p' "$postgres_log" >&2
  exit 1
fi

psql_cmd=(
  "${pg17_bin}/psql" -X -v ON_ERROR_STOP=1
  -h "$socket_dir" -p "$port" -U postgres -d postgres
)

"${psql_cmd[@]}" -f "$fixture" >/dev/null
"${psql_cmd[@]}" -f "$migration" >/dev/null
# Definition and cron rewiring are idempotent.
"${psql_cmd[@]}" -f "$migration" >/dev/null

# CALL is intentionally a top-level statement.  The first player's receipt
# must commit before the second player's three-second transaction begins.
"${psql_cmd[@]}" \
  -c 'CALL public.sp_drain_daily_challenge_event_outbox(20, 0, 1);' \
  >"$drain_log" 2>&1 &
drain_pid=$!

slow_started='f'
for _ in $(seq 1 100); do
  slow_started="$("${psql_cmd[@]}" -Atc \
    "SELECT is_called FROM public.probe_slow_user_started;")"
  if [[ "$slow_started" == 't' ]]; then
    break
  fi
  sleep 0.05
done
if [[ "$slow_started" != 't' ]]; then
  echo 'The slow second-player transaction never began.' >&2
  sed -n '1,240p' "$drain_log" >&2 || true
  exit 1
fi

# While player 2 is still locked, the first player's committed profile must be
# immediately available to the table_seats foreign-key check.
"${psql_cmd[@]}" -c "
  SET lock_timeout = '400ms';
  INSERT INTO public.table_seats(user_id)
  VALUES ('11111111-0000-4000-8000-000000000001');
" >/dev/null

# The same-player mutex is not weakened: player 2's FK check must still wait
# for the player 2 mission transaction and hit this deliberately short probe
# timeout.
if "${psql_cmd[@]}" -c "
  SET lock_timeout = '400ms';
  INSERT INTO public.table_seats(user_id)
  VALUES ('22222222-0000-4000-8000-000000000002');
" >"$same_user_log" 2>&1; then
  echo 'A same-player table write bypassed the Daily Missions player mutex.' >&2
  exit 1
fi
if ! grep -Eq 'lock timeout|canceling statement due to lock timeout' "$same_user_log"; then
  echo 'The same-player write failed for an unexpected reason.' >&2
  sed -n '1,240p' "$same_user_log" >&2
  exit 1
fi

if ! wait "$drain_pid"; then
  sed -n '1,240p' "$drain_log" >&2
  exit 1
fi

"${psql_cmd[@]}" -Atc "
  DO \$assertions\$
  BEGIN
    IF (SELECT count(*) FROM public.daily_challenge_progress_events) <> 2 THEN
      RAISE EXCEPTION 'each event must have exactly one durable receipt';
    END IF;
    IF EXISTS (SELECT 1 FROM public.daily_challenge_event_outbox) THEN
      RAISE EXCEPTION 'successfully receipted probe events must leave the outbox';
    END IF;
    IF (SELECT count(*) FROM public.table_seats
         WHERE user_id = '11111111-0000-4000-8000-000000000001') <> 1 THEN
      RAISE EXCEPTION 'the unrelated table write did not commit';
    END IF;
    IF (SELECT count(*) FROM cron.job
         WHERE command LIKE 'CALL public.sp_drain_daily_challenge_event_outbox%') <> 4 THEN
      RAISE EXCEPTION 'all four primary shards must use top-level CALL';
    END IF;
  END;
  \$assertions\$;
" >/dev/null

# A later event for one player can abort the helper's protected
# subtransaction after an earlier event incremented v_done. Both writes must
# roll back and the JSON result must report booked=0, because PL/pgSQL scalar
# variables do not roll back with table changes.
"${psql_cmd[@]}" -Atc "
  INSERT INTO public.daily_challenge_event_outbox(
    user_id, event_key, amounts, magnitudes, threshold_values,
    occurred_at, created_at, next_attempt_at
  ) VALUES
    (
      '33333333-0000-4000-8000-000000000003',
      'probe:rollback-first', '{\"hands_played\":1}', '{}', '{}',
      now() - interval '2 seconds', now() - interval '2 seconds', now() - interval '1 second'
    ),
    (
      '33333333-0000-4000-8000-000000000003',
      'probe:rollback-second', '{\"hands_played\":1}', '{}', '{}',
      now() - interval '1 second', now() - interval '1 second', now() - interval '1 second'
    );

  DO \$rollback_truth\$
  DECLARE
    v_result jsonb;
  BEGIN
    v_result := public.fn_drain_daily_challenge_event_outbox_user(
      '33333333-0000-4000-8000-000000000003', 100
    );
    IF v_result <> '{\"seen\": 1, \"booked\": 0, \"skipped\": 1}'::jsonb THEN
      RAISE EXCEPTION 'rolled-back player batch reported false telemetry: %', v_result;
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.daily_challenge_progress_events
       WHERE user_id = '33333333-0000-4000-8000-000000000003'
    ) THEN
      RAISE EXCEPTION 'an earlier receipt survived the rolled-back player batch';
    END IF;
    IF (
      SELECT count(*) FROM public.daily_challenge_event_outbox
       WHERE user_id = '33333333-0000-4000-8000-000000000003'
    ) <> 2 THEN
      RAISE EXCEPTION 'the rolled-back player batch lost an authoritative event';
    END IF;
  END;
  \$rollback_truth\$;
" >/dev/null

echo 'PASS: Daily Missions commits per player; unrelated table FK writes do not wait, same-player serialization, rollback telemetry, and exact receipts remain intact.'

#!/usr/bin/env bash
# scripts/ci/probes/hand-number-lock/concurrency.sh
#
# THE HAND-NUMBER INVARIANT, UNDER REAL CONCURRENCY (2026-09-26)
#
# Installs smarter_private.f06_allocate_number_above exactly as a migration
# file defines it into a DISPOSABLE PostgreSQL cluster (initdb in a temp
# directory, a private port, removed on exit - never a shared or production
# database), then drives it from many concurrent pgbench clients, each one a
# "table" that asks for a number above its own high-water mark, the way
# public.fn_f06_allocate_hand_number does. A fraction of the asks put the
# floor ABOVE the global sequence, which forces the setval path while other
# clients are allocating.
#
# It asserts the two things a hand number must never do:
#   * be issued twice (to any two allocations, same table or not);
#   * come back at or below the floor its caller passed (a table's last
#     dealt number + 1).
#
# Variants, each against a fresh sequence:
#   installed  - the function text exactly as the migration writes it;
#   widened    - the same text with pg_sleep(0.005) between nextval and
#                setval on the exclusive path, so a rewind WOULD land if
#                anything could interleave there, and with the ALTER SEQUENCE
#                barrier removed: that statement takes an ACCESS EXCLUSIVE
#                lock on the sequence until commit, which would hide a missing
#                advisory lock. Here the advisory lock alone must hold;
#   regression - the widened text with the exclusive lock replaced by the
#                shared one (a planted defect: setval no longer excludes
#                nextval). The harness MUST report duplicates for it, or it
#                proves nothing.
#
#   preimage   - (optional, PREIMAGE=<older migration>) the definition being
#                replaced, run with a 2 ms stall between the allocation and
#                COMMIT (a commit flush stall) beside the installed text under
#                the same stall: the before/after of the lock's cost.
#
# Usage: [PREIMAGE=<older.sql>] concurrency.sh <migration.sql> [clients] [transactions-per-client]
# Exit 0 when installed and widened hold and regression is caught; 1 otherwise;
# 3 when it could not run.
set -euo pipefail
# macOS: a postmaster with no valid locale refuses to start ("became multithreaded").
export LC_ALL=C LANG=C
MIG="${1:?migration file}"; CLIENTS="${2:-48}"; TX="${3:-400}"; PREIMAGE="${PREIMAGE:-}"
command -v initdb >/dev/null && command -v pgbench >/dev/null || { echo "COULD NOT TELL: initdb/pgbench not on PATH"; exit 3; }
DIR="$(mktemp -d "${TMPDIR:-/tmp}/hand-number-lock.XXXXXX")"
PORT=$(( 20000 + RANDOM % 20000 ))
cleanup() { pg_ctl -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT
initdb -D "$DIR/data" -U postgres -A trust --no-locale -E UTF8 >/dev/null
pg_ctl -D "$DIR/data" -o "-p $PORT -k $DIR -c max_connections=200 -c listen_addresses=''" -l "$DIR/log" -w start >/dev/null || { cat "$DIR/log"; echo "COULD NOT TELL: the disposable cluster did not start"; exit 3; }
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -h "$DIR" -p "$PORT" -U postgres -d postgres)

extract() { python3 - "$1" <<'PY'
import sys
import re
s = open(sys.argv[1]).read()
m = re.search(r"CREATE (OR REPLACE )?FUNCTION smarter_private\.f06_allocate_number_above\(.*?AS (\$[a-z_]*\$)(.*?)\2;", s, re.S)
body = m.group(0)
print(body if m.group(1) else body.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION", 1))
PY
}
BODY="$(extract "$MIG")"
variant() {
  case "$1" in
    installed|installed-stall) printf '%s\n' "$BODY" ;;
    preimage-stall) extract "$PREIMAGE" ;;
    widened) printf '%s\n' "$BODY" | python3 -c 'import sys; s=sys.stdin.read(); t=" IF n<floor_number THEN n:=setval("; a="ALTER SEQUENCE public.global_hand_number_seq CACHE 1;"; assert s.count(t)==1 and s.count(a)==1; print(s.replace(t, " PERFORM pg_sleep(0.005);\n"+t).replace(a, "NULL;"))' ;;
    regression) variant widened | python3 -c 'import sys; s=sys.stdin.read(); t="PERFORM pg_advisory_xact_lock(hashtext"; assert s.count(t)==1; print(s.replace(t, "PERFORM pg_advisory_xact_lock_shared(hashtext"))' ;;
  esac
}

run() {
  local name="$1"
  "${PSQL[@]}" <<SQL
DROP SCHEMA IF EXISTS smarter_private CASCADE; CREATE SCHEMA smarter_private;
DROP SEQUENCE IF EXISTS public.global_hand_number_seq;
CREATE SEQUENCE public.global_hand_number_seq START 14800000 CACHE 1 NO CYCLE;
DROP TABLE IF EXISTS public.issued; CREATE TABLE public.issued(t int NOT NULL, floor_number bigint NOT NULL, n bigint NOT NULL); CREATE INDEX ON public.issued(t, n);
$(variant "$name")
SQL
  local stall=0; case "$name" in *-stall) stall=0.002 ;; esac
  cat > "$DIR/alloc.sql" <<PGB
\\set t random(1, 64)
\set jump random(1, 25)
BEGIN;
SELECT CASE WHEN :jump = 1 THEN (SELECT last_value + 3 + (:t % 7) FROM public.global_hand_number_seq)
            ELSE COALESCE((SELECT max(n) FROM public.issued WHERE t = :t), 1000000) + 1 END AS fl \gset
INSERT INTO public.issued(t, floor_number, n) VALUES (:t, :fl, smarter_private.f06_allocate_number_above(:fl));
SELECT pg_sleep($stall);
COMMIT;
PGB
  local start end
  start=$(python3 -c 'import time; print(time.time())')
  pgbench -n -h "$DIR" -p "$PORT" -U postgres -c "$CLIENTS" -j 8 -t "$TX" -f "$DIR/alloc.sql" postgres > "$DIR/$name.pgbench" 2>&1 || true
  end=$(python3 -c 'import time; print(time.time())')
  "${PSQL[@]}" -At -F ' ' -c "
    SELECT '$name',
           count(*) AS allocations,
           count(*) - count(DISTINCT n) AS duplicates,
           count(*) FILTER (WHERE n < floor_number) AS below_floor,
           count(*) FILTER (WHERE n = floor_number) AS setval_path,
           round(count(*) / greatest($end - $start, 0.001)) AS per_second
      FROM public.issued"
}

if [ -n "$PREIMAGE" ]; then run preimage-stall; run installed-stall; fi
R_INSTALLED="$(run installed)"; echo "$R_INSTALLED"
R_WIDENED="$(run widened)"; echo "$R_WIDENED"
R_REGRESSION="$(run regression)"; echo "$R_REGRESSION"
grep -h -E 'failed|aborted' "$DIR"/*.pgbench | sed 's/^/pgbench: /' || true

ok=1
read -r _ a d b s _ <<<"$R_INSTALLED";  [ "$a" -gt 0 ] && [ "$d" = 0 ] && [ "$b" = 0 ] || { echo "FAIL installed: allocations=$a duplicates=$d below_floor=$b"; ok=0; }
read -r _ a d b s _ <<<"$R_WIDENED";    [ "$a" -gt 0 ] && [ "$d" = 0 ] && [ "$b" = 0 ] && [ "$s" -gt 0 ] || { echo "FAIL widened: allocations=$a duplicates=$d below_floor=$b setval_path=$s"; ok=0; }
read -r _ a d b s _ <<<"$R_REGRESSION"; [ "$d" -gt 0 ] || { echo "FAIL regression: the planted defect produced no duplicate, so this harness proves nothing"; ok=0; }
[ "$ok" = 1 ] && echo "HOLDS: no duplicate and no number below its floor; the planted regression was caught" && exit 0
exit 1

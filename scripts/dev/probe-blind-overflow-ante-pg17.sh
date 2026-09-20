#!/usr/bin/env bash
# =============================================================================
#  THE OVERFLOW ANTE KEEPS ITS AUTHORED SHARE OF THE BIG BLIND - PG17 PROOF
# =============================================================================
#
# Red before, green after, against a throwaway PostgreSQL 17 cluster on a unix
# socket. Never against production: fn_resolve_tournament_blinds is pure (no
# table access, no writes), so every case here is a function call on fixture
# text.
#
# The pre-image is not hand-copied. It is rebuilt from this repository's own
# migration chain and then pinned to the md5 of pg_get_functiondef read out of
# production on 2026-09-20, so a drifted chain fails here instead of quietly
# proving something about a different function.
#
# The unchanged-levels proof is exhaustive: every distinct blind_structure in
# production x every level in it x seven chip totals x both variants, old
# jsonb against new jsonb.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
migrations="${repo_dir}/supabase/migrations"

# The exact production identity of the function this repair was written
# against, read from kuklfnapbkmacvwxktbh on 2026-09-20 (read-only).
PRODUCTION_FUNCTIONDEF_MD5='8545c67dc20be918ada9027d88f46312'
PRODUCTION_PROSRC_MD5='4f83c09a69eecc766a1f3984feeb9823'
PRODUCTION_ACL='{postgres=X/postgres}'
PRODUCTION_PROCONFIG='{"search_path=public, pg_temp"}'

migration_by_suffix() {
  local suffix="$1" matches=() match
  while IFS= read -r match; do matches+=("$match"); done < <(
    find "$migrations" -maxdepth 1 -type f \
      \( -name "*_${suffix}" -o -name "*_${suffix}.pending" \) -print | sort
  )
  if [[ "${#matches[@]}" -ne 1 ]]; then
    echo "Expected exactly one migration ending ${suffix}; found ${#matches[@]}." >&2
    exit 1
  fi
  printf '%s\n' "${matches[0]}"
}

helper_migration="$(migration_by_suffix every_tournament_insert_was_failing_on_a_text_column_read_as_jsonb.sql)"
birth_migration="$(migration_by_suffix late_registration_can_build_its_first_table.sql)"
capped_migration="$(migration_by_suffix ca_a_capped_blind_level_is_still_a_blind_level.sql)"
spin_migration="$(migration_by_suffix booked_spin_continuation_preserves_floating_point_rounding.sql)"
repair_migration="$(migration_by_suffix the_overflow_ante_keeps_its_authored_share_of_the_big_blind.sql)"
structures_fixture="${repo_dir}/scripts/dev/fixtures/blind-overflow-ante/production-blind-structures.sql"

if [[ ! -f "$structures_fixture" ]]; then
  echo "Missing production structure fixture: $structures_fixture" >&2
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

# A postmaster that inherits a multithreaded locale environment refuses to
# start on macOS ("postmaster became multithreaded during startup").
export LC_ALL=C LANG=C

probe_root="$(mktemp -d "/tmp/ca-blind-overflow-ante-pg17.XXXXXX")"
cluster_dir="${probe_root}/cluster"
socket_dir="${probe_root}/socket"
postgres_log="${probe_root}/postgres.log"
mkdir -p "$socket_dir"
port="$((42432 + ($$ % 10000)))"

cleanup() {
  if [[ -d "$cluster_dir" ]]; then
    "${pg17_bin}/pg_ctl" -D "$cluster_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "$probe_root" == "/tmp/ca-blind-overflow-ante-pg17."* ]]; then
    rm -rf "$probe_root"
  fi
}
trap cleanup EXIT

"${pg17_bin}/initdb" -D "$cluster_dir" --auth=trust --no-locale \
  --username=postgres >/dev/null
# listen_addresses='' keeps this cluster on its unix socket only.
if ! "${pg17_bin}/pg_ctl" -D "$cluster_dir" -l "$postgres_log" \
  -o "-k ${socket_dir} -p ${port} -c listen_addresses=''" -w start >/dev/null; then
  sed -n '1,240p' "$postgres_log" >&2
  exit 1
fi

psql_cmd=("${pg17_bin}/psql" -X -q -v ON_ERROR_STOP=1
          -h "$socket_dir" -p "$port" -U postgres -d postgres)
q() { "${psql_cmd[@]}" -Atc "$1"; }

fail() { echo "PROBE FAILED: $*" >&2; exit 1; }
expect_eq() {
  local label="$1" actual="$2" wanted="$3"
  [[ "$actual" == "$wanted" ]] || fail "${label}: got '${actual}', wanted '${wanted}'"
  printf '  ok  %-58s %s\n' "$label" "$actual"
}

# Supabase's roles are named by the migrations' REVOKE/GRANT lines.
"${psql_cmd[@]}" -c "
DO \$\$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN END \$\$;
DO \$\$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN END \$\$;
DO \$\$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN END \$\$;" >/dev/null

# ---------------------------------------------------------------------------
# 1. Rebuild the production pre-image from the repository's own chain.
# ---------------------------------------------------------------------------
echo '== pre-image =='
awk 'index($0,"CREATE OR REPLACE FUNCTION public.fn_safe_jsonb_array(")==1{c=1}
     c{print} c&&/^\$function\$;$/{exit}' "$helper_migration" > "${probe_root}/safe.sql"
awk 'index($0,"CREATE OR REPLACE FUNCTION public.fn_resolve_tournament_blinds(")==1{c=1}
     c{print} c&&/^\$function\$;$/{exit}' "$birth_migration" > "${probe_root}/base.sql"
[[ -s "${probe_root}/safe.sql" && -s "${probe_root}/base.sql" ]] \
  || fail 'could not extract the resolver and its helper from the birth migration'

"${psql_cmd[@]}" -f "${probe_root}/safe.sql" >/dev/null
"${psql_cmd[@]}" -f "${probe_root}/base.sql" >/dev/null
"${psql_cmd[@]}" -c "
REVOKE ALL ON FUNCTION public.fn_safe_jsonb_array(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_resolve_tournament_blinds(text,integer,text,text,numeric) FROM PUBLIC;" >/dev/null
# The capped-level migration ends with REVOKEs for roles it assumes exist; the
# function surgery ahead of them is what this chain needs.
"${psql_cmd[@]}" -f "$capped_migration" >/dev/null 2>&1 || true
"${psql_cmd[@]}" -f "$spin_migration" >/dev/null

sig="public.fn_resolve_tournament_blinds(text,integer,text,text,numeric)"
expect_eq 'pre-image md5(pg_get_functiondef)' \
  "$(q "SELECT md5(pg_get_functiondef('${sig}'::regprocedure));")" "$PRODUCTION_FUNCTIONDEF_MD5"
expect_eq 'pre-image md5(prosrc)' \
  "$(q "SELECT md5(prosrc) FROM pg_proc WHERE oid='${sig}'::regprocedure;")" "$PRODUCTION_PROSRC_MD5"
expect_eq 'pre-image owner' \
  "$(q "SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='${sig}'::regprocedure;")" 'postgres'
expect_eq 'pre-image acl' \
  "$(q "SELECT proacl::text FROM pg_proc WHERE oid='${sig}'::regprocedure;")" "$PRODUCTION_ACL"
expect_eq 'pre-image proconfig' \
  "$(q "SELECT proconfig::text FROM pg_proc WHERE oid='${sig}'::regprocedure;")" "$PRODUCTION_PROCONFIG"
expect_eq 'pre-image volatility' \
  "$(q "SELECT provolatile::text FROM pg_proc WHERE oid='${sig}'::regprocedure;")" 'v'
expect_eq 'pre-image security definer' \
  "$(q "SELECT prosecdef::text FROM pg_proc WHERE oid='${sig}'::regprocedure;")" 'true'

# ---------------------------------------------------------------------------
# 2. Every production structure, every level, seven chip totals, both variants.
# ---------------------------------------------------------------------------
"${psql_cmd[@]}" -f "$structures_fixture" >/dev/null
expect_eq 'production structures loaded' "$(q 'SELECT count(*) FROM probe_structures;')" '21'
expect_eq 'authored levels across them' "$(q 'SELECT sum(n_levels) FROM probe_structures;')" '370'
expect_eq 'authored levels with ante above the big blind' \
  "$(q "SELECT count(*) FROM probe_structures p, jsonb_array_elements(p.structure::jsonb) e
        WHERE COALESCE((e->>'ante')::numeric,0) > (e->>'bigBlind')::numeric;")" '0'

"${psql_cmd[@]}" -c "
CREATE TABLE probe_grid AS
SELECT p.tag, p.n_levels, lv.idx, tc.chips, vr.variant, vr.ttype,
       (lv.idx < p.n_levels) AS authored, p.structure
  FROM probe_structures p
  CROSS JOIN LATERAL (SELECT generate_series(0, p.n_levels + 200) AS idx) lv
  CROSS JOIN (VALUES (NULL::numeric),(40),(1000),(100000),(975000),(1755000),(50000000)) tc(chips)
  CROSS JOIN (VALUES ('freezeout','MTT'),('spin','SPIN')) vr(variant,ttype);
CREATE TABLE probe_old AS
SELECT tag,n_levels,idx,chips,variant,ttype,authored,
       public.fn_resolve_tournament_blinds(structure,idx,variant,ttype,chips) AS r
  FROM probe_grid;" >/dev/null
echo "  ..  grid rows: $(q 'SELECT count(*) FROM probe_grid;') ($(q 'SELECT count(*) FROM probe_grid WHERE authored;') authored)"

# ---------------------------------------------------------------------------
# 3. RED - the defect on the pre-image, at the two live production cases.
# ---------------------------------------------------------------------------
echo '== red (pre-image) =='
live_deep="SELECT r->>'small_blind'||'/'||(r->>'big_blind')||'/'||(r->>'ante')
             FROM probe_old WHERE tag='5558f378' AND idx=162 AND chips=1755000 AND variant='freezeout'"
live_mid="SELECT r->>'small_blind'||'/'||(r->>'big_blind')||'/'||(r->>'ante')
            FROM probe_old WHERE tag='70cd09f8' AND idx=126 AND chips=975000 AND variant='freezeout'"
# tables.id 2c621856-e728-4e8b-bf08-4c56746a8649, live 2026-09-20.
expect_eq 'live 2c621856 reproduces sb/bb/ante' "$(q "$live_deep")" '43875/87750/87750'
# tables.id 9f30d335-8262-4872-8926-3ddf1fefe75c, live 2026-09-20.
expect_eq 'live 9f30d335 reproduces sb/bb/ante' "$(q "$live_mid")" '24375/48750/48750'
expect_eq 'pre-image overflow rows dealing ante = big blind' \
  "$(q "SELECT count(*) FROM probe_old o
         JOIN probe_structures p USING (tag)
        WHERE NOT o.authored AND o.variant='freezeout'
          AND (o.r->>'ante')::numeric = (o.r->>'big_blind')::numeric
          AND (o.r->>'ante')::numeric > 0
          AND COALESCE((p.structure::jsonb->(p.n_levels-1)->>'ante')::numeric,0)
              < (p.structure::jsonb->(p.n_levels-1)->>'bigBlind')::numeric;")" '12663'

# ---------------------------------------------------------------------------
# 4. Apply the repair.
# ---------------------------------------------------------------------------
echo '== repair =='
"${psql_cmd[@]}" -f "$repair_migration" >/dev/null
echo '  ok  migration applied (its own in-transaction assertions passed)'

replay_log="${probe_root}/replay.log"
if "${psql_cmd[@]}" -f "$repair_migration" >"$replay_log" 2>&1; then
  fail 'the repair applied twice; its pre-image guard does not bite'
fi
grep -Fq 'BLIND_OVERFLOW_ANTE_PREIMAGE_CHANGED' "$replay_log" \
  || { sed -n '1,40p' "$replay_log" >&2; fail 'replay failed for the wrong reason'; }
echo '  ok  replay refused by the pre-image guard'

expect_eq 'post-image owner'           "$(q "SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='${sig}'::regprocedure;")" 'postgres'
expect_eq 'post-image acl'             "$(q "SELECT proacl::text FROM pg_proc WHERE oid='${sig}'::regprocedure;")" "$PRODUCTION_ACL"
expect_eq 'post-image proconfig'       "$(q "SELECT proconfig::text FROM pg_proc WHERE oid='${sig}'::regprocedure;")" "$PRODUCTION_PROCONFIG"
expect_eq 'post-image volatility'      "$(q "SELECT provolatile::text FROM pg_proc WHERE oid='${sig}'::regprocedure;")" 'v'
expect_eq 'post-image security definer' "$(q "SELECT prosecdef::text FROM pg_proc WHERE oid='${sig}'::regprocedure;")" 'true'

"${psql_cmd[@]}" -c "
CREATE TABLE probe_new AS
SELECT tag,n_levels,idx,chips,variant,ttype,authored,
       public.fn_resolve_tournament_blinds(structure,idx,variant,ttype,chips) AS r
  FROM probe_grid;
CREATE VIEW probe_pair AS
SELECT o.tag,o.n_levels,o.idx,o.chips,o.variant,o.authored,
       o.r AS old_r, n.r AS new_r,
       COALESCE((p.structure::jsonb->(p.n_levels-1)->>'ante')::numeric,0) AS anchor_ante,
       (p.structure::jsonb->(p.n_levels-1)->>'bigBlind')::numeric         AS anchor_bb
  FROM probe_old o
  JOIN probe_new n ON n.tag=o.tag AND n.idx=o.idx AND n.variant=o.variant
                  AND n.ttype=o.ttype AND n.chips IS NOT DISTINCT FROM o.chips
  JOIN probe_structures p ON p.tag=o.tag;" >/dev/null

# ---------------------------------------------------------------------------
# 5. GREEN.
# ---------------------------------------------------------------------------
echo '== green (post-image) =='
new_deep="SELECT r->>'small_blind'||'/'||(r->>'big_blind')||'/'||(r->>'ante')
            FROM probe_new WHERE tag='5558f378' AND idx=162 AND chips=1755000 AND variant='freezeout'"
new_mid="SELECT r->>'small_blind'||'/'||(r->>'big_blind')||'/'||(r->>'ante')
           FROM probe_new WHERE tag='70cd09f8' AND idx=126 AND chips=975000 AND variant='freezeout'"
expect_eq 'live 2c621856 now sane (0.125 x bb)' "$(q "$new_deep")" '43875/87750/10968'
expect_eq 'live 9f30d335 now sane (0.125 x bb)' "$(q "$new_mid")"  '24375/48750/6093'

# (b) THE EXHAUSTIVE UNCHANGED-LEVELS PROOF.
expect_eq 'authored in-structure levels whose jsonb changed' \
  "$(q "SELECT count(*) FROM probe_pair WHERE authored AND old_r IS DISTINCT FROM new_r;")" '0'
expect_eq 'authored in-structure levels compared' \
  "$(q 'SELECT count(*) FROM probe_pair WHERE authored;')" '5180'

# Nothing but the ante may move, anywhere on the grid.
for field in small_blind big_blind level_index source overflow_ratio; do
  expect_eq "field '${field}' changed anywhere" \
    "$(q "SELECT count(*) FROM probe_pair WHERE old_r->>'${field}' IS DISTINCT FROM new_r->>'${field}';")" '0'
done
expect_eq 'spin-path rows changed' \
  "$(q "SELECT count(*) FROM probe_pair WHERE variant='spin' AND old_r IS DISTINCT FROM new_r;")" '0'
expect_eq 'blind_capped flipped true -> false' \
  "$(q "SELECT count(*) FROM probe_pair WHERE old_r->>'blind_capped'='true' AND new_r->>'blind_capped'='false';")" '0'

# The ceiling only ever lowers an ante.
expect_eq 'rows where the ante increased' \
  "$(q "SELECT count(*) FROM probe_pair WHERE (new_r->>'ante')::numeric > (old_r->>'ante')::numeric;")" '0'
expect_eq 'rows where the ante exceeds the big blind' \
  "$(q "SELECT count(*) FROM probe_pair WHERE (new_r->>'ante')::numeric > (new_r->>'big_blind')::numeric;")" '0'

# (d) the 2026-09-09 blind invariant is untouched, and the small blind is
#     still exactly floor(bb/2) everywhere its guard governs. Note that in a
#     narrow band the big blind saturates at 10,000,000 while the small blind
#     has not yet - sb stays below bb, so the guard correctly does not fire and
#     sb keeps its own grown value. That band is PRE-EXISTING: 'small_blind
#     changed anywhere' above proves this repair leaves every one of them
#     byte-identical.
expect_eq 'overflow rows with sb >= bb' \
  "$(q "SELECT count(*) FROM probe_pair WHERE new_r->>'source'='mtt_overflow'
           AND (new_r->>'small_blind')::numeric >= (new_r->>'big_blind')::numeric;")" '0'
expect_eq 'overflow rows with bb below 2' \
  "$(q "SELECT count(*) FROM probe_pair WHERE new_r->>'source'='mtt_overflow'
           AND (new_r->>'big_blind')::numeric < 2;")" '0'
expect_eq 'deep overflow rows where sb <> floor(bb/2)' \
  "$(q "SELECT count(*) FROM probe_pair WHERE new_r->>'source'='mtt_overflow'
           AND chips IN (975000,1755000) AND idx > n_levels + 60
           AND (new_r->>'small_blind')::numeric
               <> floor((new_r->>'big_blind')::numeric/2);")" '0'

# (c) the documented chip headroom is untouched: a clamped big blind is still
#     exactly total_chips/20, so the field always holds at least 20 big blinds.
expect_eq 'clamped overflow rows not on the total_chips/20 ceiling' \
  "$(q "SELECT count(*) FROM probe_pair
         WHERE new_r->>'source'='mtt_overflow' AND chips > 0
           AND (new_r->>'big_blind')::numeric > chips/20;")" '0'
# The clamped big blind sits ON that ceiling, never under it by more than the
# chip clamp's own pre-existing rounding (it scales by a numeric quotient and
# floors, which can land one chip low). 'big_blind changed anywhere' above
# proves this repair moves none of them.
expect_eq 'deep overflow rows more than one chip under total_chips/20' \
  "$(q "SELECT count(*) FROM probe_pair WHERE new_r->>'source'='mtt_overflow'
           AND chips IN (975000,1755000) AND idx > n_levels + 60
           AND (new_r->>'big_blind')::numeric < floor(chips/20) - 1;")" '0'
# 20 big blinds of play for the whole field is the documented intent, and the
# repaired ante must not eat into it: blinds plus a full table of antes still
# cost less than the field holds.
expect_eq 'deep overflow rows where blinds+9 antes reach the whole chip pool' \
  "$(q "SELECT count(*) FROM probe_pair WHERE new_r->>'source'='mtt_overflow'
           AND chips IN (975000,1755000) AND idx > n_levels + 60
           AND (new_r->>'small_blind')::numeric + (new_r->>'big_blind')::numeric
             + 9*(new_r->>'ante')::numeric >= chips;")" '0'

# (e) a structure that authors a big blind ante keeps ante = big blind. Its
#     ante must never be shaved below its big blind: AnteMath.ts reads
#     `ante >= bigBlind` as the structure having authored a TOTAL, and dropping
#     under it would recharge the table ante x seats.
expect_eq 'big-blind-ante rows the repair pushed below their big blind' \
  "$(q "SELECT count(*) FROM probe_pair
         WHERE anchor_bb > 0 AND anchor_ante >= anchor_bb
           AND (old_r->>'ante')::numeric >= (old_r->>'big_blind')::numeric
           AND (new_r->>'ante')::numeric <  (new_r->>'big_blind')::numeric;")" '0'
expect_eq 'big-blind-ante rows changed at all' \
  "$(q "SELECT count(*) FROM probe_pair
         WHERE anchor_bb > 0 AND anchor_ante >= anchor_bb
           AND old_r IS DISTINCT FROM new_r;")" '0'

# A structure with no authored ante never acquires one.
expect_eq 'anteless structures that gained an ante' \
  "$(q "SELECT count(*) FROM probe_pair
         WHERE anchor_ante = 0 AND (new_r->>'ante')::numeric <> 0;")" '0'

# The repaired ante honours the authored proportion wherever the big blind is
# large enough to express it. Below that the function's own pre-existing
# GREATEST(1,...) chip floor governs, as it always has.
expect_eq 'overflow rows above the authored proportion at bb >= 10' \
  "$(q "SELECT count(*) FROM probe_pair
         WHERE NOT authored AND anchor_ante > 0 AND anchor_ante < anchor_bb
           AND (new_r->>'big_blind')::numeric >= 10
           AND (new_r->>'ante')::numeric * anchor_bb
               > (new_r->>'big_blind')::numeric * anchor_ante;")" '0'
expect_eq 'overflow rows still dealing ante = big blind on a per-player ladder' \
  "$(q "SELECT count(*) FROM probe_pair
         WHERE NOT authored AND anchor_ante > 0 AND anchor_ante < anchor_bb
           AND (new_r->>'big_blind')::numeric >= 10
           AND (new_r->>'ante')::numeric = (new_r->>'big_blind')::numeric;")" '0'

echo
echo "  repaired overflow rows: $(q "SELECT count(*) FROM probe_pair WHERE (old_r->>'ante')::numeric <> (new_r->>'ante')::numeric;")"
echo "  of which cut by more than one chip: $(q "SELECT count(*) FROM probe_pair WHERE (old_r->>'ante')::numeric - (new_r->>'ante')::numeric > 1;")"
echo 'BLIND_OVERFLOW_ANTE_PG17_OK'

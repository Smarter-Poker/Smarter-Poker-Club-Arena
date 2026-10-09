#!/usr/bin/env bash
# UNQUALIFIED DRAFT. Requires the committed synthetic concurrency fixture, with
# no payout yet. Owns no setup/DDL. Root destroys the whole owning container.
# Actual COMMIT acknowledgment is quarantined before an independent readback.
set -euo pipefail
[[ $# == 2 ]] || exit 1
readonly container="$1" scratch="$2" bootstrap='leaderboard_qualification_bootstrap'
[[ "$container" =~ ^leaderboard-isolation-[A-Za-z0-9_-]+$ && -d "$scratch" ]] || exit 1
[[ -z "${DATABASE_URL:-}" && -z "${PGDATABASE:-}" && -z "${PGHOST:-}" && -z "${PGUSER:-}" && -z "${PGPASSWORD:-}" ]] || exit 1
[[ "$(docker inspect --format '{{.Config.Image}}' "$container")" == 'supabase/postgres:17.6.1.063' ]] || exit 1
[[ "$(docker network inspect --format '{{.Internal}}' "$container-network")" == true ]] || exit 1
umask 077
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly here
readonly -a socket=(docker exec -i "$container" psql -h /tmp -XAt -U "$bootstrap" -d postgres -v ON_ERROR_STOP=1)
sql() { timeout 65 "${socket[@]}"; }
declare -A starts=()
diagnostic_stage='precondition'
owned_failure=false
node_source_id=''
node_source_attempted=false
# Official Node 22 Bookworm Slim uses glibc, matching the Ubuntu PG image.
# Alpine executables require a musl loader absent from the owning container.
readonly node_image='node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392'
readonly node_source_name="$container-unknownack-node-$BASHPID"
readonly isolated_node="/tmp/leaderboard-unknown-ack-node-$BASHPID"
cleanup_node_source() {
  local actual remaining
  [[ "$node_source_attempted" == true ]] || return 0
  if [[ -z "$node_source_id" ]]; then
    # Recover an unknown create acknowledgment by exact durable name. A failed
    # Docker read is UNKNOWN, never absence or permission to remove a container.
    remaining="$(timeout 10 docker container ls -aq --no-trunc --filter "name=^/$node_source_name$")" || return 1
    [[ -n "$remaining" ]] || return 0
    [[ "$remaining" =~ ^[0-9a-f]{64}$ ]] || return 1
    node_source_id="$remaining"
  fi
  actual="$(timeout 10 docker inspect --format '{{.Id}}|{{.Name}}|{{index .Config.Labels "leaderboard.unknownack.owner"}}|{{.Config.Image}}|{{.State.Running}}|{{.HostConfig.NetworkMode}}' "$node_source_id")" || return 1
  [[ "$actual" == "$node_source_id|/$node_source_name|$node_source_name|$node_image|false|none" ]] || return 1
  timeout 10 docker rm "$node_source_id" >/dev/null || return 1
  remaining="$(timeout 10 docker container ls -aq --no-trunc --filter "id=$node_source_id")" || return 1
  [[ -z "$remaining" ]] || return 1
  node_source_id=''
}
register() { starts["$1"]="$(awk '{sub(/^[^)]*\) /, ""); print $20}' "/proc/$1/stat")"; [[ "${starts[$1]}" =~ ^[0-9]+$ ]]; }
await_owned() {
  local pid="$1" status=0
  wait "$pid" || status=$?
  unset 'starts[$pid]'
  if kill -0 -- "-$pid" 2>/dev/null; then
    echo 'Owned client group remains after leader terminated' >&2
    owned_failure=true
    [[ "$status" != 0 ]] || status=1
  fi
  return "$status"
}
cleanup() {
  local code=$? failed=false pid actual pgid status
  trap - EXIT
  for pid in "${!starts[@]}"; do
    actual="$(awk '{sub(/^[^)]*\) /, ""); print $20}' "/proc/$pid/stat" 2>/dev/null)" || actual=''
    if [[ "$actual" == "${starts[$pid]}" ]]; then
      pgid="$(ps -o pgid= -p "$pid" | tr -d ' ')" || pgid=''
      if [[ "$pgid" == "$pid" ]]; then
        kill -KILL -- "-$pid" 2>/dev/null || failed=true
      else
        kill -KILL "$pid" 2>/dev/null || failed=true
      fi
    elif [[ -n "$actual" ]]; then
      failed=true # Reused identity: never signal it.
    elif kill -0 -- "-$pid" 2>/dev/null; then
      failed=true # Orphan group without original leader cannot be owned safely.
    fi
    status=0
    wait "$pid" 2>/dev/null || status=$?
    [[ "$status" != 127 ]] || failed=true
    unset 'starts[$pid]'
    if kill -0 -- "-$pid" 2>/dev/null; then failed=true; fi
  done
  cleanup_node_source || failed=true
  if [[ "$failed" == true ]]; then
    # Preserve the actual failed stage; cleanup is a separate fixed receipt.
    printf '%s\n' 'UNKNOWN_ACK_OWN_CLEANUP_FAILED'
    [[ "$code" != 0 ]] || diagnostic_stage='own_cleanup'
    echo 'Owned unknown-ack client cleanup failed; whole container cleanup required' >&2
    [[ "$code" != 0 ]] || code=1
  fi
  if [[ "$code" != 0 ]]; then printf 'FINANCIAL_DRIVER|f||%s\n' "$diagnostic_stage"; fi
  exit "$code"
}
trap cleanup EXIT
sql >"$scratch/unknown-ack-precondition.log" 2>&1 <<'SQL'
DO $guard$
BEGIN
  IF session_user<>'leaderboard_qualification_bootstrap' OR current_user<>session_user
     OR current_database()<>'postgres' OR inet_server_addr() IS NOT NULL
     OR (SELECT count(*) FROM auth.users)<>5
     OR EXISTS(SELECT 1 FROM auth.users WHERE id::text NOT LIKE '90000000-0000-4000-8000-%')
     OR (SELECT count(*) FROM public.clubs)<>3
     OR EXISTS(SELECT 1 FROM public.leaderboard_payout_batches)
     OR EXISTS(SELECT 1 FROM public.leaderboard_payouts)
     OR public.fn_player_home_club('90000000-0000-4000-8000-000000000004',NULL) IS DISTINCT FROM '92000000-0000-4000-8000-000000000002'::uuid
     OR EXISTS(SELECT 1 FROM public.club_members WHERE chip_balance IS DISTINCT FROM 0)
     OR (SELECT sum(chip_balance) FROM public.club_members) IS DISTINCT FROM 0
     OR (SELECT chip_balance FROM public.club_members WHERE club_id='92000000-0000-4000-8000-000000000002' AND user_id='90000000-0000-4000-8000-000000000004') IS DISTINCT FROM 0
     OR (SELECT promo_balance FROM public.clubs WHERE id='92000000-0000-4000-8000-000000000002') IS DISTINCT FROM 20 THEN
    RAISE EXCEPTION 'Exact isolated unknown-ack preimage required';
  END IF;
END;
$guard$;
SQL
# Copy only the immutable official image's executable. The stopped source has
diagnostic_stage='node_compatibility'
# no network, ports or volumes. Nothing is installed or run in that source.
# Compatibility is determined by executing the copied binary in the owning PG
# container; missing libraries/version mismatch fail before transport clients.
existing_source="$(timeout 10 docker container ls -aq --filter "name=^/$node_source_name$")" || exit 1
[[ -z "$existing_source" ]] || exit 1
timeout 10 docker exec "$container" test ! -e "$isolated_node"
node_scratch="$(mktemp -d "$scratch/unknown-ack-node.XXXXXX")"
node_source_attempted=true
node_source_id="$(timeout 45 docker create --name "$node_source_name" --network none --label "leaderboard.unknownack.owner=$node_source_name" "$node_image")"
[[ "$node_source_id" =~ ^[0-9a-f]{64}$ ]] || exit 1
[[ "$(timeout 10 docker inspect --format '{{.Config.Image}}' "$node_source_id")" == "$node_image" ]] || exit 1
timeout 15 docker cp "$node_source_id:/usr/local/bin/node" "$node_scratch/node"
[[ -f "$node_scratch/node" && -x "$node_scratch/node" ]] || exit 1
timeout 15 docker cp "$node_scratch/node" "$container:$isolated_node"
version="$(timeout 10 docker exec "$container" "$isolated_node" --version)"
[[ "$version" =~ ^v22\.[0-9]+\.[0-9]+$ ]] || exit 1
printf '%s\n' "$version" >"$scratch/unknown-ack-node.log"
cleanup_node_source
diagnostic_stage='quarantine'
setsid timeout 75 docker exec -i "$container" "$isolated_node" --input-type=module <"$here/leaderboard-unknown-ack-proxy-draft.mjs" >"$scratch/unknown-ack-proxy.log" 2>&1 & proxy=$!
register "$proxy"
ready=false
for _attempt in {1..100}; do
  if docker exec "$container" "$isolated_node" --input-type=module -e 'import http from "node:http";const r=http.get("http://127.0.0.1:15433/health",s=>process.exit(s.statusCode===409?0:1));r.on("error",()=>process.exit(1));' >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.1
done
[[ "$ready" == true ]] || exit 1
# psql simple-query native client, encryption disabled only on isolated loopback.
setsid timeout 65 docker exec -i -e PGSSLMODE=disable -e PGGSSENCMODE=disable "$container" psql -h 127.0.0.1 -p 15432 -XAt -U "$bootstrap" -d postgres -v ON_ERROR_STOP=1 >"$scratch/unknown-ack-client.log" 2>&1 <<'SQL' &
BEGIN;
SET LOCAL application_name='lb-unknown-ack';
DO $ack_payout$
DECLARE response jsonb;
BEGIN
  IF session_user<>'leaderboard_qualification_bootstrap' OR inet_server_addr() IS NOT NULL THEN RAISE EXCEPTION 'Socket bootstrap required'; END IF;
  PERFORM set_config('request.jwt.claims','{"sub":"90000000-0000-4000-8000-000000000001","role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000001',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;
  SELECT public.fn_payout_leaderboard('92000000-0000-4000-8000-000000000002','weekly','profit',start_date::timestamp AT TIME ZONE 'UTC',end_date::timestamp AT TIME ZONE 'UTC') INTO response FROM public.fn_leaderboard_period_window('weekly',-1);
  IF (response->>'success')::boolean IS DISTINCT FROM true OR (response->>'already_settled')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'Initial actual payout refused'; END IF;
  SET CONSTRAINTS ALL IMMEDIATE;
END;
$ack_payout$;
COMMIT;
SQL
client=$!
register "$client"
visible=false
for _attempt in {1..100}; do
  count="$(printf 'SELECT count(*) FROM public.leaderboard_payout_batches;\n' | sql | tail -n 1)"
  if [[ "$count" == 1 ]]; then visible=true; break; fi
  sleep 0.1
done
[[ "$visible" == true ]] || exit 1
grep -qx 'COMMIT_FORWARDED_ACK_QUARANTINED' "$scratch/unknown-ack-proxy.log"
# Financial proof is independently derived before transport is closed.
diagnostic_stage='durable_readback'
sql >"$scratch/unknown-ack-durable.log" 2>&1 <<'SQL'
DO $durable$
DECLARE starts date; ends date; batch uuid; program uuid;
  club constant uuid:='92000000-0000-4000-8000-000000000002';
  winner constant uuid:='90000000-0000-4000-8000-000000000004';
BEGIN
  SELECT start_date,end_date INTO starts,ends FROM public.fn_leaderboard_period_window('weekly',-1);
  SELECT id,program_id INTO STRICT batch,program FROM public.leaderboard_payout_batches;
  IF (SELECT count(*) FROM public.leaderboard_payout_batches)<>1
     OR NOT EXISTS(SELECT 1 FROM public.leaderboard_payout_batches WHERE id=batch
       AND club_id=club AND period='weekly' AND metric='profit' AND period_start=starts AND period_end=ends
       AND funding_owner_type='club' AND funding_union_id IS NULL AND winner_count=1)
     OR (SELECT sum(total_paid) FROM public.leaderboard_payout_batches) IS DISTINCT FROM 10
     OR (SELECT sum(promo_funded) FROM public.leaderboard_payout_batches) IS DISTINCT FROM 10
     OR (SELECT sum(seed_funded+overlay_funded) FROM public.leaderboard_payout_batches) IS DISTINCT FROM 0
     OR (SELECT count(*) FROM public.leaderboard_payouts)<>1
     OR NOT EXISTS(SELECT 1 FROM public.leaderboard_payouts WHERE batch_id=batch
       AND club_id=club AND period='weekly' AND metric='profit'
       AND start_date=starts::timestamp AT TIME ZONE 'UTC'
       AND end_date=ends::timestamp AT TIME ZONE 'UTC'
       AND user_id=winner AND rank=1 AND payout_amount=10 AND payout_currency='chips')
     OR (SELECT sum(payout_amount) FROM public.leaderboard_payouts) IS DISTINCT FROM 10
     OR (SELECT count(*) FROM public.wallet_credit_idempotency WHERE key LIKE 'leaderboard:%')<>1
     OR NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency
       WHERE key=format('leaderboard:%s:weekly:%s:%s',club,starts,winner) AND user_id=winner AND amount=10)
     OR (SELECT promo_balance FROM public.clubs WHERE id=club) IS DISTINCT FROM 10
     OR (SELECT chip_treasury FROM public.clubs WHERE id=club) IS DISTINCT FROM 99980
     OR EXISTS(SELECT 1 FROM public.club_members WHERE NOT(club_id=club AND user_id=winner) AND chip_balance IS DISTINCT FROM 0)
     OR (SELECT sum(chip_balance) FROM public.club_members) IS DISTINCT FROM 10
     OR (SELECT chip_balance FROM public.club_members WHERE club_id=club AND user_id=winner) IS DISTINCT FROM 10
     OR (SELECT count(*) FROM public.wallet_transactions WHERE related_entity_id=program
       AND category='leaderboard_payout' AND user_id=winner AND amount=10 AND type='credit')<>1
     OR (SELECT count(*) FROM public.wallet_transactions WHERE category='leaderboard_payout')<>1
     OR (SELECT count(*) FROM public.chip_ledger WHERE category='leaderboard_payout')<>2
     OR (SELECT count(DISTINCT correlation_id) FROM public.chip_ledger WHERE category='leaderboard_payout')<>1
     OR (SELECT count(*) FROM public.chip_ledger WHERE category='leaderboard_payout'
       AND from_type='promo_wallet' AND from_entity_id=club AND to_type='leaderboard_round' AND to_entity_id=club
       AND club_id=club AND amount=10 AND pre_from_balance=20 AND post_from_balance=10)<>1
     OR (SELECT count(*) FROM public.chip_ledger WHERE category='leaderboard_payout'
       AND from_type='leaderboard_round' AND from_entity_id=club AND to_type='player_wallet' AND to_entity_id=winner
       AND club_id=club AND amount=10)<>1
     OR (SELECT sum(amount) FROM public.chip_ledger WHERE category='leaderboard_payout' AND to_type='leaderboard_round') IS DISTINCT FROM 10
     OR (SELECT sum(amount) FROM public.chip_ledger WHERE category='leaderboard_payout' AND from_type='leaderboard_round') IS DISTINCT FROM 10 THEN RAISE EXCEPTION 'Unknown-ack durable reconciliation failed'; END IF;
END;
$durable$;
SQL
diagnostic_stage='connection_loss'
docker exec "$container" "$isolated_node" --input-type=module -e 'import http from "node:http";const r=http.request("http://127.0.0.1:15433/release",{method:"POST"},s=>process.exit(s.statusCode===204?0:1));r.on("error",()=>process.exit(1));r.end();'
status=0
await_owned "$client" || status=$?
[[ "$owned_failure" == false ]]
[[ "$status" != 0 && "$status" != 124 ]]
if grep -qx COMMIT "$scratch/unknown-ack-client.log"; then exit 1; fi
grep -Eq 'server closed the connection unexpectedly|connection to server was lost' "$scratch/unknown-ack-client.log"
await_owned "$proxy"
[[ "$owned_failure" == false ]]
# Retry the SAME composite identity once, with independent full-state digests.
diagnostic_stage='same_identity_retry'
sql >"$scratch/unknown-ack-retry.log" 2>&1 <<'SQL'
DO $retry$
DECLARE before_digest text; after_digest text; expected uuid; response jsonb;
BEGIN
  SELECT id INTO STRICT expected FROM public.leaderboard_payout_batches;
  SELECT md5(jsonb_build_array(
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.clubs t),
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY club_id,user_id) FROM public.club_members t),
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.leaderboard_payout_batches t),
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.leaderboard_payouts t),
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.chip_ledger t),
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY key) FROM public.wallet_credit_idempotency t),
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.wallet_transactions t))::text) INTO before_digest;
  PERFORM set_config('request.jwt.claims','{"sub":"90000000-0000-4000-8000-000000000001","role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000001',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;
  SELECT public.fn_payout_leaderboard('92000000-0000-4000-8000-000000000002','weekly','profit',start_date::timestamp AT TIME ZONE 'UTC',end_date::timestamp AT TIME ZONE 'UTC') INTO response FROM public.fn_leaderboard_period_window('weekly',-1);
  RESET ROLE;
  SELECT md5(jsonb_build_array(
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.clubs t),
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY club_id,user_id) FROM public.club_members t),
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.leaderboard_payout_batches t),
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.leaderboard_payouts t),
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.chip_ledger t),
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY key) FROM public.wallet_credit_idempotency t),
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.wallet_transactions t))::text) INTO after_digest;
  IF before_digest IS DISTINCT FROM after_digest OR (response->>'success')::boolean IS DISTINCT FROM true OR (response->>'already_settled')::boolean IS DISTINCT FROM true OR response->>'batch_id' IS DISTINCT FROM expected::text THEN RAISE EXCEPTION 'Unknown-ack exact-identity replay changed durable state'; END IF;
END;
$retry$;
SQL
echo 'UNQUALIFIED_DRAFT_EXECUTION_FINISHED: owning container destruction still required'

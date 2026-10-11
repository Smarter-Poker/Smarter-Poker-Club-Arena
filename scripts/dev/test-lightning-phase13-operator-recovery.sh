#!/usr/bin/env bash
# The original 20-section qualification remains intact; then qualify the
# forward-only worker-off guard over that same real-chain database.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
port=${LIGHTNING_P13_PORT:-55564}
log=$(mktemp "${TMPDIR:-/tmp}/lp13-recovery.XXXXXX")
fixture=''
cleanup() {
  if [ -n "$fixture" ]; then
    "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null 2>&1 || true
    rm -rf "$fixture"
  fi
  rm -f "$log"
}
trap cleanup EXIT
LIGHTNING_P13_KEEP=1 bash "$root/scripts/dev/test-lightning-phase13-rollout-drain.sh" | tee "$log"
fixture=$(sed -n 's/^kept //p' "$log")
[ -d "$fixture/data" ] || { echo 'FAIL: missing qualified fixture'; exit 1; }
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -w -o "-k $fixture/socket -p $port -h '' -c wal_level=logical" start >/dev/null
PSQL=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p "$port" -d postgres)
"${PSQL[@]}" <<'SQL'
BEGIN;
DO $$
DECLARE g uuid; players uuid[]; hand uuid; r jsonb;
BEGIN
 g := harness.lc('worker off before');
 players := harness.idle(g,false,4) || harness.idle(g,true,2);
 hand := harness.dealt(g,players);
 PERFORM harness.must(harness.ctl('admin',g,'set_worker_mode','{"mode":"form"}'),'fixture form');
 r := harness.must(harness.ctl('admin',g,'set_worker_mode','{"mode":"off"}'),'before allows unsafe off');
 IF harness.hstate(hand) <> 'dealing' OR public.fn_lightning_config(g)->>'worker_mode' <> 'off' THEN RAISE EXCEPTION 'FAIL preimage witness'; END IF;
 RAISE NOTICE 'REPRODUCED: worker off admitted with a real hand dealing';
END $$;
ROLLBACK;
CREATE PUBLICATION supabase_realtime;
-- Production owns these doors as postgres; local initdb owns as its OS user.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='postgres') THEN CREATE ROLE postgres SUPERUSER; END IF; END $$;
ALTER FUNCTION public.fn_lightning_operator_control(uuid,text,text,jsonb) OWNER TO postgres;
ALTER FUNCTION public.fn_lightning_operator_state(uuid) OWNER TO postgres;
SELECT prosecdef,proconfig,pg_get_userbyid(proowner),proacl::text FROM pg_proc WHERE oid IN ('public.fn_lightning_operator_control(uuid,text,text,jsonb)'::regprocedure,'public.fn_lightning_operator_state(uuid)'::regprocedure);
SQL
# The serving checkpointed thaw's exact preimage, from its immutable migration.
"${PSQL[@]}" <<'SQL'
CREATE TABLE public.engine_maintenance_thaws (freeze_started_at timestamptz PRIMARY KEY, thawed_at timestamptz DEFAULT now(), frozen_seconds numeric NOT NULL, shifted jsonb NOT NULL, thawed_by text);
SQL
python3 - "$root" "$fixture/thaw.sql" <<'PYTHON'
import re,sys
from pathlib import Path
s=(Path(sys.argv[1])/'supabase/migrations/20260908032311_reconnect_allowance_survives_maintenance.sql').read_text()
f=re.search(r'CREATE OR REPLACE FUNCTION public.fn_thaw_platform\(.*?\$function\$\s*;',s,re.S).group().replace('FUNCTION public.fn_thaw_platform(', 'FUNCTION public.fn_thaw_platform_checkpointed(')
Path(sys.argv[2]).write_text(f+'\nALTER FUNCTION public.fn_thaw_platform_checkpointed(timestamptz,numeric,text) OWNER TO postgres;\nREVOKE ALL ON FUNCTION public.fn_thaw_platform_checkpointed(timestamptz,numeric,text) FROM PUBLIC,anon,authenticated,service_role;')
PYTHON
"${PSQL[@]}" -f "$fixture/thaw.sql"
"${PSQL[@]}" <<'SQL'
BEGIN;
DO $$
DECLARE g uuid; f timestamptz := clock_timestamp(); deadline timestamptz; keys jsonb;
BEGIN
 g := harness.lc('drain thaw before'); PERFORM harness.must(harness.ctl('admin',g,'drain'),'before drain');
 SELECT deadline_at INTO deadline FROM public.lightning_cluster_drain WHERE cluster_id=g AND completed_at IS NULL;
 SELECT jsonb_object_agg(k,0) INTO keys FROM unnest(ARRAY['sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until','reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at','cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at','cluster_break_eligible_since','cluster_move_expires_at','reconnect_presence','reconnect_snapshots']) k;
 INSERT INTO public.engine_maintenance_thaws(freeze_started_at,frozen_seconds,shifted) VALUES(f,300,keys);
 PERFORM public.fn_thaw_platform_checkpointed(f,300,'before witness');
 IF (SELECT deadline_at FROM public.lightning_cluster_drain WHERE cluster_id=g AND completed_at IS NULL) IS DISTINCT FROM deadline THEN RAISE EXCEPTION 'FAIL unexpected preimage thaw'; END IF;
 RAISE NOTICE 'REPRODUCED: completed thaw leaves the active drain deadline unshifted';
END $$;
ROLLBACK;
SQL
migration="$root/supabase/migrations/20261011155910_lightning_worker_off_requires_completed_drain.sql"
"${PSQL[@]}" -f "$migration"
"${PSQL[@]}" <<'SQL'
DO $$
DECLARE g uuid; players uuid[]; hand uuid; before jsonb; money text; r jsonb; req uuid := gen_random_uuid();
BEGIN
 g := harness.lc('worker off guarded');
 players := harness.idle(g,false,4) || harness.idle(g,true,2);
 hand := harness.dealt(g,players);
 PERFORM harness.must(harness.ctl('admin',g,'set_worker_mode','{"mode":"form"}'),'fixture form');
 before := harness.stacks(g); money := harness.money(g);
 r := harness.ctl('admin',g,'set_worker_mode','{"mode":"off"}');
 PERFORM harness.refused(r,'CLUSTER_BUSY','worker off while dealt');
 IF r->>'reason' <> 'drain_before_worker_off' OR harness.hstate(hand) <> 'dealing' OR harness.stacks(g) IS DISTINCT FROM before OR harness.money(g) IS DISTINCT FROM money OR public.fn_lightning_config(g)->>'worker_mode' <> 'form' THEN RAISE EXCEPTION 'FAIL guarded transition: %',r; END IF;
 PERFORM harness.must(harness.ctl('admin',g,'drain'),'drain');
 PERFORM harness.refused(harness.ctl('admin',g,'set_worker_mode','{"mode":"off"}'),'CLUSTER_BUSY','off during drain');
 PERFORM harness.finish(g,hand,players[1]);
 PERFORM public.fn_cash_cluster_lightning_drive(g);
 IF harness.mode(g) <> 'must_move' OR harness.open_sessions(g) <> 0 THEN RAISE EXCEPTION 'FAIL incomplete real drain'; END IF;
 before := harness.stacks(g); money := harness.money(g);
 r := harness.must(harness.ctl('admin',g,'set_worker_mode','{"mode":"off"}','drained worker off',req),'off after real drain');
 IF r#>>'{before,worker_mode}' <> 'form' OR r#>>'{after,worker_mode}' <> 'off' OR harness.stacks(g) IS DISTINCT FROM before OR harness.money(g) IS DISTINCT FROM money THEN RAISE EXCEPTION 'FAIL receipts or money: %',r; END IF;
 r := harness.ctl('admin',g,'set_worker_mode','{"mode":"off"}','drained worker off',req);
 IF (r->>'replayed')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL request replay'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='cash_cluster_events') THEN RAISE EXCEPTION 'FAIL event publication'; END IF;
END $$;
SQL
"${PSQL[@]}" <<'SQL'
DO $$
DECLARE g uuid; f timestamptz := clock_timestamp(); deadline timestamptz; r jsonb; keys jsonb;
BEGIN
 g := harness.lc('drain deadline freeze');
 PERFORM harness.must(harness.ctl('admin',g,'drain'),'deadline drain');
 SELECT deadline_at INTO deadline FROM public.lightning_cluster_drain WHERE cluster_id=g AND completed_at IS NULL;
 -- Other thaw steps are outside this narrow fixture and already have their keys.
 SELECT jsonb_object_agg(k,0) INTO keys FROM unnest(ARRAY['sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until','reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at','cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at','cluster_break_eligible_since','cluster_move_expires_at','reconnect_presence','reconnect_snapshots']) k;
 INSERT INTO public.engine_maintenance_thaws(freeze_started_at,frozen_seconds,shifted) VALUES(f,300,keys);
 r := public.fn_thaw_platform_checkpointed(f,300,'isolated lightning deadline');
 IF (r->>'complete')::boolean IS DISTINCT FROM true OR (SELECT deadline_at FROM public.lightning_cluster_drain WHERE cluster_id=g AND completed_at IS NULL) IS DISTINCT FROM deadline+interval '300 seconds' THEN RAISE EXCEPTION 'FAIL thaw did not restore deadline: %',r; END IF;
 r := public.fn_thaw_platform_checkpointed(f,300,'repeat');
 IF r->>'reason' <> 'already_thawed' OR (SELECT deadline_at FROM public.lightning_cluster_drain WHERE cluster_id=g AND completed_at IS NULL) IS DISTINCT FROM deadline+interval '300 seconds' OR harness.evn(g,'lightning_drain_deadline_thawed') <> 1 THEN RAISE EXCEPTION 'FAIL duplicate thaw shifted again or emitted twice'; END IF;
END $$;
SQL
"${PSQL[@]}" -f "$migration"
"${PSQL[@]}" -c "DELETE FROM harness.lp8 WHERE phase='own'" -f "$fixture/own-proofs-eval.sql" -f "$fixture/own-proofs.sql"
echo 'PASS: worker off refuses before completed drain, preserves dealt hands and stacks, admits after real settlement and MUST MOVE, receipts expose mode, request replay, publication, idempotent frozen-deadline restoration, prior proofs and exact reapplication'

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
CREATE TABLE public.engine_maintenance_thaws (freeze_started_at timestamptz PRIMARY KEY, thawed_at timestamptz DEFAULT now(), frozen_seconds numeric NOT NULL, shifted jsonb NOT NULL, thawed_by text, contract_version integer);
SQL
python3 - "$root" "$fixture/thaw.sql" <<'PYTHON'
import re,sys
from pathlib import Path
s=(Path(sys.argv[1])/'supabase/migrations/20260908032311_reconnect_allowance_survives_maintenance.sql').read_text()
reconnect=re.search(r'CREATE OR REPLACE FUNCTION public.fn_thaw_reconnect_states.*?\$\$\s*;',s,re.S).group()
f=re.search(r'CREATE OR REPLACE FUNCTION public.fn_thaw_platform\(.*?\$function\$\s*;',s,re.S).group().replace('FUNCTION public.fn_thaw_platform(', 'FUNCTION public.fn_thaw_platform_checkpointed(')
Path(sys.argv[2]).write_text(reconnect+'\n'+f+'\nALTER FUNCTION public.fn_thaw_platform_checkpointed(timestamptz,numeric,text) OWNER TO postgres;\nREVOKE ALL ON FUNCTION public.fn_thaw_platform_checkpointed(timestamptz,numeric,text) FROM PUBLIC,anon,authenticated,service_role;')
PYTHON
"${PSQL[@]}" -f "$fixture/thaw.sql"
python3 - "$root" "$fixture/thaw-targets.sql" <<'PYTHON'
import re,sys
from pathlib import Path
s=(Path(sys.argv[1])/'scripts/ci/fixtures/phase-three-current-thaw-authority.sql').read_text()
functions=[]
for name in ['fn_snapshot_maintenance_thaw_targets','fn_credit_maintenance_thaw_targets']:
 f=re.search(r'CREATE OR REPLACE FUNCTION public.'+name+r'\(.*?\$function\$\s*;',s,re.S).group()
 functions.append(f+'\nALTER FUNCTION public.'+name+'(timestamptz,numeric) OWNER TO postgres;\nREVOKE ALL ON FUNCTION public.'+name+'(timestamptz,numeric) FROM PUBLIC,anon,authenticated,service_role;')
Path(sys.argv[2]).write_text('CREATE TABLE public.engine_maintenance_thaw_targets(freeze_started_at timestamptz, step text,target_id uuid,credited_seconds numeric DEFAULT 0,PRIMARY KEY(freeze_started_at,step,target_id));\n'+'\n'.join(functions))
PYTHON
"${PSQL[@]}" -f "$fixture/thaw-targets.sql"

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
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS sit_out_at timestamptz;
CREATE TABLE IF NOT EXISTS public.table_waitlist(id uuid PRIMARY KEY,hold_expires_at timestamptz);
CREATE TABLE IF NOT EXISTS public.tournaments(id uuid PRIMARY KEY);
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS addon_period_ends_at timestamptz, ADD COLUMN IF NOT EXISTS level_started_at timestamptz, ADD COLUMN IF NOT EXISTS on_break boolean, ADD COLUMN IF NOT EXISTS status text;
CREATE TABLE IF NOT EXISTS public.chip_transactions(id uuid PRIMARY KEY,reversible_until timestamptz);
CREATE TABLE IF NOT EXISTS public.tournament_bounty_awards(id uuid PRIMARY KEY,reveal_deadline_at timestamptz);
CREATE TABLE IF NOT EXISTS public.tournament_players(id uuid PRIMARY KEY,rebuy_prompt_until timestamptz);
ALTER TABLE public.cash_player_session ADD COLUMN IF NOT EXISTS stay_last_tick_at timestamptz, ADD COLUMN IF NOT EXISTS stay_running boolean;
CREATE TABLE IF NOT EXISTS public.cash_rejoin_constraints(id uuid PRIMARY KEY,expires_at timestamptz);
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS bomb_pot_next_due_at timestamptz, ADD COLUMN IF NOT EXISTS break_eligible_since timestamptz;
ALTER TABLE public.cash_seat_moves ADD COLUMN IF NOT EXISTS expires_at timestamptz;
CREATE TABLE IF NOT EXISTS public.engine_presence_parked(table_id uuid PRIMARY KEY,disconnect_states jsonb,parked_at timestamptz);
CREATE TABLE IF NOT EXISTS public.hand_state_snapshots(id uuid PRIMARY KEY,disconnect_states jsonb,is_complete boolean,updated_at timestamptz);
DO $$
DECLARE g uuid; f timestamptz := clock_timestamp(); deadline timestamptz; r jsonb; keys jsonb;
BEGIN
 g := harness.lc('drain deadline freeze');
 PERFORM harness.must(harness.ctl('admin',g,'drain'),'deadline drain');
 SELECT deadline_at INTO deadline FROM public.lightning_cluster_drain WHERE cluster_id=g AND completed_at IS NULL;
 -- Other thaw steps are outside this narrow fixture and already have their keys.
 SELECT jsonb_object_agg(k,0) INTO keys FROM unnest(ARRAY['sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until','reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at','cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at','cluster_break_eligible_since','cluster_move_expires_at','reconnect_presence','reconnect_snapshots']) k;
 INSERT INTO public.engine_maintenance_thaws(freeze_started_at,frozen_seconds,shifted) VALUES(f,300,keys);
 PERFORM public.fn_snapshot_maintenance_thaw_targets(f,300);
 r := public.fn_thaw_platform_checkpointed(f,300,'isolated lightning deadline');
 IF (r->>'complete')::boolean IS DISTINCT FROM true OR (SELECT deadline_at FROM public.lightning_cluster_drain WHERE cluster_id=g AND completed_at IS NULL) IS DISTINCT FROM deadline+interval '300 seconds' THEN RAISE EXCEPTION 'FAIL thaw did not restore deadline: %',r; END IF;
 r := public.fn_thaw_platform_checkpointed(f,300,'repeat');
 IF r->>'reason' <> 'already_thawed' OR (SELECT deadline_at FROM public.lightning_cluster_drain WHERE cluster_id=g AND completed_at IS NULL) IS DISTINCT FROM deadline+interval '300 seconds' OR harness.evn(g,'lightning_drain_deadline_thawed') <> 1 THEN RAISE EXCEPTION 'FAIL duplicate thaw shifted again or emitted twice'; END IF;
END $$;
SQL
"${PSQL[@]}" <<'SQL'
DO $$
DECLARE t record; r jsonb; deadline timestamptz;
BEGIN
 SELECT freeze_started_at INTO t FROM public.engine_maintenance_thaws WHERE thawed_by IS DISTINCT FROM 'before witness' ORDER BY freeze_started_at DESC LIMIT 1;
 -- Mirror the real v3 wrapper marking the initial step's captured targets.
 UPDATE public.engine_maintenance_thaw_targets SET credited_seconds=300 WHERE freeze_started_at=t.freeze_started_at AND step='lightning_drain_deadline_at';
 UPDATE public.engine_maintenance_thaws SET shifted=shifted||'{"_targets_snapshotted":true}' WHERE freeze_started_at=t.freeze_started_at;
 CREATE TEMP TABLE tail_before AS SELECT id,deadline_at FROM public.lightning_cluster_drain WHERE id IN (SELECT target_id FROM public.engine_maintenance_thaw_targets WHERE freeze_started_at=t.freeze_started_at);
 r:=public.fn_credit_maintenance_thaw_targets(t.freeze_started_at,312);
 IF (r->>'complete')::boolean IS DISTINCT FROM true OR EXISTS(SELECT 1 FROM tail_before b JOIN public.lightning_cluster_drain d USING(id) WHERE d.deadline_at IS DISTINCT FROM b.deadline_at+interval '12 seconds') THEN RAISE EXCEPTION 'FAIL tail credit: %',r; END IF;
 r:=public.fn_credit_maintenance_thaw_targets(t.freeze_started_at,312);
 IF EXISTS(SELECT 1 FROM tail_before b JOIN public.lightning_cluster_drain d USING(id) WHERE d.deadline_at IS DISTINCT FROM b.deadline_at+interval '12 seconds') THEN RAISE EXCEPTION 'FAIL tail credit replay'; END IF;
END $$;
SQL
"${PSQL[@]}" -f "$migration"
python3 - "$migration" "$fixture/forward-proofs.sql" <<'PYTHON'
import sys
from pathlib import Path
proofs=[line.split('-- @live-proof: ',1)[1] for line in Path(sys.argv[1]).read_text().splitlines() if line.startswith('-- @live-proof: ')]
assert len(proofs)==6
Path(sys.argv[2]).write_text('\n'.join("DO $$ BEGIN IF ("+expr+") IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL forward live proof "+str(n)+"'; END IF; END $$;" for n,expr in enumerate(proofs,1)))
PYTHON
"${PSQL[@]}" -f "$fixture/forward-proofs.sql"
"${PSQL[@]}" -c "DELETE FROM harness.lp8 WHERE phase='own'" -f "$fixture/own-proofs-eval.sql" -f "$fixture/own-proofs.sql"
echo 'PASS: worker off refuses before completed drain, preserves dealt hands and stacks, admits after real settlement and MUST MOVE, receipts expose mode, request replay, publication, idempotent frozen-deadline restoration, prior proofs and exact reapplication'

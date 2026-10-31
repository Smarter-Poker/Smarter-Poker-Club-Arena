#!/usr/bin/env python3
"""Current v3 authority, separate committed installments, disposable PostgreSQL.
No production connection or credentials. Existing full freeze/entry functions
are loaded unchanged; only the candidate migration changes the thaw admission.
"""
import importlib.util
import json
import re
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / 'scripts/ci/fixtures/on-time-start'
MIGRATION = ROOT / 'supabase/migrations/20261018172103_prepare_the_certified_thaw_before_the_advertised_hour.sql'
spec = importlib.util.spec_from_file_location('stage_fixture', ROOT / 'scripts/ci/test-multi-day-stage-foundation.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
TOKEN = 'a1000000-0000-4000-8000-000000000001'
NEXT = 'a1000000-0000-4000-8000-000000000002'
SIG = 'public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text)'
EXTRA = r"""
ALTER TABLE public.engine_maintenance_break ADD COLUMN id boolean PRIMARY KEY DEFAULT true;
ALTER TABLE public.engine_maintenance_thaws ADD COLUMN announced_at timestamptz,
 ADD COLUMN ownership_token uuid, ADD COLUMN contract_version integer,
 ADD COLUMN release_target_at timestamptz, ADD COLUMN release_generation integer;
CREATE TABLE public.engine_maintenance_thaw_targets (
 freeze_started_at timestamptz, step text, target_id uuid, credited_seconds numeric DEFAULT 0,
 PRIMARY KEY(freeze_started_at,step,target_id));
ALTER TABLE public.table_waitlist ADD COLUMN id uuid PRIMARY KEY DEFAULT gen_random_uuid();
ALTER TABLE public.chip_transactions ADD COLUMN id uuid PRIMARY KEY DEFAULT gen_random_uuid();
ALTER TABLE public.tournament_bounty_awards ADD COLUMN id uuid PRIMARY KEY DEFAULT gen_random_uuid();
ALTER TABLE public.cash_player_session ADD COLUMN id uuid PRIMARY KEY DEFAULT gen_random_uuid();
ALTER TABLE public.cash_rejoin_constraints ADD COLUMN id uuid PRIMARY KEY DEFAULT gen_random_uuid();
ALTER TABLE public.cash_seat_moves ADD COLUMN id uuid PRIMARY KEY DEFAULT gen_random_uuid();
ALTER TABLE public.engine_presence_parked ADD COLUMN table_id uuid PRIMARY KEY;
ALTER TABLE public.tournament_players ADD COLUMN is_satellite_qualifier boolean DEFAULT false,
 ADD COLUMN source_satellite_id uuid;
CREATE TABLE public.tournament_stage_resume_receipts(tournament_id uuid,completed_at timestamptz,resume_id uuid);
CREATE TABLE public.lightning_cluster_drain(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 cluster_id uuid,request_id uuid,deadline_at timestamptz,completed_at timestamptz);
CREATE TABLE public.cash_cluster_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 game_id uuid,kind text,payload jsonb,request_id uuid);
CREATE TABLE public.test_wallets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),balance numeric);
CREATE TABLE public.test_parameters(freeze_start timestamptz, due_at timestamptz);
GRANT SELECT ON public.test_parameters TO service_role;
GRANT USAGE ON SCHEMA public TO service_role,anon,authenticated;
"""

def require(value, message):
    if not value:
        raise AssertionError(message)
    print('PASS ' + message, flush=True)

def reset(c, elapsed):
    c.psql("TRUNCATE public.engine_maintenance_break, public.engine_maintenance_thaws, public.engine_maintenance_thaw_targets, public.test_parameters;")
    c.psql("INSERT INTO public.test_parameters WITH moment AS MATERIALIZED (SELECT clock_timestamp() t) SELECT t-make_interval(secs=>%s),t+make_interval(secs=>%s) FROM moment;" % (elapsed,300-elapsed))
    c.psql("INSERT INTO public.engine_maintenance_break(id,enforce_freeze,phase,announced_at,break_started_at,break_ends_at,reason,ownership_token) SELECT true,true,'counting_down',freeze_start-interval '2 minutes',freeze_start,due_at,'native qualification','%s' FROM public.test_parameters;" % TOKEN)

def call(c, token=TOKEN):
    return c.rpc("public.fn_thaw_platform((SELECT freeze_start-interval '2 minutes' FROM public.test_parameters),(SELECT freeze_start FROM public.test_parameters),300,'%s','native qualification')" % token)

def fingerprint(c):
    return c.val("SELECT jsonb_build_object('wallets',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM public.test_wallets w),'seats',(SELECT jsonb_agg(to_jsonb(s)-'sit_out_at' ORDER BY id) FROM public.table_seats s),'players',(SELECT jsonb_agg(to_jsonb(p)-'rebuy_prompt_until' ORDER BY id) FROM public.tournament_players p),'tables',(SELECT jsonb_agg(to_jsonb(t)-'bomb_pot_next_due_at'-'break_eligible_since' ORDER BY id) FROM public.tables t))::text;")

def main():
    with tempfile.TemporaryDirectory(prefix='ontime-') as directory:
        c = base.Cluster(directory)
        try:
            c.start()
            c.psql(base.FIXTURE + EXTRA)
            c.psql((FIX/'bypass.sql').read_text()+(FIX/'authority.sql').read_text())
            pins = json.loads((FIX/'authority.json').read_text())
            for pin in pins:
                got = c.val("SELECT md5(prosrc) FROM pg_proc WHERE oid='public.%s'::regprocedure" % pin['signature'])
                require(got == pin['body_md5'], 'exact installed body '+pin['signature'])
            reset(c,285)
            require(call(c)['reason']=='maintenance_break_not_due', 'old authority reproduces delayed on-hour admission')
            c.psql(MIGRATION.read_text(), error='ON_TIME_THAW_REQUIRES_QUIESCENT_CUTOVER')
            c.psql('TRUNCATE public.engine_maintenance_break;')
            c.psql(MIGRATION.read_text())
            post = c.val("SELECT md5(prosrc) FROM pg_proc WHERE oid='%s'::regprocedure" % SIG)
            require(post != 'd352182bd881a074848061a9c5820cc6', 'candidate installed exactly once')
            c.psql(MIGRATION.read_text(),error='ON_TIME_THAW_PREIMAGE_DRIFT')
            require(c.val("SELECT (NOT has_function_privilege('anon','%s','EXECUTE') AND NOT has_function_privilege('authenticated','%s','EXECUTE') AND has_function_privilege('service_role','%s','EXECUTE'))::text" % (SIG,SIG,SIG))=='true', 'service-only execution unchanged')
            reset(c,100)
            require(call(c)['reason']=='maintenance_break_not_due', 'early preparation refused')
            require(c.val('SELECT count(*) FROM public.engine_maintenance_thaws')=='0', 'early refusal creates no checkpoint')
            reset(c,285)
            # Nonempty examples of all fifteen deadline families, 53 ordinary
            # levels force more than one 40-row credit batch. Null first-level
            # and independently paused event clocks must stay null/unshifted.
            c.psql(r"""
INSERT INTO public.tournaments(status,level_started_at,addon_period_ends_at,on_break)
 SELECT 'RUNNING',freeze_start-interval '10 minutes',freeze_start+interval '1 minute',false
 FROM public.test_parameters CROSS JOIN generate_series(1,53);
INSERT INTO public.tournaments(name,status,level_started_at,on_break)
 SELECT 'independent break','RUNNING',freeze_start-interval '10 minutes',true FROM public.test_parameters;
INSERT INTO public.tournaments(name,status) VALUES ('booked first level','RUNNING');
INSERT INTO public.tables(status,bomb_pot_next_due_at,break_eligible_since,cluster_id)
 SELECT 'playing',freeze_start+interval '1 minute',freeze_start-interval '1 minute',gen_random_uuid() FROM public.test_parameters;
INSERT INTO public.table_seats(table_id,seat_number,user_id,stack,sit_out_at)
 SELECT id,1,gen_random_uuid(),12345.67,freeze_start-interval '1 minute' FROM public.tables CROSS JOIN public.test_parameters;
INSERT INTO public.tournament_players(tournament_id,user_id,chips,rebuy_prompt_until)
 SELECT id,gen_random_uuid(),23456,freeze_start+interval '1 minute' FROM public.tournaments CROSS JOIN public.test_parameters LIMIT 1;
INSERT INTO public.test_wallets(balance) VALUES(76543.21);
INSERT INTO public.table_waitlist(hold_expires_at) SELECT freeze_start+interval '1 minute' FROM public.test_parameters;
INSERT INTO public.chip_transactions(reversible_until) SELECT freeze_start+interval '1 minute' FROM public.test_parameters;
INSERT INTO public.tournament_bounty_awards(reveal_deadline_at) SELECT freeze_start+interval '1 minute' FROM public.test_parameters;
INSERT INTO public.cash_player_session(stay_last_tick_at,stay_running) SELECT freeze_start-interval '1 minute',true FROM public.test_parameters;
INSERT INTO public.cash_rejoin_constraints(expires_at) SELECT freeze_start+interval '1 minute' FROM public.test_parameters;
INSERT INTO public.cash_seat_moves(state,expires_at) SELECT 'pending',freeze_start+interval '1 minute' FROM public.test_parameters;
INSERT INTO public.engine_presence_parked(table_id,parked_at,disconnect_states)
 SELECT id,freeze_start,jsonb_build_object('player',jsonb_build_object('state','MISSING','reconnectDeadlineMs',extract(epoch FROM freeze_start+interval '1 minute')*1000)) FROM public.tables CROSS JOIN public.test_parameters;
INSERT INTO public.hand_state_snapshots(table_id,hand_number,disconnect_states)
 SELECT table_id,1,disconnect_states FROM public.engine_presence_parked;
INSERT INTO public.lightning_cluster_drain(cluster_id,request_id,deadline_at)
 SELECT gen_random_uuid(),gen_random_uuid(),freeze_start+interval '1 minute' FROM public.test_parameters;
CREATE TABLE public.test_level_before AS SELECT id,level_started_at FROM public.tournaments;
CREATE TABLE public.test_deadlines_before AS
 SELECT 'sit_out_at' kind,id,sit_out_at at FROM public.table_seats UNION ALL
 SELECT 'hold_expires_at',id,hold_expires_at FROM public.table_waitlist UNION ALL
 SELECT 'addon_period_ends_at',id,addon_period_ends_at FROM public.tournaments WHERE addon_period_ends_at IS NOT NULL UNION ALL
 SELECT 'reversible_until',id,reversible_until FROM public.chip_transactions UNION ALL
 SELECT 'reveal_deadline_at',id,reveal_deadline_at FROM public.tournament_bounty_awards UNION ALL
 SELECT 'rebuy_prompt_until',id,rebuy_prompt_until FROM public.tournament_players UNION ALL
 SELECT 'bomb_pot_next_due_at',id,bomb_pot_next_due_at FROM public.tables UNION ALL
 SELECT 'cash_stay_last_tick_at',id,stay_last_tick_at FROM public.cash_player_session UNION ALL
 SELECT 'cash_rejoin_expires_at',id,expires_at FROM public.cash_rejoin_constraints UNION ALL
 SELECT 'cluster_break_eligible_since',id,break_eligible_since FROM public.tables UNION ALL
 SELECT 'cluster_move_expires_at',id,expires_at FROM public.cash_seat_moves UNION ALL
 SELECT 'lightning_drain_deadline_at',id,deadline_at FROM public.lightning_cluster_drain;
CREATE TRIGGER zz_freeze_entry_guard BEFORE INSERT ON public.tournament_players
 FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_new_entries_while_frozen();
CREATE TRIGGER zz_freeze_entry_guard BEFORE INSERT OR UPDATE OF left_at,user_id ON public.table_seats
 FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_new_entries_while_frozen();
""")
            deadlines = re.search(r"CREATE TABLE public.test_deadlines_before AS\n(.*?);\nCREATE TRIGGER", Path(__file__).read_text(), re.S).group(1)
            c.psql('CREATE VIEW public.test_deadlines_after AS '+deadlines+';')
            before = fingerprint(c)
            require(call(c,NEXT)['reason']=='maintenance_ownership_changed', 'wrong owner refused before effects')
            r=call(c)
            require(not r['complete'], 'first committed installment retains checkpoint')
            c.psql("UPDATE public.engine_maintenance_break SET ownership_token='%s'" % NEXT)
            require(call(c)['reason']=='maintenance_ownership_changed', 'retired owner refused after restart adoption')
            calls=1
            for _ in range(12):
                r=call(c,NEXT); calls+=1
                if r['complete']: break
                require(r.get('retryable') is True, 'partial installment remains recoverable')
            require(r.get('complete') is True, 'separate committed installments complete after adoption')
            require(calls>1, 'qualification crosses actual transaction boundaries')
            require(c.val('SELECT count(DISTINCT step) FROM public.engine_maintenance_thaw_targets')=='15', 'all fifteen deadline families represented')
            require(c.val('SELECT bool_and(credited_seconds=300)::text FROM public.engine_maintenance_thaw_targets')=='true', 'all clock targets receive the full five minutes exactly')
            require(c.val('SELECT (release_target_at=due_at AND frozen_seconds=300)::text FROM public.engine_maintenance_thaws CROSS JOIN public.test_parameters')=='true', 'certificate releases on advertised end, never before')
            require(c.val("SELECT bool_and(t.level_started_at IS NOT DISTINCT FROM (CASE WHEN t.on_break OR b.level_started_at IS NULL THEN b.level_started_at ELSE b.level_started_at+interval '300 seconds' END))::text FROM public.tournaments t JOIN public.test_level_before b USING(id)")=='true', 'all 53 level clocks shift exactly once; paused and unstarted clocks preserved')
            require(c.val("SELECT bool_and(a.at=b.at+interval '300 seconds')::text FROM public.test_deadlines_after a JOIN public.test_deadlines_before b USING(kind,id)")=='true', 'every nonempty deadline column shifts by exactly 300 seconds')
            require(c.val("SELECT bool_and((disconnect_states->'player'->>'reconnectDeadlineMs')::numeric=extract(epoch FROM freeze_start+interval '360 seconds')*1000)::text FROM (SELECT disconnect_states FROM public.engine_presence_parked UNION ALL SELECT disconnect_states FROM public.hand_state_snapshots) r CROSS JOIN public.test_parameters")=='true', 'parked and snapshot reconnect deadlines receive full credit')
            require(fingerprint(c)==before, 'wallets, chip stacks, seats, registrations and table identities unchanged')
            require(c.val('SELECT (public.fn_platform_frozen() AND public.fn_entry_purchases_frozen())::text')=='true', 'both real predicates hold after row clears until future certificate')
            c.psql("INSERT INTO public.tournament_players(tournament_id,user_id) SELECT id,gen_random_uuid() FROM public.tournaments LIMIT 1",error='PLATFORM_FROZEN')
            c.psql("INSERT INTO public.table_seats(table_id,seat_number,user_id,stack) SELECT id,2,gen_random_uuid(),10 FROM public.tables LIMIT 1",error='PLATFORM_FROZEN')
            clocks_before_replay = c.val('SELECT jsonb_agg(to_jsonb(d) ORDER BY kind,id)::text FROM public.test_deadlines_after d')
            require(call(c,NEXT)['reason']=='release_receipt_recovered', 'lost completion response recovers exact durable receipt')
            require(fingerprint(c)==before, 'receipt replay cannot change money or roster')
            require(c.val('SELECT jsonb_agg(to_jsonb(d) ORDER BY kind,id)::text FROM public.test_deadlines_after d')==clocks_before_replay, 'receipt replay cannot credit a clock twice')
            seconds=float(c.val('SELECT greatest(0,extract(epoch FROM due_at-clock_timestamp())) FROM public.test_parameters'))
            time.sleep(seconds+0.05)
            require(c.val('SELECT (NOT public.fn_platform_frozen() AND NOT public.fn_entry_purchases_frozen())::text')=='true', 'entry and platform release only at scheduled endpoint')
            reset(c,301)
            for _ in range(12):
                r=call(c)
                if r['complete']: break
            require(r.get('complete') is True and float(r['effective_frozen_seconds'])>301, 'late preparation retains fail-closed extended credit')
            require(c.val('SELECT public.fn_platform_frozen()::text')=='true', 'late fallback remains frozen until its actual credited endpoint')
            print(json.dumps({'passed':True,'post_body_md5':post,'committed_calls':calls,'clock_families':15,'production_writes':False}))
        finally:
            c.stop()

if __name__=='__main__':
    main()
    # The heavy-hour release (20261020011548) is qualified on this same
    # authority and runner, so it runs wherever this qualification runs.
    import subprocess, sys
    subprocess.run([sys.executable, '-B', str(ROOT / 'scripts/ci/test-heavy-thaw-releases-on-the-hour.py')], check=True)

    # Daily maintenance observation shares this required maintenance-native lane.
    subprocess.run([sys.executable, '-B', str(ROOT / 'scripts/ci/test-daily-maintenance-observation.py')], check=True)

    # Retired history cannot block active/system maintenance clock credit.
    subprocess.run([sys.executable, '-B', str(ROOT / 'scripts/ci/test-thaw-preserves-retired-clubs.py')], check=True)

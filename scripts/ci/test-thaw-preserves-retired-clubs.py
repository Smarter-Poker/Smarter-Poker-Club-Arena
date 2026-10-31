#!/usr/bin/env python3
"""Real PG17 retired-club thaw regression; disposable local cluster only."""
import importlib.util
import re
import tempfile
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('ot', ROOT/'scripts/ci/test-on-time-maintenance-thaw.py')
ot = importlib.util.module_from_spec(spec); spec.loader.exec_module(ot)
require = ot.require
MIG = ROOT/'supabase/migrations/20261031201656_maintenance_thaw_preserves_retired_club_records.sql'
EXTRA = r"""
CREATE TABLE public.clubs(id uuid PRIMARY KEY,lifecycle_status text);
CREATE TABLE public.cash_games(id uuid PRIMARY KEY,club_id uuid);
ALTER TABLE public.table_waitlist ADD COLUMN table_id uuid;
ALTER TABLE public.chip_transactions ADD COLUMN club_id uuid;
ALTER TABLE public.tournament_bounty_awards ADD COLUMN tournament_id uuid;
ALTER TABLE public.cash_player_session ADD COLUMN club_id uuid;
ALTER TABLE public.cash_rejoin_constraints ADD COLUMN club_id uuid;
ALTER TABLE public.cash_seat_moves ADD COLUMN game_id uuid, ADD COLUMN from_table_id uuid, ADD COLUMN to_table_id uuid;
INSERT INTO public.clubs VALUES('c1000000-0000-4000-8000-000000000001','active'),('c1000000-0000-4000-8000-000000000002','retired');
INSERT INTO public.cash_games SELECT id,id FROM public.clubs;
"""
SEED = r"""
INSERT INTO public.tournaments(id,club_id,status,level_started_at,addon_period_ends_at,on_break)
 SELECT c.id,c.id,'RUNNING',p.freeze_start-interval '10 minutes',p.freeze_start+interval '1 minute',false FROM public.clubs c CROSS JOIN public.test_parameters p;
INSERT INTO public.tournaments(club_id,status,level_started_at,on_break)
 SELECT c.id,'RUNNING',p.freeze_start-interval '10 minutes',false FROM public.clubs c CROSS JOIN public.test_parameters p CROSS JOIN generate_series(1,53) WHERE c.lifecycle_status='active';
INSERT INTO public.tables(id,club_id,status,bomb_pot_next_due_at,break_eligible_since,cluster_id)
 SELECT c.id,c.id,'playing',p.freeze_start+interval '1 minute',p.freeze_start-interval '1 minute',c.id FROM public.clubs c CROSS JOIN public.test_parameters p;
INSERT INTO public.tables(status,bomb_pot_next_due_at) SELECT 'playing',freeze_start+interval '1 minute' FROM public.test_parameters;
INSERT INTO public.table_seats(table_id,seat_number,user_id,stack,sit_out_at)
 SELECT t.id,1,gen_random_uuid(),12345.67,p.freeze_start-interval '1 minute' FROM public.tables t CROSS JOIN public.test_parameters p;
INSERT INTO public.tournament_players(tournament_id,user_id,chips,rebuy_prompt_until)
 SELECT c.id,gen_random_uuid(),23456,p.freeze_start+interval '1 minute' FROM public.clubs c CROSS JOIN public.test_parameters p;
INSERT INTO public.table_waitlist(table_id,hold_expires_at) SELECT c.id,p.freeze_start+interval '1 minute' FROM public.clubs c CROSS JOIN public.test_parameters p;
INSERT INTO public.chip_transactions(club_id,reversible_until) SELECT c.id,p.freeze_start+interval '1 minute' FROM public.clubs c CROSS JOIN public.test_parameters p;
INSERT INTO public.tournament_bounty_awards(tournament_id,reveal_deadline_at) SELECT c.id,p.freeze_start+interval '1 minute' FROM public.clubs c CROSS JOIN public.test_parameters p;
INSERT INTO public.cash_player_session(club_id,stay_last_tick_at,stay_running) SELECT c.id,p.freeze_start-interval '1 minute',true FROM public.clubs c CROSS JOIN public.test_parameters p;
INSERT INTO public.cash_rejoin_constraints(club_id,expires_at) SELECT c.id,p.freeze_start+interval '1 minute' FROM public.clubs c CROSS JOIN public.test_parameters p;
INSERT INTO public.cash_seat_moves(game_id,from_table_id,to_table_id,state,expires_at) SELECT c.id,c.id,c.id,'pending',p.freeze_start+interval '1 minute' FROM public.clubs c CROSS JOIN public.test_parameters p;
INSERT INTO public.engine_presence_parked(table_id,parked_at,disconnect_states) SELECT c.id,p.freeze_start,jsonb_build_object('player',jsonb_build_object('state','MISSING','reconnectDeadlineMs',extract(epoch FROM p.freeze_start+interval '1 minute')*1000)) FROM public.clubs c CROSS JOIN public.test_parameters p;
INSERT INTO public.hand_state_snapshots(table_id,hand_number,disconnect_states) SELECT table_id,1,disconnect_states FROM public.engine_presence_parked;
INSERT INTO public.lightning_cluster_drain(cluster_id,request_id,deadline_at) SELECT c.id,gen_random_uuid(),p.freeze_start+interval '1 minute' FROM public.clubs c CROSS JOIN public.test_parameters p;
CREATE VIEW public.test_clocks AS
 SELECT 'sit_out_at' kind,s.id,t.club_id,s.sit_out_at at FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id UNION ALL
 SELECT 'hold_expires_at',w.id,t.club_id,w.hold_expires_at FROM public.table_waitlist w JOIN public.tables t ON t.id=w.table_id UNION ALL
 SELECT 'addon_period_ends_at',id,club_id,addon_period_ends_at FROM public.tournaments WHERE addon_period_ends_at IS NOT NULL UNION ALL
 SELECT 'reversible_until',id,club_id,reversible_until FROM public.chip_transactions UNION ALL
 SELECT 'reveal_deadline_at',a.id,t.club_id,a.reveal_deadline_at FROM public.tournament_bounty_awards a JOIN public.tournaments t ON t.id=a.tournament_id UNION ALL
 SELECT 'rebuy_prompt_until',p.id,t.club_id,p.rebuy_prompt_until FROM public.tournament_players p JOIN public.tournaments t ON t.id=p.tournament_id UNION ALL
 SELECT 'bomb_pot_next_due_at',id,club_id,bomb_pot_next_due_at FROM public.tables UNION ALL
 SELECT 'cash_stay_last_tick_at',id,club_id,stay_last_tick_at FROM public.cash_player_session UNION ALL
 SELECT 'cash_rejoin_expires_at',id,club_id,expires_at FROM public.cash_rejoin_constraints UNION ALL
 SELECT 'cluster_break_eligible_since',id,club_id,break_eligible_since FROM public.tables UNION ALL
 SELECT 'cluster_move_expires_at',m.id,g.club_id,m.expires_at FROM public.cash_seat_moves m JOIN public.cash_games g ON g.id=m.game_id UNION ALL
 SELECT 'level_started_at',id,club_id,level_started_at FROM public.tournaments UNION ALL
 SELECT 'reconnect_presence',p.table_id,t.club_id,to_timestamp((p.disconnect_states->'player'->>'reconnectDeadlineMs')::double precision/1000) FROM public.engine_presence_parked p JOIN public.tables t ON t.id=p.table_id UNION ALL
 SELECT 'reconnect_snapshots',s.id,t.club_id,to_timestamp((s.disconnect_states->'player'->>'reconnectDeadlineMs')::double precision/1000) FROM public.hand_state_snapshots s JOIN public.tables t ON t.id=s.table_id UNION ALL
 SELECT 'lightning_drain_deadline_at',d.id,g.club_id,d.deadline_at FROM public.lightning_cluster_drain d JOIN public.cash_games g ON g.id=d.cluster_id;
CREATE TABLE public.test_before AS SELECT * FROM public.test_clocks;
"""
def main():
 with tempfile.TemporaryDirectory(prefix='retired-thaw-') as directory:
  c=ot.base.Cluster(directory)
  try:
   c.start(); c.psql(ot.base.FIXTURE+ot.EXTRA+EXTRA)
   c.psql((ot.FIX/'bypass.sql').read_text()+(ot.FIX/'authority.sql').read_text())
   c.psql(ot.MIGRATION.read_text()); c.psql((ROOT/'supabase/migrations/20261020011548_a_heavy_thaw_releases_on_the_hour_when_nothing_is_left_to_cr.sql').read_text())
   ot.reset(c,270); c.psql(SEED)
   guard=ot.base.function_source('20261002152925_club_retirement_safe_unwind.sql','fn_guard_retired_club_mutation')
   parent=(ROOT/'supabase/migrations/20261029193107_certification_cleanup_locks_only_its_own_club_graph.sql').read_text()
   addition=re.search(r'addition text := \$missing\$(.*?)\$missing\$;',parent,re.S).group(1)
   guard=guard.replace('  IF (v_club_id IS NOT NULL OR v_old_club_id IS NOT NULL) AND EXISTS (',addition+'  IF (v_club_id IS NOT NULL OR v_old_club_id IS NOT NULL) AND EXISTS (')
   c.psql(guard)
   require(c.val("SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_guard_retired_club_mutation()'::regprocedure")=='19b9ffb6dc97e019ac47cb73c70fe93d','actual installed retirement guard exact')
   for table in ['tables','tournaments','table_seats','tournament_players']:
    c.psql('CREATE TRIGGER aa_retired BEFORE INSERT OR UPDATE OR DELETE ON public.%s FOR EACH ROW EXECUTE FUNCTION public.fn_guard_retired_club_mutation();'%table)
   before=ot.fingerprint(c)
   error=c.psql("\\set VERBOSITY verbose\nSELECT public.fn_thaw_platform((SELECT freeze_start-interval '2 minutes' FROM public.test_parameters),(SELECT freeze_start FROM public.test_parameters),300,'%s','retired qualification');"%ot.TOKEN,error='CLUB_RETIRED')
   require('fn_thaw_platform_checkpointed' in error and '55000' in error,'RED installed thaw reaches actual retired mutation guard')
   require(c.val('SELECT count(*) FROM public.engine_maintenance_thaws')=='0','failed old thaw rolls back clocks and checkpoint')
   c.psql(MIG.read_text())
   c.psql(MIG.read_text(),error='RETIRED_CLUB_THAW_PREIMAGE_DRIFT')
   require(ot.call(c,ot.NEXT)['reason']=='maintenance_ownership_changed','wrong owner refused before credit')
   r=ot.call(c); require(not r['complete'],'first committed installment remains recoverable')
   c.psql("UPDATE public.engine_maintenance_break SET ownership_token='%s'"%ot.NEXT)
   require(ot.call(c)['reason']=='maintenance_ownership_changed','old owner refused after adoption')
   for _ in range(20):
    r=ot.call(c,ot.NEXT)
    if r.get('complete'):break
   require(r.get('complete') is True,'GREEN same-owner/adopted v3 thaw completes')
   require(c.val('SELECT count(DISTINCT step) FROM public.engine_maintenance_thaw_targets')=='15','all14 clock families plus Lightning retained')
   require(c.val('SELECT bool_and(credited_seconds=300)::text FROM public.engine_maintenance_thaw_targets')=='true','all active targets credited full five minutes')
   require(c.val("SELECT bool_and(a.at=b.at+CASE WHEN b.club_id='c1000000-0000-4000-8000-000000000002' THEN interval '0' ELSE interval '300 seconds' END)::text FROM public.test_clocks a JOIN public.test_before b USING(kind,id)")=='true','all active clocks shift once and every retired clock unchanged')
   require(c.val("SELECT count(*) FROM public.engine_maintenance_thaw_targets x JOIN public.test_before b ON b.id=x.target_id AND b.kind=x.step WHERE b.club_id='c1000000-0000-4000-8000-000000000002'")=='0','retired records absent from authoritative targets')
   require(c.val("SELECT bool_and(a.at=b.at+interval '300 seconds')::text FROM public.test_clocks a JOIN public.test_before b USING(kind,id) WHERE b.club_id IS NULL AND b.at IS NOT NULL")=='true','null/system-club clocks remain eligible')
   require(before==ot.fingerprint(c),'money rosters and identities unchanged')
   clocks=c.val('SELECT jsonb_agg(to_jsonb(t) ORDER BY kind,id)::text FROM public.test_clocks t')
   require(ot.call(c,ot.NEXT)['reason']=='release_receipt_recovered','repeat recovers same receipt')
   require(clocks==c.val('SELECT jsonb_agg(to_jsonb(t) ORDER BY kind,id)::text FROM public.test_clocks t'),'repeat credits no clock twice')
   c.psql("UPDATE public.tables SET bomb_pot_next_due_at=bomb_pot_next_due_at+interval '1 second' WHERE club_id='c1000000-0000-4000-8000-000000000002'",error='CLUB_RETIRED')
   # A stale authoritative target must fail closed, never be marked paid/credited.
   c.psql("UPDATE public.engine_maintenance_thaws SET shifted=shifted-'complete'; UPDATE public.engine_maintenance_thaw_targets SET credited_seconds=0 WHERE step='bomb_pot_next_due_at'; UPDATE public.clubs SET lifecycle_status='retired' WHERE lifecycle_status='active';")
   c.psql("SELECT public.fn_credit_maintenance_thaw_targets((SELECT freeze_start FROM public.test_parameters),300);",error='MAINTENANCE_THAW_TARGET_CHANGED')
   require(c.val("SELECT bool_and(credited_seconds=0)::text FROM public.engine_maintenance_thaw_targets WHERE step='bomb_pot_next_due_at'")=='true','retired-after-snapshot mismatch rolls back partial credit atomically')
   print('PASS retired-club thaw PG17 qualification; production_writes=False')
  finally:c.stop()
if __name__=='__main__':main()

"""Narrow forward repair on the retained native owner-basis estate."""
import hashlib,json,re,subprocess,runpy

def qualify(root,fix,out,cmd,run,schema):
 forward=json.loads((fix/'source-binding.json').read_text())['member_lane_migration']
 candidate=(root/forward).read_text()
 captured=json.loads((fix/'member-lane-production.json').read_text())
 for row in captured:
  if hashlib.md5(row['definition'].encode()).hexdigest()!=row['md5']:raise AssertionError('Member lane captured definition drift')
 run('BEGIN;\n'+';\n'.join(r['definition'] for r in captured)+';\nCOMMIT;','lane-production-context')
 # Retain the existing original Spin scene and accepted standings. Close only
 # the standalone0.24 event; do not repeat its unrelated behavior suite.
 spin=root/'tests/fixtures/sep8-spin-custody'
 raw=(spin/'originals.json').read_text().strip()
 scene='SELECT $original$'+raw+'$original$ AS sep8_originals \\gset\n'+(spin/'setup.sql').read_text()
 scene+='\n'+(spin/'original-physical-support.sql').read_text()
 scene+='\n'+(spin/'g8-original-standings-seed.sql').read_text()
 scene+="""
CREATE TABLE IF NOT EXISTS public.hand_history_retention_policy(id boolean PRIMARY KEY DEFAULT true CHECK(id),
 horse_retention_days integer NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),note text);
INSERT INTO public.hand_history_retention_policy(id,horse_retention_days,note)
 VALUES(true,8,'Owner horse retention, maintained native fixture only') ON CONFLICT(id) DO NOTHING;
SET request.jwt.claims='{"role":"service_role"}';
SELECT public.fn_complete_sep8_spin_original_standings(operation_id,expected)
 FROM sep8_spin_fixture.standings_cases WHERE tournament_id='b60c7add-6b38-4549-b091-601f64d118a0';
BEGIN;
SET LOCAL session_replication_role=replica;
INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms)
 SELECT 'club_members',m.club_id::text||':'||m.user_id,m.club_id,m.user_id,'baseline',h.completed_at-interval '1 second',to_jsonb(m)
 FROM public.club_members m,public.tournament_terminal_settlements h WHERE h.tournament_id='b60c7add-6b38-4549-b091-601f64d118a0'
 AND EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=h.tournament_id AND p.club_id=m.club_id AND p.user_id=m.user_id);
SET LOCAL session_replication_role=origin;
COMMIT;
CREATE FUNCTION held_fee_fixture.lane_events() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_array(jsonb_build_object('tournament_id','b60c7add-6b38-4549-b091-601f64d118a0','amount',0.24),
 jsonb_build_object('tournament_id',held_fee_fixture.event(),'amount',2.70)) $$;
"""
 # A real independent backend keeps the same shared G lock cash holds. The
 # installed global request must refuse before any money; the replacement must
 # settle both different T members without waiting for cash to finish.
 interactive=cmd[:cmd.index('-c')]
 locker=subprocess.Popen(interactive+['-At'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  locker.stdin.write("BEGIN;SELECT pg_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0));SELECT 'LOCK_READY';\n");locker.stdin.flush()
  while True:
   line=locker.stdout.readline()
   if not line:raise AssertionError('Cash shared-G backend did not acquire lock')
   if line.strip()=='LOCK_READY':break
  run("""BEGIN;SET LOCAL request.jwt.claims='{"role":"service_role"}';
DO $$ DECLARE before_state jsonb;code text;BEGIN
 before_state:=held_fee_fixture.snapshot();
 BEGIN PERFORM public.fn_ca_recognize_held_tournament_fees_by_owner_basis(held_fee_fixture.operation(),jsonb_build_array(jsonb_build_object('tournament_id',held_fee_fixture.event(),'amount',2.70)));
 EXCEPTION WHEN OTHERS THEN code:=SQLSTATE; END;
 PERFORM held_fee_fixture.assert(code='55P03' AND before_state=held_fee_fixture.snapshot(),
 'Installed global owner operation refuses under cash shared-G with no financial writes');
END $$;ROLLBACK;
""",'lane-original-shared-g-refusal')
  run("ALTER FUNCTION public.fn_ca_recognize_held_tournament_fees_by_owner_basis(uuid,jsonb) SET lock_timeout='4s';",'lane-predecessor-drift')
  before=schema();p=out/'lane-install-refused.sql';p.write_text(candidate)
  r=subprocess.run(cmd+['-f',str(p)],capture_output=True,text=True);(out/'lane-install-refused.log').write_text(r.stdout+r.stderr)
  if r.returncode==0 or 'held fee member lane predecessor changed' not in r.stderr or schema()!=before:raise AssertionError('Member lane full-definition guard must refuse atomically')
  run("ALTER FUNCTION public.fn_ca_recognize_held_tournament_fees_by_owner_basis(uuid,jsonb) SET lock_timeout='5s';",'lane-predecessor-restored')
  run(candidate,'lane-install')
  admission=runpy.run_path(str(fix/'qualify-projection-admission.py'))['qualify'](root,fix,out,cmd,run,schema)
  cmd[cmd.index('-c')+1]=cmd[cmd.index('-c')+1].replace("statement_timeout='60s'","statement_timeout='5s'")
  # Keep the reused source scene in this single rolled-back connection so
  # its extra unresolved events cannot affect the original weekly assertions.
  scene=re.sub(r'^(?:BEGIN|COMMIT);\s*$', '',scene,flags=re.M)
  faults=(fix/'member-lane-refusals.sql').read_text().replace('BEGIN;\n','SAVEPOINT lane_fault;\n').replace('ROLLBACK;','ROLLBACK TO SAVEPOINT lane_fault;')
  success=(fix/'member-lane-after.sql').read_text().replace('BEGIN;\n','SAVEPOINT lane_success;\n').replace('ROLLBACK;','ROLLBACK TO SAVEPOINT lane_success;')
  run('BEGIN;\n'+scene+'\n'+faults+'\n'+success+'\nROLLBACK;\n','lane-two-event-operation')
  if locker.poll() is not None:raise AssertionError('Cash lock must remain held through the patched operation')
 finally:
  if locker.poll() is None:locker.communicate('ROLLBACK;\n',timeout=10)
 # The rollback above preserves the original scene for every maintained owner
 # refusal/replay/weekly-reader assertion that follows.
 return {'events':2,'amount':'2.94','original_shared_g_refusal':True,'patched_shared_g_concurrency':True,'full_definition_drift_refusal':True,'projection_admission':admission}

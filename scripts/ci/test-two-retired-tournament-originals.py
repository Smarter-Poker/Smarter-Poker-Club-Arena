#!/usr/bin/env python3
"""Real PG17 two omitted-original admission/helper regression. No financial owner is called.
Uses maintained financial catalog closure; never replaces a financial owner with a mock.
This deliberately calls only the actual helper, not an obsolete captured financial core.
"""
import argparse, ast, hashlib, json, re, subprocess, signal, sys
from pathlib import Path
sys.dont_write_bytecode=True
from satellite_qualifier_fixture import module,table_sql
MIGRATION=Path("supabase/migrations/20261006182937_a_retirement_cannot_erase_the_original_tournament_hand.sql")
SEAT_CONTINUATION=Path('supabase/migrations/20261007000711_a_retained_tournament_seat_keeps_its_original_paid_stack.sql')
SEAT_READ_DEPS=Path('scripts/ci/fixtures/retirement-original/recorded-seat-first-read-dependencies.sql')
SEAT_GUARD_PROOF=Path('scripts/ci/fixtures/retirement-original/aged-seat-guard-proof.sql')
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--evidence',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--socket-root',type=Path,required=True);a=p.parse_args()
 root=Path(__file__).resolve().parents[2];out=a.evidence.resolve();out.mkdir(parents=True,exist_ok=False)
 hand=module(root/'scripts/ci/test-hand-submission.py','retirement_hand_fixture');hand.prepare(root,out)
 native=module(root/'scripts/ci/test-mtt-unlimited.py','retirement_pg_owner');a.socket_root.mkdir(parents=True,exist_ok=True);e=native.Execution(root,out,a.pg_bin.resolve(),out,300,socket_parent=a.socket_root)
 e.report['scope']='native original custody helper; not current financial owner certification'
 inputs=[Path('supabase/migrations/20261007021522_two_additional_retained_tournament_originals_keep_their_paid.sql'),Path('scripts/ci/fixtures/retirement-original/current-resume-preimage.sql'),MIGRATION,SEAT_CONTINUATION,SEAT_READ_DEPS,SEAT_GUARD_PROOF,Path('scripts/admin/retire-patterned-identities.sql'),Path('scripts/qualification/build-retirement-native-fixture.py'),Path('scripts/qualification/retirement-native-proof.sql'),Path('scripts/qualification/retirement-original-57-manifest.json'),Path('scripts/ci/fixtures/retirement-original/readonly-provenance-shapes.json'),Path('scripts/ci/fixtures/retirement-original/retirement-catalog.sql'),Path(__file__).relative_to(root)]
 e.report['source_sha256']={str(f):hashlib.sha256((root/f).read_bytes()).hexdigest() for f in inputs}
 for sig in native.CANCELLATION_SIGNALS:signal.signal(sig,native.interrupted)
 try:
  e.start();db=e.database();e.sql(db,file=out/'foundation.sql',label='actual-maintained-catalog',seconds=180)
  e.sql(db,file=out/'current-authorities.sql',label='actual-retention-dependencies')
  e.sql(db,file=root/'scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql',label='existing-structural-template')
  e.sql(db,file=root/hand.MIGRATION,label='existing-native-retention-owner')
  shapes=json.loads((root/'scripts/ci/fixtures/retirement-original/readonly-provenance-shapes.json').read_text())['tables']
  for shape in shapes:
   row=dict(shape);row['constraints']=[c for c in row['constraints'] if c['type']!='f']
   e.sql(db,table_sql(row),label='actual-readonly-provenance-shape-'+row['name'])
  mark=(root/'supabase/migrations/20261002083400_a_table_start_reads_only_the_hands_after_its_settled_mark_an.sql').read_text()
  mark=mark[mark.index('CREATE TABLE smarter_private.hand_submission_resume_marks'):mark.index('CREATE OR REPLACE FUNCTION public.fn_ca_resume_hand_submission')]
  e.sql(db,mark,label='actual-empty-native-resume-mark')
  disposal=(root/'supabase/migrations/20260928001934_a_hand_the_table_has_already_dealt_past_is_disposed.sql').read_text()
  disposal=disposal[disposal.index('CREATE TABLE IF NOT EXISTS smarter_private.hand_submission_disposals'):disposal.index('DROP TRIGGER IF EXISTS hand_submission_disposal_immutable')]
  e.sql(db,disposal,label='actual-empty-native-disposal-receipts')
  e.sql(db,file=root/'scripts/ci/fixtures/retirement-original/retirement-catalog.sql',label='empty-retirement-catalog')
  e.sql(db,"CREATE SCHEMA retirement_native; CREATE FUNCTION retirement_native.submission_fault() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'isolated accepted-hand storage interruption' USING ERRCODE='XX000'; END$$;",label='fixture-namespace')
  opening=(out/'opening.sql').read_text();opening=opening.replace('SET LOCAL session_replication_role=replica;','').replace('SET LOCAL session_replication_role = replica;','')
  e.sql(db,'BEGIN; SET LOCAL session_replication_role=replica;'+opening+'SET LOCAL session_replication_role=origin; COMMIT;',label='actual-original-template')
  s=(root/MIGRATION).read_text()
  helper=s[s.index('AS $body$')+len('AS $body$'):s.index('$body$;',s.index('AS $body$'))]
  if hashlib.md5(helper.encode()).hexdigest()!='2663bfd55e57f5b2499cc7da43def579':raise ValueError('qualified native helper body changed')
  required=["retirement_restored:=smarter_private.restore_retired_original_tournament_hand(s.submission_id,p_instance_id,p_lease_generation);","IF retirement_restored AND (r->>'success' IS DISTINCT FROM 'true' OR r->>'atomic_hand_commit' IS DISTINCT FROM 'true') THEN","USING ERRCODE='P0404'"]
  if any(x not in s for x in required):raise ValueError('native financial claim/rollback wiring changed')
  start=s.index('CREATE TABLE smarter_private.retirement_original_hand_qualification');end=s.index('DO $native_patch$')
  e.sql(db,'BEGIN;'+s[start:end]+'COMMIT;',label='exact-private-custody-helper')
  e.sql(db,'ALTER TABLE public.tournaments ADD COLUMN format_contract text;',label='captured-current-format-discriminator-column')
  e.sql(db,file=root/SEAT_READ_DEPS,label='exact-recorded-seat-first-read-guards')
  e.sql(db,file=root/SEAT_CONTINUATION,label='exact-retained-seat-continuation-helper-and-guard')
  e.sql(db,file=root/'scripts/ci/fixtures/retirement-original/current-resume-preimage.sql',label='exact-current-public-resume-preimage-not-called')
  e.sql(db,"CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(version text PRIMARY KEY); INSERT INTO supabase_migrations.schema_migrations(version) VALUES('20261007000711') ON CONFLICT DO NOTHING;",label='isolated-installed-predecessor-shape')
  # Read the existing fixture's literal, without executing its argument parser.
  tree=ast.parse((root/'scripts/qualification/build-retirement-native-fixture.py').read_text())
  body=next(ast.literal_eval(x.value.func.value) for x in tree.body if isinstance(x,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='body' for t in x.targets))
  body=body.replace('COUNTS','1,1').replace('FOR i IN 1..57 LOOP','FOR i IN 1..2 LOOP').replace('event:=CASE WHEN i<=4 THEN 1 ELSE i-3 END;','event:=i;').replace('np:=CASE WHEN i<=53 THEN 3 ELSE 2 END;','np:=2;')
  before="CASE WHEN i=1 THEN CASE j WHEN 1 THEN 104 ELSE 2896 END ELSE CASE j WHEN 1 THEN 1031 ELSE 1969 END END"
  body=body.replace("'chips',100", "'chips',"+before).replace("'stack',100", "'stack',"+before)
  after="CASE WHEN c.i=1 THEN CASE s.seat_number WHEN 1 THEN 208 ELSE 2792 END ELSE CASE s.seat_number WHEN 1 THEN 1021 ELSE 1979 END END"
  body=body.replace("'stack_before',100", "'stack_before',s.stack").replace('CASE s.seat_number WHEN 1 THEN 99 WHEN 2 THEN 101 ELSE 100 END',after)
  body=body.replace("'started_at','2026-09-08T12:00:02+00:00','ended_at','2026-09-08T12:00:03+00:00'", "'started_at',CASE c.i WHEN 1 THEN '2026-10-06T15:33:02+00:00' ELSE '2026-10-06T15:33:04+00:00' END,'ended_at',CASE c.i WHEN 1 THEN '2026-10-06T15:33:04+00:00' ELSE '2026-10-06T15:33:06+00:00' END")
  body=body.replace('CREATE TRIGGER zz_retirement_original_failure BEFORE INSERT ON public.hand_projection_outbox FOR EACH ROW EXECUTE FUNCTION retirement_native.submission_fault();','').replace('DROP TRIGGER zz_retirement_original_failure ON public.hand_projection_outbox;','')
  x=body.index('  r:=public.fn_ca_commit_hand_submission');z=body.index(' END LOOP;',x);body=body[:x]+body[z:]
  e.sql(db,body,label='two-anonymous-native-originals-after-and-during-hand-departure')
  probe=(root/'scripts/qualification/retirement-native-proof.sql').read_text()
  capture=probe[:probe.index('CREATE FUNCTION retirement_native.assert_true')]
  capture=capture.replace('TRUNCATE smarter_private.retirement_original_hand_qualification CASCADE;','CREATE TABLE retirement_native.additions (LIKE smarter_private.retirement_original_hand_qualification);').replace('INSERT INTO smarter_private.retirement_original_hand_qualification','INSERT INTO retirement_native.additions')
  e.sql(db,capture,label='synthetic-two-exact-original-request-and-force-postimages')
  _,stdout,_=e.sql(db,'SELECT jsonb_agg(expected ORDER BY submission_id)::text FROM retirement_native.additions;',label='anonymous-two-qualification-literal')
  anonymous=json.loads(next(line for line in stdout.splitlines() if line.startswith('[')))
  migration=(root/'supabase/migrations/20261007021522_two_additional_retained_tournament_originals_keep_their_paid.sql').read_text()
  migration=re.sub(r'\$qualified\$.*?\$qualified\$',lambda _:'$qualified$'+json.dumps(anonymous,separators=(',',':'))+'$qualified$',migration,flags=re.S)
  for original,synthetic in zip(['13b3d759-2915-4f10-974a-28649a3ece9e','54aed95a-98de-4d12-a8b5-fb7da2c1b59f'],[x['submission_id'] for x in anonymous]):migration=migration.replace(original,synthetic)
  # Same source guards, SQL and predecessor hashes; only the two fixture identifiers/payloads differ.
  core=migration[migration.index('DO $preimage$'):migration.index('-- @live-proof:')]
  negative=r'''CREATE FUNCTION retirement_native.assert_true(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'TWO ORIGINAL NATIVE FAIL: %',label;END IF;RAISE NOTICE 'TWO ORIGINAL NATIVE PASS: %',label;END$$;
DO $negative$ DECLARE action text;denied boolean;BEGIN
FOR action IN SELECT unnest(ARRAY[
 'UPDATE public.table_seats SET stack=stack+1 WHERE id=retirement_native.fixture_id(8,12)',
 'UPDATE public.table_seats SET joined_at=joined_at+interval ''1 second'' WHERE id=retirement_native.fixture_id(8,11)',
 'UPDATE public.tournament_players SET chips=chips+1 WHERE id=retirement_native.fixture_id(7,11)',
 'UPDATE public.tournament_players SET rebuys=1 WHERE id=retirement_native.fixture_id(7,11)',
 'UPDATE smarter_private.patterned_identity_retirements SET replacement_horse_id=retirement_native.fixture_id(6,12) WHERE old_id=retirement_native.fixture_id(6,11)',
 'INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state) VALUES(retirement_native.fixture_id(10,99),retirement_native.fixture_id(2,1),retirement_native.fixture_id(1,1),1,9700099,retirement_native.fixture_id(11,99),retirement_native.fixture_id(5,1),''accepted'')'
]) LOOP BEGIN
 PERFORM set_config('session_replication_role','replica',true);EXECUTE action;PERFORM set_config('session_replication_role','origin',true);denied:=false;
 BEGIN EXECUTE $admit$CORE$admit$;EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM LIKE 'ADDITIONAL_TOURNAMENT_%';END;
 PERFORM retirement_native.assert_true(denied,'exact custody/foreign generation/repurchase/later hand refuses');
 PERFORM retirement_native.assert_true((SELECT count(*)=57 FROM smarter_private.retirement_original_hand_qualification),'refused two admission inserts rollback together');
 RAISE EXCEPTION 'rollback anonymous counterfactual' USING ERRCODE='P9001';EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;END;END LOOP;END $negative$;'''.replace('CORE',core)
  e.sql(db,negative,label='native-two-migration-atomic-guard-refusals')
  e.sql(db,migration,label='same-maintained-two-admission-anonymous-literal')
  e.sql(db,"SELECT retirement_native.assert_true((SELECT count(*)=59 AND sum(jsonb_array_length(expected->'rows'))=68 FROM smarter_private.retirement_original_hand_qualification),'exact old57 intact plus two original qualifiers');",label='additive59-68-native-admission')
  e.sql(db,r'''SET request.jwt.claim.role='service_role';SET request.jwt.claims='{"role":"service_role"}';
BEGIN;
DO $$DECLARE c retirement_native.cases;restored boolean;BEGIN FOR c IN SELECT * FROM retirement_native.cases ORDER BY i LOOP
 PERFORM set_config('app.smarter_data_actor','tournament-manager',true);PERFORM set_config('app.smarter_tournament_id',c.tournament_id::text,true);PERFORM set_config('app.smarter_tournament_lease_generation',c.successor_generation::text,true);
 UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp() WHERE tournament_id=c.tournament_id;
 restored:=smarter_private.restore_retired_original_tournament_hand(c.submission_id,'synthetic-successor',c.successor_generation);
 PERFORM retirement_native.assert_true(restored,'exact two different held stacks restored by native helper');
 END LOOP;END$$;
SELECT retirement_native.assert_true((SELECT count(*)=2 AND sum(restored_players)=2 FROM smarter_private.retirement_original_hand_restorations),'two transaction-owned native receipts');
SELECT retirement_native.assert_true((SELECT count(*)=2 FROM public.profiles WHERE status='deleted' AND horse_status='disabled'),'both closed identities remain closed');
ROLLBACK;
SELECT retirement_native.assert_true(NOT EXISTS(SELECT 1 FROM smarter_private.retirement_original_hand_restorations) AND (SELECT count(*)=2 FROM public.tournament_players WHERE status='eliminated'),'whole native helper transaction rollback preserves original postimages');
SELECT 'TWO_ORIGINAL_HELPER_NATIVE_PASS';''',label='two-exact-helper-restorations-and-whole-owner-rollback')
  e.report.update(status='passed',passed=True,native_originals=2,affected_custodies=2,synthetic_only=True,financial_owner_called=False,scope='two omitted original admission and actual native helper; existing57 untouched; no current financial-owner certification')
 finally:
  e.close();(out/'two-original-helper-report.json').write_text(json.dumps(e.report,indent=2)+'\n')
if __name__=='__main__':main()

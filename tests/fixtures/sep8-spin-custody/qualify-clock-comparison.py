"""Only elapsed clock metadata may drift before original financial closure."""
import hashlib,json,re,subprocess

def qualify(root,fix,out,cmd,run,schema):
    signature='public.fn_complete_sep8_spin_original_standings(uuid,jsonb)'
    def query(sql):
        return subprocess.check_output(cmd+['-At','-c',sql],text=True).strip()
    def metadata():
        return json.loads(query("SELECT jsonb_build_object('definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'config',p.proconfig) FROM pg_proc p WHERE p.oid='"+signature+"'::regprocedure"))
    before=metadata()
    if hashlib.md5(before['definition'].encode()).hexdigest()!='c74c2e9f19687a882eed8d3e88200847':
        raise AssertionError('Clock guard live preimage differs from native original')
    migration=root/'supabase/migrations/20260918225150_original_spin_closure_ignores_only_elapsed_clock_metadata.sql'
    source=migration.read_text()
    for label,assignment in [
        ('timestamp',"level_started_at=level_started_at+interval '13 hours'"),
        ('index',"blind_level_state=jsonb_set(blind_level_state,'{index}',to_jsonb((blind_level_state->>'index')::integer+203))"),
        ('both',"level_started_at=level_started_at+interval '13 hours',blind_level_state=jsonb_set(blind_level_state,'{index}',to_jsonb((blind_level_state->>'index')::integer+203))"),
    ]:
        proof="""
BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
DO $proof$ DECLARE c record; prior jsonb;err text;BEGIN
 SELECT * INTO c FROM sep8_spin_fixture.standings_cases ORDER BY tournament_id LIMIT 1;
 prior:=sep8_spin_fixture.snapshot();
 BEGIN
  UPDATE public.tournaments SET """+assignment+""" WHERE id=c.tournament_id;
  PERFORM public.fn_complete_sep8_spin_original_standings(c.operation_id,c.expected);
 EXCEPTION WHEN SQLSTATE '40001' THEN err:=SQLERRM;END;
 PERFORM sep8_spin_fixture.assert(err='SPIN_ORIGINAL_PREIMAGE_CHANGED' AND prior=sep8_spin_fixture.snapshot(),
 'Original closure refuses clock-only """+label+""" change with complete rollback');
END $proof$;
ROLLBACK;
"""
        run(proof,'sep8-clock-before-'+label)
    for label,change,restore in [
        ('config',"ALTER FUNCTION "+signature+" SET lock_timeout='4s';","ALTER FUNCTION "+signature+" SET lock_timeout='3s';"),
        ('acl',"GRANT EXECUTE ON FUNCTION "+signature+" TO authenticated;","REVOKE EXECUTE ON FUNCTION "+signature+" FROM authenticated;"),
    ]:
        run(change,'sep8-clock-'+label+'-drift')
        state=schema()
        p=out/('sep8-clock-'+label+'-refusal.sql');p.write_text(source)
        response=subprocess.run(cmd+['-f',str(p)],capture_output=True,text=True)
        (out/('sep8-clock-'+label+'-refusal.log')).write_text(response.stdout+response.stderr)
        if not response.returncode or 'SPIN_ORIGINAL_CLOCK_PREIMAGE_CHANGED' not in response.stderr or schema()!=state:
            raise AssertionError('Clock installer accepted '+label+' drift or mutated schema')
        run(restore,'sep8-clock-'+label+'-restore')
    run(source,'sep8-clock-successor')
    after=metadata()
    prior=re.search(r'\$prior\$(.*?)\$prior\$',source,re.S).group(1)
    successor=re.search(r'\$successor\$(.*?)\$successor\$',source,re.S).group(1)
    if before['definition'].count(prior)!=1 or after!=dict(before,definition=before['definition'].replace(prior,successor)):
        raise AssertionError('Clock successor changed any other source or authority')
    # Preserve this drift through all five real continuations, concurrency
    # races, canonical receipts and existing financial negative controls.
    run("""BEGIN;
UPDATE public.tournaments SET level_started_at=level_started_at+interval '13 hours',
 blind_level_state=jsonb_set(blind_level_state,'{index}',to_jsonb((blind_level_state->>'index')::integer+203))
WHERE id IN(SELECT tournament_id FROM sep8_spin_fixture.standings_cases);
SELECT sep8_spin_fixture.assert(
 (SELECT count(*)=5 FROM sep8_spin_fixture.standings_cases s
 WHERE smarter_private.spin_original_current_case(s.tournament_id) IS DISTINCT FROM s.expected->'snapshot'
 AND (smarter_private.spin_original_current_case(s.tournament_id) #- '{tournament,level_started_at}' #- '{tournament,blind_level_state,index}')
  = (s.expected->'snapshot' #- '{tournament,level_started_at}' #- '{tournament,blind_level_state,index}')),
 'All five original financial and physical witnesses unchanged under real clock drift');
COMMIT;""",'sep8-clock-after-drift')
    result={'status':'passed','old_clock_only_refusals':3,'installer_authority_refusals':2,
      'clock_drift_kept_through_five_real_continuations':True,'immutable_original_witness_preserved':True,
      'migration_sha256':hashlib.sha256(migration.read_bytes()).hexdigest(),
      'full_definition_md5':hashlib.md5(after['definition'].encode()).hexdigest()}
    (out/'sep8-clock-qualified-function.json').write_text(json.dumps(after,indent=2)+'\n')
    (out/'sep8-clock-evidence.json').write_text(json.dumps(result,indent=2)+'\n')
    return result

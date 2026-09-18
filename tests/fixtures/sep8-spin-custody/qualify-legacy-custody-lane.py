"""Review the existing custody child declarations without changing their lanes."""
import hashlib,json,re,subprocess

def qualify(root,fix,out,cmd,run,schema):
    capture=json.loads((fix/'legacy-custody-lane-catalog.json').read_text())['functions']
    original=next(r for r in capture if r['signature']=='fn_ca_settlement_lane_doctrine()')
    def query(sql):
        return subprocess.check_output(cmd+['-At','-c',sql],text=True).strip()
    def metadata(signature):
        return json.loads(query("SELECT jsonb_build_object('definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'config',p.proconfig) FROM pg_proc p WHERE p.oid='public."+signature+"'::regprocedure"))
    def observed(row):
        return dict(definition=row['definition'],owner=row['owner'],acl=row['proacl'],config=row['proconfig'])
    children={r['signature']:observed(r) for r in capture if r!=original}
    for signature,expected in children.items():
        if metadata(signature)!=expected:raise AssertionError('Unreviewed custody child source: '+signature)
    # Current catalog reader only. Financial bodies and locks stay unchanged.
    run(original['definition']+";\nREVOKE ALL ON FUNCTION public.fn_ca_settlement_lane_doctrine() FROM PUBLIC,anon,authenticated;\nGRANT EXECUTE ON FUNCTION public.fn_ca_settlement_lane_doctrine() TO service_role;",'sep8-lane-current-doctrine')
    if metadata(original['signature'])!=observed(original):raise AssertionError('Current doctrine capture differs')
    before=json.loads(query("SELECT public.fn_ca_settlement_lane_doctrine()"))['violations']
    unknown=[v for v in before if v['rule']=='global_lane_callers_are_reviewed']
    expected='fn_ca_begin_legacy_fee_resolution,fn_ca_hold_legacy_tournament_fee'
    # The frozen full-schema fixture predates two finish helpers and retains
    # this old satellite wrapper. Preserve and report those exact historical
    # findings; replacing financial fixture bodies to make the catalog green
    # would broaden this declaration-only qualification.
    historical=[dict(rule='f_named_only_by_finish_helpers',found='fn_ca_lock_settlement_lane_for_finish'),
      dict(rule='global_lane_callers_are_reviewed',found='fn_settle_satellite_tournament_pre_money_path_gate')]
    if before!=[historical[0],dict(rule='global_lane_callers_are_reviewed',found=expected+','+historical[1]['found'])]:
        raise AssertionError('Native did not reproduce exact missing custody declarations: '+str(before))
    migration=root/'supabase/migrations/20260918213339_review_bounded_legacy_fee_custody_settlement_lane_callers.sql'
    source=migration.read_text()
    run("ALTER FUNCTION public.fn_ca_hold_legacy_tournament_fee(uuid,text) SET statement_timeout='7s';",'sep8-lane-reviewed-child-drift')
    prior_schema=schema()
    path=out/'sep8-lane-reviewed-child-refusal.sql';path.write_text(source)
    response=subprocess.run(cmd+['-f',str(path)],capture_output=True,text=True)
    (out/'sep8-lane-reviewed-child-refusal.log').write_text(response.stdout+response.stderr)
    if not response.returncode or 'LEGACY_CUSTODY_LANE_REVIEW_CHANGED' not in response.stderr or schema()!=prior_schema:
        raise AssertionError('Changed reviewed child must refuse with no schema mutation')
    run("ALTER FUNCTION public.fn_ca_hold_legacy_tournament_fee(uuid,text) RESET statement_timeout;",'sep8-lane-child-restore')
    run(source,'sep8-lane-reviewed-successor')
    after=metadata(original['signature'])
    prior=re.search(r'\$prior\$(.*?)\$prior\$',source,re.S).group(1)
    successor=re.search(r'\$successor\$(.*?)\$successor\$',source,re.S).group(1)
    if original['definition'].count(prior)!=1 or after!=dict(observed(original),definition=original['definition'].replace(prior,successor)):
        raise AssertionError('Doctrinal successor changed rules, ACL or configuration')
    answer=json.loads(query("SELECT public.fn_ca_settlement_lane_doctrine()"))
    if answer['violations']!=historical:
        raise AssertionError('Doctrinal successor changed any result outside the two reviewed declarations')
    run((fix/'legacy-custody-lane-controls.sql').read_text(),'sep8-lane-all-four-rule-refusals')
    for signature,expected in children.items():
        if metadata(signature)!=expected:raise AssertionError('Custody financial child changed')
    result={'status':'passed','exact_original_missing_declarations':unknown,
      'existing_fixture_other_violations':answer['violations'],'all_four_rule_negative_controls':True,
      'rolling_into_both_declared_children_refused':True,'financial_children_unchanged':True,
      'changed_reviewed_child_install_refused':True,'full_definition_md5':hashlib.md5(after['definition'].encode()).hexdigest(),
      'migration_sha256':hashlib.sha256(migration.read_bytes()).hexdigest()}
    (out/'sep8-lane-qualified-function.json').write_text(json.dumps(after,indent=2)+'\n')
    (out/'sep8-lane-evidence.json').write_text(json.dumps(result,indent=2)+'\n')
    return result

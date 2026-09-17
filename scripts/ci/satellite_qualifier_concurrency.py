"""Direct two-backend qualification through the retained Execution owner."""
import re
from collections import Counter
from hashlib import sha256

RECEIPT_READER_LOCKS = """  -- Browser receipt reads take the same outer locks as manager/finish reads.
  -- Acquire them before the header or any target row, never after a row lock.
  -- Reading an already committed receipt does not require an activated ABI.
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  PERFORM public.fn_ca_lock_settlement_lane_for_satellite_finish(p_tournament_id);
"""

def validate_reader_result(code, stdout, stderr, mode, negative):
    if mode not in ('commit', 'rollback'):
        raise ValueError('unknown reader release permutation')
    joined=stdout+'\n'+stderr
    notices=re.findall(r'^(?:[a-z_]+: )?NOTICE:\s*(.*)$', joined, re.M)
    errors=re.findall(r'^(?:[a-z_]+: )?(ERROR|FATAL|PANIC|WARNING):\s*(.*)$', joined, re.M)
    expected=['SATELLITE_MANAGER_RECEIPT_PROVEN']
    if not negative: expected.append('SATELLITE_READER_LANE_WAIT_PROVEN')
    expected += ['SATELLITE_OWN_RESULT_PROVEN','SATELLITE_READER_EFFECTS_PROVEN']
    refusal=[('ERROR','SATELLITE_READER_LANE_WAIT_NOT_PROVEN')] if negative else []
    permutation='manager_begin manager_read own_result reader_wait_proven manager_'+mode+' reader_effects'
    steps=Counter(re.findall(r'^step ([a-z_]+):',stdout,re.M))
    required=Counter({'manager_begin':1,'manager_read':1,'own_result':2,'reader_wait_proven':1,
                      'manager_'+mode:1,'reader_effects':1})
    if (code or notices!=expected or errors!=refusal or steps!=required
        or re.findall(r'^starting permutation: (.*)$',stdout,re.M)!=[permutation]
        or stdout.count('Parsed test spec with 2 sessions')!=1
        or stdout.count('<waiting ...>')!=1 or stdout.count('<... completed>')!=1
        or not re.search(r'^step own_result: <\.\.\. completed>$',stdout,re.M)):
        raise RuntimeError('satellite reader lacks exact lane, completed caller and unchanged financial proof')
    return {'negative_control':negative,'observed_wait':True,'financial_lane_wait_proven':not negative,
            'authenticated_own_result':True,'exact_effects':True}

def qualify_readers(e, root, native, template, output, probe):
    spec_path=root/'scripts/ci/probes/satellite-qualifier-reader.spec'
    spec=spec_path.read_text()
    permutations=re.findall(r'^permutation .+$',spec,re.M)
    if len(permutations)!=2: raise ValueError('exact two reader permutations required')
    body=re.sub(r'^permutation .+$','',spec,flags=re.M)
    binary=native.stock_isolationtester(e.pg)
    e.report['source_sha256'][str(spec_path.relative_to(root))]=sha256(spec_path.read_bytes()).hexdigest()
    seed=probe.read_text().split("SELECT 'SATELLITE_QUALIFIER_NATIVE_EVIDENCE='")[0]
    if seed.count('BEGIN;')!=1 or re.search(r'^COMMIT;|^ROLLBACK;',seed,re.M): raise ValueError('invalid reader opening')
    seed+="""SELECT pg_temp.qualifier_case('race',2,false);
SET LOCAL ROLE service_role;
SELECT public.fn_settle_satellite_qualifiers(md5('l04:race:source')::uuid,
 ARRAY(SELECT x FROM unnest(ARRAY[md5('l04:race:user:1')::uuid,md5('l04:race:user:2')::uuid]) x ORDER BY x));
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
"""
    (output/'reader-opening.sql').write_text(seed)
    # Keep the original frozen receipt as a precise, isolated counterfactual.
    # No production function, financial rail, ACL or guard is substituted.
    for negative in [True,False]:
      for permutation in permutations:
        mode='rollback' if 'manager_rollback' in permutation else 'commit'
        label='reader-'+('original-' if negative else '')+mode
        db=e.database(template)
        e.sql(db,file=output/'reader-opening.sql',label=label+'-completed-opening',seconds=90)
        if negative:
          seam=RECEIPT_READER_LOCKS.replace("'","''")
          e.sql(db,"""DO $original$ DECLARE d text; b text; seam text:='"""+seam+"""'; BEGIN
            SELECT pg_get_functiondef(oid),prosrc INTO d,b FROM pg_proc WHERE oid='public.fn_ca_satellite_cohort_receipt(uuid,uuid[])'::regprocedure;
            IF (length(b)-length(replace(b,seam,'')))/length(seam)<>1
              OR md5(replace(b,seam,''))<>'325ff2e2d0e588ccd6652ab7a1099a0b' THEN RAISE EXCEPTION 'original receipt counterfactual differs'; END IF;
            EXECUTE replace(d,b,replace(b,seam,''));
          END $original$;""",label=label+'-exact-original-receipt')
        before=e.snapshot(db,label+'-before-data'); catalog=e.catalog_snapshot(db,label+'-before-catalog')
        conn=f'host={e.socket} port={e.port} dbname={db} user=postgres'
        code,out,err=e.run(label,[binary,conn],text=body+'\n'+permutation+'\n',seconds=75,check=False)
        proof=validate_reader_result(code,out,err,mode,negative)
        if before!=e.snapshot(db,label+'-after-data') or catalog!=e.catalog_snapshot(db,label+'-after-catalog'):
            raise RuntimeError('receipt read changed financial or catalog state')
        e.discard(db)
        e.report['races'].append({'case':label,**proof,'all_data_unchanged':True,'catalog_unchanged':True,'database_removed':True})

def validate_result(code, stdout, stderr, mode, negative):
    if mode not in ('commit', 'rollback'):
        raise ValueError('unknown financial outcome permutation')
    joined=stdout+'\n'+stderr
    notices=re.findall(r'^(?:[a-z_]+: )?NOTICE:  (SATELLITE_[A-Z_]+)\s*$', joined, re.M)
    errors=re.findall(r'^(?:[a-z_]+: )?(ERROR|FATAL|PANIC|WARNING):\s*(.*)$', joined, re.M)
    waited=stdout.count('<waiting ...>')==1 and stdout.count('<... completed>')==1
    expected_outcome='SATELLITE_RACE_OUTCOME_ROLLED_BACK' if negative or mode=='rollback' else 'SATELLITE_RACE_OUTCOME_COMMITTED'
    expected_notices=[expected_outcome,'SATELLITE_RACE_EXACT_EFFECTS_PROVEN']
    if not negative:
        expected_notices.insert(0,'SATELLITE_FINISH_LANE_WAIT_PROVEN')
    expected_errors=[('ERROR','SATELLITE_FINISH_LANE_WAIT_NOT_PROVEN')] if negative else []
    if code or not waited or notices!=expected_notices or errors!=expected_errors:
        raise RuntimeError('satellite race lacks exact wait, financial outcome and negative-control proof')
    return {'negative_control':negative,'observed_wait':True,
            'financial_lane_wait_proven':not negative,'exact_effects':True}

def qualify(e, root, native, template, output, probe):
    spec_path=root/'scripts/ci/probes/satellite-qualifier-finish.spec'
    spec=spec_path.read_text()
    permutations=re.findall(r'^permutation .+$',spec,re.M)
    if len(permutations)!=2: raise ValueError('exact two settlement permutations required')
    spec_body=re.sub(r'^permutation .+$','',spec,flags=re.M)
    binary=native.stock_isolationtester(e.pg)
    e.report['source_sha256'][str(spec_path)]=sha256(spec_path.read_bytes()).hexdigest()
    e.report['isolationtester']={'path':str(binary),'sha256':sha256(binary.read_bytes()).hexdigest()}
    seed=probe.read_text().split("SELECT 'SATELLITE_QUALIFIER_NATIVE_EVIDENCE='")[0]
    if seed.count('BEGIN;')!=1 or re.search(r'^COMMIT;|^ROLLBACK;',seed,re.M): raise ValueError('invalid race opening')
    seed+="SELECT pg_temp.qualifier_case('race',2,false);\nSET CONSTRAINTS ALL IMMEDIATE;\nCOMMIT;\n"
    (output/'race-opening.sql').write_text(seed)
    for negative in [False,True]:
      for permutation in permutations:
        mode='rollback' if 'payer_rollback' in permutation else 'commit'
        label=('negative-' if negative else '')+mode
        db=e.database(template)
        e.sql(db,file=output/'race-opening.sql',label=label+'-funded-race-opening',seconds=90)
        if negative:
          e.sql(db,"""DO $fixture$ DECLARE d text; b text; seam text:='PERFORM public.fn_ca_lock_settlement_lane_for_satellite_finish(p_tournament_id);'; BEGIN
            SELECT pg_get_functiondef(oid),prosrc INTO d,b FROM pg_proc WHERE oid='public.fn_resolve_satellite_qualifier_outcome(uuid,uuid[])'::regprocedure;
            IF (length(b)-length(replace(b,seam,'')))/length(seam)<>1 THEN RAISE EXCEPTION 'negative seam changed'; END IF;
            EXECUTE replace(d,b,replace(b,seam,''));
          END $fixture$;""",label=label+'-remove-outcome-lane')
        conn=f'host={e.socket} port={e.port} dbname={db} user=postgres'
        code,stdout,stderr=e.run(label,[binary,conn],text=spec_body+'\n'+permutation+'\n',seconds=75,check=False)
        proof=validate_result(code,stdout,stderr,mode,negative)
        e.discard(db)
        e.report['races'].append({'case':label,**proof,'database_removed':True})

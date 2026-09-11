#!/usr/bin/python3
"""Fixed JSON intake/readback for the journal-owned v2 native transaction."""
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
SPEC=importlib.util.spec_from_file_location('engine_operation',Path(__file__).with_name('engine-operation-v2.py'))
V2=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(V2)
BASE=V2.BASE
NATIVE=V2.NATIVE
UNIT='club-arena-engine-operation-v2@.service'

def dispatch(action,envelope,config,manager=None):
    BASE.require(action in ('preflight','submit','observe','resume-acceptance','maintenance-need','maintenance-safe-resume'))
    operation=envelope['operation_id'];BASE.require(re.fullmatch(NATIVE.UUID,operation))
    folder=V2.STATE/operation
    unit=UNIT.replace('@.','@'+operation+'.')
    # Existing operation readback always uses its immutable configuration,
    # including after a later bundle becomes the new intake default.
    if (folder/'installation.json').exists():
        config,files=NATIVE.pinned_configuration(folder)
        BASE.require(json.loads(BASE.secure(folder/'intent.json').read_text())==envelope)
    BASE.require(Path(config['bundle_path'])==Path(__file__).resolve().parent.parent)
    NATIVE.verify_configuration(config)
    if action=='resume-acceptance':
        BASE.require((folder/'installation.json').exists() and not any((folder/name).exists() for name in
            ('acceptance.json','execution-owner.json','claim-attempt.json','result.json','retired.json')))
        BASE.dispatch('preflight',envelope,config)
        attempts=folder/'acceptance-resumes';NATIVE.directory(attempts)
        prior=list(attempts.glob('*.json'));BASE.require(len(prior)<12)
        NATIVE.immutable(attempts/(str(len(prior)+1)+'.json'),NATIVE.canonical({'operation_id':operation,'ordinal':len(prior)+1}))
        return NATIVE.prepare(envelope,config,manager,root=V2.STATE)
    if action=='submit' and (folder/'installation.json').exists() and ((folder/'acceptance.json').exists() or (folder/'execution-owner.json').exists()):
        return NATIVE.prepare(envelope,config,manager,root=V2.STATE)
    if action in ('preflight','submit','maintenance-need'):
        proof=BASE.dispatch('preflight',envelope,config)
        if action=='preflight':return proof
        if action=='maintenance-need':return BASE.maintenance_proof(proof,envelope,config)
        return NATIVE.prepare(envelope,config,manager,root=V2.STATE)
    base={'operation_id':operation,'run_key':envelope['request']['run_key'],'source_sha':envelope['request']['source_sha'],
          'control_sha':envelope['request']['control_sha'],'terminal':False}
    if not (folder/'intent.json').exists():return base
    BASE.require(json.loads(BASE.secure(folder/'intent.json').read_text())==envelope)
    if ((folder/'installation.json').exists() and not any((folder/name).exists() for name in
        ('acceptance.json','execution-owner.json','claim-attempt.json','result.json','retired.json'))):
        return {**base,'acceptance_state':'PARTIAL'}
    state=BASE.command(['/usr/bin/systemctl','show',unit,'-p','ActiveState','-p','Job','-p','MainPID','-p','ControlPID'])
    fields=dict(line.split('=',1) for line in state.stdout.splitlines() if '=' in line)
    if state.returncode!=0 or fields.get('ActiveState') not in ('inactive','failed') or fields.get('Job') not in ('0','') or fields.get('MainPID')!='0' or fields.get('ControlPID')!='0':return base
    if not (folder/'result.json').exists() or (folder/'uncertain-command.json').exists():return base
    if not (folder/'retired.json').exists():return base
    retirement=json.loads(BASE.secure(folder/'retired.json').read_text())
    BASE.require(retirement=={'operation_id':operation,'result_digest':NATIVE.digest(BASE.secure(folder/'result.json').read_bytes()),
                             'installation_digest':NATIVE.digest(BASE.secure(folder/'installation.json').read_bytes())})
    for name in (unit,unit.removesuffix('.service')+'.path'):
        BASE.require(BASE.command(['/usr/bin/systemctl','is-enabled',name]).stdout.strip()=='disabled')
    result=json.loads(BASE.secure(folder/'result.json').read_text())
    BASE.require(all(result[k]==v for k,v in base.items() if k!='terminal') and result['terminal'] is True)
    host=V2.LinuxActuator(envelope,config)
    if result['outcome']=='SUCCEEDED':
        BASE.require(host.committed() and result['image_id']==envelope['request']['artifact_image_id'])
        host.witness(result['source_sha'],result['image_id'])
        attestation=host.seal('attest-result','--sha',result['source_sha'],'--run-id',result['run_key']).stdout.split()
        BASE.require(len(attestation)==7 and attestation[1]==result['source_sha'] and attestation[2]==result['image_id'] and attestation[6]==result['control_sha'])
    else:
        BASE.require(result['outcome']=='FAILED' and host.seal('get','desired-sha').stdout.strip()==result['recovered_sha'] and
                     host.seal('get','desired-image-id').stdout.strip()==result['image_id'])
        host.witness(result['recovered_sha'],result['image_id'],sealed_source=True)
    if action=='maintenance-safe-resume':
        BASE.require(result['outcome']=='SUCCEEDED')
        return BASE.maintenance_proof(result,envelope,config)
    return result

if __name__=='__main__':
    try:
        BASE.require(os.geteuid()==0 and len(sys.argv)==2)
        raw=sys.stdin.buffer.read(65537);BASE.require(len(raw)<=65536)
        # Intake and execution serialize on the existing native engine lock.
        with NATIVE.mutation_lock(V2.LOCK):
            result=dispatch(sys.argv[1],json.loads(raw),json.loads(BASE.secure(V2.CONFIG).read_text()))
        print(json.dumps(result))
    except Exception:print(json.dumps({'error':'RELEASE_ENGINE_INTAKE_V2_REFUSED'}));sys.exit(1)

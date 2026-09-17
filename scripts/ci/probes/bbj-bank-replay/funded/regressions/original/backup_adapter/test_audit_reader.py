"""UNRUN, protected-only audit reader and installer evidence-retention checks."""
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
import case_module as adapter

physical = {'database':'fixture_base','database_oid':'123','system_identifier':'456',
            'data_directory':'/owned/data','socket_directory':'/owned/socket'}
actual = {**physical,'role':'postgres','session_role':'postgres','socket':True,'replication':'origin',
          'server_version':'17.11','pid':123,'backend_start':'2026-09-15 12:00:00+00'}
checks = []


class Pipe:
    def __init__(self, mode):
        self.mode=mode;self.calls=[];self.reads=0
    def one(self,sql):
        self.calls.append(sql);self.reads+=1
        if self.mode=='changed_endpoint' and self.reads==2:
            return {**actual,'system_identifier':'999'}
        return actual
    def sql(self,sql):
        self.calls.append(sql)
        if self.mode=='commit_failure' and sql=='COMMIT':
            raise RuntimeError('read-only commit response lost')
        if self.mode=='rollback_failure' and sql=='ROLLBACK':
            raise RuntimeError('read-only rollback failed')


original = adapter.supplemental_module
try:
    for mode in ('success','source_failure','capture_error','validation_failure','changed_endpoint','commit_failure','rollback_failure'):
        pipe=Pipe(mode);retained={}
        def capture(c,report):
            retained['report']=report
            report.update(raw={'audit_rows':'retained'},sequence_state={'last_value':'125'},errors=[])
            if mode=='capture_error':
                report['errors'].append({'original':'capture error'})
        def validate(report):
            if mode in ('capture_error','validation_failure'):
                raise AssertionError('audit evidence incomplete or changed')
        def supplement():
            if mode=='source_failure':
                raise AssertionError('source pin differs')
            return SimpleNamespace(capture_audit=capture,A=SimpleNamespace(validate_capture=validate))
        adapter.supplemental_module=supplement
        try:
            report=adapter.audit_postflight(pipe,'protected_fault',physical)
        except Exception as exc:
            assert mode!='success'
            report=exc.audit_report
            assert report['status']=='FAIL' or report['cleanup_errors']
        else:
            assert mode=='success' and report['status']=='CAPTURED'
        assert pipe.calls[-1]=='ROLLBACK'
        if mode!='source_failure':
            assert report['capture'] is retained['report']
            assert report['capture']['raw']=={'audit_rows':'retained'}
        if mode=='changed_endpoint':
            assert report['status']=='FAIL' and report['capture']['sequence_state']['last_value']=='125'
        if mode=='rollback_failure':
            assert report['cleanup_errors'][0]['action']=='rollback'
        checks.append({'name':mode,'passed':True})
finally:
    adapter.supplemental_module=original

if __name__=='__main__':
    print(json.dumps({'status':'PASS','checks':checks,'count':len(checks),'native_calls':0,
                     'scope':'Modeled reader error retention only; actual protected nested loader/native checks remain mandatory'},indent=2))

#!/usr/bin/env python3
"""Native current typed three-scope financial phase and Union receipt regression.
Uses the maintained own-agent bootstrap without its unrelated case tail. No remote
DB connection is supported. Fixture boundaries remain explicit in passed.json.
"""
from pathlib import Path
import argparse,hashlib,json,sys
R=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser(add_help=False);p.add_argument('--controller-migration',type=Path,required=True);p.add_argument('--repo',type=Path,default=R);p.add_argument('--fixture-root',type=Path,default=R/'scripts/ci/fixtures/weekly-current-typed-union-phase')
control,rest=p.parse_known_args();sys.argv=[sys.argv[0],*rest]
R=control.repo;EXT=control.fixture_root
binding=json.loads((EXT/'source-binding.json').read_text())
for name,digest in binding['fixture_sha256'].items():
    assert hashlib.sha256((EXT/name).read_bytes()).hexdigest()==digest,('fixture source drift',name)
candidate_controller_sql=control.controller_migration.read_text()
assert hashlib.sha256(candidate_controller_sql.encode()).hexdigest()==binding['controller_migration_sha256'],'candidate migration differs from exact qualified bytes'
assert candidate_controller_sql==(EXT/'controller-migration-body.sql').read_text(),'candidate migration source binding differs'
base=R/'scripts/ci/test-own-agent-financial-postgres.py'
source=base.read_text();marker='    correction_call='
assert source.count(marker)==1
source=source[:source.index(marker)]
source+="""
    if sys.platform=='darwin':assert A.scratch_root.resolve().is_relative_to('/Volumes/SmarterWork/agent-work'),'owned external scratch required'
    OUT=A.scratch_root/'weekly-current-typed-union-phase-output';OUT.mkdir(exist_ok=True)
    q((R/'supabase/accounting/standalone-paid-replay/fn_prepare_accounting_week.sql').read_text())
    assert q("SELECT md5(pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure))").stdout.strip()=='39a7e057da9a65dab5d0b2f761428f13'
    exec(compile((EXT/'global_extension.py').read_text(),str(EXT/'global_extension.py'),'exec'))
finally:
    if started: subprocess.run([str(A.pg_bin/'pg_ctl'),'-D',str(D),'-m','immediate','stop'],env=E,capture_output=True)
    shutil.rmtree(W,ignore_errors=True)
    Path.read_text=original_read_text;Path.read_bytes=original_read_bytes
"""
exec(compile(source,str(base),'exec'),{'__name__':'__main__','__file__':str(base),'EXT':EXT,'candidate_controller_sql':candidate_controller_sql})

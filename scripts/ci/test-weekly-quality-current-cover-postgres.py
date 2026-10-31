#!/usr/bin/env python3
"""Current quality/fee regression invoked by the existing required floor family.
Runs retained meaningful full owner/error cases on isolated native data; does
not qualify an unallocated installer, generation or production throughput.
"""
from pathlib import Path
import argparse,json,subprocess,sys
p=argparse.ArgumentParser();p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--scratch',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();R=Path(__file__).resolve().parents[2];F=R/'scripts/ci/fixtures/weekly-quality-current-cover'
results=[]
for script,count,key in [('native-parity.py',29,'case_count'),('native-stream-boundary.py',7,'count'),('native-fee-parity.py',16,'cases')]:
 out=a.output.with_name('weekly-quality-current-'+script+'.json');assert not out.exists()
 subprocess.run([sys.executable,str(F/script),'--repo',str(R),'--pg-bin',str(a.pg_bin),'--scratch',str(a.scratch),'--output',str(out)],check=True)
 result=json.loads(out.read_text());assert script!='native-parity.py'or(result['installer_controls']['passed']and len(result['installer_controls']['cases'])==6and result['installer_controls']['actual_allocated_version_guard_tested']is True and result['installer_controls']['unallocated_version_adapter_explicit']is False);observed=len(result[key])if key=='cases'else result[key];assert observed==count,(script,observed,count);results.append({'runner':script,'expected_case_count':count,'evidence':str(out)})
a.output.write_text(json.dumps({'passed':True,'retained_meaningful_cases':52,'results':results,'installer_unallocated_not_qualified':True,'production_capacity_not_proven':True},indent=2)+'\n')

#!/usr/bin/env python3
"""Focused original/current receipt access parity; no production calls."""
from pathlib import Path
import argparse,json,subprocess,sys
p=argparse.ArgumentParser();p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--scratch',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();R=Path(__file__).resolve().parents[2]
assert __debug__ and a.scratch.is_dir() and not a.output.exists()
subprocess.run([sys.executable,'-B',str(R/'scripts/ci/fixtures/weekly-quality-current-cover/native-receipt-access-parity.py'),'--repo',str(R),'--pg-bin',str(a.pg_bin),'--scratch',str(a.scratch),'--output',str(a.output)],check=True)
x=json.loads(a.output.read_text());assert x['passed'] is True and x['case_count']==33 and x['new_canonical_md5']=='53ffa57118e0d605dc65c5cbc4043dda' and x['real_full_old_and_new_function_invoked'] is True and x['ABI_ACL_all_metadata_except_prosrc_equal'] is True and x['no_production_calls'] is True
assert x['successor_installer_controls']['passed'] is True and len(x['successor_installer_controls']['cases'])==6 and x['successor_installer_controls']['actual_allocated_version_guard_tested'] is True

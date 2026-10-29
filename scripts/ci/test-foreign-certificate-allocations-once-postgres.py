#!/usr/bin/env python3
"""Exact helper-only transition inside the existing isolated original financial family.
No network or production calls. Its original36 financial cases remain unchanged.
"""
from pathlib import Path
base=Path(__file__).with_name('test-zero-standalone-foreign-postgres.py')
s=base.read_text();marker='    load(zero_migration)';assert s.count(marker)==1
hook=Path(__file__).parent/'fixtures/foreign-certificate-allocations-once/native-hook.py'
s=s.replace(marker,marker+'\n    exec(compile(Path('+repr(str(hook))+').read_text(),'+repr(str(hook))+',"exec"),globals())')
exec(compile(s,str(base),'exec'),globals())

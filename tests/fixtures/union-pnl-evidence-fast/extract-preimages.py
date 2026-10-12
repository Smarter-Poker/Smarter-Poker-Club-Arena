#!/usr/bin/env python3
"""Copies each production function body this change reads or replaces from the
newest migration that defines it into preimage/<name>.sql. The harness then
proves md5(pg_get_functiondef) of every copy equals production's digest."""
import re, sys
from pathlib import Path
here = Path(__file__).resolve().parent
root = here.parents[2]
extra = [Path(p) for p in sys.argv[1:]]  # migrations not yet on main (applied in production)
migs = sorted((root / 'supabase/migrations').glob('*.sql')) + extra
NAMES = ['fn_union_pnl_evidence_report', 'fn_union_pnl_boundary', 'fn_union_pnl_close_quality', 'fn_union_pnl_qualified_clubs',
 'fn_union_pnl_cash_outcome_accepted', 'fn_union_pnl_original_flow_evidence', 'fn_union_pnl_tournament_returns',
 'fn_union_pnl_tournament_entry_club', 'fn_pnl_evidence_cents', 'fn_union_week_start', 'fn_accounting_union_earned_plan',
 'fn_weekly_accounting_attempt_begin', 'fn_weekly_accounting_attempt_end']
for name in NAMES:
    found = None
    pat = re.compile(r'CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?"?' + name + r'"?\s*\(', re.I)
    for m in migs:
        t = m.read_text()
        for mm in pat.finditer(t):
            s = mm.start()
            # the body ends at the second occurrence of its dollar tag
            tag = re.search(r'AS\s+(\$[A-Za-z_]*\$)', t[s:])
            if not tag: continue
            a = s + tag.end()
            e = t.index(tag.group(1), a) + len(tag.group(1))
            found = (m.name, t[s:e])
    if not found: print('MISSING', name); continue
    (here / 'preimage' / f'{name}.sql').write_text(found[1] + '\n')
    print(name, found[0])

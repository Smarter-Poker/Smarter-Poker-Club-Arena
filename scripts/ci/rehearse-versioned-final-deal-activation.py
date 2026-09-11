#!/usr/bin/env python3
"""Rehearse fresh and repeated exact-consent activation in owned rollback PG.

Uses the existing paid/unpaid/partial final-deal acceptance without changing
its assertions, money authorities or consent flow. No production deployment.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location("consent_final",ROOT/"scripts/ci/rehearse-final-deal-current-terminal.py")
final=importlib.util.module_from_spec(spec)
spec.loader.exec_module(final)
original=final.compose

def compose(root,variant,probe_path=None):
    sql=original(root,variant,probe_path)
    activation=(root/"scripts/deploy/phase-three-activate-versioned-final-deal.sql").read_text()
    if len(re.findall(r"^BEGIN;$",activation,re.M))!=1 or len(re.findall(r"^COMMIT;$",activation,re.M))!=1:
        raise ValueError("activation must have one outer transaction")
    activation=re.sub(r"^(BEGIN|COMMIT);$","",activation,flags=re.M)
    pattern=r"CREATE TRIGGER require_exact_final_deal_proposal\s+BEFORE INSERT OR UPDATE OF tournament_id,kind,user_id,place,amount_owed ON public.tournament_obligations\s+FOR EACH ROW EXECUTE FUNCTION public.fn_require_exact_final_deal_proposal\(\);"
    found=list(re.finditer(pattern,sql))
    if len(found)!=1:
        raise ValueError("exact native consent trigger boundary differs")
    match=found[0]
    sql=sql[:match.start()]+activation+"\n"+activation+"\n"+sql[match.end():]
    if len(re.findall(r"^BEGIN;$",sql,re.M))!=1 or re.search(r"^COMMIT;$",sql,re.M):
        raise ValueError("activation rehearsal must remain rollback-only")
    return sql

if __name__=="__main__":
    final.compose=compose
    try:
        final.main()
    finally:
        if "--evidence" in sys.argv:
            path=Path(sys.argv[sys.argv.index("--evidence")+1])
            if path.exists():
                evidence=json.loads(path.read_text())
                evidence["activation_rehearsal"]={"fresh_then_repeat":True,"production_mutation":False,
                    "runner_sha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                    "activation_sha256":hashlib.sha256((ROOT/"scripts/deploy/phase-three-activate-versioned-final-deal.sql").read_bytes()).hexdigest()}
                path.write_text(json.dumps(evidence,indent=2)+"\n")

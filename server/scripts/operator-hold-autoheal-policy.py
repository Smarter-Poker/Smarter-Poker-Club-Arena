#!/usr/bin/env python3
"""Read the original bounded autoheal policy; never mutate or guess identity."""
import json,os,stat,sys
from pathlib import Path
root=Path('/var/lib/club-arena/operator-hold')
def read(p):
 s=p.lstat()
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_nlink!=1 or stat.S_IMODE(s.st_mode)!=0o600: raise SystemExit('original restart receipt unsafe')
 return json.loads(p.read_text())
i=read(root.parent/'operator-hold-required');r=read(root/'restart-fence.json')
if r.get('kind')!='operator_restart_fence_v1' or r.get('handoffId')!=i.get('handoffId') or r.get('autohealContainer')!=sys.argv[1] or r.get('autohealPolicy') not in ['always','unless-stopped','no']: raise SystemExit('original autoheal policy identity refused')
print(r['autohealPolicy'])

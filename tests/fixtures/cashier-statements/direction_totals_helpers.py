"""Private PG17 process helper for the finite directional totals regression."""
from pathlib import Path
import hashlib, os, subprocess, time
PG=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
ENV={'PATH':str(PG)+':/usr/bin:/bin','LANG':'C','LC_ALL':'C'}
OWN=DATA=SOCKET=None
deadline=0

def run(args, text=None, timeout=150):
    remaining=deadline-time.monotonic()
    assert remaining>0,'owning_deadline'
    p=subprocess.run(list(map(str,args)),input=text,text=True,capture_output=True,
                     env=ENV,timeout=min(timeout,remaining))
    if p.returncode:
        # Synthetic-only cluster; expose no runtime SQL/raw fixtures in receipt.
        raise RuntimeError('isolated_command_failed:'+hashlib.sha256(p.stderr.encode()).hexdigest())
    return p.stdout.strip()

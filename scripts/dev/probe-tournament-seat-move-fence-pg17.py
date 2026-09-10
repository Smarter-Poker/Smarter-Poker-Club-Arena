#!/usr/bin/env python3
"""Execute the actual prepared strict request hook on a disposable PG17 cluster.
No database URL is accepted. This is route-authority evidence only, not a
rehearsal of the complete cutover or the seat-move money/roster transaction.
"""
from pathlib import Path
import os
import re
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
pg = Path(os.environ.get("PG17_BINDIR", "/opt/homebrew/opt/postgresql@17/bin"))
assert " 17." in subprocess.check_output([str(pg / "postgres"), "--version"], text=True)
source = (repo / "scripts/deploy/phase-three-strict-tournament-cutover.sql").read_text()
hooks = re.findall(
    r"CREATE OR REPLACE FUNCTION smarter_private\.fn_smarter_data_api_pre_request\(\)[\s\S]*?\$function\$;",
    source,
)
assert len(hooks) == 1, "Expected exactly one real strict request hook"
fixtures = repo / "scripts/dev/fixtures"
sql = "BEGIN;\n" + (fixtures / "tournament-seat-move-fence-bootstrap.sql").read_text()
sql += hooks[0] + "\nREVOKE ALL ON FUNCTION smarter_private.fn_smarter_data_api_pre_request() FROM PUBLIC;\n"
sql += "GRANT EXECUTE ON FUNCTION smarter_private.fn_smarter_data_api_pre_request() TO anon,authenticated,service_role;\n"
sql += (fixtures / "tournament-seat-move-fence-behavior.sql").read_text() + "\nROLLBACK;\n"
with tempfile.TemporaryDirectory(prefix="ca-seat-move-fence-pg17-") as directory:
    root = Path(directory)
    cluster, sock = root / "cluster", root / "socket"
    sock.mkdir()
    port = str(35000 + os.getpid() % 10000)
    started = False
    try:
        subprocess.run([str(pg / "initdb"), "-D", str(cluster), "-U", "postgres", "--auth=trust", "--no-locale"], check=True, capture_output=True, timeout=30)
        subprocess.run([str(pg / "pg_ctl"), "-D", str(cluster), "-l", str(root / "postgres.log"), "-o", f"-h '' -k {sock} -p {port}", "-w", "start"], check=True, capture_output=True, timeout=30)
        started = True
        result = subprocess.run([str(pg / "psql"), "-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", str(sock), "-p", port, "-U", "postgres", "-d", "postgres"], input=sql, text=True, capture_output=True, timeout=30)
        if result.returncode:
            raise RuntimeError(result.stderr.strip())
        print(result.stdout.strip())
    finally:
        if started:
            subprocess.run([str(pg / "pg_ctl"), "-D", str(cluster), "-m", "fast", "-w", "stop"], check=True, capture_output=True, timeout=30)

#!/usr/bin/env python3
"""Full hand-boundary regression on an explicitly supplied disposable local clone.
Reuses the existing hand probe through hand acceptance; its separate rebuy
section is not part of this probe and remains independently required.
Requires the inspected terminal core, seat-authority wrapper and corrected
outer hand function installed, plus atomic-terminal-rehearsal-fixture.sql.
"""
import argparse
import os
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--socket", required=True)
parser.add_argument("--port", required=True)
parser.add_argument("--database", required=True)
args = parser.parse_args()
socket = Path(args.socket).resolve()
assert socket.is_dir() and str(socket).startswith(("/private/tmp/", "/tmp/")), "Disposable local socket required"
root = Path(__file__).resolve().parents[2]
psql = str(Path(os.environ.get("PG17_BINDIR", "/opt/homebrew/opt/postgresql@17/bin")) / "psql")
command = [psql, "-X", "-v", "ON_ERROR_STOP=1", "-h", str(socket), "-p", args.port,
           "-U", "postgres", "-d", args.database]
source = (root / "scripts/ci/probes/atomic-tournament-hand-boundary.sql").read_text()
marker = "-- The accepted zero-hand candidate is also the sole authority for its paid"
assert source.count(marker) == 1
hand = source.split(marker)[0] + "ROLLBACK;\n"

adversarial = """
DO $generation_boundaries$
DECLARE
 before_state jsonb;
 stacks jsonb;
 obligations jsonb;
 result jsonb;
 refused boolean;
 scenario integer;
BEGIN
 FOR scenario IN 1..4 LOOP
  stacks:=pg_temp.atomic_hand_stacks();
  obligations:=pg_temp.atomic_hand_obligations();
  IF scenario=1 THEN
   stacks:=jsonb_set(stacks,'{0,seat_id}','"86300000-0000-0000-0000-000000000099"');
   obligations:=jsonb_set(obligations,'{time_banks,0,seat_id}',stacks->0->'seat_id');
  ELSIF scenario=2 THEN
   stacks:=jsonb_set(stacks,'{0,seat_joined_at}','"2026-09-08T12:00:02+00:00"');
   obligations:=jsonb_set(obligations,'{time_banks,0,seat_joined_at}',stacks->0->'seat_joined_at');
  ELSIF scenario=3 THEN
   obligations:=jsonb_set(obligations,'{time_banks,0,seat_id}','"86300000-0000-0000-0000-000000000099"');
  ELSE
   stacks:=jsonb_set(stacks,'{0}',(stacks->0)-'seat_id'-'seat_joined_at');
  END IF;
  before_state:=pg_temp.atomic_hand_gameplay_state();
  refused:=false;
  BEGIN
   result:=public.fn_ca_commit_hand_settlement(
    '86100000-0000-0000-0000-000000000001',8600001,stacks,
    0,0,'atomic-zero-seat',0,pg_temp.atomic_hand_row(),'[]'::jsonb,
    'atomic-hand-boundary-probe','86500000-0000-0000-0000-000000000001',obligations);
   refused:=result->>'success' IS DISTINCT FROM 'true'
     AND (result->>'error' LIKE '%exact seat generation missing or replaced%'
       OR result->>'error' LIKE '%seat_generation%');
  EXCEPTION WHEN OTHERS THEN
   IF SQLERRM NOT LIKE '%seat_generation%'
      AND SQLERRM NOT LIKE '%exact seat generation missing or replaced%' THEN RAISE; END IF;
   refused:=true;
  END;
  IF NOT refused OR before_state IS DISTINCT FROM pg_temp.atomic_hand_gameplay_state() THEN
   RAISE EXCEPTION 'Generation scenario % failed atomic refusal: %',scenario,result;
  END IF;
 END LOOP;
END $generation_boundaries$;
"""
for mode in ["legacy", "exact"]:
    probe = hand
    if mode == "exact":
        for tag in ["stacks", "obligations"]:
            match = re.search(r"AS \$" + tag + r"\$([\s\S]*?)\$" + tag + r"\$;", probe)
            assert match, tag
            body = match.group(1)
            for index, second in [(1, "00"), (2, "01")]:
                uid = f"10000000-0000-0000-0000-00000000000{index}"
                anchor = "'user_id','" + uid + "'"
                assert body.count(anchor) == 1
                body = body.replace(anchor,
                    f"'seat_id','86300000-0000-0000-0000-00000000000{index}',"
                    f"'seat_joined_at','2026-09-08T12:00:{second}+00:00'," + anchor)
            probe = probe[:match.start(1)] + body + probe[match.end(1):]
        assert probe.count("$state$;") == 1
        probe = probe.replace("$state$;", "$state$;\n" + adversarial, 1)
    result = subprocess.run(command, input=probe, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr[:4000]
    print(f"{mode}: full hand acceptance, fault rollback and replay passed", flush=True)
print("Four invalid-generation outer-commit scenarios also passed. Rebuy and deployment acceptance remain separate.")

#!/usr/bin/env python3
"""Two-session, rollback-only deadline admission on the real terminal lock.

This exercises the prepared consensus function while another backend owns its
actual advisory key. It does not simulate or certify terminal money completion.
"""
import argparse
import json
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import threading
import time


class Session:
    def __init__(self, command):
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                        text=True, bufsize=1)
        self.output = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.process.stdout:
            self.output.put(line.rstrip('\n'))
        self.output.put(None)

    def send(self, sql):
        self.process.stdin.write(sql + '\n')
        self.process.stdin.flush()

    def until(self, prefix, timeout=15):
        limit = time.monotonic() + timeout
        while time.monotonic() < limit:
            line = self.output.get(timeout=max(.01, limit-time.monotonic()))
            if line is None or 'ERROR:' in line or 'FATAL:' in line:
                raise RuntimeError(f'backend ended before {prefix}: {line}')
            if line.startswith(prefix):
                return line[len(prefix):]
        raise TimeoutError(prefix)

    def finish(self):
        if self.process.poll() is None:
            try:
                self.send('ROLLBACK;\n\\q')
            except BrokenPipeError:
                pass
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                self.process.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--composer', type=Path, default=Path(__file__).with_name('build-versioned-final-deal-probe.py'))
    parser.add_argument("--psql",default=shutil.which("psql") or "/opt/homebrew/opt/postgresql@17/bin/psql")
    parser.add_argument("--host",required=True,help="owned local Unix socket directory")
    parser.add_argument("--port",required=True,type=int)
    args = parser.parse_args()
    if not args.host.startswith("/"):
        parser.error("a local Unix socket is required")
    sql = subprocess.check_output([sys.executable, str(args.composer), '--root', str(args.root)], text=True)
    marker = 'CREATE FUNCTION pg_temp.deal_assert('
    assert sql.count(marker) == 1
    setup = sql[:sql.index(marker)]
    command = [args.psql, '-XqAt', '-v', 'ON_ERROR_STOP=1',
               '-h', args.host, '-p', str(args.port), '-U', 'postgres', '-d', 'current_replay']
    reader = Session(command)
    holder = Session(command)
    tid = '87000000-0000-0000-0000-000000000001'
    review_id = '87900000-0000-0000-0000-000000000099'
    try:
        reader.send(setup + "\nSELECT 'LOCKS='||count(*) FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory';")
        assert reader.until('LOCKS=') == '0', 'setup already owns the lock under test'
        holder.send("BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('ca:tournament-terminal-settlement:v1',0));\n\\echo HELD")
        holder.until('HELD')
        reader.send(f"""
INSERT INTO public.tournament_deal_reviews(id,tournament_id,requested_by,state,expires_at,requested_hand_revision)
VALUES('{review_id}','{tid}',md5('atomic-deal-user:1')::uuid,'requested',clock_timestamp()+interval '200 milliseconds',public.fn_ca_tournament_deal_hand_revision('{tid}'));
SELECT 'STATE='||md5(jsonb_build_object(
 'payouts',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.tournament_payouts p),
 'wallets',(SELECT jsonb_agg(to_jsonb(w) ORDER BY user_id,club_id) FROM public.club_members w),
 'escrow',(SELECT jsonb_agg(to_jsonb(e) ORDER BY tournament_id) FROM public.tournament_escrow e))::text);
SELECT 'RESULT='||public.fn_get_tournament_deal_consensus('{tid}')::text;
""")
        before = reader.until('STATE=')
        started = time.monotonic()
        try:
            line = reader.output.get(timeout=0.7)
            raise AssertionError(f'consensus returned before serialized owner released: {line}')
        except queue.Empty:
            pass
        holder.send('COMMIT;\n\\echo RELEASED')
        holder.until('RELEASED')
        result = json.loads(reader.until('RESULT='))
        assert result['review_id'] == review_id and result['review_state'] == 'expired'
        assert result['ready'] is False and result['proposal_id'] is None
        print('PASS consensus waits for admitted terminal lane owner before observing expiry')
        print('PASS deadline is evaluated after lock wait with exact review identity')
        reader.send("""SELECT 'STATE='||md5(jsonb_build_object(
 'payouts',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.tournament_payouts p),
 'wallets',(SELECT jsonb_agg(to_jsonb(w) ORDER BY user_id,club_id) FROM public.club_members w),
 'escrow',(SELECT jsonb_agg(to_jsonb(e) ORDER BY tournament_id) FROM public.tournament_escrow e))::text);""")
        assert reader.until('STATE=') == before
        print('PASS serialized expiry read changes no wallet, cash payout or escrow')
        print(json.dumps({'blocked_seconds': round(time.monotonic()-started, 3), 'transaction': 'ROLLBACK'}))
    finally:
        reader.finish()
        holder.finish()


if __name__ == '__main__':
    main()

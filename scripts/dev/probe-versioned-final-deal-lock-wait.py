#!/usr/bin/env python3
"""Two-session, rollback-only deadline admission through the current lane.

Exercise the prepared consensus behind both the actual terminal helper and
the actual shared hand-barrier helper. Holder helper bodies remain byte-exact
but use pg_temp names so uncommitted fixture DDL need not become persistent.
This does not simulate or certify terminal money completion or hand production.
"""
import argparse
import json
from pathlib import Path
import queue
import runpy
import shutil
import subprocess
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


MONEY_STATE = """SELECT 'STATE='||md5(jsonb_build_object(
 'payouts',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.tournament_payouts p),
 'wallets',(SELECT jsonb_agg(to_jsonb(w) ORDER BY user_id,club_id) FROM public.club_members w),
 'escrow',(SELECT jsonb_agg(to_jsonb(e) ORDER BY tournament_id) FROM public.tournament_escrow e))::text);"""


def run_case(setup, command, helper, mode):
    reader, holder = Session(command), Session(command)
    name, signature, digest, definition = helper
    tid = '87000000-0000-0000-0000-000000000001'
    review_id = '87900000-0000-0000-0000-000000000099'
    try:
        reader.send(setup + "\nSELECT 'LOCKS='||count(*) FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory';")
        assert reader.until('LOCKS=') == '0', 'setup already owns the lock under test'
        # The holder has its own uncommitted helper identity, with the exact
        # production body, search_path and invoker semantics fingerprinted.
        holder_definition = definition.replace(
            f'FUNCTION public.{name}(', f'FUNCTION pg_temp.{name}(', 1)
        holder.send("BEGIN;\n" + holder_definition + f"""
SELECT 'HELPER='||md5(prosrc)||':'||(NOT prosecdef)::text||':'||
 (proconfig=ARRAY['search_path=public, pg_temp']::text[])::text
FROM pg_proc WHERE oid='pg_temp.{name}({signature})'::regprocedure;
SELECT pg_temp.{name}({'' if not signature else 'NULL::uuid'});
\\echo HELD
""")
        assert holder.until('HELPER=') == digest + ':true:true'
        holder.until('HELD')
        reader.send(f"""
INSERT INTO public.tournament_deal_reviews(id,tournament_id,requested_by,state,expires_at,requested_hand_revision)
VALUES('{review_id}','{tid}',md5('atomic-deal-user:1')::uuid,'requested',clock_timestamp()+interval '200 milliseconds',public.fn_ca_tournament_deal_hand_revision('{tid}'));
{MONEY_STATE}
SELECT 'RESULT='||public.fn_get_tournament_deal_consensus('{tid}')::text;
""")
        before = reader.until('STATE=')
        started = time.monotonic()
        try:
            line = reader.output.get(timeout=0.7)
            raise AssertionError(f'{mode}: consensus returned before lane holder released: {line}')
        except queue.Empty:
            pass
        holder.send('ROLLBACK;\n\\echo RELEASED')
        holder.until('RELEASED')
        result = json.loads(reader.until('RESULT='))
        assert result['review_id'] == review_id and result['review_state'] == 'expired'
        assert result['ready'] is False and result['proposal_id'] is None
        print(f'PASS {mode}: consensus waits for the fingerprinted lane helper')
        print(f'PASS {mode}: deadline is evaluated after wait with exact review identity')
        reader.send(MONEY_STATE)
        assert reader.until('STATE=') == before
        print(f'PASS {mode}: serialized expiry changes no wallet, cash payout or escrow')
        result = {'mode': mode, 'assertions': 3,
                  'blocked_seconds': round(time.monotonic()-started, 3),
                  'helper_body_md5': digest, 'transaction': 'ROLLBACK'}
        print(json.dumps(result))
        return result
    finally:
        reader.finish()
        holder.finish()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--composer', type=Path, default=Path(__file__).with_name('build-versioned-final-deal-probe.py'))
    parser.add_argument('--lane-migration', type=Path, help='exact tracked migration in its owning checkout')
    parser.add_argument("--psql", default=shutil.which("psql") or "/opt/homebrew/opt/postgresql@17/bin/psql")
    parser.add_argument("--host", required=True, help="owned local Unix socket directory")
    parser.add_argument("--port", required=True, type=int)
    args = parser.parse_args()
    if not args.host.startswith("/"):
        parser.error("a local Unix socket is required")
    composer = runpy.run_path(str(args.composer))
    lane_path = args.lane_migration or args.root / 'supabase/migrations' / composer['LANE_MIGRATION']
    sql = composer['compose'](args.root, args.root / 'scripts/ci/probes/versioned-final-deal-native.sql', 'paid', lane_path)
    marker = 'CREATE FUNCTION pg_temp.deal_assert('
    assert sql.count(marker) == 1
    setup = sql[:sql.index(marker)]
    command = [args.psql, '-XqAt', '-v', 'ON_ERROR_STOP=1',
               '-h', args.host, '-p', str(args.port), '-U', 'postgres', '-d', 'current_replay']
    helpers = {helper[0]: helper for helper in composer['lane_helpers'](lane_path)}
    run_case(setup, command, helpers['fn_ca_lock_settlement_lane_global'], 'terminal_global')
    run_case(setup, command, helpers['fn_ca_share_settlement_lane_for_table'], 'hand_shared_barrier')


if __name__ == '__main__':
    main()

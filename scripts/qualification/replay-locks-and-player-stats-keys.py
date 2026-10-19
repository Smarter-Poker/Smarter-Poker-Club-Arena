#!/usr/bin/env python3
"""The 04:37 replay freeze and the player_stats deadlocks, reproduced on an isolated
PostgreSQL 17 cluster, before and after 20261019155432.

    PG_BIN=/opt/homebrew/opt/postgresql@17/bin \
    python3 -B scripts/qualification/replay-locks-and-player-stats-keys.py \
        --work <empty dir> [--out result.json]

It builds its OWN cluster inside --work (unix socket in a private directory, no TCP
listener) and reads nothing but PG_BIN from the environment, so it cannot reach a real
database. replay-locks-and-player-stats-keys-live.sql is production's text of every door measured (md5-pinned in
replay-locks-and-player-stats-keys.manifest.json; the run refuses to measure on drift) over replay-locks-and-player-stats-keys-schema.sql (production's
column shapes, and readers for what the doors call that locks nothing measured).

Every case runs BEFORE, on production's bodies, then this runner executes the
migration file itself (its preimage, postimage, metadata and grant assertions), and
every case runs AFTER on the text it installed.
Deadlocks are counted from the cluster log (one 'deadlock detected' per deadlock).
"""
import argparse, hashlib, json, os, pathlib, queue, re, shutil, subprocess, threading, time, uuid

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PG_BIN = os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')
MIGRATION = ROOT / 'supabase/migrations/20261019155432_replay_holds_no_lock_past_its_receipt_player_stats_key_order.sql'
DB, PORT, GATE = 'replay_keys', '55493', 424243


class Cluster:
    def __init__(self, work):
        self.data, self.sock, self.log = work / 'pg' / 'data', work / 'pg' / 's', work / 'pg' / 'postgres.log'

    def tool(self, name):
        return str(pathlib.Path(PG_BIN) / name)

    def start(self):
        env = dict(os.environ, LC_ALL='C', LANG='C')
        self.sock.mkdir(parents=True, exist_ok=True)
        subprocess.run([self.tool('initdb'), '-D', str(self.data), '-U', 'postgres', '-A', 'trust', '--no-locale',
                        '-E', 'UTF8'], check=True, capture_output=True, env=env)
        opts = ('-p %s -k %s -c listen_addresses= -c max_connections=30 -c shared_buffers=32MB '
                '-c log_lock_waits=on -c deadlock_timeout=200ms -c lc_messages=C '
                "-c log_line_prefix='%%m [%%p] '" % (PORT, self.sock))
        subprocess.run([self.tool('pg_ctl'), '-D', str(self.data), '-l', str(self.log), '-w', '-o', opts, 'start'],
                       check=True, capture_output=True, env=env)

    def stop(self):
        subprocess.run([self.tool('pg_ctl'), '-D', str(self.data), '-m', 'fast', '-w', 'stop'], capture_output=True)

    def psql(self, database, *args):
        r = subprocess.run([self.tool('psql'), '-X', '-q', '-At', '-U', 'postgres', '-h', str(self.sock), '-p', PORT,
                            '-d', database, '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off', *args],
                           capture_output=True, text=True, timeout=300)
        if r.returncode:
            raise RuntimeError(r.stderr[-3000:] + r.stdout[-1000:])
        return r.stdout.strip()

    def q(self, sql):
        return self.psql(DB, '-c', sql)

    def deadlocks_since(self, offset):
        with open(self.log, 'rb') as f:
            f.seek(offset)
            return f.read().decode('utf8', 'replace').count('ERROR:  deadlock detected')

    def log_size(self):
        return self.log.stat().st_size


class Session:
    """One psql backend fed statement by statement; each statement ends in an echoed tag."""

    def __init__(self, cl, name):
        self.name, self.n, self.lines = name, 0, queue.Queue()
        self.p = subprocess.Popen([cl.tool('psql'), '-X', '-q', '-At', '-U', 'postgres', '-h', str(cl.sock), '-p', PORT,
                                   '-d', DB, '-v', 'ON_ERROR_STOP=0', '-P', 'pager=off'],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                  bufsize=1)
        threading.Thread(target=self._read, daemon=True).start()
        self.pid = int(self.run("SET statement_timeout = '60s'; SELECT pg_backend_pid();").splitlines()[-1])

    def _read(self):
        for line in self.p.stdout:
            self.lines.put(line.rstrip('\n'))

    def send(self, sql):
        self.n += 1
        tag = '__END_%s_%d__' % (self.name, self.n)
        self.p.stdin.write(sql.rstrip() + '\n\\echo ' + tag + '\n')
        self.p.stdin.flush()
        return tag, time.time()

    def wait(self, sent, timeout=60):
        tag, t0 = sent
        out, end = [], time.time() + timeout
        while True:
            try:
                line = self.lines.get(timeout=max(0.05, end - time.time()))
            except queue.Empty:
                raise RuntimeError('%s: no answer in %ss (%s)' % (self.name, timeout, out[-3:]))
            if line == tag:
                return '\n'.join(out), round(time.time() - t0, 3)
            out.append(line)

    def run(self, sql, timeout=60):
        return self.wait(self.send(sql), timeout)[0]

    def close(self):
        try:
            self.p.stdin.write('\\q\n')
            self.p.stdin.flush()
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


def waiting_for(cl, pid, timeout=5.0):
    """The pids pid waits for, once it waits (empty if it never does within timeout)."""
    end = time.time() + timeout
    while time.time() < end:
        b = cl.q('SELECT pg_blocking_pids(%d);' % pid).strip('{}')
        if b:
            return sorted(int(x) for x in b.split(','))
        time.sleep(0.05)
    return []


def u(run, *names):
    return {n: str(uuid.uuid5(uuid.NAMESPACE_URL, 'replay-keys/%s/%s' % (run, n))) for n in names}


def ordered(run, label):
    a, b = sorted(str(uuid.uuid5(uuid.NAMESPACE_URL, 'replay-keys/%s/%s/%d' % (run, label, i))) for i in range(2))
    return a, b


# ------------------------------------------------------------------------------------------ A
def case_replay(cl, state):
    I = u(state, 'club', 'clubX', 'S1', 'S2', 'T1', 'M1', 'M2', 'X', 'TB1', 'p1', 'p2', 'p3')
    cl.q("""
      DELETE FROM tournaments; DELETE FROM tournament_players; DELETE FROM tournament_satellite_settlements;
      DELETE FROM financial_alerts; DELETE FROM harness_pause; DELETE FROM tables;
      INSERT INTO clubs(id) VALUES ('%(club)s'),('%(clubX)s') ON CONFLICT DO NOTHING;
      INSERT INTO tournaments(id,club_id,status,tournament_type,variant,ended_at,satellite_target_id) VALUES
        ('%(S1)s','%(club)s','COMPLETED','SATELLITE','satellite',now()-interval '2 hours','%(T1)s'),
        ('%(S2)s','%(club)s','COMPLETED','SATELLITE','satellite',now()-interval '3 hours',NULL),
        ('%(T1)s','%(club)s','RUNNING','MTT','holdem',NULL,NULL),
        ('%(M1)s','%(club)s','COMPLETED','MTT','holdem',now()-interval '1 hour',NULL),
        ('%(M2)s','%(club)s','COMPLETED','MTT','holdem',now()-interval '4 hours',NULL),
        ('%(X)s','%(clubX)s','RUNNING','MTT','holdem',NULL,NULL);
      INSERT INTO tournament_satellite_settlements(tournament_id,target_id,qualifier_ids) VALUES ('%(S1)s','%(T1)s',ARRAY['%(p1)s'::uuid]);
      INSERT INTO tournament_players(tournament_id,user_id,status,position,chips) VALUES
        ('%(S1)s','%(p1)s','winner',1,0),('%(T1)s','%(p1)s','playing',NULL,1000),('%(T1)s','%(p2)s','playing',NULL,1000),
        ('%(M1)s','%(p3)s','winner',1,0),('%(M2)s','%(p3)s','winner',1,0);
      INSERT INTO tables(id,club_id,tournament_id) VALUES ('%(TB1)s','%(club)s','%(T1)s');
      INSERT INTO harness_pause(id) VALUES ('%(M1)s');""" % I)
    ctl, R, E, F = (Session(cl, n) for n in ('ctl', 'replay', 'engine', 'finish'))
    try:
        ctl.run('SELECT pg_advisory_lock(%d);' % GATE)
        rs = R.send('SELECT public.fn_ca_replay_terminal_receipts(26, 4000);')
        assert waiting_for(cl, R.pid) == [ctl.pid], 'the replay did not reach the paused receipt'
        held = cl.q("SELECT count(*) FROM pg_locks WHERE pid=%d AND granted AND locktype='advisory'" % R.pid)
        # The engine: a hand on a table of the running target tournament T1 (its live lane door,
        # then its seat rows), and an unrelated tournament's finish (its live lane door).
        es = E.send("BEGIN; SET LOCAL lock_timeout='20s'; SELECT public.fn_ca_share_settlement_lane_for_table('%(TB1)s');"
                    " UPDATE tournament_players SET chips=chips+1 WHERE tournament_id='%(T1)s';"
                    " SELECT round(extract(epoch FROM clock_timestamp()-now())::numeric,3); COMMIT;" % I)
        fs = F.send("BEGIN; SET LOCAL lock_timeout='20s'; SELECT public.fn_ca_lock_settlement_lane_for_finish('%(X)s');"
                    " SELECT round(extract(epoch FROM clock_timestamp()-now())::numeric,3); COMMIT;" % I)
        e_wait, f_wait = waiting_for(cl, E.pid, 1.5), waiting_for(cl, F.pid, 1.5)
        time.sleep(0.5)
        ctl.run('SELECT pg_advisory_unlock(%d);' % GATE)
        out, replay_s = R.wait(rs)
        e_out, _ = E.wait(es)
        f_out, _ = F.wait(fs)
        e_s, f_s = (float(re.findall(r'^\d+\.\d+$', o, re.M)[-1]) for o in (e_out, f_out))
        res = json.loads(out.splitlines()[-1])
        res.pop('checked_at', None)
        named = json.dumps(res)          # the same tournaments by name, so both runs compare
        for k, v in I.items():
            named = named.replace(v, k)
        res = json.loads(named)
        alerts = cl.q("SELECT coalesce(json_agg(json_build_object('refusal',context->>'refusal','count',context->>'count') ORDER BY id),'[]') FROM financial_alerts")
        seats = cl.q("SELECT sum(chips) FROM tournament_players WHERE tournament_id='%(T1)s'" % I)
        return {'case': 'replay-vs-live-target', 'state': state,
                'replay_advisory_locks_held_while_paused': int(held),
                'engine_hand_waited_for': ['replay' if p == R.pid else p for p in e_wait],
                'unrelated_finish_waited_for': ['replay' if p == R.pid else p for p in f_wait],
                'engine_hand_seconds': e_s, 'unrelated_finish_seconds': f_s,
                'engine_errors': [l for l in (e_out + '\n' + f_out).splitlines() if 'ERROR' in l],
                'target_seat_chips_after': seats, 'replay': res, 'alerts': json.loads(alerts)}
    finally:
        for s in (ctl, R, E, F):
            s.close()


# ------------------------------------------------------------------------------------------ B
def seed_hands(cl, run, club, users_by_hand, ps_rows):
    """rake records for hands in page order; returns their rake record ids."""
    rr = []
    for i, uid in enumerate(users_by_hand):
        hand, rec = str(uuid.uuid5(uuid.NAMESPACE_URL, '%s/hand/%d' % (run, i))), str(uuid.uuid5(uuid.NAMESPACE_URL, '%s/rr/%d' % (run, i)))
        cl.q("INSERT INTO rake_records(id,hand_id,club_id,rake_amount,metadata) VALUES ('%s','%s','%s',1.00,'{}');"
             "INSERT INTO rake_attributions(hand_id,player_id,rake_amount,rake_record_id,club_id,weighted_rake_credit)"
             " VALUES ('%s','%s',1.00,'%s','%s',1.00);" % (rec, hand, club, hand, uid, rec, club))
        rr.append((rec, hand))
    for (uid, c) in ps_rows:
        cl.q("INSERT INTO player_stats(user_id,club_id,hands_played,hands_dealt) VALUES ('%s','%s',5,5);" % (uid, c))
    return rr


def seed_projection(cl, run, club, players):
    hand, table = str(uuid.uuid5(uuid.NAMESPACE_URL, '%s/proj-hand' % run)), str(uuid.uuid5(uuid.NAMESPACE_URL, '%s/proj-table' % run))
    pl = json.dumps([{'userId': p, 'stack': 100} for p in players])
    cl.q("INSERT INTO tables(id,club_id) VALUES ('%s','%s');"
         "INSERT INTO hand_history(id,table_id,hand_number,players,winners,actions,big_blind,rake_amount,pot_size)"
         " VALUES ('%s','%s',1,'%s','[]','[]',2,0,4);"
         "INSERT INTO hand_projection_outbox(hand_id,table_id,hand_number) VALUES ('%s','%s',1);"
         % (table, club, hand, table, pl, hand, table))
    return hand


def reset_b(cl):
    cl.q("TRUNCATE player_stats, rake_records, rake_attributions, rakeback_stats_applied, accounting_cash_source_work,"
         " accounting_cash_source_receipts, accounting_cash_accrual_batches, accounting_cash_rake_sources,"
         " accounting_period_recompute_requests, hand_history, hand_projection_outbox, club_member_daily_stats,"
         " club_member_table_state, club_hand_daily_shard, ca_hand_player_idx, harness_pause;"
         " DELETE FROM tables; DELETE FROM profiles;")


def case_batch_vs_projection(cl, state, label, rows, proj_club_other):
    """The batch's items are the hand of b then the hand of a; it is paused after b's row,
    and the projection of a hand with a and b runs then."""
    run = '%s/%s' % (label, state)
    reset_b(cl)
    club, club2 = str(uuid.uuid5(uuid.NAMESPACE_URL, run + '/club')), str(uuid.uuid5(uuid.NAMESPACE_URL, run + '/club2'))
    a, b = ordered(run, 'users')
    cl.q("INSERT INTO clubs(id) VALUES ('%s'),('%s') ON CONFLICT DO NOTHING;"
         "INSERT INTO profiles(id) VALUES ('%s'),('%s');" % (club, club2, a, b))
    ps_rows = [(a, club), (b, club)] if rows == 'existing' else []
    rr = seed_hands(cl, run, club, [b, a], ps_rows)
    hand = seed_projection(cl, run, club2 if proj_club_other else club, [a, b])
    cl.q("INSERT INTO harness_pause(id) VALUES ('%s');" % rr[1][1])     # pause before a's row
    items = json.dumps([{'source_type': 'cash_rake_record', 'source_id': r} for r, _ in rr])
    ctl, B, P = Session(cl, 'ctl'), Session(cl, 'batch'), Session(cl, 'projection')
    off = cl.log_size()
    try:
        ctl.run('SELECT pg_advisory_lock(%d);' % GATE)
        bs = B.send("SELECT public.fn_credit_agent_commissions_batch('%s'::jsonb);" % items)
        assert waiting_for(cl, B.pid) == [ctl.pid], 'the batch did not reach its pause'
        ps = P.send("SELECT public.fn_project_hand_side_effects_after_post_commit_20260908('%s');" % hand)
        p_wait = waiting_for(cl, P.pid, 2.0)
        ctl.run('SELECT pg_advisory_unlock(%d);' % GATE)
        b_out, _ = B.wait(bs)
        p_out, _ = P.wait(ps)
        time.sleep(0.3)
        res = json.loads([l for l in b_out.splitlines() if l.startswith('{')][-1])
        stats = json.loads(cl.q("SELECT coalesce(json_object_agg(CASE user_id WHEN '%s' THEN 'a' ELSE 'b' END ||"
                                " CASE club_id WHEN '%s' THEN '@club' ELSE '@club2' END,"
                                " json_build_array(hands_played, hands_dealt)),'{}') FROM player_stats" % (a, club)))
        prof = json.loads(cl.q("SELECT json_object_agg(CASE id WHEN '%s' THEN 'a' ELSE 'b' END, total_hands_played)"
                               " FROM profiles" % a))
        return {'case': label, 'state': state, 'deadlocks': cl.deadlocks_since(off),
                'projection_waited_for': ['batch' if p == B.pid else p for p in p_wait],
                'projection': ('ok' if '"ok": true' in p_out else p_out.splitlines()[-1][:200]),
                'batch': {k: res.get(k) for k in ('ok', 'failed', 'blocked', 'first_error', 'deferred')},
                'item_attempts': json.loads(cl.q("SELECT coalesce(json_agg(attempts ORDER BY rake_record_id),'[]') FROM accounting_cash_source_work")),
                'player_stats': stats, 'profile_total_hands': prof}
    finally:
        for s in (ctl, B, P):
            s.close()


def case_batch_defers_for_a_held_key(cl, state):
    """A projection holds its players' keys longer than the batch waits: the batch defers,
    writes nothing, and is accrued when resubmitted."""
    run = 'defer/%s' % state
    reset_b(cl)
    club = str(uuid.uuid5(uuid.NAMESPACE_URL, run + '/club'))
    a, b = ordered(run, 'users')
    cl.q("INSERT INTO clubs(id) VALUES ('%s') ON CONFLICT DO NOTHING; INSERT INTO profiles(id) VALUES ('%s'),('%s');" % (club, a, b))
    rr = seed_hands(cl, run, club, [b, a], [(a, club), (b, club)])
    hand = seed_projection(cl, run, club, [a, b])
    items = json.dumps([{'source_type': 'cash_rake_record', 'source_id': r} for r, _ in rr])
    B, P = Session(cl, 'batch'), Session(cl, 'projection')
    off = cl.log_size()
    try:
        P.run("BEGIN; SELECT public.fn_project_hand_side_effects_after_post_commit_20260908('%s');" % hand)
        first, secs = B.wait(B.send("SELECT public.fn_credit_agent_commissions_batch('%s'::jsonb);" % items))
        written = cl.q('SELECT count(*) FROM rakeback_stats_applied')
        P.run('COMMIT;')
        second, _ = B.wait(B.send("SELECT public.fn_credit_agent_commissions_batch('%s'::jsonb);" % items))
        pick = lambda o: {k: v for k, v in json.loads([l for l in o.splitlines() if l.startswith('{')][-1]).items()
                          if k in ('ok', 'failed', 'blocked', 'deferred')}
        return {'case': 'batch-defers-for-a-held-player-key', 'state': state, 'deadlocks': cl.deadlocks_since(off),
                'first': pick(first), 'first_seconds': secs, 'rows_written_while_held': int(written),
                'resubmitted': pick(second),
                'hands_played': json.loads(cl.q("SELECT json_agg(hands_played ORDER BY user_id) FROM player_stats"))}
    finally:
        B.close()
        P.close()


B_CASES = [('batch-vs-projection-existing-rows', 'existing', False),
           ('batch-vs-projection-new-rows', 'new', False),
           ('batch-vs-projection-profiles-across-clubs', 'existing', True)]


def run_all(cl, state):
    out = [case_replay(cl, state)]
    for label, rows, other in B_CASES:
        out.append(case_batch_vs_projection(cl, state, label, rows, other))
    if state == 'after':
        out.append(case_batch_defers_for_a_held_key(cl, state))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--work', required=True)
    ap.add_argument('--out')
    args = ap.parse_args()
    work = pathlib.Path(args.work).resolve()
    if work.exists() and any(work.iterdir()):
        raise SystemExit('--work must be empty')
    work.mkdir(parents=True, exist_ok=True)
    cl = Cluster(work)
    cl.start()
    report = {'postgres': None, 'manifest': {}, 'results': []}
    try:
        cl.psql('postgres', '-c', 'CREATE DATABASE %s;' % DB)
        report['postgres'] = cl.q('SHOW server_version;')
        cl.psql(DB, '-f', str(HERE / 'replay-locks-and-player-stats-keys-schema.sql'))
        cl.psql(DB, '-f', str(HERE / 'replay-locks-and-player-stats-keys-live.sql'))
        pins = json.load(open(HERE / 'replay-locks-and-player-stats-keys.manifest.json'))['functions']
        for sig, want in pins.items():
            got = cl.q("SELECT md5(pg_get_functiondef('public.%s'::regprocedure));" % sig)
            if got != want:
                raise SystemExit('%s loaded as %s, production pinned %s: refusing to measure' % (sig, got, want))
            report['manifest'][sig] = got
        report['results'] += run_all(cl, 'before')
        # The whole migration file, exactly as the applier sends it: its BEGIN, the
        # $subs$ block with its preimage/postimage/metadata guards, the restated
        # grants and their assertion, COMMIT.
        report['migration_output'] = cl.psql(DB, '-f', str(MIGRATION))
        report['installed'] = {s: cl.q("SELECT md5(pg_get_functiondef('public.%s'::regprocedure));" % s) for s in (
            'fn_ca_replay_terminal_receipts(integer,integer)', 'fn_credit_agent_commissions_batch(jsonb)',
            'fn_project_hand_side_effects_after_post_commit_20260908(uuid)')}
        report['results'] += run_all(cl, 'after')
    finally:
        cl.stop()
    by = {(r['case'], r['state']): r for r in report['results']}
    rb, ra = by[('replay-vs-live-target', 'before')], by[('replay-vs-live-target', 'after')]
    checks = {
        'replay: before, the engine hand and an unrelated finish wait for the paused replay':
            rb['engine_hand_waited_for'] == ['replay'] and rb['unrelated_finish_waited_for'] == ['replay'],
        'replay: after, neither waits and the paused replay holds no lane key':
            ra['engine_hand_waited_for'] == [] and ra['unrelated_finish_waited_for'] == []
            and ra['replay_advisory_locks_held_while_paused'] == 0,
        'replay: the outcome and the alerts are identical':
            rb['replay'] == ra['replay'] and rb['alerts'] == ra['alerts']
            and ra['replay']['replayed'] == 3 and ra['replay']['refused'] == 1,
        'replay: the engine wrote its hand both times': rb['engine_errors'] == [] == ra['engine_errors']
            and rb['target_seat_chips_after'] == ra['target_seat_chips_after'],
    }
    for label, _, _ in B_CASES:
        b, a = by[(label, 'before')], by[(label, 'after')]
        checks['%s: before deadlocks' % label] = b['deadlocks'] > 0
        checks['%s: after no deadlock, the projection waited for the batch, every value once' % label] = (
            a['deadlocks'] == 0 and a['projection'] == 'ok' and a['projection_waited_for'] == ['batch']
            and a['batch']['ok'] == 2 and a['batch']['failed'] == 0 and a['batch']['deferred'] == []
            and a['item_attempts'] == [1, 1])
    d = by[('batch-defers-for-a-held-player-key', 'after')]
    checks['a held player key defers the batch, writes nothing, and the resubmission accrues'] = (
        d['deadlocks'] == 0 and d['first']['ok'] == 0 and d['first']['failed'] == 0 and len(d['first']['deferred']) == 2
        and d['rows_written_while_held'] == 0 and d['resubmitted']['ok'] == 2 and d['resubmitted']['deferred'] == [])
    report['checks'] = checks
    report['ok'] = all(checks.values())
    print(json.dumps(report['results'], indent=1))
    for k, v in checks.items():
        print('%-6s %s' % ('PASS' if v else 'FAIL', k))
    if args.out:
        pathlib.Path(args.out).write_text(json.dumps(report, indent=2) + '\n')
    shutil.rmtree(work / 'pg', ignore_errors=True)
    raise SystemExit(0 if report['ok'] else 1)


if __name__ == '__main__':
    main()

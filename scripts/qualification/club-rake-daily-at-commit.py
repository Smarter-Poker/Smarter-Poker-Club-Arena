#!/usr/bin/env python3
"""A club's day rake row is taken at commit: proved on an isolated cluster, before and after
20261001005431_a_club_day_rake_row_is_taken_at_commit.

    PG_BIN=/opt/homebrew/opt/postgresql@17/bin \
    python3 scripts/qualification/club-rake-daily-at-commit.py --work <empty dir> [--out result.json]

--work must be a SHORT path: the cluster's unix socket lives under it, and a socket path
longer than about 100 bytes cannot be created.

It builds its OWN PostgreSQL 17 cluster with chip-deadlocks.py's machinery (unix socket in a
private directory, no TCP listener) and loads the same md5-pinned production bodies:
atomic_distribute_rake, the VIP award, fn_ca_club_rake_daily_compute / _apply and the
rake_records triggers over production's column shapes. It adds production's foreign key
rake_attributions.player_id -> profiles(id), the one that waits behind a horse claim.

Two cases, each run BEFORE (the live statement trigger) and AFTER (the migration file itself,
executed whole, pins and all - its rake_records trigger stays as it is; its function now hands
the same ids to an unlogged scratch table whose deferred trigger applies them at COMMIT):

  stalled-hand-holds-its-club  a third session holds one player's profile FOR UPDATE (what
                               fn_ca_horse_claim_due does). Hand 1 of club C names that player
                               and stalls on the rake_attributions foreign key. Hand 2 of the
                               same club, other players, is then dealt its rake. BEFORE, hand 2
                               waits on ca_club_rake_daily behind hand 1. AFTER, hand 2 rakes and
                               commits while hand 1 is still stalled.
  same-rows                    one session: two raked hands through atomic_distribute_rake, one
                               multi-row INSERT of cash rake rows (a union table whose rake is
                               attributed to two member clubs, plus a standalone row), one
                               tournament rake row (excluded), and one raked hand rolled back.
                               Every ca_club_rake_daily value must be identical before and after.
"""
import argparse, importlib.util, json, pathlib, sys, time

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
_spec = importlib.util.spec_from_file_location('chip_deadlocks', HERE / 'chip-deadlocks.py')
cd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cd)
cd.PORT = '55491'  # its own port: never the chip-deadlocks run's
MIGRATION = ROOT / 'supabase/migrations/20261001005431_a_club_day_rake_row_is_taken_at_commit.sql'

DAILY = ("SELECT coalesce(json_agg(json_build_object('club', d.club_id, 'day', d.stat_date, 'hands', d.hands, "
         "'rake', d.rake::text, 'bbj', d.bbj::text, 'pot', d.pot::text, 'source_rows', d.source_rows) "
         "ORDER BY d.club_id, d.stat_date), '[]') FROM public.ca_club_rake_daily d WHERE d.club_id IN (%s);")


def daily(ctl, names):
    rows = json.loads(ctl.run(DAILY % ','.join("'%s'" % v for v in names.values())).splitlines()[-1])
    label = {v: k for k, v in names.items()}
    out = [dict(r, club=label[r['club']]) for r in rows]
    return sorted(out, key=lambda r: (r['club'], r['day']))


def case_stalled_hand(cl, ctl, run):
    I = cd.ids(run, 'S', 'club', 'ta', 'tb', 'p1', 'p2', 'p3', 'p4', 'hand1', 'hand2')
    cd.seed_club(ctl, I['club'], I['ta'])
    ctl.run("INSERT INTO public.tables (id, club_id, name) VALUES ('%s', '%s', 'harness');" % (I['tb'], I['club']))
    cd.seed_profiles(ctl, I['p1'], I['p2'], I['p3'], I['p4'])
    with cd.Case(cl, ctl, run, 'stalled-hand-holds-its-club', 'raked hand x raked hand of one club') as c:
        H, S1, S2 = c.session('claims'), c.session('hand1'), c.session('hand2')
        H.run("BEGIN; SELECT 1 FROM public.profiles WHERE id = '%s' FOR UPDATE;" % I['p1'])
        t1 = S1.send('BEGIN; ' + cd.rake_sql(I['ta'], I['club'], I['hand1'], 11, {I['p1']: 5, I['p2']: 5}))
        c.notes['hand1_stalled_on_the_claim'] = cd.wait_until_waiting(ctl, S1)
        t2 = S2.send('BEGIN; ' + cd.rake_sql(I['tb'], I['club'], I['hand2'], 12, {I['p3']: 5, I['p4']: 5}))
        waited = cd.wait_until_waiting(ctl, S2, timeout=2)
        c.notes['hand2_waited_behind_hand1'] = waited
        if waited:
            # log_lock_waits names the row a waiter is queued on: "while inserting index tuple
            # (...) in relation \"ca_club_rake_daily\"" - the same line production logs.
            time.sleep(0.4)
            log = cl.log_since(c.off)
            mine = [ln for ln in log.splitlines() if '[%d]' % S2.pid in ln]
            idx = [i for i, ln in enumerate(log.splitlines()) if '[%d] LOG:  process %d still waiting' % (S2.pid, S2.pid) in ln]
            ctx = '\n'.join(log.splitlines()[idx[0]:idx[0] + 4]) if idx else ''
            c.notes['hand2_waits_on'] = ('ca_club_rake_daily' if 'relation "ca_club_rake_daily"' in ctx
                                         else (ctx[:300] or 'unknown: %d log lines' % len(mine)))
        else:
            c.notes['hand2_rake'] = cd.outcome(S2.wait(t2))
            tc = time.time()
            S2.run('COMMIT;')
            c.notes['hand2_commit_s'] = round(time.time() - tc, 3)
            c.notes['hand1_still_stalled_at_hand2_commit'] = cd.waiting(ctl, S1.pid)
        H.run('COMMIT;')
        c.notes['hand1'] = cd.outcome(S1.wait(t1)); S1.run('COMMIT;')
        if waited:
            c.notes['hand2_rake'] = cd.outcome(S2.wait(t2)); S2.run('COMMIT;')
        c.notes['daily'] = daily(ctl, {'club': I['club']})
        return c.result()


def case_same_rows(cl, ctl, run):
    I = cd.ids(run, 'V', 'solo', 'ts', 'ua', 'ub', 'union', 'tu', 'pa', 'pb', 'pc', 'h1', 'h2', 'h3', 'tour')
    cd.seed_club(ctl, I['solo'], I['ts'])
    cd.seed_club(ctl, I['ua'])
    cd.seed_club(ctl, I['ub'])
    ctl.run("INSERT INTO public.tables (id, club_id, name, union_id) VALUES ('%s', '%s', 'harness union', '%s');"
            "INSERT INTO public.union_clubs (union_id, club_id) VALUES ('%s', '%s'), ('%s', '%s');"
            "INSERT INTO public.club_members (club_id, user_id) VALUES ('%s', '%s'), ('%s', '%s');"
            % (I['tu'], I['ua'], I['union'], I['union'], I['ua'], I['union'], I['ub'],
               I['ua'], I['pa'], I['ub'], I['pb']))
    cd.seed_profiles(ctl, I['pa'], I['pb'], I['pc'])
    with cd.Case(cl, ctl, run, 'same-rows', 'one session, every insert shape') as c:
        S = c.session('writer')
        c.notes['hand_a'] = cd.outcome(S.run('BEGIN; ' + cd.rake_sql(I['ts'], I['solo'], I['h1'], 21, {I['pa']: 4, I['pc']: 6}) + ' COMMIT;'))
        c.notes['hand_b'] = cd.outcome(S.run('BEGIN; ' + cd.rake_sql(I['ts'], I['solo'], I['h2'], 22, {I['pb']: 3, I['pc']: 3}) + ' COMMIT;'))
        S.run("BEGIN; INSERT INTO public.rake_records (table_id, club_id, rake_amount, bbj_contribution, pot_size, "
              "player_contributions, is_tournament) VALUES "
              "('%(tu)s','%(ua)s',3.00,0.50,60,'{\"%(pa)s\": 10, \"%(pb)s\": 20}'::jsonb,false),"
              "('%(tu)s','%(ua)s',1.25,0,25,'{\"%(pa)s\": 7, \"%(pb)s\": 0}'::jsonb,false),"
              "('%(ts)s','%(solo)s',2.00,0.25,40,'{\"%(pc)s\": 5}'::jsonb,false),"
              "('%(ts)s','%(solo)s',9.00,0,90,NULL,true); COMMIT;" % I)
        S.run('BEGIN; ' + cd.rake_sql(I['ts'], I['solo'], I['h3'], 23, {I['pa']: 5, I['pb']: 5}) + ' ROLLBACK;')
        c.notes['daily'] = daily(ctl, {'solo': I['solo'], 'ua': I['ua'], 'ub': I['ub']})
        return c.result()


CASES = (case_stalled_hand, case_same_rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--work', required=True)
    ap.add_argument('--out')
    a = ap.parse_args()
    work = pathlib.Path(a.work).resolve()
    work.mkdir(parents=True, exist_ok=True)
    cl = cd.Cluster(work)
    cl.start()
    report = {'started': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'results': {}}
    try:
        report['postgres'] = cl.psql('postgres', '-c', 'SELECT version()')
        report['functions_pinned_and_verified'] = cd.build(cl)
        cl.q('ALTER TABLE public.rake_attributions ADD CONSTRAINT rake_attributions_player_id_fkey '
             'FOREIGN KEY (player_id) REFERENCES public.profiles(id) ON DELETE CASCADE')
        for state in ('before', 'after'):
            if state == 'after':
                cl.psql(cd.DB, '-f', str(MIGRATION))
                report['triggers_after'] = cl.q(
                    "SELECT string_agg(pg_get_triggerdef(oid), E'\\n' ORDER BY tgname) FROM pg_trigger "
                    "WHERE tgname IN ('trg_ca_club_rake_daily_ins', 'ca_club_rake_daily_at_commit')")
            ctl = cd.Session(cl, 'ctl')
            for case in CASES:
                r = case(cl, ctl, state)
                report['results'].setdefault(r['case'], {})[state] = r
                print('%-30s %-6s %s' % (r['case'], state, json.dumps({k: v for k, v in r.items() if k not in ('case', 'pair', 'state', 'daily')})), flush=True)
            if state == 'after':
                report['scratch_rows_left_after_every_commit_and_rollback'] = int(
                    cl.q('SELECT count(*) FROM smarter_private.ca_club_rake_daily_at_commit'))
            ctl.close()
    finally:
        cl.stop()
    st = report['results']['stalled-hand-holds-its-club']
    sr = report['results']['same-rows']
    checks = {
        'before: hand 2 waits behind the stalled hand on ca_club_rake_daily':
            st['before']['hand2_waited_behind_hand1'] and st['before'].get('hand2_waits_on') == 'ca_club_rake_daily',
        'after: hand 2 rakes and commits while hand 1 is still stalled':
            (not st['after']['hand2_waited_behind_hand1']) and st['after'].get('hand1_still_stalled_at_hand2_commit') is True
            and st['after'].get('hand2_commit_s', 99) < 1.0,
        'both hands complete, before and after':
            all(st[s][k] == 'completed' for s in ('before', 'after') for k in ('hand1', 'hand2_rake')),
        'stalled case: identical day rows': st['before']['daily'] == st['after']['daily'] and len(st['after']['daily']) == 1,
        'same-rows: identical day rows': sr['before']['daily'] == sr['after']['daily'] and len(sr['after']['daily']) >= 3,
        'after: the scratch table is empty once every transaction has ended':
            report.get('scratch_rows_left_after_every_commit_and_rollback') == 0,
        'after: the rake_records trigger itself is unchanged':
            'REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_ca_club_rake_daily_insert()'
            in report.get('triggers_after', ''),
        'no deadlock anywhere': all(r[s]['deadlocks'] == 0 for r in report['results'].values() for s in ('before', 'after')),
    }
    report['checks'] = checks
    report['finished'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    if a.out:
        pathlib.Path(a.out).write_text(json.dumps(report, indent=2, default=str) + '\n')
    for k, v in checks.items():
        print('%-4s %s' % ('ok' if v else 'FAIL', k))
    ok = all(checks.values())
    print('CLUB RAKE DAILY AT COMMIT: %s' % ('as claimed' if ok else 'NOT AS CLAIMED'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""P14.2 accepted-roster qualification on the maintained PG17 hand-submission owner.

Builds the exact hand-submission catalog test-hand-submission.py builds, brings
the 12-argument settlement door and its stack core forward to their current
installed postimages through the real migration text (captured definitions,
20261006184554's own anchor edits, 20261006154344 unchanged), proves the
existing hand-submission probe on that chain, installs
20261007024757_horse_accepted_roster_at_settlement.sql unchanged, and then
proves the roster cases, the unchanged existing probe, a legacy receipt
accepted before the migration, and installation refusals. Every case runs in
a private socket-only cluster this process creates and removes. No DSN,
credential or production endpoint is accepted. Must run as a non-root user.
"""
import argparse, datetime, hashlib, json, re, signal, sys
from pathlib import Path
sys.dont_write_bytecode = True
from satellite_qualifier_fixture import module, lit, sha

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = Path('supabase/migrations/20261007024757_horse_accepted_roster_at_settlement.sql')
SUBMISSION = Path('supabase/migrations/20260918092329_retained_hand_submission_atomic_acknowledgement.sql')
LIGHTNING = Path('supabase/migrations/20261001154813_lightning_phase_6_settlement_the_hand_settles_onto_its_ancho.sql')
RETIRED_CASH = Path('supabase/migrations/20261006184554_a_retired_cash_hand_keeps_its_original_custody.sql')
RAKED_DIAMOND = Path('supabase/migrations/20261006154344_a_raked_diamond_cash_hand_passes_the_commit_door.sql')
CAPTURE = Path('tests/fixtures/ev-cashout-lifecycle/captured-authorities.json')
FIXTURE = Path('scripts/ci/probes/accepted-hand-roster-fixture.sql')
PROBE = Path('scripts/ci/probes/accepted-hand-roster-native.sql')
EXISTING_PROBE = Path('scripts/ci/probes/hand-submission-native.sql')
DOOR = 'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'
CORE = 'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'
DOOR_PREIMAGE = 'ad4eadeb4df8113db0ba2b598d219aaf'
ROSTER_PASSES = 56
EXISTING_PASSES = 50


def between(text, start, end, include_end=False):
    a = text.index(start)
    b = text.index(end, a)
    return text[a:b + (len(end) if include_end else 0)]


def captured(rows, name, md5):
    row = next(r for r in rows if r['signature'].split('(')[0] == name)
    if hashlib.md5(row['definition'].encode()).hexdigest() != md5:
        raise ValueError('captured definition differs: ' + name)
    sig = row['signature'] if row['signature'].startswith('smarter_private.') else 'public.' + row['signature']
    out = row['definition'].rstrip().rstrip(';') + ';\n'
    out += 'ALTER FUNCTION ' + sig + ' OWNER TO postgres;\n'
    out += 'REVOKE ALL ON FUNCTION ' + sig + ' FROM PUBLIC,anon,authenticated,service_role;\n'
    for item in row['acl'].strip('{}').split(','):
        role = item.split('=')[0]
        if role != 'postgres':
            out += 'GRANT EXECUTE ON FUNCTION ' + sig + ' TO ' + role + ';\n'
    out += ("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=" + lit(sig) + "::regprocedure AND md5(pg_get_functiondef(oid))="
            + lit(md5) + " AND proacl::text=" + lit(row['acl']) + ") THEN RAISE EXCEPTION 'current chain capture differs: %'," + lit(sig) + "; END IF; END $$;\n")
    return out


def current_chain(root):
    """The installed door/core chain after 20260918092329, from repository text only."""
    rows = json.loads((root / CAPTURE).read_text())['functions']
    lightning = (root / LIGHTNING).read_text()
    retired = (root / RETIRED_CASH).read_text()
    sql = 'BEGIN;\n'
    sql += between(lightning, 'CREATE TABLE IF NOT EXISTS public.lightning_settlement_marker', 'COMMENT ON TABLE public.lightning_settlement_marker') + '\n'
    sql += captured(rows, 'fn_lightning_settlement_seats', '14c611d5059a62806e2017f937d64ee4')
    sql += captured(rows, 'fn_poker_diamond_cash_variant', '929c207a922004eb0e764011a2fe386c')
    sql += captured(rows, 'fn_ca_settle_hand_stacks_absolute', '3571d2b9553a9b8832cdd8e72d2ab871')
    sql += captured(rows, 'fn_ca_commit_hand_settlement', 'e9d96bfefffef41bc22b6b6f2d5da452')
    sql += 'COMMIT;\n'
    # 20261006184554 exactly as written: private custody relations, the two
    # helpers its anchors call, then its own core and door anchor edits.
    header = retired[:retired.index('INSERT INTO smarter_private.retired_cash_hand_qualification')]
    sql += header
    sql += between(retired, 'CREATE FUNCTION smarter_private.retired_cash_original_stack', 'DO $patch$')
    patch = between(retired, 'DO $patch$', 'END $patch$;', include_end=True)
    body = patch[patch.index('BEGIN') + len('BEGIN'):patch.index("-- The preceding tournament migration owns its serial resume postimage.")]
    sql += 'DO $patch$\nDECLARE d text;old text;replacement text;\nBEGIN' + body + 'END $patch$;\n'
    sql += ("DO $$ BEGIN IF md5(pg_get_functiondef(" + lit(CORE) + "::regprocedure))<>'7b7b090aa1d6eab13d677fcc5e821e77' "
            "OR md5(pg_get_functiondef(" + lit(DOOR) + "::regprocedure))<>'650b8ff04411a9974ae96ef245645705' THEN "
            "RAISE EXCEPTION 'retired cash chain postimage differs'; END IF; END $$;\nCOMMIT;\n")
    # The raked-Diamond migration expects the cash switch to read false.
    sql += ("INSERT INTO public.ca_arena_settings(id,settlement_window_days,updated_at,cash_games_enabled,tournaments_enabled) "
            "SELECT 1,7,now(),false,true WHERE NOT EXISTS(SELECT 1 FROM public.ca_arena_settings WHERE id=1);\n")
    return sql


def notices(text, tag):
    return [m.group(1) for m in re.finditer(r'NOTICE:\s+' + re.escape(tag) + r':? (.*)$', text, re.M)]


def door_md5(e, db, label):
    _, out, _ = e.sql(db, "SELECT md5(pg_get_functiondef(" + lit(DOOR) + "::regprocedure));", label=label)
    return out.strip()


def existing_probe(e, db, label):
    script = 'BEGIN;\n' + (e.output / 'opening.sql').read_text() + (e.root / EXISTING_PROBE).read_text() + '\nROLLBACK;\n'
    path = e.output / (label + '.sql'); path.write_text(script)
    code, out, err = e.sql(db, file=path, label=label, check=False, seconds=120)
    passes = err.count('HAND SUBMISSION PASS:')
    if code or re.search(r'(ERROR|FATAL|PANIC|WARNING):', err) or out.splitlines().count('HAND_SUBMISSION_NATIVE_PASS') != 1 or passes != EXISTING_PASSES:
        raise RuntimeError(label + ' failed: %d passes' % passes)
    return passes


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--evidence', type=Path, required=True)
    p.add_argument('--pg-bin', type=Path, required=True)
    p.add_argument('--capsules', type=Path, help='also write the captured capsules here')
    args = p.parse_args()
    out = args.evidence.resolve(); out.mkdir(parents=True, exist_ok=False)
    hs = module(ROOT / 'scripts/ci/test-hand-submission.py', 'accepted_roster_hand_submission')
    m = hs.prepare(ROOT, out)
    (out / 'current-chain.sql').write_text(current_chain(ROOT))
    native = module(ROOT / 'scripts/ci/test-mtt-unlimited.py', 'accepted_roster_execution')
    e = native.Execution(ROOT, out, args.pg_bin.resolve(), out, 900)
    inputs = [Path(__file__).relative_to(ROOT), MIGRATION, SUBMISSION, LIGHTNING, RETIRED_CASH, RAKED_DIAMOND, CAPTURE, FIXTURE, PROBE, EXISTING_PROBE]
    e.report['source_sha256'] = {**m['source_sha256'], **{str(f): sha(ROOT / f) for f in inputs}}
    e.report['cases'] = []
    for s in native.CANCELLATION_SIGNALS:
        signal.signal(s, native.interrupted)
    capsules = []
    try:
        e.start(); db = e.database()
        e.sql(db, file=out / 'foundation.sql', label='real-financial-foundation', seconds=240)
        e.sql(db, file=out / 'current-authorities.sql', label='hand-authority-closure')
        e.sql(db, file=ROOT / 'scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql', label='structural-opening')
        e.sql(db, file=ROOT / SUBMISSION, label='retained-submission-owner')
        e.sql(db, file=out / 'current-chain.sql', label='current-door-chain')
        e.sql(db, file=ROOT / RAKED_DIAMOND, label='raked-diamond-door-repin')
        if door_md5(e, db, 'door-preimage') != DOOR_PREIMAGE:
            raise RuntimeError('reconstructed door is not the installed preimage')
        e.report['door_preimage_md5'] = DOOR_PREIMAGE
        e.report['cases'].append({'case': 'existing-probe-on-current-chain', 'passes': existing_probe(e, db, 'existing-probe-before')})
        pre = e.database(db)  # pre-migration template for legacy and refusals

        # Installation refusals leave the catalog exactly as found.
        for label, mutation, error in [
            ('door-drift', 'ALTER FUNCTION ' + DOOR + ' SET statement_timeout TO 0;', 'ACCEPTED_ROSTER_DOOR_PREIMAGE_DRIFT'),
            ('door-acl', 'GRANT EXECUTE ON FUNCTION ' + DOOR + ' TO authenticated;', 'ACCEPTED_ROSTER_DOOR_PREIMAGE_DRIFT'),
        ]:
            child = e.database(pre)
            e.sql(child, mutation, label='mutate-' + label)
            before = e.catalog_snapshot(child, label + '-before'); private = hs.private_snapshot(e, child, label + '-private-before')
            code, _, err = e.sql(child, file=ROOT / MIGRATION, label='refuse-' + label, check=False)
            if code == 0 or error not in err:
                raise RuntimeError('installation drift not refused: ' + label)
            if before != e.catalog_snapshot(child, label + '-after') or private != hs.private_snapshot(e, child, label + '-private-after'):
                raise RuntimeError('refused installation changed the catalog: ' + label)
            e.report['cases'].append({'case': 'install-refused-' + label, 'catalog_unchanged': True})
            e.discard(child)

        # A receipt accepted before the migration replays as legacy_missing.
        legacy = e.database(pre)
        script = ('BEGIN;\n' + (out / 'opening.sql').read_text() + (ROOT / FIXTURE).read_text()
                  + "\nDO $$DECLARE r jsonb; BEGIN r:=pg_temp.roster_commit(8800007,'88400000-0000-0000-0000-000000000007');"
                  " IF r->>'success' IS DISTINCT FROM 'true' OR r ? 'accepted_roster' THEN RAISE EXCEPTION 'legacy door outcome %',r; END IF;"
                  " RAISE NOTICE 'ROSTER LEGACY FIRST: %',r; END $$;\nCOMMIT;\n"
                  + '\\i ' + str(ROOT / MIGRATION) + '\n'
                  + "BEGIN;\nDO $$DECLARE r jsonb; a public.hand_atomic_commits; BEGIN"
                  " SELECT * INTO a FROM public.hand_atomic_commits WHERE hand_number=8800007;"
                  " r:=pg_temp.roster_commit(8800007,'88400000-0000-0000-0000-000000000007');"
                  " IF r->>'success' IS DISTINCT FROM 'true' OR r->>'replay' IS DISTINCT FROM 'true'"
                  " OR r->'accepted_roster' IS DISTINCT FROM jsonb_build_object('version',1,'status','legacy_missing',"
                  "'reasons',jsonb_build_array('accepted_roster_not_recorded'),'payloadDigest',a.post_commit_payload_hash,"
                  "'producerVersion','accepted_hand_roster_v1','roster',NULL)"
                  " OR EXISTS(SELECT 1 FROM smarter_private.accepted_hand_rosters) THEN RAISE EXCEPTION 'legacy replay outcome %',r; END IF;"
                  " RAISE NOTICE 'ROSTER LEGACY REPLAY: %',r; END $$;\nROLLBACK;\n")
        path = out / 'legacy.sql'; path.write_text(script)
        code, _, err = e.sql(legacy, file=path, label='legacy-receipt', check=False, seconds=120)
        if code or 'ROSTER LEGACY REPLAY' not in err:
            raise RuntimeError('legacy receipt case failed')
        capsules.append({'case': 'legacy_receipt_replay', 'result': json.loads(notices(err, 'ROSTER LEGACY REPLAY')[0])})
        code, _, err = e.sql(legacy, file=ROOT / MIGRATION, label='install-replay-refused', check=False)
        if code == 0 or 'ACCEPTED_ROSTER_ALREADY_INSTALLED' not in err:
            raise RuntimeError('a second installation was not refused')
        e.report['cases'] += [{'case': 'legacy-receipt-replays-legacy-missing', 'passed': True},
                              {'case': 'second-install-refused', 'passed': True}]
        e.discard(legacy)

        # Install the migration unchanged and prove the roster cases.
        e.sql(db, file=ROOT / MIGRATION, label='accepted-roster-install')
        post = door_md5(e, db, 'door-postimage')
        e.report['door_postimage_md5'] = post
        before = e.snapshot(db, 'before-data'); catalog = e.catalog_snapshot(db, 'before-catalog'); private = hs.private_snapshot(e, db, 'before-private')
        script = 'BEGIN;\n' + (out / 'opening.sql').read_text() + (ROOT / FIXTURE).read_text() + (ROOT / PROBE).read_text() + '\nROLLBACK;\n'
        path = out / 'roster-probe.sql'; path.write_text(script)
        code, stdout, stderr = e.sql(db, file=path, label='accepted-roster-cases', check=False, seconds=180)
        (out / 'roster-notices.log').write_text(stderr)
        passes = stderr.count('ROSTER PASS:')
        e.report['roster_assertions'] = passes
        if code or re.search(r'(ERROR|FATAL|PANIC|WARNING):', stderr) or stdout.splitlines().count('ACCEPTED_ROSTER_NATIVE_PASS') != 1:
            raise RuntimeError('accepted roster cases failed; see roster-notices.log')
        if passes != ROSTER_PASSES:
            raise RuntimeError('roster assertion count differs: %d' % passes)
        capsules = [json.loads(x) for x in notices(stderr, 'ROSTER CAPSULE')] + capsules
        if before != e.snapshot(db, 'after-data') or catalog != e.catalog_snapshot(db, 'after-catalog') or private != hs.private_snapshot(e, db, 'after-private'):
            raise RuntimeError('roster cases did not roll back completely')
        e.report['cases'].append({'case': 'existing-probe-after-migration', 'passes': existing_probe(e, db, 'existing-probe-after')})
        for path, digest in e.report['source_sha256'].items():
            if sha(ROOT / path) != digest:
                raise RuntimeError('source changed during qualification: ' + path)
        e.report['status'] = 'passed'; e.discard(pre); e.discard(db)
    except BaseException as exc:
        e.report['failure'] = repr(exc)
    finally:
        for s in native.CANCELLATION_SIGNALS:
            signal.signal(s, signal.SIG_IGN)
        try:
            e.close()
        except BaseException as exc:
            e.report.update(cleanup_failure=repr(exc), status='failed')
        e.report['ended_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        dump = {'producer': 'scripts/ci/test-accepted-hand-roster.py', 'migration': str(MIGRATION),
                'door_preimage_md5': e.report.get('door_preimage_md5'), 'door_postimage_md5': e.report.get('door_postimage_md5'),
                'synthetic_fixture': True, 'capsules': capsules}
        (out / 'capsules.json').write_text(json.dumps(dump, indent=2) + '\n')
        if args.capsules and e.report['status'] == 'passed':
            args.capsules.write_text(json.dumps(dump, indent=2) + '\n')
        (out / 'result.json').write_text(json.dumps(e.report, indent=2) + '\n')
        print(json.dumps({k: e.report.get(k) for k in ['status', 'failure', 'roster_assertions', 'door_postimage_md5', 'cleanup']}), flush=True)
    return 0 if e.report['status'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())

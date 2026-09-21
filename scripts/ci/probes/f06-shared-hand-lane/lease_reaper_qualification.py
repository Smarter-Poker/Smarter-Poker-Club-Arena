"""The existing lease reaper retains unresolved F06 authority, in real PostgreSQL."""
from contextlib import contextmanager
import hashlib
import json
import subprocess
import time


def qualify(root, out, cmd, command, run, probe, require, results):
    here = root / 'scripts/ci/probes/f06-shared-hand-lane'
    migration = root / 'supabase/migrations/20260919024039_unresolved_f06_custody_retains_its_lease_evidence.sql'
    captured = json.loads((here / 'lease-reaper-preimage.json').read_text())
    results['leaseReaperInputs'] = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in (migration, here / 'lease-reaper-preimage.json', here / 'lease_reaper_qualification.py',
                  root / 'scripts/ci/test-f06-shared-hand-lane.py')}
    run('lease-reaper-original-function', captured['definition'] +
        ';REVOKE ALL ON FUNCTION reap_dead_engine_leases(integer) FROM PUBLIC,anon,authenticated;'
        'GRANT EXECUTE ON FUNCTION reap_dead_engine_leases(integer) TO service_role;')
    run('lease-reaper-original-pin', "SELECT md5(pg_get_functiondef('reap_dead_engine_leases(integer)'::regprocedure));", captured['definition_md5'])
    run('lease-reaper-controls-schema', """
      CREATE TABLE IF NOT EXISTS engine_table_leases(table_id uuid PRIMARY KEY,instance_id text,
       heartbeat_at timestamptz,lease_generation uuid,protocol_version integer);
      CREATE FUNCTION fixture_seed_lease_reaper(i integer,kind text) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE t uuid:=md5('lr-event'||i)::uuid; tab uuid:=md5('lr-table'||i)::uuid;
       dest uuid:=md5('lr-dest'||i)::uuid; g uuid:=md5('lr-generation'||i)::uuid; b uuid:=md5('lr-break'||i)::uuid;
      BEGIN
       INSERT INTO tournaments(id,status,format_contract) VALUES(t,'RUNNING','mtt-v1');
       INSERT INTO tables(id,tournament_id,status) VALUES(tab,t,'running'),(dest,t,'running');
       INSERT INTO engine_tournament_leases(tournament_id,instance_id,engine_version,acquired_at,heartbeat_at,lease_generation,protocol_version)
        VALUES(t,'lr-process','lr-source',now()-interval '3 hours',now()-interval '2 hours',g,2);
       INSERT INTO engine_table_leases(table_id,instance_id,heartbeat_at,lease_generation,protocol_version)
        VALUES(tab,'lr-process',now()-interval '2 hours',g,2),(dest,'lr-process',now()-interval '2 hours',g,2);
       IF kind IN('reserved','accepted','never_started','aborted_unsettled') THEN
        INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state)
         SELECT md5('lr-permit'||i)::uuid,t,tab,f06_lifecycle,1,md5('lr-custody'||i)::uuid,g,kind FROM tables WHERE id=tab;
       ELSIF kind IN('park_requested','begun','close_confirmed','acknowledged') THEN
        INSERT INTO smarter_private.f06_operations(break_id,tournament_id,source_table_id,lifecycle,boundary_id,origin_generation,state,close_receipt)
         SELECT b,t,tab,f06_lifecycle,md5('lr-boundary'||i)::uuid,g,kind,
          CASE WHEN kind IN('close_confirmed','acknowledged') THEN '{}'::jsonb ELSE NULL END FROM tables WHERE id=tab;
       END IF;
      END $$;
    """)
    run('lease-reaper-original-retained-hands', "SELECT fixture_seed_lease_reaper(2001,'reserved');")
    presence = lambda i: (f"SELECT EXISTS(SELECT 1 FROM engine_tournament_leases WHERE tournament_id=md5('lr-event{i}')::uuid)::text||'|'||"
                         f"EXISTS(SELECT 1 FROM engine_table_leases WHERE table_id=md5('lr-table{i}')::uuid)::text;")
    # Reproduce the defect with the exact installed predecessor; rollback keeps
    # the original synthetic witnesses for the corrected operation below.
    before_failure = probe('lease-reaper-before-deletes-original', 'SELECT * FROM reap_dead_engine_leases(3600);' + presence(2001))
    require(before_failure.endswith('false|false'),
            'Old reaper did not reproduce original lease destruction')
    for name, sql in [('acl','GRANT EXECUTE ON FUNCTION reap_dead_engine_leases(integer) TO authenticated;'),
                      ('body',"CREATE OR REPLACE FUNCTION reap_dead_engine_leases(p_stale_seconds integer DEFAULT 3600) RETURNS TABLE(table_leases_deleted integer,tournament_leases_deleted integer) LANGUAGE sql AS 'SELECT 0,0';")]:
        run('lease-reaper-refuses-' + name, 'BEGIN;' + sql + migration.read_text(), error='F06_LEASE_RETENTION_PREIMAGE_CHANGED')
    money = "SELECT jsonb_build_object(" + ','.join(
        "'%s',(SELECT jsonb_agg(to_jsonb(x)||jsonb_build_object('row_xmin',xmin::text) ORDER BY %s) FROM %s x)" % (name, key, relation)
        for name, key, relation in [('seats','id','table_seats'),('players','id','tournament_players'),
          ('operations','break_id','smarter_private.f06_operations'),('permits','permit_id','smarter_private.f06_hand_permits'),
          ('settlements','id','ca_settlements')]) + ');'
    untouched = run('lease-reaper-owned-state-before', money)
    run('lease-reaper-install', migration.read_text())
    run('lease-reaper-retains-original', 'SELECT * FROM reap_dead_engine_leases(3600);' + presence(2001))
    run('lease-reaper-positive-original-present', presence(2001), 'true|true')
    require(run('lease-reaper-owned-state-after', money) == untouched, 'Housekeeping changed hand/move/player/financial state')
    for i, kind, expected in [(2002,'park_requested','true|true'),(2003,'begun','true|true'),
                             (2004,'close_confirmed','true|true'),(2005,'acknowledged','false|false'),
                             (2006,'accepted','false|false'),(2007,'never_started','false|false'),
                             (2008,'aborted_unsettled','false|false'),(2009,'none','false|false')]:
        run('lease-reaper-seed-' + kind, f"SELECT fixture_seed_lease_reaper({i},'{kind}');")
        run('lease-reaper-call-' + kind, 'SELECT * FROM reap_dead_engine_leases(3600);')
        run('lease-reaper-result-' + kind, presence(i), expected)
    run('lease-reaper-fresh-control', "SELECT fixture_seed_lease_reaper(2010,'none');UPDATE engine_tournament_leases SET heartbeat_at=now() WHERE tournament_id=md5('lr-event2010')::uuid;UPDATE engine_table_leases SET heartbeat_at=now() WHERE table_id IN(md5('lr-table2010')::uuid,md5('lr-dest2010')::uuid);")
    run('lease-reaper-fresh-call', 'SELECT * FROM reap_dead_engine_leases(3600);')
    run('lease-reaper-fresh-kept', presence(2010), 'true|true')
    probe('lease-reaper-age-floor', 'SELECT * FROM reap_dead_engine_leases(599);', error='refuses a cutoff under 600s')
    probe('lease-reaper-null-floor', 'SELECT * FROM reap_dead_engine_leases(NULL);', error='refuses a cutoff under 600s')
    for role in ['anon','authenticated']:
        probe('lease-reaper-' + role + '-refused', f'SET ROLE {role};SELECT * FROM reap_dead_engine_leases(3600);', error='42501')
    probe('lease-reaper-private-helper-refused', "SET ROLE service_role;SELECT smarter_private.f06_lease_has_pending_custody(NULL,NULL);", error='42501')
    probe('lease-reaper-service-owner-kept', 'SET ROLE service_role;SELECT * FROM reap_dead_engine_leases(3600);')

    @contextmanager
    def held(sql, finish='ROLLBACK'):
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            p.stdin.write('BEGIN;' + sql + 'SELECT pg_advisory_lock(19024039);\n'); p.stdin.flush()
            until = time.monotonic() + 5
            while command(cmd, "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=19024039 AND granted);").stdout.strip() != 't':
                require(p.poll() is None and time.monotonic() < until, 'Lease-reaper holder barrier unavailable')
                time.sleep(.01)
            yield
        finally:
            if p.poll() is None:
                p.stdin.write(finish + ';\n'); p.stdin.close(); p.wait(timeout=5)
            require(p.returncode == 0, p.stderr.read())

    run('lease-reaper-concurrent-seed', "SELECT fixture_seed_lease_reaper(2011,'none');")
    admission = "SELECT 1 FROM engine_tournament_leases WHERE tournament_id=md5('lr-event2011')::uuid FOR KEY SHARE;"
    reservation = "INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state) SELECT md5('lr-permit2011')::uuid,tournament_id,id,f06_lifecycle,1,md5('lr-custody2011')::uuid,md5('lr-generation2011')::uuid,'reserved' FROM tables WHERE id=md5('lr-table2011')::uuid;"
    with held(admission + reservation, finish='COMMIT'):
        probe('lease-reaper-admitted-hand-does-not-wait-or-delete', "SET LOCAL statement_timeout='1s';SELECT * FROM reap_dead_engine_leases(3600);" + presence(2011))
        run('lease-reaper-concurrent-original-still-present', presence(2011), 'true|true')
    run('lease-reaper-after-admission-commit', 'SELECT * FROM reap_dead_engine_leases(3600);' + presence(2011))
    run('lease-reaper-committed-original-kept', presence(2011), 'true|true')

    # Projection of the independent immutable transfer/completion contract. All
    # production columns consumed by the reaper are represented with exact types.
    run('lease-reaper-transfer-schema', 'CREATE TABLE smarter_private.f06_manager_custody_transfers(transfer_id uuid PRIMARY KEY,tournament_id uuid,origin_generation uuid,successor_generation uuid,local_proof jsonb,canonical_proof jsonb);')
    run('lease-reaper-transfer-seed', "SELECT fixture_seed_lease_reaper(2012,'none');INSERT INTO smarter_private.f06_manager_custody_transfers VALUES(md5('lr-transfer2012')::uuid,md5('lr-event2012')::uuid,md5('lr-generation2012')::uuid,md5('lr-successor2012')::uuid,jsonb_build_object('engines',jsonb_build_array(jsonb_build_object('table_id',md5('lr-table2012')::uuid))),'{}');")
    run('lease-reaper-partial-transfer-schema-call', 'SELECT * FROM reap_dead_engine_leases(3600);')
    run('lease-reaper-partial-transfer-schema-kept', presence(2012), 'true|true')
    run('lease-reaper-completion-schema', 'CREATE TABLE smarter_private.f06_manager_custody_completions(transfer_id uuid PRIMARY KEY,tournament_id uuid,generation uuid,admission jsonb,operation_receipts jsonb,presence_receipts jsonb);')
    run('lease-reaper-uncompleted-transfer-call', 'SELECT * FROM reap_dead_engine_leases(3600);')
    run('lease-reaper-uncompleted-transfer-kept', presence(2012), 'true|true')
    run('lease-reaper-completion', "INSERT INTO smarter_private.f06_manager_custody_completions VALUES(md5('lr-transfer2012')::uuid,md5('lr-event2012')::uuid,md5('lr-successor2012')::uuid,'{}','[]','[]');")
    run('lease-reaper-completed-transfer-call', 'SELECT * FROM reap_dead_engine_leases(3600);')
    run('lease-reaper-completed-transfer-collected', presence(2012), 'false|false')
    # These two minimal schema projections belong only to this qualifier.
    # Remove them after proof so the next owning custody qualifier installs its
    # complete real schema; no production table is created or removed here.
    run('lease-reaper-release-fixture-projections', 'DROP TABLE smarter_private.f06_manager_custody_completions;DROP TABLE smarter_private.f06_manager_custody_transfers;')
    results['leaseReaper'] = {'passed': True, 'beforeReproducedLeaseDeletion': True,
        'nativeConcurrency': True, 'unrelatedStaleLeasesCollected': True,
        'newBackgroundMechanisms': 0, 'scope': 'existing reaper only; no missing lease reconstruction'}

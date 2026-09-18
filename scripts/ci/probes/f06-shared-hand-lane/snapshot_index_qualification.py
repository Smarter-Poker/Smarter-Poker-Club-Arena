"""Finite physical access-path proof in the existing isolated F06 native owner."""
import hashlib
import json

MIGRATION = 'supabase/migrations/20260918130650_hand_snapshot_table_and_hand_access_path.sql'
ONLINE = 'scripts/ci/probes/f06-shared-hand-lane/snapshot-index/build-online.sql'
INDEX = 'idx_hand_state_snapshots_table_hand'


def qualify(root, out, cmd, command, run, probe, require, results):
    original_database = cmd[-1]
    source = root / MIGRATION
    online = root / ONLINE
    paths = [source, online, root / 'scripts/ci/probes/f06-shared-hand-lane/snapshot_index_qualification.py',
             root / 'scripts/ci/test-f06-shared-hand-lane.py']
    results['snapshotIndexInputs'] = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    run('snapshot-index-database', 'CREATE DATABASE f06_snapshot_index;')
    cmd[-1] = 'f06_snapshot_index'
    try:
        # Only physical columns touched by the production access paths; no
        # replacement financial function or game authority is installed.
        run('snapshot-index-original-physical-fixture', """
          CREATE TABLE public.hand_state_snapshots(id uuid PRIMARY KEY,table_id uuid NOT NULL,
            hand_number integer NOT NULL,is_complete boolean NOT NULL,created_at timestamptz NOT NULL,
            state_json jsonb NOT NULL);
          CREATE UNIQUE INDEX idx_hand_snapshots_one_active_per_table ON public.hand_state_snapshots(table_id) WHERE NOT is_complete;
          CREATE INDEX idx_hand_state_snapshots_created_at ON public.hand_state_snapshots(created_at DESC);
          INSERT INTO public.hand_state_snapshots
            SELECT md5('snapshot'||i)::uuid,md5('table'||i)::uuid,i,true,now(),jsonb_build_object('padding',repeat('s',600))
            FROM generate_series(1,12000) i;
          INSERT INTO public.hand_state_snapshots VALUES
            (md5('target-first')::uuid,md5('target-table')::uuid,12636137,true,now(),'{"stage":"preflop"}'),
            (md5('target-duplicate')::uuid,md5('target-table')::uuid,12636137,true,now(),'{"stage":"preflop"}'),
            (md5('target-later')::uuid,md5('target-table')::uuid,12636138,true,now(),'{"stage":"preflop"}');
          ANALYZE public.hand_state_snapshots;
        """)
        preservation = "SELECT md5(string_agg(to_jsonb(s)::text,',' ORDER BY id)) FROM public.hand_state_snapshots s;"
        before = run('snapshot-index-original-rows', preservation)
        predicate = "table_id=md5('target-table')::uuid AND hand_number"
        queries = {
            'completed-equality': 'SELECT id FROM public.hand_state_snapshots WHERE ' + predicate + '=12636137 AND is_complete',
            'later-absence': 'SELECT id FROM public.hand_state_snapshots WHERE ' + predicate + '>12636137',
            'history-range': 'SELECT id FROM public.hand_state_snapshots WHERE ' + predicate + '>=12636137',
            'row-lock': 'SELECT id FROM public.hand_state_snapshots WHERE ' + predicate + '>=12636137 ORDER BY id FOR SHARE',
        }
        def nodes(plan):
            yield plan
            for child in plan.get('Plans', []):
                yield from nodes(child)
        plans = {}
        expected_rows = {}
        for name, sql in queries.items():
            plan = json.loads(probe('snapshot-index-before-plan-' + name, 'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + sql + ';'))[0]['Plan']
            require(any(n['Node Type'] == 'Seq Scan' for n in nodes(plan)), 'Baseline did not reproduce missing access path: ' + name)
            expected_rows[name] = sorted(probe('snapshot-index-before-rows-' + name, sql + ';').splitlines())
            plans[name] = {'before': plan}
        run('snapshot-index-missing-refused', source.read_text(), error='HAND_SNAPSHOT_INDEX_MISSING_BUILD_ONLINE')
        for label, definition in [
            ('reversed-keys', '(hand_number,table_id)'),
            ('partial', '(table_id,hand_number) WHERE NOT is_complete'),
            ('included-column', '(table_id,hand_number) INCLUDE(id)'),
            ('descending', '(table_id,hand_number DESC)'),
            ('expression', '(table_id,(hand_number+0))'),
        ]:
            probe('snapshot-index-same-name-' + label + '-refused',
                  'CREATE INDEX ' + INDEX + ' ON public.hand_state_snapshots ' + definition + ';' + source.read_text(),
                  error='HAND_SNAPSHOT_INDEX_CONTRACT_CHANGED')
        # The actual online statement is executed outside a transaction. It has
        # no IF NOT EXISTS shortcut that could hide a partial/failed build.
        run('snapshot-index-actual-online-build', online.read_text())
        run('snapshot-index-online-name-replay-refused', online.read_text(), error='42P07')
        run('snapshot-index-actual-recording', source.read_text())
        run('snapshot-index-recording-replay', source.read_text())
        run('snapshot-index-other-owner-role', 'CREATE ROLE snapshot_index_other_owner;')
        for label, change in [
            ('invalid', "UPDATE pg_index SET indisvalid=false WHERE indexrelid='public." + INDEX + "'::regclass;"),
            ('not-ready', "UPDATE pg_index SET indisready=false WHERE indexrelid='public." + INDEX + "'::regclass;"),
            ('not-live', "UPDATE pg_index SET indislive=false WHERE indexrelid='public." + INDEX + "'::regclass;"),
            ('unique', "UPDATE pg_index SET indisunique=true WHERE indexrelid='public." + INDEX + "'::regclass;"),
            ('wrong-owner', 'ALTER TABLE public.hand_state_snapshots OWNER TO snapshot_index_other_owner;'),
        ]:
            # Invalid-state controls mutate only this disposable cluster catalog,
            # inside a transaction that the actual migration refusal rolls back.
            probe('snapshot-index-' + label + '-refused', change + source.read_text(), error='HAND_SNAPSHOT_INDEX_CONTRACT_CHANGED')
        for name, sql in queries.items():
            plan = json.loads(probe('snapshot-index-after-plan-' + name, 'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + sql + ';'))[0]['Plan']
            require(any(n.get('Index Name') == INDEX for n in nodes(plan)), 'Exact access path was not used: ' + name)
            require(not any(n['Node Type'] == 'Seq Scan' for n in nodes(plan)), 'Sequential scan remains: ' + name)
            require(sorted(probe('snapshot-index-after-rows-' + name, sql + ';').splitlines()) == expected_rows[name], 'Index changed proof rows: ' + name)
            plans[name]['after'] = plan
        require(run('snapshot-index-final-rows', preservation) == before, 'Index/recording changed snapshot data')
        results['snapshotIndexCatalog'] = json.loads(run('snapshot-index-final-catalog', "SELECT jsonb_build_object('definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'unique',i.indisunique,'owner',pg_get_userbyid(c.relowner),'predicate',pg_get_expr(i.indpred,i.indrelid),'expression',pg_get_expr(i.indexprs,i.indrelid)) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indexrelid='public." + INDEX + "'::regclass;"))
        results['snapshotIndex'] = {'passed': True, 'plans': plans, 'rowsUnchanged': True,
                                    'boundary': 'Isolated physical access-path proof; production online installation and real plans are separate'}
    finally:
        cmd[-1] = original_database

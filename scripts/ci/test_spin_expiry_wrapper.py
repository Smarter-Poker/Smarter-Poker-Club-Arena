"""Source-specific hosted adapter controls; not native financial qualification.

The normal wrapper runs these controls before all six separate PG17 images.
No successful mocked protocol receipt establishes that SQL or refunds passed.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location('spin_expiry_pg_wrapper', Path(__file__).with_name('test-spin-expiry-postgres.py'))
W = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(W)
EXECUTION = '00000000-0000-4000-8000-000000000001'
ORDINARY = '00000000-0000-4000-8000-000000000002'
TOURNAMENT = '00000000-0000-4000-8000-000000000003'
MANIFEST_SHA = 'b' * 64
PG = Path('/usr/lib/postgresql/17/bin')
SOURCE = Path('/tmp/spin5-protocol/source')


def mixed_source_files():
    root = Path(__file__).resolve().parents[2]
    files={name:(root/name).read_bytes() for name in W.MIXED.INPUTS}
    files['inputs/captured-financial-store-policy.sql']=(root/'scripts/ci/probes/spin-expiry/inputs/captured-financial-store-policy.sql').read_bytes()
    return files


class PositiveFeeEntryTests(unittest.TestCase):
    def trigger_authority_inputs(self):
        root = Path(__file__).resolve().parents[2]
        base = root / W.FEE.BASE
        return {
            'schema': (root / 'scripts/ci/probes/spin-expiry/inputs/schema.sql').read_text(),
            'preimage': W.FEE.decode((base / 'preimage-metadata.json').read_bytes()),
            'expected': W.FEE.decode((base / 'expected-metadata.json').read_bytes()),
            'provider': (base / 'provider-supplement.sql').read_text(),
            'readback': (base / 'catalog-readback.sql').read_text(),
        }

    def binding_literals(self, sql):
        arrays = []
        for match in re.finditer(r'\$capture\$(.*?)\$capture\$', sql, re.S):
            value = W.FEE.decode(match.group(1))
            if (isinstance(value, list) and value and isinstance(value[0], dict)
                    and {'relation', 'name', 'enabled', 'definition'} <= value[0].keys()):
                arrays.append(value)
        return arrays

    def assert_trigger_authority(self, inputs):
        # Native 0c3e5d81 refused because CREATE-only parsing lost these authentic
        # DISABLE declarations. This is source evidence, not a native pass.
        names = {
            'aa_guard_tournament_completing_claim', 'aaa_guard_atomic_satellite_completion',
            'zzzz_freeze_finalized_tournament_prize_pool',
            'zzzz_tournament_pool_finalization_window_guard',
            'zzzz_tournaments_atomic_place_completion_guard',
            'zzzzz_tournaments_atomic_final_table_deal_completion_guard',
            'zzzzzz_tournaments_financial_certificate',
        }
        disabled = re.findall(r'^ALTER TABLE public\.tournaments DISABLE TRIGGER "([^"]+)";$',
                              inputs['schema'], re.M)
        self.assertEqual(len(disabled), 7, 'authentic disabled-trigger premise changed')
        self.assertEqual(set(disabled), names)
        before, after = inputs['preimage']['bindings'], inputs['expected']['bindings']
        self.assertEqual((len(before), len(after)), (153, 192))
        maps = [{(row['relation'], row['name']): row for row in rows} for rows in (before, after)]
        self.assertEqual(tuple(map(len, maps)), (153, 192), 'duplicate binding identity')
        for name in disabled:
            self.assertIsNotNone(re.search(
                r'(?m)^CREATE TRIGGER ' + re.escape(name) + r' [^\n]* ON (?:public\.)?tournaments ',
                inputs['schema']), name + ' original CREATE binding absent')
            pre, post = (mapping[('tournaments', name)] for mapping in maps)
            self.assertEqual(pre['enabled'], 'D', name + ' preimage differs from original schema')
            self.assertEqual(post['enabled'], 'D', name + ' captured postimage differs')
            self.assertEqual(pre['definition'], post['definition'])
        # Bind every row/field/order, not just the seven corrected flags. Both
        # SQL consumers must execute the exact standalone metadata expectation.
        self.assertEqual(self.binding_literals(inputs['provider']), [before, after])
        self.assertEqual(self.binding_literals(inputs['readback']), [after])

    def test_paid_entry_trigger_authority_preserves_authentic_disabled_bindings(self):
        self.assert_trigger_authority(self.trigger_authority_inputs())

    def test_paid_entry_trigger_authority_refuses_metadata_flag_corruption(self):
        original = self.trigger_authority_inputs()
        names = [row['name'] for row in original['preimage']['bindings'] if row['enabled'] == 'D']
        self.assertEqual(len(names), 7)
        for label in ('preimage', 'expected'):
            for name in names:
                changed = copy.deepcopy(original)
                next(row for row in changed[label]['bindings'] if row['name'] == name)['enabled'] = 'O'
                with self.subTest(metadata=label, name=name), self.assertRaises(AssertionError):
                    self.assert_trigger_authority(changed)

    def test_paid_entry_trigger_authority_refuses_embedded_flag_corruption(self):
        original = self.trigger_authority_inputs()
        for label, ordinal in (('provider', 0), ('provider', 1), ('readback', 0)):
            changed = copy.deepcopy(original)
            arrays = self.binding_literals(changed[label])
            target = arrays[ordinal]
            for match in re.finditer(r'\$capture\$(.*?)\$capture\$', changed[label], re.S):
                if W.FEE.decode(match.group(1)) == target:
                    altered = copy.deepcopy(target)
                    next(row for row in altered if row['enabled'] == 'D')['enabled'] = 'O'
                    changed[label] = (changed[label][:match.start(1)] + json.dumps(altered)
                                      + changed[label][match.end(1):])
                    break
            else:
                self.fail('original embedded binding array absent')
            with self.subTest(consumer=label, array=ordinal), self.assertRaises(AssertionError):
                self.assert_trigger_authority(changed)

    def test_paid_entry_trigger_authority_refuses_omitted_original_declaration(self):
        original = self.trigger_authority_inputs()
        declarations = re.findall(r'^ALTER TABLE public\.tournaments DISABLE TRIGGER "[^"]+";$',
                                  original['schema'], re.M)
        self.assertEqual(len(declarations), 7)
        for declaration in declarations:
            changed = dict(original)
            changed['schema'] = original['schema'].replace(declaration, '', 1)
            with self.subTest(declaration=declaration), self.assertRaises(AssertionError):
                self.assert_trigger_authority(changed)

    def allocation_receipt(self, source):
        # Protocol-only evidence. The independent baseline below mirrors actual
        # successful allocator 8ce73e0b, not FEE's validation-plan implementation.
        work = source.parent / 'work'
        work.mkdir()
        (source / 'inputs').mkdir(parents=True)
        prefix = b'-- authentic schema prefix\n'
        suffix = W.MARKER + b'\n-- authentic trigger suffix\n'
        (source / 'inputs/schema.sql').write_bytes(prefix + suffix)
        (work / 'schema-prefix.sql').write_bytes(prefix)
        (work / 'schema-suffix.sql').write_bytes(suffix)
        data = work / 'data'
        db = 'qual_spin_expiry_' + EXECUTION.replace('-', '')
        bootstrap = [str(PG/'psql'), '-X', '-w', '-h', str(work/'socket'), '-p', '5432',
                     '-U', 'fixture_bootstrap', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
        extension = "SELECT json_build_object('pgcrypto',EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='pgcrypto'),'uuid-ossp',EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='uuid-ossp'),'pg_trgm_1_6',EXISTS(SELECT 1 FROM pg_available_extension_versions WHERE name='pg_trgm' AND version='1.6'));"
        plan = [('pg_version', [str(PG/'postgres'), '--version']),
                ('initdb', [str(PG/'initdb'), '-D', str(data), '-U', 'fixture_bootstrap',
                            '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8']),
                ('pg_start', [str(PG/'pg_ctl'), '-D', str(data), '-l', str(work/'postgres.log'), '-w', '-t', '12', 'start']),
                ('server_endpoint_readback', W.server_endpoint_command(PG, work/'socket')),
                ('extension_availability', bootstrap + ['-qAt', '-c', extension]),
                ('create_sql_owner', bootstrap + ['-c', 'CREATE ROLE postgres NOSUPERUSER INHERIT LOGIN CREATEDB CREATEROLE REPLICATION BYPASSRLS']),
                ('create_database', [str(PG/'createdb'), '-w', '-h', str(work/'socket'), '-p', '5432',
                                     '-U', 'fixture_bootstrap', '-O', 'postgres', db])]
        sql = [('schema_prefix', work/'schema-prefix.sql'),
               ('restore_preexisting_principals', source/'principals.sql'),
               ('schema_suffix_all_real_triggers', work/'schema-suffix.sql'),
               ('authentic_access', source/'inputs/access.sql'),
               ('authentic_policies', source/'inputs/policies.sql'),
               ('current_notification_supplement', source/'provider-supplement.sql'),
               ('current_tested_roles', source/'provider-roles.sql'),
               ('tested_role_readback', source/'provider-roles-check.sql'),
               ('current_catalog_readback', source/'provider-check.sql'),
               ('empty_provider_readback', source/'empty-provider-check.sql'),
               ('authentic_spin_catalog_supplement', source/'inputs/spin-catalog-supplement.sql'),
               ('authentic_entry_provider_supplement', source/'inputs/entry-provider-supplement.sql'),
               ('authentic_entry_sequence_authority', source/'inputs/entry-sequence-authority.sql'),
               ('authentic_settlement_source_authority', source/'inputs/settle-source-authority.sql'),
               ('retention_provider_authority', source/W.RETENTION_STAGES['retention_provider_authority'][1])]
        for name, path in sql:
            argv = W.qualification_sql_argv(PG, source, EXECUTION, ORDINARY, TOURNAMENT,
                                            'fixture_bootstrap', str(path))
            plan.append((name, argv))
        plan += W.FEE.body_plan(PG, source, EXECUTION, ORDINARY, TOURNAMENT)
        plan += [('pg_stop_fast', [str(PG/'pg_ctl'), '-D', str(data), '-w', '-t', '10', '-m', 'fast', 'stop']),
                 ('pg_stopped_readback', [str(PG/'pg_ctl'), '-D', str(data), 'status'])]
        receipt = {'stages': [], 'positive_fee_entry_qualification': {'mocked_output_only': True},
                   'work_deadline_seconds': 240, 'cleanup_deadline_seconds': 30,
                   'cleanup_verified': True, 'cleanup_errors': [], 'hosted_cleanup_observed': True,
                   'original_clients_terminal': True, 'source_stable': True}
        for ordinal, (name, argv) in enumerate(plan):
            code = 3 if name=='pg_stopped_readback' else 0
            stage = {'stage': name, 'argv': argv, 'returncode': code,
                     'terminal_returncode': code, 'pid': 1000+ordinal}
            for stream in ('stdout', 'stderr'):
                content = (name + ':' + stream + '\n').encode()
                (work/(name+'.'+stream)).write_bytes(content)
                stage[stream+'_sha256'] = W.digest(content)
            receipt['stages'].append(stage)
        return receipt

    def validate_allocation(self, receipt, source):
        # Monetary-output behavior has its separate actual oracle controls; only
        # this receipt-protocol unit boundary is mocked here, never SQL execution.
        with patch.object(W.FEE, 'validate_outputs', return_value={'mocked_output_only': True}):
            return W.FEE.validate_stages(receipt, PG, source, EXECUTION, ORDINARY, TOURNAMENT)

    def test_paid_entry_requires_every_successful_baseline_and_cleanup_stage(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder)/'source'
            receipt = self.allocation_receipt(source)
            self.assertEqual(len(receipt['stages']), 32)
            self.assertEqual(self.validate_allocation(receipt, source), [])
            for original in receipt['stages']:
                for mutation in ('missing', 'failed', 'unterminated', 'deadline'):
                    changed = copy.deepcopy(receipt)
                    stage = next(s for s in changed['stages'] if s['stage']==original['stage'])
                    if mutation=='missing': changed['stages'].remove(stage)
                    elif mutation=='failed': stage['returncode']=7
                    elif mutation=='unterminated': stage['terminal_returncode']=None
                    else: stage['client_deadline_exceeded']=True
                    with self.subTest(stage=original['stage'], mutation=mutation), self.assertRaises((ValueError, KeyError)):
                        self.validate_allocation(changed, source)

    def test_paid_entry_rejects_reordered_extra_or_replaced_baseline_authority(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder)/'source'
            receipt = self.allocation_receipt(source)
            for name in ['authentic_access','authentic_policies','current_tested_roles','tested_role_readback',
                         'authentic_entry_sequence_authority','authentic_settlement_source_authority',
                         'fee_hand_id_sequence','fee_actual_paid_entry']:
                for option in ['-U','-h','-d','-f','-v']:
                    changed = copy.deepcopy(receipt)
                    stage = next(s for s in changed['stages'] if s['stage']==name)
                    stage['argv'][stage['argv'].index(option)+1]='wrong-authority-or-identity'
                    with self.subTest(stage=name, option=option), self.assertRaises(ValueError):
                        self.validate_allocation(changed, source)
                for variable in ('execution_uuid=', 'ordinary_user_uuid=', 'tournament_uuid='):
                    changed = copy.deepcopy(receipt)
                    stage = next(s for s in changed['stages'] if s['stage']==name)
                    index = next(i for i, value in enumerate(stage['argv']) if value.startswith(variable))
                    stage['argv'][index] = variable + '00000000-0000-0000-0000-000000000000'
                    with self.subTest(stage=name, variable=variable), self.assertRaises(ValueError):
                        self.validate_allocation(changed, source)
            for mutation in ('reordered', 'extra', 'duplicate'):
                changed = copy.deepcopy(receipt)
                if mutation=='reordered': changed['stages'][10:12]=reversed(changed['stages'][10:12])
                elif mutation=='extra': changed['stages'].insert(22, {'stage':'unclaimed_sql'})
                else: changed['stages'].insert(22, copy.deepcopy(changed['stages'][10]))
                with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                    self.validate_allocation(changed, source)

    def test_paid_entry_binds_all_baseline_and_cleanup_streams_and_schema_split(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder)/'source'
            receipt = self.allocation_receipt(source)
            for original in receipt['stages']:
                for stream in ('stdout','stderr'):
                    changed=copy.deepcopy(receipt)
                    next(s for s in changed['stages'] if s['stage']==original['stage'])[stream+'_sha256']='a'*64
                    with self.subTest(stage=original['stage'], stream=stream), self.assertRaises(ValueError):
                        self.validate_allocation(changed, source)
            for name in ('schema-prefix.sql','schema-suffix.sql','authentic_access.stdout','pg_stopped_readback.stderr'):
                path=source.parent/'work'/name
                old=path.read_bytes()
                path.write_bytes(old+b'changed')
                try:
                    with self.subTest(file=name), self.assertRaises(ValueError):
                        self.validate_allocation(receipt, source)
                finally: path.write_bytes(old)

    def test_paid_entry_preserves_budget_and_terminal_cleanup_contract(self):
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/'source'; receipt=self.allocation_receipt(source)
            for key, value in [('work_deadline_seconds',241),('cleanup_deadline_seconds',31),
                               ('cleanup_verified',False),('cleanup_errors',['unobserved']),
                               ('hosted_cleanup_observed',False),('original_clients_terminal',False),
                               ('source_stable',False),('fast_stop_failure','failed')]:
                changed=copy.deepcopy(receipt);changed[key]=value
                with self.subTest(key=key), self.assertRaises(ValueError):
                    self.validate_allocation(changed,source)

    def test_paid_entry_context_initialization_has_no_uuid_scalar_output(self):
        argv=W.FEE.sql_argv(PG,SOURCE,EXECUTION,ORDINARY,TOURNAMENT,W.FEE.FIXTURE)
        self.assertEqual(argv[argv.index('-c')+1],
            "DO $entry_context$ BEGIN PERFORM set_config('spin_mixed_qualification.execution_uuid','"+EXECUTION+
            "',false); PERFORM set_config('qualification.execution_uuid','"+EXECUTION+"',false); END $entry_context$;")

    def test_paid_entry_sequence_restore_is_bound_to_original_capture_and_fresh_preimage(self):
        root = Path(__file__).resolve().parents[2]
        base = root / W.FEE.BASE
        raw = (base / 'hand-id-sequence-capture.json').read_bytes()
        self.assertEqual(W.digest(raw), 'a86f2f81e2ed49bf347c9806a9279b8f8e437c10642de163ee2bd8c5d05f92f1')
        captured, = W.FEE.decode(raw)
        sql = (base / 'hand-id-sequence.sql').read_text()
        pre, post = [W.FEE.decode(value) for value in re.findall(r"'(\{[^\n]+\})'::jsonb", sql)]
        expected = {k: v for k, v in captured['capture']['sequence'].items() if not k.endswith('_usage')}
        expected.update(kind='S', persistence='p', owned_dependencies=0)
        self.assertEqual(post, expected)
        self.assertEqual(pre, {**expected, 'owner': 'fixture_bootstrap', 'acl': None, 'start': '1', 'cache': '1'})
        self.assertIn('last_value=1 AND is_called=false', sql)
        self.assertIn('START WITH 1000000 RESTART WITH 1000000 CACHE 100 NO CYCLE', sql)
        self.assertLess(sql.index('PERFORM pg_temp.fee_sequence_empty_estate();'), sql.index('ALTER SEQUENCE'))
        self.assertIn('last_value=1000000 AND is_called=false', sql)
        self.assertIn("'production_counter_copied',false", sql)
        self.assertNotIn('ALTER SEQUENCE public.hand_id_seq',
                         (root / 'scripts/ci/probes/spin-expiry/inputs/entry-sequence-authority.sql').read_text())

    def test_paid_entry_sequence_readback_refuses_wrong_authority_or_scope(self):
        root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'source'; work = Path(folder) / 'work'
            base = source / W.FEE.BASE; base.mkdir(parents=True); work.mkdir()
            for name in ('hand-id-sequence-capture.json', 'expected-metadata.json'):
                (base / name).write_bytes((root / W.FEE.BASE / name).read_bytes())
            captured, = W.FEE.decode((base / 'hand-id-sequence-capture.json').read_bytes())
            authority = {k: v for k, v in captured['capture']['sequence'].items() if not k.endswith('_usage')}
            authority.update(kind='S', persistence='p', owned_dependencies=0)
            sequence = {'stage': 'positive_fee_hand_id_sequence', 'execution_uuid': EXECUTION,
                'database': 'qual_spin_expiry_' + EXECUTION.replace('-', ''), 'user': 'fixture_bootstrap',
                'session_user': 'fixture_bootstrap', 'socket': str(work / 'socket'), 'sequence': authority,
                'empty_tables_checked': 250, 'empty_business_estate': True,
                'fresh_isolated_initialization_only': True, 'production_counter_copied': False,
                'financial_qualification': False, 'historical_qualification': False, 'production_qualification': False}
            metadata = W.FEE.decode((base / 'expected-metadata.json').read_bytes())
            catalog = {'stage': 'positive_fee_catalog_readback', 'execution_uuid': EXECUTION,
                'database': sequence['database'], 'relations': len(metadata['relations']),
                'function_authorities': len(metadata['functions']), 'trigger_bindings': len(metadata['bindings']),
                'logical_catalog_exact': True, 'empty_business_estate': True, 'mtt_abi': 'legacy-capacity-v1',
                **{key: False for key in ('deployment_local_attnum_identity_compared', 'mtt_activation_qualified',
                    'native_financial_qualification', 'historical_qualification', 'production_qualification', 'full_qualification')}}
            (work / 'fee_provider_readback.stdout').write_text(json.dumps(catalog) + '\n')
            (work / 'fee_actual_paid_entry.stdout').write_bytes(b'original entry bytes for mocked oracle boundary\n')
            oracle = Mock(); oracle.validate_output.return_value = {'separate_oracle_boundary': True}
            stream = work / 'fee_hand_id_sequence.stdout'
            with patch.object(W.FEE, 'load_oracle', return_value=oracle):
                stream.write_text(json.dumps(sequence) + '\n')
                self.assertEqual(W.FEE.validate_outputs(source, work, EXECUTION, TOURNAMENT)['sequence'], sequence)
                for key, value in [('user', 'postgres'), ('socket', '/other/socket'), ('empty_business_estate', False),
                    ('empty_tables_checked', 0), ('fresh_isolated_initialization_only', False),
                    ('production_counter_copied', True), ('financial_qualification', True)]:
                    changed = copy.deepcopy(sequence); changed[key] = value
                    stream.write_text(json.dumps(changed) + '\n')
                    with self.subTest(field=key), self.assertRaises(ValueError):
                        W.FEE.validate_outputs(source, work, EXECUTION, TOURNAMENT)
                for key, value in [('owner', 'fixture_bootstrap'), ('acl', None), ('start', '1'), ('cache', '1')]:
                    changed = copy.deepcopy(sequence); changed['sequence'][key] = value
                    stream.write_text(json.dumps(changed) + '\n')
                    with self.subTest(authority=key), self.assertRaises(ValueError):
                        W.FEE.validate_outputs(source, work, EXECUTION, TOURNAMENT)

    def test_independent_paid_entry_oracle_rejects_corrupted_original_evidence(self):
        root = Path(__file__).resolve().parents[2]
        self.assertEqual(W.FEE.load_oracle(root).run_negative_controls(), 46)

    def test_restoration_reader_is_created_before_the_read_only_observation(self):
        sql = (W.ROOT / 'scripts/qualification/spin-mixed-positive-fee-entry.sql').read_text()
        start = sql.index('BEGIN READ ONLY;')
        end = sql.index('COMMIT;', start)
        self.assertLess(sql.index('END $restoration$;'), start)
        self.assertIn("'restoration_inputs',pg_temp.spin_q_restoration_inputs()", sql[start:end])
        self.assertNotIn('CREATE FUNCTION', sql[start:end])

    def files(self):
        root = Path(__file__).resolve().parents[2]
        files = {name: (root / name).read_bytes() for name in W.FEE.INPUTS}
        files['inputs/captured-financial-store-policy.sql'] = (
            root / 'scripts/ci/probes/spin-expiry/inputs/captured-financial-store-policy.sql').read_bytes()
        name = 'scripts/qualification/fixtures/spin-history-retention/database-state.sql'
        files[name] = (root / name).read_bytes()
        return files

    def test_missing_and_changed_paid_entry_inputs_are_refused(self):
        files = self.files()
        W.FEE.validate_sources(files)
        for name in W.FEE.INPUTS:
            for missing in (False, True):
                changed = dict(files)
                if missing:
                    del changed[name]
                else:
                    changed[name] += b'changed'
                with self.subTest(name=name, missing=missing), self.assertRaises((ValueError, KeyError)):
                    W.FEE.validate_sources(changed)

    def test_paid_entry_cannot_load_historical_or_synthetic_estates(self):
        plan = W.FEE.body_plan(PG, SOURCE, EXECUTION, ORDINARY, TOURNAMENT)
        self.assertEqual([name for name, _ in plan], ['fee_hand_id_sequence', 'fee_current_catalog_restore',
            'fee_current_catalog_readback', 'fee_current_recognition_restore',
            'fee_current_recognition_readback', 'fee_provider_restore',
            'fee_provider_readback', 'fee_actual_paid_entry'])
        for name, argv in plan:
            self.assertEqual(argv[argv.index('-U') + 1],
                             'fixture_bootstrap' if name == 'fee_hand_id_sequence' else 'postgres')
            self.assertEqual(argv[argv.index('-h') + 1], str(SOURCE.parent / 'work/socket'))
            self.assertEqual(argv[argv.index('-d') + 1], 'qual_spin_expiry_' + EXECUTION.replace('-', ''))
            self.assertIn('ordinary_user_uuid=' + ORDINARY, argv)
            self.assertIn('tournament_uuid=' + TOURNAMENT, argv)
            self.assertNotIn('synthetic-', argv[-1])
        self.assertIn('qualification_socket=' + str(SOURCE.parent / 'work/socket'), plan[0][1])
        self.assertEqual(plan[0][1][-1], str(SOURCE / W.FEE.BASE / 'hand-id-sequence.sql'))
        self.assertTrue(set(W.FEE.INPUTS) <= set(W.REPLACEMENTS))
        self.assertEqual(W.CASES[W.FEE.IMAGE], ())

    def test_paid_entry_observer_does_not_modify_sealed_source(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder).resolve()
            leaf = source / W.FEE.ORACLE
            leaf.parent.mkdir(parents=True)
            leaf.write_text('value = 42\n')
            before = sorted(str(p.relative_to(source)) for p in source.rglob('*'))
            with patch.object(sys, 'dont_write_bytecode', False):
                self.assertEqual(W.FEE.load_oracle(source).value, 42)
            self.assertEqual(sorted(str(p.relative_to(source)) for p in source.rglob('*')), before)

    def test_paid_entry_catalog_reader_refuses_ambiguous_json(self):
        for raw in (b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":Infinity}', b'{"a":-Infinity}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                W.FEE.decode(raw)


class MixedCurrentTests(unittest.TestCase):
    def test_fresh_doctrine_is_restored_before_lane_and_terminal_installation(self):
        M = W.MIXED
        for image in M.IMAGES:
            rows = M.body_plan(PG, W.ROOT, EXECUTION, ORDINARY, TOURNAMENT, image)
            names = [name for name, _ in rows]
            self.assertIn('mixed_doctrine_restore', names)
            self.assertLess(names.index('mixed_catalog_readback'), names.index('mixed_doctrine_restore'))
            self.assertLess(names.index('mixed_doctrine_restore'), names.index('current_lane_before'))
            argv = dict(rows)['mixed_doctrine_restore']
            self.assertEqual(argv[argv.index('-U') + 1], 'postgres')
            self.assertEqual(argv[-1], str(W.ROOT / M.BASE / 'doctrine-successor-restore.sql'))

    def test_current_lane_variants_preserve_original_bodies_and_capture_pins(self):
        M = W.MIXED
        fields = ('signature', 'owner', 'acl', 'config', 'full_md5', 'volatility', 'security_definer')
        captured = json.loads((W.ROOT / M.BASE / 'authority.json').read_text())[0]['evidence']['functions']
        expected = {f['signature']: {k: f[k] for k in fields} for f in captured}
        fresh = json.loads((W.ROOT / M.BASE / 'doctrine-successor.json').read_text())['function']
        self.assertEqual(__import__('hashlib').md5(fresh['definition'].encode()).hexdigest(), fresh['full_md5'])
        self.assertEqual(fresh['full_md5'], 'd6885832ceaa6c071d40bdc26a0b16fa')
        self.assertIn(fresh['definition'].rstrip() + ';',
                      (W.ROOT / M.BASE / 'doctrine-successor-restore.sql').read_text())
        self.assertIn(fresh['definition'].rstrip() + ';', (W.ROOT / M.ROLLBACK).read_text())
        expected[fresh['signature']] = {k: fresh[k] for k in fields}
        legacy = json.loads((W.ROOT / 'scripts/qualification/fixtures/spin-receipt-lane/authority.json').read_text())['functions']
        expected.update({f['identity']: {k: f['identity'] if k == 'signature' else f[k] for k in fields}
                         for f in legacy})
        for reverse, name in ((False, M.LANE), (True, M.LANE_ROLLBACK)):
            text = (W.ROOT / name).read_text()
            pins = json.loads(re.search(r'\$current_lane_authority\$(.*?)\$current_lane_authority\$', text, re.S)[1])
            self.assertEqual(len(pins), 10)
            self.assertEqual(len({p['signature'] for p in pins}), 10)
            for pin in pins:
                value = copy.deepcopy(expected[pin['signature']])
                if reverse and pin['signature'].startswith('settle_hand_atomically('):
                    value['full_md5'] = '64abd1e3234fdabc655647bfb1ad5018'
                if reverse and pin['signature'].startswith('sp_compact_hand_history('):
                    value['full_md5'] = '36a41aa4447e199ec8a9f2a5aa1840ec'
                self.assertEqual(pin, value)
            # Only current authority guards and the wrapper preimage differ.
            original = (W.ROOT / name.replace('current-receipt-lane', 'receipt-lane')).read_text()
            reduced = re.sub(r'-- Current-cohort variant\..*?END \$current_cohort\$;\n', '', text, count=1, flags=re.S)
            reduced = re.sub(r'DO \$current_handler\$.*?END \$current_handler\$;\n', '', reduced, count=1, flags=re.S)
            reduced = reduced.replace('c64e049911fd99c1d784cdb042ca714b', '480be3139fe0878e637ce54f533a2170')
            self.assertEqual(reduced[reduced.index('BEGIN;'):], original[original.index('BEGIN;'):])
            mode = 'rollback' if reverse else 'forward'
            body = dict(M.lane_variables(W.ROOT, mode))['lane_body']
            self.assertNotIn('\nBEGIN;\n', body)
            self.assertFalse(body.endswith('COMMIT;\n'))
            self.assertIn(__import__('hashlib').md5(body.encode()).hexdigest(),
                          (W.ROOT / M.BASE / 'current-lane-refusals.sql').read_text())

    def test_current_lane_body_refuses_changed_executed_source(self):
        M = W.MIXED
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder)
            for mode, name in (('forward', M.LANE), ('rollback', M.LANE_ROLLBACK)):
                path = source / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((W.ROOT / name).read_bytes() + b'-- changed\n')
                with self.assertRaises(ValueError): M.lane_variables(source, mode)

    def roundtrip_outputs(self):
        # Small protocol records exercise the reader, not PostgreSQL behavior.
        M = W.MIXED
        before = {'catalog': {'functions': ['current originals']},
                  'current_cohort': ['captured current wrapper/finish authority'],
                  'handler': None, 'business': {'public.input': [{'value': 1}]}}
        installed = copy.deepcopy(before)
        installed['catalog'] = {'functions': ['lane installed']}
        installed['handler'] = {'owner': 'postgres', 'acl': '{postgres=X/postgres}',
            'body_md5': '534850c97847e72075044d8604b0a09d',
            'config': ['search_path=pg_catalog, public, pg_temp'],
            'security_definer': False, 'volatility': 'v'}
        terminal = copy.deepcopy(installed)
        terminal['business']['public.output'] = [{'real_writer_output': 2}]
        reversing = copy.deepcopy(terminal)
        after = copy.deepcopy(before)
        after['business'] = copy.deepcopy(terminal['business'])
        return {'current_lane_before': before, 'current_lane_installed': installed,
                'current_lane_before_terminal_rollback': terminal,
                'current_lane_before_rollback': reversing, 'current_lane_after': after,
                'current_lane_forward_refusals': {'current_lane_mode': 'forward',
                    'authority_refusals': 10, 'exact_state_restored': True},
                'current_lane_rollback_refusals': {'current_lane_mode': 'rollback',
                    'authority_refusals': 13, 'exact_state_restored': True}}

    def test_current_lane_roundtrip_requires_exact_authority_and_no_business_loss(self):
        M = W.MIXED
        original = self.roundtrip_outputs()
        self.assertTrue(M.validate_lane_roundtrip(original.__getitem__)['original_current_authority_restored'])
        changes = [
            ('current_lane_after', 'catalog', {'functions': ['stale wrapper']}),
            ('current_lane_after', 'current_cohort', ['wrong current authority']),
            ('current_lane_after', 'handler', {'owner': 'postgres'}),
            ('current_lane_after', 'business', original['current_lane_before']['business']),
            ('current_lane_installed', 'business', {'public.input': []}),
            ('current_lane_before_rollback', 'business', {'public.input': []}),
            ('current_lane_before_rollback', 'handler', None),
            ('current_lane_installed', 'current_cohort', ['changed by lane install']),
            ('current_lane_forward_refusals', 'authority_refusals', 8),
            ('current_lane_rollback_refusals', 'authority_refusals', 11),
            ('current_lane_rollback_refusals', 'exact_state_restored', False),
        ]
        for stage, key, value in changes:
            wrong = copy.deepcopy(original); wrong[stage][key] = value
            with self.subTest(stage=stage, key=key), self.assertRaises(ValueError):
                M.validate_lane_roundtrip(wrong.__getitem__)
        for stage in original:
            wrong = copy.deepcopy(original); del wrong[stage]
            with self.subTest(missing=stage), self.assertRaises(KeyError):
                M.validate_lane_roundtrip(wrong.__getitem__)

    def test_current_lane_stages_require_original_successful_streams_order_and_roles(self):
        M = W.MIXED
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'source'; work = Path(folder) / 'work'; work.mkdir()
            for name in M.INPUTS:
                path = source / name; path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((W.ROOT / name).read_bytes())
            for image in M.IMAGES:
                seed = M.seed_plan(PG, source, EXECUTION, ORDINARY, TOURNAMENT)
                body = M.body_plan(PG, source, EXECUTION, ORDINARY, TOURNAMENT, image)
                stages = [{'stage': 'schema_prefix'}]
                for name, argv in seed:
                    stages.append({'stage': name, 'argv': argv, 'returncode': 0})
                stages += [{'stage': 'schema_suffix_all_real_triggers'}, {'stage': 'retention_provider_authority'}]
                stages += [{'stage': name, 'argv': argv, 'returncode': 0} for name, argv in body]
                for stage in stages:
                    if 'argv' not in stage: continue
                    for stream in ('stdout', 'stderr'):
                        raw = (stage['stage'] + stream).encode()
                        (work / (stage['stage'] + '.' + stream)).write_bytes(raw)
                        stage[stream + '_sha256'] = W.digest(raw)
                receipt = {'stages': stages, 'mixed_current_qualification': {'protocol': True}}
                with patch.object(M, 'validate_outputs', return_value={'protocol': True}):
                    M.validate_stages(receipt, PG, source, EXECUTION, ORDINARY, TOURNAMENT, image)
                    for mode in ('missing', 'reordered', 'wrong_role', 'failed', 'hash'):
                        wrong = copy.deepcopy(receipt)
                        target = next(s for s in wrong['stages'] if s['stage'] == 'current_lane_rollback')
                        if mode == 'missing': wrong['stages'].remove(target)
                        elif mode == 'reordered':
                            wrong['stages'].remove(target); wrong['stages'].insert(0, target)
                        elif mode == 'wrong_role': target['argv'][target['argv'].index('-U') + 1] = 'fixture_bootstrap'
                        elif mode == 'failed': target['returncode'] = 3
                        else: target['stdout_sha256'] = '0' * 64
                        with self.subTest(image=image, mode=mode), self.assertRaises(ValueError):
                            M.validate_stages(wrong, PG, source, EXECUTION, ORDINARY, TOURNAMENT, image)

    def test_loading_staged_observer_never_writes_bytecode_into_sealed_packet(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder).resolve()
            leaf = source / 'observer.py'
            leaf.write_text('value = 42\n')
            with patch.object(sys, 'dont_write_bytecode', False):
                self.assertEqual(W.MIXED.load_module(source, 'observer.py').value, 42)
            self.assertEqual(list(source.iterdir()), [leaf])

    def race_receipt(self, image):
        # Protocol-only control: these tiny records do not simulate or qualify SQL.
        M = W.MIXED
        value = {'execution': EXECUTION, 'mode': M.mode_for(image),
            'qualification': 'synthetic_current_terminal_zero_fee',
            'passed': True, 'cleanup_verified': True, 'source_stable': True,
            'work_deadline_seconds': 20, 'cleanup_deadline_seconds': 5,
            'source_sha256': {name: W.digest(data) for name, data in mixed_source_files().items() if name in M.INPUTS},
            'backend_pids': {'observer': 101, 'holder': 102, 'caller': 103},
            'clients': [{'backend_pid': pid, 'client_exit': 0} for pid in (103, 102, 101)],
            'verifier_client': {'backend_pid': 104, 'client_exit': 0},
            'backend_cleanup': {'backends': 0, 'locks': 0},
            'environment': {'database': 'qual_spin_expiry_' + EXECUTION.replace('-', ''),
                'user': 'postgres', 'session_user': 'postgres', 'address': None, 'listen': '',
                'port': '5432', 'super': False, 'version': 170011, 'others': 0},
            'transcripts': {'current_mixed_' + name + '_' + EXECUTION: 'original transcript\n'
                            for name in ('observer', 'holder', 'caller')},
            'cleanup_transcript': 'original cleanup transcript\n'}
        for key in ('production_mutation', 'full_qualification', 'historical_qualification',
                    'full_financial_qualification', 'fee_bearing_qualification', 'incident_closed'):
            value[key] = False
        value['source_readback'] = {name: {'sha256': sha, 'matches': True}
                                    for name, sha in value['source_sha256'].items()}
        barriers = [{'classid': '4265093629', 'objid': '1253463894'},
                    {'classid': '880566413', 'objid': '1926503905'}]
        wait = {'pid': 103, 'type': 'Lock', 'event': 'advisory', 'blockers': [102],
                'data_locks': 0, 'locks': [dict(barriers[0], mode='ExclusiveLock', granted=False, objsubid=1)]}
        if image == M.IMAGES[0]:
            value['cases'] = [{'case': 'receipt_writer_rollback_then_wrapper',
                               'exact_rollback': True, 'wait': copy.deepcopy(wait)}]
            for replay in (False, True):
                value['cases'].append({'case': 'concurrent_completion_commit_replay' if replay else 'concurrent_completion_rollback_retry',
                    'exact_rollback': not replay, 'exact_replay': replay, 'wait': copy.deepcopy(wait),
                    'exclusive_barriers': [dict(x, mode='ExclusiveLock', granted=True, objsubid=1) for x in barriers],
                    'second_receipt': {'ok': True, 'fully_settled': True, 'status': 'COMPLETED',
                                       'tournament_id': M.TID, 'winner_id': M.WINNER}})
        else:
            value['source_preconditions'] = {'table_id': '20000000-0000-4000-8000-000000000001',
                'hand_id': M.SOURCE_HAND, 'status': 'succeeded', 'error': None, 'running_unsealed': True}
            value['cases'] = [{'case': 'committed_source_reread_after_wait', 'affected_rows': 1,
                'exact_refusal': True, 'only_declared_source_change': True, 'wait': wait}]
            value['transcripts']['current_mixed_caller_' + EXECUTION] += (
                'ERROR:  P0404: mixed-basis retained history refused: unaccepted_receipt\n')
        return value

    def test_nested_race_receipt_requires_sources_waits_scope_and_cleanup(self):
        changes = [
            (('source_stable',), False), (('source_sha256', W.MIXED.PROGRAM), '0' * 64),
            (('source_readback', W.MIXED.PROGRAM, 'matches'), False),
            (('work_deadline_seconds',), 21), (('cleanup_deadline_seconds',), 6),
            (('failure',), None), (('cleanup_failure',), ''), (('verifier_cleanup_error',), ''),
            (('historical_qualification',), True), (('full_financial_qualification',), True),
            (('fee_bearing_qualification',), True), (('production_mutation',), True),
            (('incident_closed',), True), (('full_qualification',), True),
            (('environment', 'super'), True), (('environment', 'address'), '127.0.0.1'),
            (('environment', 'others'), 1), (('backend_pids', 'holder'), 101),
            (('clients', 0, 'client_exit'), None), (('verifier_client', 'backend_pid'), 101),
            (('backend_cleanup', 'locks'), 1), (('cases', 0, 'wait', 'data_locks'), 1),
            (('cases', 0, 'wait', 'blockers'), [999]),
            (('cases', 0, 'wait', 'locks', 0, 'granted'), True),
            (('cases', 0, 'wait', 'locks', 0, 'classid'), '0'),
            (('cleanup_transcript',), 'ERROR: wrong cleanup\n'),
        ]
        for image in W.MIXED.IMAGES:
            original = self.race_receipt(image)
            W.MIXED.validate_races(original, EXECUTION, image, mixed_source_files())
            for path, wrong in changes:
                value = copy.deepcopy(original); cursor = value
                for key in path[:-1]: cursor = cursor[key]
                cursor[path[-1]] = wrong
                with self.subTest(image=image, path=path), self.assertRaises(ValueError):
                    W.MIXED.validate_races(value, EXECUTION, image, mixed_source_files())
        for path, wrong in [
            (('source_preconditions', 'status'), 'failed'),
            (('cases', 0, 'affected_rows'), 0), (('cases', 0, 'exact_refusal'), False),
            (('transcripts', 'current_mixed_caller_' + EXECUTION), 'ERROR:  P0404: unrelated failure\n'),
        ]:
            value = self.race_receipt(W.MIXED.IMAGES[1]); cursor = value
            for key in path[:-1]: cursor = cursor[key]
            cursor[path[-1]] = wrong
            with self.subTest(path=path), self.assertRaises(ValueError):
                W.MIXED.validate_races(value, EXECUTION, W.MIXED.IMAGES[1], mixed_source_files())

    def test_race_decoder_preserves_decimal_and_rejects_ambiguous_json(self):
        self.assertEqual(str(W.MIXED.decode_races(b'{"amount":9007199254740992.01}')['amount']), '9007199254740992.01')
        for raw in (b'{"ok":false,"ok":true}', b'{"x":{"ok":false,"ok":true}}',
                    b'{"amount":NaN}', b'{"amount":Infinity}', b'{"amount":-Infinity}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError): W.MIXED.decode_races(raw)

    def test_all_six_images_and_original_cases_remain_required(self):
        self.assertEqual(W.IMAGES, ('preimage', 'candidate', 'retention-completed',
                                   'mixed-current-completion', 'mixed-current-source-change', 'positive-fee-entry'))
        self.assertEqual(W.CASES, {'preimage': ('order',),
            'candidate': ('order', 'timeout', 'committed-refund'),
            'retention-completed': (), 'mixed-current-completion': (),
            'mixed-current-source-change': (), 'positive-fee-entry': ()})
        self.assertTrue(set(W.MIXED.INPUTS) <= set(W.REPLACEMENTS))

    def test_exact_sources_and_executed_provider_paths_are_pinned(self):
        files = mixed_source_files()
        W.MIXED.validate_sources(files)
        for name in W.MIXED.INPUTS:
            for missing in (False, True):
                changed = dict(files)
                if missing:
                    del changed[name]
                else:
                    changed[name] += b'changed'
                with self.subTest(name=name, missing=missing), self.assertRaises((ValueError, KeyError)):
                    W.MIXED.validate_sources(changed)
        for mode in ('scope', 'inventory', 'include', 'store-policy'):
            changed = dict(files)
            manifest = json.loads(changed[W.MIXED.MANIFEST])
            if mode == 'scope': manifest['historical_qualification'] = True
            if mode == 'inventory': manifest['files']['unexecuted/provider.sql'] = {'bytes': 0, 'sha256': W.digest(b'')}
            if mode == 'include': manifest['relative_include_graph'] = {'other.sql': ['outside.sql']}
            if mode == 'store-policy': changed['inputs/captured-financial-store-policy.sql'] += b'changed'
            changed[W.MIXED.MANIFEST] = json.dumps(manifest).encode()
            with self.subTest(mode=mode), self.assertRaises(ValueError): W.MIXED.validate_sources(changed)

    def test_stage_plan_uses_staged_source_and_separate_committed_estates(self):
        M = W.MIXED
        source = W.ROOT
        completion = M.body_plan(PG, source, EXECUTION, ORDINARY, TOURNAMENT, M.IMAGES[0])
        refusal = M.body_plan(PG, source, EXECUTION, ORDINARY, TOURNAMENT, M.IMAGES[1])
        common = next(i for i, row in enumerate(completion) if row[0] == 'terminal_consumer')
        self.assertEqual(completion[:common], refusal[:common])
        self.assertEqual([name for name, _ in refusal[common:]],
                         ['terminal_consumer', 'independent_after_source_change',
                          'current_lane_before_terminal_rollback', 'current_terminal_rollback',
                          'independent_after_rollback', 'current_lane_before_rollback',
                          'current_lane_rollback_refusals', 'current_lane_rollback', 'current_lane_after'])
        self.assertEqual(completion[-2][0], 'current_lane_rollback')
        self.assertEqual(completion[-1][0], 'current_lane_after')
        for rows in (completion, refusal):
            names = [name for name, _ in rows]
            self.assertLess(names.index('mixed_catalog_readback'), names.index('mixed_lane_install'))
            self.assertLess(names.index('mixed_recognition_readback'), names.index('mixed_lane_install'))
            self.assertLess(names.index('mixed_lane_install'), names.index('mixed_terminal_install'))
            self.assertLess(names.index('current_terminal_rollback'), names.index('current_lane_rollback'))
            self.assertEqual(dict(rows)['mixed_lane_install'][-1], str(source / M.LANE))
            self.assertEqual(dict(rows)['current_lane_rollback'][-1], str(source / M.LANE_ROLLBACK))
        for name, argv in M.seed_plan(PG, source, EXECUTION, ORDINARY, TOURNAMENT) + completion:
            if '-f' in argv:
                self.assertTrue(Path(argv[-1]).is_relative_to(source))
                self.assertEqual(argv[argv.index('-h')+1], str(source.parent / 'work/socket'))
                self.assertEqual(argv[argv.index('-d')+1], 'qual_spin_expiry_' + EXECUTION.replace('-', ''))
            elif name == 'terminal_consumer':
                self.assertEqual(argv[1], str(source / M.PROGRAM))
                self.assertEqual(argv[-1], str(source.parent / 'work' / M.RESULT))
        self.assertIn('SET ROLE postgres;', dict(completion)['mixed_synthetic_provider'][-3])
        self.assertEqual(dict(completion)['mixed_terminal_install'][-1], str(source / M.COMPONENT))
        with self.assertRaises(ValueError): M.mode_for('candidate')

    def test_diagnostic_selection_and_local_storage_guard(self):
        for platform, scratch, mounted, accepted in (
            ('linux', None, False, True),
            ('darwin', None, True, False),
            ('darwin', '/Volumes/SmarterWork/agent-work', False, False),
            ('darwin', '/Volumes/SmarterWork/agent-work', True, True),
        ):
            argv = ['wrapper', '--image', W.MIXED.IMAGES[1]]
            if scratch: argv += ['--scratch-dir', scratch]
            with self.subTest(platform=platform, scratch=scratch, mounted=mounted), \
                    patch.object(W, 'source_controls', return_value=True), \
                    patch.object(W, 'find_pg', return_value=PG), \
                    patch.object(W, 'run_image', return_value=0) as run, \
                    patch.object(W.sys, 'argv', argv), patch.object(W.sys, 'platform', platform), \
                    patch.object(W.os, 'geteuid', return_value=1000), \
                    patch.object(W.os.path, 'ismount', return_value=mounted), \
                    patch.object(W.os, 'access', return_value=True), \
                    patch.object(W.Path, 'is_dir', return_value=True), patch.object(W.signal, 'signal'):
                if accepted:
                    self.assertEqual(W.main(), 0)
                    run.assert_called_once_with(W.MIXED.IMAGES[1], PG, Path(scratch) if scratch else None)
                else:
                    with self.assertRaises(RuntimeError): W.main()
                    run.assert_not_called()

    def test_process_absence_requires_actual_os_observation(self):
        with patch.object(W.os, 'kill', side_effect=ProcessLookupError): self.assertTrue(W.process_absent(123))
        with patch.object(W.os, 'kill', side_effect=PermissionError): self.assertFalse(W.process_absent(123))
        with patch.object(W.os, 'kill', return_value=None): self.assertFalse(W.process_absent(123))


def lane_source_files():
    return {name:(Path(__file__).resolve().parents[2]/name).read_bytes() for name in W.LANE_INPUTS}


def lane_catalog():
    return {'qualification':'receipt_lane_catalog','original_and_candidate_compactor_checked':True,
        'unrelated_update_trigger_refused':True,'altered_binding_refusals':7,'helper_authority_drift_refusals':2,'missing_preimage_refused':True,
        'original_cohort_mismatch_reproduced':True,'reverse_prerequisite_refusals':4,
        'replay_refused':True,'existing_function_metadata_preserved':True,'guarded_and_outer_rollback_verified':True,
        'business_rows_unchanged':True,'historical_rows_qualified':False,'financial_completion_qualified':False,
        'full_qualification':False}


def lane_races():
    # Independent tiny protocol example; no database behavior is simulated/proven.
    value={'execution':EXECUTION,'qualification':'receipt_statement_lane_and_zero_rake_compatibility',
        'passed':True,'cleanup_verified':True,'source_stable':True,'full_qualification':False,
        'historical_rows_qualified':False,'financial_completion_qualified':False,
        'work_deadline_seconds':20,'cleanup_deadline_seconds':5,
        'source_sha256':{name:W.digest(data) for name,data in lane_source_files().items()},
        'backend_pids':{'observer':101,'holder':102,'writer':103},
        'environment':{'database':'qual_spin_expiry_'+EXECUTION.replace('-',''),'user':'postgres','session_user':'postgres',
                       'address':None,'port':'5432','version':170006,'others':0},
        'shared_helper_authority':{'owner':'postgres','acl':'{postgres=X/postgres,service_role=X/postgres}',
          'security_definer':False,'volatility':'v','config':['search_path=public, pg_temp'],
          'full_md5':'409b14ee72ce888d3b26524c52d49a68'},
        'clients':[{'backend_pid':pid,'client_exit':0} for pid in (101,102,103)],
        'backend_cleanup':{'backends':0,'locks':0},'verifier_client':{'backend_pid':104,'client_exit':0},
        'transcripts':{'lane_'+name+'_'+EXECUTION:'original transcript' for name in ('observer','holder','writer')},
        'cleanup_transcript':'original cleanup transcript'}
    state={'catalog':{'original':'selected'},'handler':{'owner':'postgres','acl':'{postgres=X/postgres}',
        'body_md5':'534850c97847e72075044d8604b0a09d','config':['search_path=pg_catalog, public, pg_temp'],
        'security_definer':False,'volatility':'v'},
           'business':{'public.hand_history':[],'public.settlement_idempotency_keys':[]}}
    value['before']=state;value['after']=copy.deepcopy(state)
    value['source_readback']={name:{'sha256':sha,'matches':True} for name,sha in value['source_sha256'].items()}
    cases=[]
    for name,role in [('receipt_insert','service_role'),('receipt_update','service_role'),('receipt_delete','service_role'),
                      ('history_insert','postgres'),('history_identity_update','postgres'),('history_metadata_update','postgres'),
                      ('reverse_shared_lane','postgres'),('truncate_relation_then_refusal','service_role')]:
        holder,writer=(103,102) if name=='reverse_shared_lane' else (102,103)
        row={'case':name,'role':role,'holder_pid':holder,'writer_pid':writer,'affected_rows':0}
        if name!='history_metadata_update':row['wait']={'pid':writer,'wait_event_type':'Lock','wait_event':
            'relation' if name=='truncate_relation_then_refusal' else 'advisory','blockers':[holder]}
        if name=='truncate_relation_then_refusal':row['sqlstate']='55000'
        cases.append(row)
    import uuid
    table_id=str(uuid.uuid5(uuid.UUID(EXECUTION),'receipt-lane-zero-rake-table'))
    hand_id=str(uuid.uuid5(uuid.UUID(EXECUTION),'receipt-lane-zero-rake-hand'))
    result={'success':True,'table_id':table_id,'hand_id':hand_id,
            'rake':{'success':True,'skipped':'zero_rake'},'commissions':[]}
    row={'table_id':table_id,'hand_id':hand_id,'status':'succeeded','result':result,'error':None,
         'attempt_count':1,'first_attempt_at':'2026-09-17T00:00:00+00:00',
         'last_attempt_at':'2026-09-17T00:00:00+00:00','completed_at':'2026-09-17T00:00:00+00:00'}
    one={'count':1,'rows':[{'row':row,'ctid':'(0,1)','xmin':'1234','cmin':'0'}]}
    cases.append({'case':'zero_rake_rpc_entry_and_replay','role':'service_role','holder_pid':102,'writer_pid':103,
        'wait':{'pid':103,'wait_event_type':'Lock','wait_event':'advisory','blockers':[102]},
        'before_receipt_count':0,'pre_entry_receipt_write_locks':0,'created_receipts':1,'rollback_receipts':0,'receipt_fk_count':0,
        'request_compatibility_only':True,'first_result':result,'replay_result':copy.deepcopy(result),
        'receipt_before_replay':one,'receipt_after_replay':copy.deepcopy(one)})
    value['cases']=cases
    return value


def lane_originals():
    before={'catalog':{'retained':'catalog'},'handler':None,'business':{'retained':[]},
            'relation_trigger_hints':{'hand_history':True,'settlement_idempotency_keys':False}}
    after=copy.deepcopy(before);after['relation_trigger_hints']['settlement_idempotency_keys']=True
    values={'receipt_lane_provider':{'qualification':'receipt_lane_provider','exact_authority':True,
             'financial_rows_seeded':False,'full_qualification':False},
        'receipt_lane_catalog':lane_catalog(),'receipt_lane_before':before,'receipt_lane_after':after}
    return {name:json.dumps(values[name]).encode() if name in values else b'' for name in W.LANE_STAGES}


def lane_summary():
    return {'catalog':lane_catalog(),'result_sha256':'d'*64,
            'observed_outputs':{name:'e'*64 for name in W.LANE_STAGES},'guarded_rollback_verified':True,
            'historical_rows_qualified':False,'financial_completion_qualified':False,'full_qualification':False}


def pure_source_files():
    root = Path(__file__).resolve().parents[2]
    return {name: (root / name).read_bytes() for name in W.PURE_INPUTS}


def pure_result():
    # Independent expected protocol only. The actual original SQL supplies proof.
    return {'qualification': 'spin_mixed_basis_pure_evidence', 'shape_positive': 1,
            'shape_negative': 24, 'key_scalar_controls': 17, 'private_invocation_refusals': 9,
            'relative_timestamp_regression_reproduced': True, 'relative_timestamp_refusal_verified': True,
            'installed_authority_verified': True, 'missing_preimage_refused': True,
            'duplicate_install_refused': True, 'inner_and_outer_rollback_verified': True,
            'business_rows_unchanged': True, 'historical_original_rows_qualified': False,
            'statement_lane_qualified': False, 'financial_completion_qualified': False,
            'full_qualification': False}


def retention_behavior():
    # Protocol samples only; actual SQL must produce its own original result.
    sequences = {name: {'last_value': '1', 'is_called': False} for name in (
        'public.content_authors_id_seq', 'public.managed_game_contract_versions_id_seq',
        'smarter_private.f06_lifecycle_seq')}
    return {'qualification': 'spin_history_retention_behavior', 'old_deleted': 5,
            'candidate_deleted': 2, 'canonical_cancellation_count': 2,
            'table_and_catalog_rollback_verified': True, 'sequence_counters_restored': False,
            'completed_spin_qualified': False, 'multi_session_race_qualified': False,
            'sequence_before': sequences, 'sequence_after': copy.deepcopy(sequences)}


def retention_source_files():
    root = Path(__file__).resolve().parents[2]
    names = (*W.RETENTION_INPUTS, 'scripts/qualification/spin-expiry-business-state.sql')
    return {name: (root / name).read_bytes() for name in names}


def completed_source_files():
    root = Path(__file__).resolve().parents[2]
    files = retention_source_files()
    files.update({name: (root / name).read_bytes() for name in W.COMPLETED_INPUTS})
    return files


def completed_result():
    sequences = retention_behavior()['sequence_before']
    return {'qualification': 'spin_history_retention_completed_receipt_eligibility',
            'old_deleted': 1, 'candidate_deleted': 1, 'captured_receipt_unchanged': True,
            'projection_and_catalog_rollback_verified': True,
            'starting_estate_retained_until_database_disposal': True,
            'terminal_creation_qualified': False, 'financial_lifecycle_qualified': False,
            'multi_session_race_qualified': False, 'sequence_counters_restored': False,
            'source_capture_observed_at': '2026-09-17T07:35:54.523723+00:00',
            'sequence_before': sequences, 'sequence_after': copy.deepcopy(sequences)}


def completed_receipt(source=SOURCE):
    value = receipt('preimage', source)
    value.update(image='retention-completed', business_cases=[], catalog_slice_passed=False,
                 native_status='retention_completed_eligibility_passed_cleanup_observed',
                 business_scenario_passed=False, retention_qualification=None,
                 completed_retention_qualification=completed_result())
    # Deliberately independent literal schedule: do not generate expected order
    # from the production validator's table.
    inputs = [
        ('schema_prefix', 'fixture_bootstrap', str(source.parent / 'work/schema-prefix.sql')),
        ('restore_preexisting_principals', 'fixture_bootstrap', 'principals.sql'),
        ('empty_provider_readback', 'fixture_bootstrap', 'empty-provider-check.sql'),
        ('restore_completed_start', 'fixture_bootstrap', 'scripts/qualification/fixtures/spin-history-retention/completed-start-restore.sql'),
        ('schema_suffix_all_real_triggers', 'fixture_bootstrap', str(source.parent / 'work/schema-suffix.sql')),
        ('authentic_access', 'fixture_bootstrap', 'inputs/access.sql'),
        ('authentic_policies', 'fixture_bootstrap', 'inputs/policies.sql'),
        ('current_notification_supplement', 'fixture_bootstrap', 'provider-supplement.sql'),
        ('current_tested_roles', 'fixture_bootstrap', 'provider-roles.sql'),
        ('tested_role_readback', 'fixture_bootstrap', 'provider-roles-check.sql'),
        ('current_catalog_readback', 'fixture_bootstrap', 'provider-check.sql'),
        ('authentic_spin_catalog_supplement', 'fixture_bootstrap', 'inputs/spin-catalog-supplement.sql'),
        ('authentic_entry_provider_supplement', 'fixture_bootstrap', 'inputs/entry-provider-supplement.sql'),
        ('authentic_entry_sequence_authority', 'fixture_bootstrap', 'inputs/entry-sequence-authority.sql'),
        ('authentic_settlement_source_authority', 'fixture_bootstrap', 'inputs/settle-source-authority.sql'),
        ('retention_provider_authority', 'fixture_bootstrap', 'scripts/qualification/fixtures/spin-history-retention/provider-supplement.sql'),
        ('mixed_pure_evidence_rollback', 'postgres', 'scripts/qualification/spin-mixed-basis-pure.sql'),
        ('retention_completed_eligibility', 'postgres', 'scripts/qualification/spin-history-retention-completed.sql'),
    ]
    value['stages'] = [value['stages'][0]] + [
        {'stage': name, 'returncode': 0, 'stdout_sha256': 'e' * 64,
         'argv': W.qualification_sql_argv(PG, source, EXECUTION, ORDINARY, TOURNAMENT, role, path)}
        for name, role, path in inputs]
    return value


def receipt(image='candidate', source=SOURCE):
    # Tiny protocol observations only, never evidence that SQL or refunds passed.
    sql = [str(PG / 'psql'), '-X', '-w', '-A', '-t', '-h', str(source.parent / 'work/socket'),
           '-p', '5432', '-d', 'qual_spin_expiry_' + EXECUTION.replace('-', ''),
           '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-v', 'execution_uuid=' + EXECUTION,
           '-v', 'ordinary_user_uuid=' + ORDINARY, '-v', 'tournament_uuid=' + TOURNAMENT]
    sql_inputs = {
        'spin_catalog_before': 'spin-catalog-observer.sql',
        'spin_catalog_rollback_qualification': 'scripts/qualification/spin-expiry-lock-order.sql',
        'spin_catalog_after': 'spin-catalog-observer.sql',
        'install_candidate': 'supabase/components/spin-expiry-lock-order.sql',
        'real_funded_paid_seat_fixture': 'scripts/qualification/spin-expiry-real-funded-fixture.sql',
    }
    catalog = ['spin_catalog_before', 'spin_catalog_rollback_qualification', 'spin_catalog_after']
    stages = [{'stage': name, 'returncode': 0, 'argv': sql + ['-f', str(source / sql_inputs[name])],
               'stdout_sha256': 'e' * 64}
              for name in (catalog + ['install_candidate'] if image == 'candidate' else []) + ['real_funded_paid_seat_fixture']]
    retention = [
        ('authentic_settlement_source_authority', 'fixture_bootstrap', 'inputs/settle-source-authority.sql'),
        ('retention_provider_authority', 'fixture_bootstrap', 'scripts/qualification/fixtures/spin-history-retention/provider-supplement.sql'),
        ('mixed_pure_evidence_rollback', 'postgres', 'scripts/qualification/spin-mixed-basis-pure.sql'),
        ('retention_catalog_rollback', 'postgres', 'scripts/qualification/spin-history-retention.sql'),
        ('retention_behavior_rollback', 'postgres', 'scripts/qualification/spin-history-retention-behavior.sql'),
    ]
    stages[:0] = [{'stage': name, 'returncode': 0, 'stdout_sha256': 'e' * 64,
        'argv': [str(PG / 'psql'), '-X', '-w', '-A', '-t', '-h', str(source.parent / 'work/socket'),
                 '-p', '5432', '-U', role, '-d', 'qual_spin_expiry_' + EXECUTION.replace('-', ''),
                 '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
                 '-v', 'execution_uuid=' + EXECUTION, '-v', 'ordinary_user_uuid=' + ORDINARY,
                 '-v', 'tournament_uuid=' + TOURNAMENT, '-f', str(source / path)]}
        for name, role, path in retention]
    if image=='candidate':
        lane_stages=[]
        for name,path in [
            ('receipt_lane_provider','scripts/qualification/fixtures/spin-receipt-lane/provider.sql'),
            ('receipt_lane_catalog','scripts/qualification/spin-receipt-lane.sql'),
            ('receipt_lane_before','scripts/qualification/fixtures/spin-receipt-lane/snapshot.sql'),
            ('receipt_lane_install','supabase/components/spin-mixed-basis-receipt-lane.sql'),
            ('receipt_lane_statements','scripts/qualification/spin-receipt-lane.py'),
            ('receipt_lane_rollback','supabase/components/spin-mixed-basis-receipt-lane.rollback.sql'),
            ('receipt_lane_after','scripts/qualification/fixtures/spin-receipt-lane/snapshot.sql')]:
            argv=([sys.executable,str(source/path),'--psql',str(PG/'psql'),'--execution',EXECUTION,
                   '--output',str(source.parent/'work/receipt-lane.json')] if name=='receipt_lane_statements' else
                  W.qualification_sql_argv(PG,source,EXECUTION,ORDINARY,TOURNAMENT,'postgres',path))
            lane_stages.append({'stage':name,'returncode':0,'stdout_sha256':'e'*64,'argv':argv})
        stages[3:3]=lane_stages
    endpoint = {'user': 'fixture_bootstrap', 'session_user': 'fixture_bootstrap',
                'port': '5432', 'address': None, 'listen_addresses': '',
                'autovacuum': 'off',
                'unix_socket_directories': str(source.parent / 'work/socket')}
    stages.insert(0, {'stage': 'server_endpoint_readback', 'returncode': 0,
                      'argv': W.server_endpoint_command(PG, source.parent / 'work/socket')})
    records = []
    for ordinal, case in enumerate(W.CASES[image], start=1):
        common = ['--psql', str(PG / 'psql'), '--execution', EXECUTION, '--tournament', TOURNAMENT]
        if case == 'committed-refund':
            argv = [sys.executable, str(source / 'scripts/qualification/spin-expiry-committed-refund.py')]
            argv += common + ['--journal', str(source.parent / 'work' / W.CASE_RESULTS[case])]
        else:
            argv = [sys.executable, str(source / 'scripts/qualification/spin-expiry-business-races.py')]
            argv += common + ['--image', image, '--case', case,
                              '--output', str(source.parent / 'work' / W.CASE_RESULTS[case])]
        stages.append({'stage': W.business_stage_name(case), 'returncode': 0, 'argv': argv})
        records.append({'case': case, 'execution': EXECUTION,
                        'case_identity': EXECUTION + ':' + str(ordinal) + ':' + case,
                        'state': 'passed', 'result_path': W.CASE_RESULTS[case],
                        'result_sha256': W.digest(b'unit-test case bytes')})
    return {'execution': EXECUTION, 'source_manifest_sha256': MANIFEST_SHA,
            'image': image, 'tournament': TOURNAMENT, 'catalog_slice_passed': image == 'candidate',
            'native_status': 'business_scenario_passed_cleanup_observed', 'business_scenario_passed': True,
            'business_qualified': False, 'cleanup_verified': True, 'cleanup_errors': [], 'source_stable': True,
            'full_qualification': False, 'connected_services_qualified': False,
            'execution_backend': 'hosted-owned-pg17-unix-socket',
            'hosted_cleanup_observed': True, 'original_clients_terminal': True,
            'stages': stages, 'business_cases': records, 'server_endpoint': endpoint,
            'retention_qualification': retention_behavior(), 'mixed_pure_qualification': pure_result(),
            'receipt_lane_qualification':lane_summary() if image=='candidate' else None}


class SessionEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.runners = Path(__file__).resolve().parents[2] / 'scripts' / 'qualification'
        spec = importlib.util.spec_from_file_location(
            'spin_expiry_session_controls', self.runners / 'spin-expiry-business-races.py')
        self.lib = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.lib)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root, self.home = self.allocation(self.temp.name)
        root_patch = patch.object(self.lib, 'ROOT', self.root)
        root_patch.start(); self.addCleanup(root_patch.stop)
        env_patch = patch.dict(os.environ, {
            'HOME': str(self.home), 'PGPASSWORD': 'host-secret-must-not-reach-child',
            'PGSERVICE': 'host-service', 'PGSERVICEFILE': '/host/service',
            'PGPASSFILE': '/host/password', 'PGOPTIONS': '-c role=host-role',
        }, clear=True)
        env_patch.start(); self.addCleanup(env_patch.stop)

    @staticmethod
    def allocation(folder):
        allocation = Path(folder).resolve()
        root = allocation / 'source'; root.mkdir()
        work = allocation / 'work'; work.mkdir(mode=0o700)
        home = work / 'home'; home.mkdir(mode=0o700)
        private = work / 'socket'; private.mkdir(mode=0o700)
        # Metadata-only Unix endpoint for transport preflight; no database runs.
        with socket.socket(socket.AF_UNIX) as endpoint:
            endpoint.bind(str(private / '.s.PGSQL.5432'))
        return root, home

    def test_empty_private_password_file_is_reused_without_inheriting_credentials(self):
        expected = {
            'LC_ALL': 'C', 'PGCONNECT_TIMEOUT': '2', 'PGAPPNAME': 'spin-control',
            'HOME': str(self.home), 'PGPASSFILE': str(self.home / '.spin-expiry.pgpass'),
            'PSQL_HISTORY': '/dev/null',
        }
        self.assertEqual(self.lib.psql_environment('spin-control'), expected)
        password_file = self.home / '.spin-expiry.pgpass'
        before = password_file.lstat()
        self.assertTrue(stat.S_ISREG(before.st_mode))
        self.assertEqual((before.st_uid, stat.S_IMODE(before.st_mode), before.st_size),
                         (os.geteuid(), 0o600, 0))
        self.assertEqual(password_file.read_bytes(), b'')
        self.assertEqual(self.lib.psql_environment('spin-control'), expected)
        after = password_file.lstat()
        self.assertEqual((before.st_dev, before.st_ino, before.st_mode, before.st_size, before.st_mtime_ns),
                         (after.st_dev, after.st_ino, after.st_mode, after.st_size, after.st_mtime_ns))

    def test_actual_session_launch_uses_private_environment_and_preserves_diagnostics(self):
        with patch.object(self.lib.subprocess, 'Popen') as launch, \
                patch.object(self.lib.selectors, 'DefaultSelector'), \
                patch.object(self.lib.os, 'set_blocking'):
            self.lib.Session(Path('/protected/psql'), 'qual_spin_expiry_' + EXECUTION.replace('-', ''),
                             'spin-control', 123)
        launch.assert_called_once()
        args, kwargs = launch.call_args
        self.assertEqual(args[0][:8], ['/protected/psql', '-X', '-w', '-qAt', '-h',
                                         str(self.root.parent / 'work/socket'), '-p', '5432'])
        self.assertEqual(kwargs['env'], self.lib.psql_environment('spin-control'))
        self.assertEqual(set(kwargs['env']), {'LC_ALL', 'PGCONNECT_TIMEOUT', 'PGAPPNAME',
                                             'HOME', 'PGPASSFILE', 'PSQL_HISTORY'})
        self.assertEqual(kwargs['stdin'], self.lib.subprocess.PIPE)
        self.assertEqual(kwargs['stdout'], self.lib.subprocess.PIPE)
        self.assertEqual(kwargs['stderr'], self.lib.subprocess.STDOUT)

    def test_unsafe_home_or_password_file_refuses_before_process_launch_without_truncation(self):
        for case in ('missing-home-env', 'relative-home', 'foreign-home', 'home-mode', 'home-symlink',
                     'password-symlink', 'password-directory', 'password-fifo',
                     'password-nonempty', 'password-mode'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as folder:
                root, home = self.allocation(folder)
                password_file = home / '.spin-expiry.pgpass'
                env = {'HOME': str(home)}
                preserved = None
                if case == 'missing-home-env': env = {}
                if case == 'relative-home': env['HOME'] = 'work/home'
                if case == 'foreign-home': env['HOME'] = str(root)
                if case == 'home-mode': home.chmod(0o755)
                if case == 'home-symlink':
                    real_home = home.with_name('real-home'); home.rename(real_home)
                    home.symlink_to(real_home, target_is_directory=True)
                if case == 'password-symlink':
                    preserved = home / 'unrelated-password'
                    preserved.write_bytes(b'preserve-existing-content'); preserved.chmod(0o600)
                    password_file.symlink_to(preserved)
                if case == 'password-directory': password_file.mkdir(mode=0o700)
                if case == 'password-fifo': os.mkfifo(password_file, 0o600)
                if case == 'password-nonempty':
                    preserved = password_file
                    preserved.write_bytes(b'preserve-existing-content'); preserved.chmod(0o600)
                if case == 'password-mode':
                    password_file.write_bytes(b''); password_file.chmod(0o644)
                original_open = self.lib.os.open
                def bounded_open(path, flags, *args, **kwargs):
                    # Exercise the real FIFO refusal, but fail before a blocking
                    # open if the nonblocking guard regresses.
                    if case == 'password-fifo' and not flags & os.O_CREAT:
                        self.assertNotEqual(flags & os.O_NONBLOCK, 0)
                    return original_open(path, flags, *args, **kwargs)
                with patch.object(self.lib, 'ROOT', root), patch.dict(os.environ, env, clear=True), \
                        patch.object(self.lib.os, 'open', side_effect=bounded_open), \
                        patch.object(self.lib.subprocess, 'Popen') as launch, \
                        patch.object(self.lib.selectors, 'DefaultSelector'), \
                        self.assertRaises((RuntimeError, OSError)):
                    self.lib.Session(Path('/protected/psql'), 'qual_spin_expiry_' + EXECUTION.replace('-', ''),
                                     'spin-control', 123)
                launch.assert_not_called()
                if preserved is not None:
                    self.assertEqual(preserved.read_bytes(), b'preserve-existing-content')
                if case == 'password-symlink': self.assertTrue(password_file.is_symlink())
                if case == 'password-fifo': self.assertTrue(stat.S_ISFIFO(password_file.lstat().st_mode))
                if case == 'password-mode': self.assertEqual(stat.S_IMODE(password_file.stat().st_mode), 0o644)

    def test_warning_prefixed_json_remains_a_failure(self):
        session = object.__new__(self.lib.Session)
        warning = "WARNING: password file '/dev/null' is not a plain file\n{\"ok\":true}"
        with patch.object(session, 'command', return_value=warning), \
                self.assertRaises(json.JSONDecodeError):
            session.json('SELECT original_observation;')
        with patch.object(session, 'command', return_value='ERROR: preserved diagnostic\n{"ok":true}'), \
                self.assertRaisesRegex(RuntimeError, 'unexpected SQL failure'):
            session.json('SELECT original_observation;')

    def poll_session(self):
        # Exercise actual poll/wait methods without a process or database.
        session = object.__new__(self.lib.Session)
        session.raw = bytearray(b'previous command output\n')
        session.pending = (b'__spin_fragmented_ack__', len(session.raw))
        session.deadline = 20.0
        session.selector = unittest.mock.Mock()
        session.selector.select.return_value = [(None, None)]
        session.process = unittest.mock.Mock()
        session.process.stdout.fileno.return_value = 123
        return session

    def test_poll_drains_fragmented_output_and_split_ack_without_fragment_sleeps(self):
        session = self.poll_session()
        payload = b'{"padding":"' + b'x' * (43004 - 14) + b'"}'
        marker = session.pending[0]
        wire = payload + b'\n'
        chunks = [wire[n:n + 512] for n in range(0, len(wire), 512)]
        chunks += [marker[:7], marker[7:] + b'\n', b'']
        with patch.object(self.lib.os, 'read', side_effect=chunks) as read, \
                patch.object(self.lib.time, 'monotonic', return_value=10.0), \
                patch.object(self.lib.time, 'sleep') as pause:
            self.assertEqual(session.wait().encode(), payload)
        self.assertIsNone(session.pending)
        self.assertEqual(read.call_count, len(chunks) - 1)
        session.selector.select.assert_called_once_with(0)
        pause.assert_not_called()
        self.assertEqual(session.deadline, 20.0)

    def test_poll_eagain_retains_partial_ack_until_remaining_bytes_arrive(self):
        session = self.poll_session()
        marker = session.pending[0]
        prefix = b'{"ok":true}\n' + marker[:7]
        with patch.object(self.lib.os, 'read', side_effect=[prefix, BlockingIOError()]) as read, \
                patch.object(self.lib.time, 'monotonic', return_value=10.0):
            self.assertIsNone(session.poll())
        self.assertEqual(read.call_count, 2)
        self.assertIsNotNone(session.pending)
        self.assertTrue(session.raw.endswith(prefix))
        with patch.object(self.lib.os, 'read', side_effect=[marker[7:] + b'\n', b'']) as read, \
                patch.object(self.lib.time, 'monotonic', return_value=10.0):
            self.assertEqual(session.poll(), '{"ok":true}')
        read.assert_called_once()
        self.assertIsNone(session.pending)

    def test_poll_preserves_sql_diagnostics_and_refuses_eof_before_ack(self):
        for kind in ('ERROR', 'FATAL', 'PANIC'):
            with self.subTest(kind=kind):
                session = self.poll_session()
                diagnostic = kind + ':  P0404: exact original diagnostic'
                wire = diagnostic.encode() + b'\n' + session.pending[0] + b'\n'
                with patch.object(self.lib.os, 'read', side_effect=[wire[:8], wire[8:], b'']), \
                        patch.object(self.lib.time, 'monotonic', return_value=10.0):
                    observed = session.poll()
                self.assertEqual(observed, diagnostic)
                with self.assertRaisesRegex(RuntimeError, 'unexpected SQL failure'):
                    self.lib.Session.no_errors(observed)
        session = self.poll_session()
        with patch.object(self.lib.os, 'read', side_effect=[b'{"ok":true}\n', b'']), \
                patch.object(self.lib.time, 'monotonic', return_value=10.0), \
                self.assertRaisesRegex(RuntimeError, 'terminated before command acknowledgement'):
            session.poll()
        self.assertIsNotNone(session.pending)

    def test_poll_keeps_stream_cap_and_checks_original_deadline_during_drain(self):
        self.assertEqual(self.lib.MAX_STREAM, 8 * 1024 * 1024)
        session = self.poll_session()
        session.raw = bytearray(b'x' * (self.lib.MAX_STREAM - 2))
        session.pending = (session.pending[0], len(session.raw))
        with patch.object(self.lib.os, 'read', return_value=b'abc') as read, \
                patch.object(self.lib.time, 'monotonic', return_value=10.0), \
                self.assertRaisesRegex(RuntimeError, 'session output bound exceeded'):
            session.poll()
        read.assert_called_once()
        session = self.poll_session()
        with patch.object(self.lib.os, 'read', return_value=b'x' * 512) as read, \
                patch.object(self.lib.time, 'monotonic', side_effect=[10.0, 10.0, 20.0, 20.0]), \
                patch.object(self.lib.time, 'sleep') as pause, \
                self.assertRaisesRegex(TimeoutError, 'original 20 second schedule deadline exceeded'):
            session.wait()
        read.assert_called_once()
        pause.assert_called_once_with(0.01)
        self.assertEqual(session.deadline, 20.0)

    def test_poll_yields_after_original_read_quantum_without_losing_pending_output(self):
        session = self.poll_session()
        marker = session.pending[0]
        chunks = [b'x' * 512] * 128 + [b'\n' + marker + b'\n']
        with patch.object(self.lib.os, 'read', side_effect=chunks) as read, \
                patch.object(self.lib.time, 'monotonic', return_value=10.0):
            self.assertIsNone(session.poll())
            self.assertEqual(read.call_count, 128)
            self.assertIsNotNone(session.pending)
            self.assertEqual([call.args[1] for call in read.call_args_list],
                             list(range(65536, 0, -512)))
            self.assertEqual(session.poll(), 'x' * 65536)
        self.assertEqual(read.call_count, 129)
        self.assertIsNone(session.pending)

    def test_cleanup_observes_server_exit_after_terminal_clients_without_extending_deadline(self):
        session = object.__new__(self.lib.Session)
        clock = [10.0]
        events = {}
        samples = [{'backends': 1, 'locks': 5}, {'backends': 0, 'locks': 0}]
        def observe(_sql):
            clock[0] += 0.005
            return samples.pop(0)
        def wait(seconds):
            clock[0] += seconds
        with patch.object(session, 'json', side_effect=observe) as query, \
                patch.object(self.lib.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(self.lib.time, 'sleep', side_effect=wait) as pause:
            self.lib.observe_backend_cleanup(session, '20445,20443,20441', 10.03, events)
        self.assertEqual(query.call_count, 2)
        self.assertEqual(query.call_args_list[0], query.call_args_list[1])
        sql = query.call_args.args[0]
        self.assertIn('WHERE datname=current_database() AND pid<>pg_backend_pid()', sql)
        self.assertIn('FROM pg_locks WHERE pid IN (20445,20443,20441)', sql)
        self.assertNotIn('pg_terminate_backend', sql)
        self.assertEqual(events['backend_cleanup_observations'],
                         [{'backends': 1, 'locks': 5}, {'backends': 0, 'locks': 0}])
        self.assertEqual(events['backend_cleanup'], {'backends': 0, 'locks': 0})
        pause.assert_called_once_with(0.01)
        self.assertLess(clock[0], 10.03)

    def test_cleanup_deadline_fails_with_remaining_backends_or_late_zero(self):
        for late_zero in (False, True):
            with self.subTest(late_zero=late_zero):
                session = object.__new__(self.lib.Session)
                clock = [10.0]
                events = {}
                def observe(_sql):
                    if late_zero:
                        clock[0] = 10.02
                        return {'backends': 0, 'locks': 0}
                    return {'backends': 1, 'locks': 5}
                def wait(seconds):
                    clock[0] += seconds
                with patch.object(session, 'json', side_effect=observe) as query, \
                        patch.object(self.lib.time, 'monotonic', side_effect=lambda: clock[0]), \
                        patch.object(self.lib.time, 'sleep', side_effect=wait) as pause, \
                        self.assertRaisesRegex(TimeoutError, 'before cleanup deadline'):
                    self.lib.observe_backend_cleanup(session, '20445,20443,20441', 10.015, events)
                self.assertEqual(query.call_count, 1 if late_zero else 2)
                self.assertEqual(events['backend_cleanup_observations'],
                                 [{'backends': 0, 'locks': 0}] if late_zero else
                                 [{'backends': 1, 'locks': 5}] * 2)
                self.assertEqual(events['backend_cleanup'], events['backend_cleanup_observations'][-1])
                self.assertNotIn('cleanup_verified', events)
                if late_zero:
                    pause.assert_not_called()
                else:
                    self.assertAlmostEqual(sum(call.args[0] for call in pause.call_args_list), 0.015)

    def test_begin_requires_observed_service_role_without_a_user_identity(self):
        session = object.__new__(self.lib.Session)
        original_transaction = ("BEGIN; SET LOCAL statement_timeout='8s'; "
            "SET LOCAL lock_timeout='4s'; SET LOCAL idle_in_transaction_session_timeout='12s'; "
            "SET LOCAL timezone='UTC'; SET LOCAL search_path=public,pg_temp; "
            "SET LOCAL request.jwt.claims='{}'; SET LOCAL request.jwt.claim.role=''; "
            "SET LOCAL request.jwt.claim.sub='';")
        with patch.object(session, 'command', return_value='') as command:
            session.begin()
        command.assert_called_once_with(original_transaction)
        self.assertNotIn('SET LOCAL ROLE', command.call_args.args[0])
        accepted = {'user': 'service_role', 'role': 'service_role', 'uid': None}
        with patch.object(session, 'command', side_effect=['', json.dumps(accepted)]) as command:
            session.begin(service_role=True)
        self.assertEqual(command.call_count, 2)
        transaction_sql = command.call_args_list[0].args[0]
        self.assertTrue(transaction_sql.startswith(original_transaction))
        for statement in ("SET LOCAL ROLE service_role;",
                          "SET LOCAL request.jwt.claims='{\"role\":\"service_role\"}';",
                          "SET LOCAL request.jwt.claim.role='service_role';",
                          "SET LOCAL request.jwt.claim.sub='';"):
            self.assertIn(statement, transaction_sql)
        observation_sql = ''.join(command.call_args_list[1].args[0].split())
        self.assertEqual(observation_sql,
                         "SELECTjsonb_build_object('user',current_user,'role',auth.role(),'uid',auth.uid());")
        invalid = [None, {}, [], {'role': 'service_role', 'uid': None}]
        for key, value in (('user', None), ('user', 'postgres'), ('user', 'authenticated'),
                           ('role', None), ('role', 'authenticated'), ('role', 'anon'),
                           ('uid', ORDINARY), ('uid', '')):
            invalid.append(dict(accepted, **{key: value}))
        for key in accepted:
            invalid.append({name: value for name, value in accepted.items() if name != key})
        for observed in invalid:
            with self.subTest(observed=observed), \
                    patch.object(session, 'command', side_effect=['', json.dumps(observed)]) as command, \
                    self.assertRaises(RuntimeError):
                session.begin(service_role=True)
            self.assertEqual(command.call_count, 2)
        with patch.object(session, 'command', return_value='ERROR: role setup refused') as command, \
                self.assertRaisesRegex(RuntimeError, 'unexpected SQL failure'):
            session.begin(service_role=True)
        command.assert_called_once()

    def test_refund_runner_binds_the_exact_session_implementation(self):
        spec = importlib.util.spec_from_file_location(
            'spin_expiry_refund_pin_control', self.runners / 'spin-expiry-committed-refund.py')
        refund = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(refund)
        self.assertEqual(refund.R1, self.runners / 'spin-expiry-business-races.py')
        self.assertEqual(refund.FROZEN[refund.R1], W.digest(refund.R1.read_bytes()))
        imported = refund.load(refund.R1, 'spin_expiry_refund_actual_dependency')
        with patch.object(imported, 'ROOT', self.root):
            self.assertEqual(imported.psql_environment('refund-control'),
                             self.lib.psql_environment('refund-control'))

    def test_private_socket_rejects_symlinks_permissions_foreign_owner_and_regular_endpoint(self):
        for case in ('permissive', 'symlink', 'foreign', 'regular', 'missing'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as folder:
                root, home = self.allocation(folder)
                private = root.parent / 'work/socket'
                endpoint = private / '.s.PGSQL.5432'
                if case == 'permissive': private.chmod(0o755)
                if case == 'symlink':
                    real = private.with_name('original-socket'); private.rename(real)
                    private.symlink_to(real, target_is_directory=True)
                if case in ('regular', 'missing'):
                    endpoint.unlink()
                    if case == 'regular': endpoint.write_bytes(b'not a PostgreSQL socket')
                expected_uid = os.geteuid() + (1 if case == 'foreign' else 0)
                with patch.object(self.lib, 'ROOT', root), \
                        patch.object(self.lib.os, 'geteuid', return_value=expected_uid), \
                        self.assertRaises((RuntimeError, OSError)):
                    self.lib.private_socket()

    def test_business_endpoint_rejects_tcp_wrong_database_and_identity(self):
        db = 'qual_spin_expiry_' + EXECUTION.replace('-', '')
        value = dict(database=db, user='postgres', session_user='postgres', port='5432',
                     address=None, version=170006, others=0)
        self.lib.require_private_endpoint(value, db)
        for key, changed in [('address','127.0.0.1'), ('database','postgres'),
                             ('user','fixture_bootstrap'), ('session_user','service_role'),
                             ('port','5433'), ('version',160000), ('others',1)]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.lib.require_private_endpoint(dict(value, **{key: changed}), db)


class RelationAuthorityTests(unittest.TestCase):
    def setUp(self):
        directory = Path(__file__).resolve().parents[2] / 'scripts' / 'qualification'
        spec = importlib.util.spec_from_file_location(
            'spin_expiry_relation_controls', directory / 'spin-expiry-committed-refund.py')
        self.refund = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.refund)
        captures = json.loads((directory / 'spin-expiry-committed-refund.authority.json').read_text())['captures']
        self.rows = next(c['rows'] for c in captures
                         if c['origin'] == 'fifo5-R2-current-payment-relations-1409.json')
        self.roles = {'0': 'PUBLIC', '16481': 'authenticated', '16482': 'service_role'}

    def test_retained_capture_normalizes_only_column_gaps_and_observed_role_oids(self):
        original = copy.deepcopy(self.rows)
        actual = copy.deepcopy(self.rows)
        self.assertTrue(any(c['ordinal_position'] != index
                            for row in original for index, c in enumerate(row['columns'], 1)))
        for row in actual:
            for index, column in enumerate(row['columns'], 1):
                column['ordinal_position'] = index
            for policy in row['policies'] or []:
                policy['roles'] = policy['roles'].replace('16481', '16389').replace('16482', '16390')
        actual_before = copy.deepcopy(actual)
        observed = [{'oid': '16389', 'name': 'authenticated'}, {'oid': '16390', 'name': 'service_role'}]
        observed_before = copy.deepcopy(observed)
        actual_roles = self.refund.observed_policy_roles(observed)
        self.assertEqual(actual_roles, {'0': 'PUBLIC', '16389': 'authenticated', '16390': 'service_role'})
        self.assertEqual(self.refund.CAPTURED_POLICY_ROLES, self.roles)
        expected = self.refund.relation_authority(self.rows, self.roles)
        self.assertEqual(self.refund.relation_authority(actual, actual_roles), expected)
        self.assertEqual(self.rows, original)
        self.assertEqual(actual, actual_before)
        self.assertEqual(observed, observed_before)
        self.assertEqual(len(expected), len(original))
        self.assertEqual(expected[0]['policies'][0]['roles'], ['PUBLIC'])
        for before, after in zip(original, expected):
            self.assertEqual({k: v for k, v in before.items() if k not in ('columns', 'policies')},
                             {k: v for k, v in after.items() if k not in ('columns', 'policies')})
            self.assertEqual(len(before['columns']), len(after['columns']))
            self.assertEqual(before['policies'] is None, after['policies'] is None)
            self.assertEqual(len(before['policies'] or []), len(after['policies'] or []))
            for index, (old_column, new_column) in enumerate(zip(before['columns'], after['columns']), 1):
                self.assertEqual(new_column, dict(old_column, ordinal_position=index))
            for old_policy, new_policy in zip(before['policies'] or [], after['policies'] or []):
                names = sorted(self.roles[oid] for oid in old_policy['roles'][1:-1].split(','))
                self.assertEqual(new_policy, dict(old_policy, roles=names))

    def test_real_column_and_policy_drift_remains_distinct(self):
        expected = self.refund.relation_authority(self.rows, self.roles)
        for change in ('column-order', 'type', 'default', 'nullability', 'policy-role', 'policy-expression'):
            changed = copy.deepcopy(self.rows)
            columns = changed[0]['columns']
            if change == 'column-order':
                first, second = columns[0]['ordinal_position'], columns[1]['ordinal_position']
                columns[0], columns[1] = columns[1], columns[0]
                columns[0]['ordinal_position'], columns[1]['ordinal_position'] = first, second
            if change == 'type': columns[0]['data_type'] = 'text'
            if change == 'default': columns[0]['column_default'] = None
            if change == 'nullability': columns[0]['is_nullable'] = 'YES'
            if change == 'policy-role': changed[0]['policies'][0]['roles'] = '{16482}'
            if change == 'policy-expression': changed[0]['policies'][0]['using'] = 'true'
            with self.subTest(change=change):
                self.assertNotEqual(self.refund.relation_authority(changed, self.roles), expected)

    def test_malformed_ordinals_columns_or_policy_role_arrays_refuse(self):
        for ordinal in (0, -1, True, 1.5, '1', None):
            changed = copy.deepcopy(self.rows)
            changed[0]['columns'][0]['ordinal_position'] = ordinal
            with self.subTest(ordinal=ordinal), self.assertRaises(RuntimeError):
                self.refund.relation_authority(changed, self.roles)
        for change in ('duplicate-ordinal', 'decreasing-ordinal', 'duplicate-column', 'missing-column'):
            changed = copy.deepcopy(self.rows)
            columns = changed[0]['columns']
            if change == 'duplicate-ordinal': columns[1]['ordinal_position'] = columns[0]['ordinal_position']
            if change == 'decreasing-ordinal': columns[0]['ordinal_position'] = columns[1]['ordinal_position'] + 1
            if change == 'duplicate-column': columns[1]['column_name'] = columns[0]['column_name']
            if change == 'missing-column': del columns[0]['column_name']
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                self.refund.relation_authority(changed, self.roles)
        for roles in ('{99999}', '{0,0}', '{}', '{16481,}', '{-1}', '{NULL}', '[16481]', ['16481'], None):
            changed = copy.deepcopy(self.rows)
            changed[0]['policies'][0]['roles'] = roles
            with self.subTest(roles=roles), self.assertRaises(RuntimeError):
                self.refund.relation_authority(changed, self.roles)
        for mappings in ({'0': 'authenticated', '16481': 'authenticated', '16482': 'service_role'},
                         {'0': 'PUBLIC', '16481': 'PUBLIC', '16482': 'service_role'},
                         {'0': 'PUBLIC', '16481': '', '16482': 'service_role'}):
            with self.subTest(mappings=mappings), self.assertRaises(RuntimeError):
                self.refund.relation_authority(self.rows, mappings)

    def test_observed_roles_require_exact_unique_names_and_positive_oid_bindings(self):
        good = [{'oid': '16389', 'name': 'authenticated'}, {'oid': '16390', 'name': 'service_role'}]
        invalid = [[], good[:1], good + [good[0]],
                   [good[0], {'oid': '16390', 'name': 'authenticated'}],
                   [good[0], {'oid': '16389', 'name': 'service_role'}],
                   [good[0], {'oid': '16390', 'name': 'PUBLIC'}],
                   [good[0], {'oid': '16390'}],
                   [good[0], {'name': 'service_role'}]]
        for oid in ('0', '-1', '1.5', '', 'abc', None, True):
            invalid.append([good[0], {'oid': oid, 'name': 'service_role'}])
        for observed in invalid:
            with self.subTest(observed=observed), self.assertRaises(RuntimeError):
                self.refund.observed_policy_roles(observed)


class CommittedRefundCleanupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[1] / 'qualification/spin-expiry-committed-refund.py'
        spec = importlib.util.spec_from_file_location('spin_expiry_cleanup_controls', path)
        cls.refund = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.refund)

    def test_delayed_backend_exit_retains_every_sample_without_replaying_business(self):
        verifier, journal = Mock(spec=['json']), Mock(spec=['append'])
        verifier.json.side_effect = [dict(backends=1, locks=2), dict(backends=0, locks=0)]
        clock = [10.0]
        with patch.object(self.refund.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(self.refund.time, 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0]+seconds)):
            result = self.refund.observe_original_backend_cleanup(verifier, [71, 72], True, 15.0, journal)
        self.assertEqual(result, dict(backends=0, locks=0))
        self.assertEqual(verifier.json.call_count, 2)
        self.assertEqual(verifier.json.call_args_list[0], verifier.json.call_args_list[1])
        sql = verifier.json.call_args.args[0]
        self.assertIn('pg_stat_activity', sql)
        self.assertIn('pid IN (71,72)', sql)
        self.assertTrue(sql.startswith('SELECT '))
        self.assertNotIn('fn_spin_expire', sql)
        self.assertNotIn('atomic_cancel', sql)
        samples = journal.append.call_args_list
        self.assertEqual([c.kwargs['remaining'] for c in samples],
                         [dict(backends=1, locks=2), dict(backends=0, locks=0)])
        self.assertTrue(all(c.args == ('original_backend_cleanup_sample',)
                            and c.kwargs['backend_pids'] == [71, 72]
                            and c.kwargs['client_terminal_verified'] is True for c in samples))

    def test_lingering_backend_or_lock_exhausts_original_budget_and_remains_failure(self):
        for observation in (dict(backends=1, locks=0), dict(backends=0, locks=1)):
            with self.subTest(observation=observation):
                verifier, journal = Mock(spec=['json']), Mock(spec=['append'])
                verifier.json.return_value = observation
                clock = [10.0]
                with patch.object(self.refund.time, 'monotonic', side_effect=lambda: clock[0]), \
                     patch.object(self.refund.time, 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0]+seconds)), \
                     self.assertRaisesRegex(TimeoutError, 'before cleanup deadline'):
                    self.refund.observe_original_backend_cleanup(verifier, [71, 72], True, 15.0, journal)
                self.assertEqual(clock[0], 15.0)
                self.assertGreater(verifier.json.call_count, 1)
                self.assertEqual(journal.append.call_count, verifier.json.call_count)
                self.assertEqual(journal.append.call_args.kwargs['remaining'], observation)

    def test_zero_observed_after_deadline_does_not_qualify(self):
        verifier, journal = Mock(spec=['json']), Mock(spec=['append'])
        verifier.json.return_value = dict(backends=0, locks=0)
        with patch.object(self.refund.time, 'monotonic', side_effect=[10.0, 15.1]), \
             self.assertRaises(TimeoutError):
            self.refund.observe_original_backend_cleanup(verifier, [71], True, 15.0, journal)
        journal.append.assert_called_once()

    def test_expired_budget_cannot_start_another_observation(self):
        verifier, journal = Mock(spec=['json']), Mock(spec=['append'])
        with patch.object(self.refund.time, 'monotonic', return_value=15.0), \
             self.assertRaises(TimeoutError):
            self.refund.observe_original_backend_cleanup(verifier, [71], True, 15.0, journal)
        verifier.json.assert_not_called()

    def test_missing_client_exit_cannot_be_replaced_by_zero_server_counts(self):
        verifier, journal = Mock(spec=['json']), Mock(spec=['append'])
        verifier.json.return_value = dict(backends=0, locks=0)
        with patch.object(self.refund.time, 'monotonic', return_value=10.0), \
             self.assertRaisesRegex(RuntimeError, 'clients did not all reach terminal exit'):
            self.refund.observe_original_backend_cleanup(verifier, [71], False, 15.0, journal)
        verifier.json.assert_called_once()
        self.assertIs(journal.append.call_args.kwargs['client_terminal_verified'], False)

    def test_unknown_readback_or_evidence_failure_is_not_retried_as_success(self):
        for observation in (None, {}, dict(backends=False, locks=0),
                            dict(backends='0', locks=0), dict(backends=-1, locks=0)):
            with self.subTest(observation=observation):
                verifier, journal = Mock(spec=['json']), Mock(spec=['append'])
                verifier.json.return_value = observation
                with patch.object(self.refund.time, 'monotonic', return_value=10.0), \
                     self.assertRaisesRegex(RuntimeError, 'invalid original backend cleanup observation'):
                    self.refund.observe_original_backend_cleanup(verifier, [71], True, 15.0, journal)
                verifier.json.assert_called_once()
        for failed in ('readback', 'journal'):
            verifier, journal = Mock(spec=['json']), Mock(spec=['append'])
            verifier.json.return_value = dict(backends=0, locks=0)
            (verifier.json if failed == 'readback' else journal.append).side_effect = OSError(failed)
            with self.subTest(failed=failed), \
                 patch.object(self.refund.time, 'monotonic', return_value=10.0), \
                 self.assertRaisesRegex(OSError, failed):
                self.refund.observe_original_backend_cleanup(verifier, [71], True, 15.0, journal)
            verifier.json.assert_called_once()


class TerminalObservationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[1] / 'qualification/spin-expiry-committed-refund-oracle.py'
        spec = importlib.util.spec_from_file_location('terminal_refund_oracle', path)
        cls.oracle = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.oracle)

    def reports(self):
        before = [dict(id='paid', related_entity_id=TOURNAMENT, terminal_closed_at=None, amount=1),
                  dict(id='other', related_entity_id='other-event', terminal_closed_at=None, amount=2)]
        after = copy.deepcopy(before)
        after[0]['terminal_closed_at'] = 'settled'
        after += [dict(id='refund1'), dict(id='refund2')]
        return before, after

    def test_only_exact_target_report_stamp_is_allowed(self):
        before, after = self.reports()
        original = copy.deepcopy(before)
        # The original immutable-only comparison reproduces the observed refusal.
        with self.assertRaisesRegex(RuntimeError, 'prior immutable row'):
            self.oracle.additions(before, after, 'id', 2)
        self.assertEqual(self.oracle.reporting_additions(before, after, TOURNAMENT, 'settled'), after[2:])
        self.assertEqual(before, original)

    def test_report_marker_event_money_and_unrelated_changes_refuse(self):
        for row, field, value in ((0, 'terminal_closed_at', None), (0, 'terminal_closed_at', 'wrong'),
                                  (0, 'related_entity_id', 'other-event'), (0, 'amount', 2),
                                  (1, 'terminal_closed_at', 'settled')):
            with self.subTest(row=row, field=field, value=value):
                before, after = self.reports()
                after[row][field] = value
                with self.assertRaisesRegex(RuntimeError, 'prior immutable row'):
                    self.oracle.reporting_additions(before, after, TOURNAMENT, 'settled')
        before, after = self.reports()
        with self.assertRaisesRegex(RuntimeError, 'prior immutable row'):
            self.oracle.reporting_additions(before, after[1:], TOURNAMENT, 'settled')
        before[0]['terminal_closed_at'] = 'already-closed'
        with self.assertRaisesRegex(RuntimeError, 'original report already closed'):
            self.oracle.reporting_additions(before, after, TOURNAMENT, 'settled')

    def test_elimination_sequence_requires_new_positive_unique_integer(self):
        before = [dict(id=str(i), status='playing', elimination_sequence=None) for i in range(2)]
        after = [dict(id=str(i), status='eliminated', elimination_sequence=i+10) for i in range(2)]
        self.oracle.elimination_sequences(before, after)
        for invalid in (None, 0, -1, True, '10', 1.5, 11):
            with self.subTest(invalid=invalid):
                damaged = copy.deepcopy(after)
                damaged[0]['elimination_sequence'] = invalid
                with self.assertRaisesRegex(RuntimeError, 'invalid database elimination sequence'):
                    self.oracle.elimination_sequences(before, damaged)
        for field, value in (('status', 'eliminated'), ('elimination_sequence', 4)):
            damaged = copy.deepcopy(before)
            damaged[0][field] = value
            with self.assertRaisesRegex(RuntimeError, 'original roster already eliminated'):
                self.oracle.elimination_sequences(damaged, after)
        with self.assertRaisesRegex(RuntimeError, 'elimination roster identity changed'):
            self.oracle.elimination_sequences(before, after[:1])


class FixtureSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve(); self.root.chmod(0o700)
        self.directory = self.root / 'scripts/ci/probes/spin-expiry'
        self.directory.mkdir(parents=True, mode=0o700)
        root_patch = patch.object(W, 'ROOT', self.root)
        root_patch.start(); self.addCleanup(root_patch.stop)
        # Parser/protocol bytes only. Never invoked as a native financial fixture.
        self.files = {name: ('unit input ' + name).encode() for name in W.FIXED_INPUTS}
        self.manifest = {'schemaVersion': 1, 'kind': 'spin-expiry-hosted-fixture',
                         'originManifestSha256': W.ORIGIN_MANIFEST,
                         'files': {name: W.pin(data) for name, data in self.files.items()}}
        for name, data in self.files.items():
            leaf = self.directory / name; leaf.parent.mkdir(parents=True, exist_ok=True)
            leaf.write_bytes(data)
        self.write_manifest()

    def write_manifest(self):
        self.raw = (json.dumps(self.manifest) + '\n').encode()
        (self.directory / 'manifest.json').write_bytes(self.raw)

    def test_exact_fixed_manifest_preserves_provenance_and_bytes(self):
        raw, manifest, files = W.load_fixture(self.directory)
        self.assertEqual((raw, manifest, files), (self.raw, self.manifest, self.files))
        self.assertEqual(len(files), 17)

    def test_missing_financial_authority_and_extra_leaf_refuse(self):
        for name in ('inputs/entry-sequence-authority.sql', 'inputs/settle-source-authority.sql',
                     'inputs/entry-provider-supplement.sql', 'inputs/captured-financial-store-policy.sql'):
            saved = self.manifest['files'].pop(name); self.write_manifest()
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'inventory'):
                W.load_fixture(self.directory)
            self.manifest['files'][name] = saved
        self.write_manifest()
        (self.directory / 'unreviewed.sql').write_bytes(b'no')
        with self.assertRaisesRegex(RuntimeError, 'unpinned'): W.load_fixture(self.directory)

    def test_manifest_duplicate_traversal_hash_and_origin_refuse(self):
        with self.assertRaisesRegex(RuntimeError, 'duplicate'): W.decode(b'{"files":{},"files":{}}')
        for name in ('../x', '/x', 'a/../x', 'a//x', 'manifest.json', 'a/./x'):
            with self.subTest(name=name), self.assertRaises(RuntimeError): W.safe_name(name)
        original = self.manifest['originManifestSha256']
        self.manifest['originManifestSha256'] = 'f' * 64; self.write_manifest()
        with self.assertRaisesRegex(RuntimeError, 'provenance'): W.load_fixture(self.directory)
        self.manifest['originManifestSha256'] = original; self.write_manifest()
        (self.directory / 'principals.sql').write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'leaf mismatch'): W.load_fixture(self.directory)

    def test_symlink_hardlink_foreign_and_writable_source_refuse(self):
        leaf = self.directory / 'principals.sql'
        leaf.unlink(); leaf.symlink_to(self.directory / 'provider-roles.sql')
        with self.assertRaises(RuntimeError): W.load_fixture(self.directory)
        leaf.unlink(); os.link(self.directory / 'provider-roles.sql', leaf)
        with self.assertRaises(RuntimeError): W.load_fixture(self.directory)
        leaf.unlink(); leaf.write_bytes(self.files['principals.sql']); leaf.chmod(0o666)
        with self.assertRaises(RuntimeError): W.load_fixture(self.directory)
        leaf.chmod(0o600)
        uid = os.geteuid()
        with patch.object(W.os, 'geteuid', return_value=uid + 1), self.assertRaises(RuntimeError):
            W.load_fixture(self.directory)

    def test_read_preserves_atime_and_rejects_inode_replacement(self):
        leaf = self.directory / 'principals.sql'; os.utime(leaf, ns=(1, 2_000_000_000))
        before = leaf.stat()
        self.assertEqual(W.read_regular(leaf, 1000), self.files['principals.sql'])
        after = leaf.stat()
        self.assertEqual((before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns),
                         (after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns))
        original_open = Path.open
        def replacing_open(path, *args, **kwargs):
            handle = original_open(path, *args, **kwargs)
            if path == leaf:
                replacement = leaf.with_name('new-inode')
                with original_open(replacement, 'wb') as out: out.write(self.files['principals.sql'])
                os.replace(replacement, leaf)
            return handle
        with patch.object(Path, 'open', replacing_open), self.assertRaisesRegex(RuntimeError, 'source changed'):
            W.read_regular(leaf, 1000)

    def test_staged_inventory_and_postrun_bytes_are_bound(self):
        files = dict(self.files)
        files.update({name: ('current source '+name).encode() for name in W.REPLACEMENTS})
        files.update(completed_source_files())
        files.update(pure_source_files())
        files.update(lane_source_files())
        files.update(mixed_source_files())
        files.update({name: (Path(__file__).resolve().parents[2] / name).read_bytes()
                      for name in W.FEE.INPUTS})
        manifest = {'files': {name: W.pin(data) for name,data in files.items()}}
        allocation = self.root / 'attempt'; allocation.mkdir(mode=0o700)
        raw = W.stage_packet(allocation, manifest, files)
        W.verify_packet(allocation / 'source', raw, manifest)
        leaf = allocation / 'source/inputs/schema.sql'; leaf.chmod(0o600); leaf.write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'source changed'):
            W.verify_packet(allocation / 'source', raw, manifest)
        with self.assertRaises(FileExistsError): W.stage_packet(allocation, manifest, files)

    def test_omitted_or_extra_maintained_source_cannot_stage(self):
        allocation = self.root / 'attempt'; allocation.mkdir(mode=0o700)
        with self.assertRaisesRegex(RuntimeError, 'inventory'):
            W.stage_packet(allocation, {'files':{}}, {})
        self.assertIn('scripts/qualification/spin-expiry-committed-refund-oracle.py',W.REPLACEMENTS)
        self.assertIn('supabase/components/spin-expiry-lock-order.rollback.sql',W.REPLACEMENTS)


class RetentionSourceTests(unittest.TestCase):
    def test_actual_frozen_packet_pins_and_full_relative_include_graph(self):
        files = retention_source_files()
        W.validate_retention_sources(files)
        self.assertEqual(len(W.RETENTION_INPUTS), 24)
        # The catalog's shared oracle must be staged in addition to the new packet.
        manifest = json.loads(files[W.RETENTION_MANIFEST])
        self.assertIn('scripts/qualification/spin-expiry-business-state.sql',
                      manifest['relative_include_graph']['scripts/qualification/spin-history-retention.sql'])

    def test_missing_leaf_modified_sql_manifest_and_shared_oracle_refuse(self):
        for mode in ('missing', 'modified', 'manifest', 'shared'):
            files = retention_source_files()
            name = 'scripts/qualification/fixtures/spin-history-retention/provider-closure-check.sql'
            if mode == 'missing': del files[name]
            if mode == 'modified': files[name] += b'\n'
            if mode == 'manifest': files[W.RETENTION_MANIFEST] += b'\n'
            if mode == 'shared': files['scripts/qualification/spin-expiry-business-state.sql'] += b'\n'
            with self.subTest(mode=mode), self.assertRaises(RuntimeError): W.validate_retention_sources(files)

    def test_actual_include_graph_must_match_declared_graph_even_with_rebound_manifest(self):
        files = retention_source_files()
        manifest = json.loads(files[W.RETENTION_MANIFEST])
        manifest['relative_include_graph']['scripts/qualification/spin-history-retention.sql'].pop()
        files[W.RETENTION_MANIFEST] = json.dumps(manifest).encode()
        with patch.object(W, 'RETENTION_MANIFEST_SHA256', W.digest(files[W.RETENTION_MANIFEST])):
            with self.assertRaisesRegex(RuntimeError, 'include graph'):
                W.validate_retention_sources(files)

    def test_original_psql_output_requires_one_strict_result_and_catalog_marker(self):
        marker = W.RETENTION_CATALOG_MARKER.encode() + b'\n'
        raw = json.dumps(retention_behavior()).encode() + b'\n'
        self.assertEqual(W.retention_output(b'BEGIN\nROLLBACK\n' + marker, b'SET\n' + raw), retention_behavior())
        # Native psql setup emits multiple columns, not another JSON result.
        # Keep every diagnostic value while explicitly tagging those rows.
        claims = ((b'retention_setup_claims',
                   b'{"sub": "47965354-0e56-43ef-931c-ddaab82af765", "role": "service_role"}'
                   b'|47965354-0e56-43ef-931c-ddaab82af765|service_role\n'),
                  (b'retention_cancel_claims', b'{"role":"service_role"}|service_role|\n'))
        tagged = b''.join(label + b'|' + row for label, row in claims)
        self.assertEqual(W.retention_output(marker, tagged + raw), retention_behavior())
        for _, row in claims:
            with self.subTest(claims=row), self.assertRaises(ValueError):
                W.retention_output(marker, row + raw)
        for catalog, behavior in ((b'', raw), (marker * 2, raw), (marker, b'SET\n'),
                                  (marker, raw * 2), (marker, b'{bad JSON}'),
                                  (marker, b'{"qualification":1,"qualification":2}')):
            with self.subTest(catalog=catalog, behavior=behavior), self.assertRaises((RuntimeError, ValueError)):
                W.retention_output(catalog, behavior)

    def test_wrong_deletion_counts_overclaims_and_lossy_sequence_observations_refuse(self):
        changes = [('old_deleted', 2), ('candidate_deleted', 5), ('canonical_cancellation_count', 0),
                   ('table_and_catalog_rollback_verified', False), ('sequence_counters_restored', True),
                   ('completed_spin_qualified', True), ('multi_session_race_qualified', True),
                   ('candidate_deleted', 2.0)]
        for key, value in changes:
            wrong = retention_behavior(); wrong[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(RuntimeError):
                W.validate_retention_behavior(wrong)
        for mode in ('missing', 'numeric', 'overflow', 'called', 'extra'):
            wrong = retention_behavior(); observed = wrong['sequence_after']
            row = observed['public.content_authors_id_seq']
            if mode == 'missing': observed.pop('smarter_private.f06_lifecycle_seq')
            if mode == 'numeric': row['last_value'] = 1
            if mode == 'overflow': row['last_value'] = '9223372036854775808'
            if mode == 'called': row['is_called'] = 1
            if mode == 'extra': wrong['invented_success'] = True
            with self.subTest(mode=mode), self.assertRaises(RuntimeError): W.validate_retention_behavior(wrong)


class ReceiptTests(unittest.TestCase):
    def validate(self, value):
        return W.validate_receipt(value, EXECUTION, ORDINARY, TOURNAMENT, value.get('image'),
                                  MANIFEST_SHA, SOURCE, PG)

    def test_separate_images_do_not_claim_full_qualification(self):
        self.validate(receipt('preimage'))
        self.validate(receipt())

    def test_wrong_identity_failed_unknown_or_overclaim_refuses(self):
        for key, value in [('execution', ORDINARY), ('source_manifest_sha256', 'c' * 64),
                           ('native_status', 'failed_or_unknown'), ('business_scenario_passed', False),
                           ('tournament', ORDINARY), ('business_qualified', True),
                           ('cleanup_verified', False), ('cleanup_errors', ['fast stop failed']),
                           ('source_stable', False), ('full_qualification', True),
                           ('connected_services_qualified', True),
                           ('execution_backend','retired-service'), ('hosted_cleanup_observed',False),
                           ('original_clients_terminal',False)]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.validate(dict(receipt(), **{key: value}))

    def test_stage_identity_order_and_original_outcome_required(self):
        for mode in ('missing', 'repeated', 'wrong-user', 'failed', 'order'):
            value = receipt()
            if mode == 'missing': value['stages'].pop()
            if mode == 'repeated': value['stages'].append(copy.deepcopy(value['stages'][0]))
            if mode == 'wrong-user':
                argv = next(stage for stage in value['stages'] if stage['stage'] == 'spin_catalog_before')['argv']
                argv[argv.index('ordinary_user_uuid=' + ORDINARY)] = 'ordinary_user_uuid=' + EXECUTION
            if mode == 'failed': value['stages'][0]['returncode'] = 1
            if mode == 'order': value['stages'].reverse()
            with self.subTest(mode=mode), self.assertRaises(RuntimeError): self.validate(value)

    def test_each_case_requires_original_identity_order_outcome_and_bytes(self):
        for mode in ('missing', 'failed', 'repeated', 'early', 'wrong-execution', 'wrong-case-id', 'path', 'hash'):
            value = receipt()
            if mode == 'missing': value['business_cases'].pop()
            if mode == 'failed': value['business_cases'][-1]['state'] = 'running'
            if mode == 'repeated': value['business_cases'].append(copy.deepcopy(value['business_cases'][-1]))
            if mode == 'early': value['business_cases'].reverse()
            if mode == 'wrong-execution': value['business_cases'][0]['execution'] = ORDINARY
            if mode == 'wrong-case-id': value['business_cases'][0]['case_identity'] = EXECUTION + ':2:order'
            if mode == 'path': value['business_cases'][-1]['result_path'] = '../receipt.json'
            if mode == 'hash': value['business_cases'][-1]['result_sha256'] = None
            with self.subTest(mode=mode), self.assertRaises(RuntimeError): self.validate(value)

    def test_catalog_requires_one_success_before_install_and_equal_original_observers(self):
        for mode in ('flag', 'missing', 'repeated', 'late', 'failed', 'drift', 'wrong-source', 'preimage'):
            value = receipt()
            stages = value['stages']
            qualification = next(stage for stage in stages if stage['stage'] == 'spin_catalog_rollback_qualification')
            after = next(stage for stage in stages if stage['stage'] == 'spin_catalog_after')
            if mode == 'flag': value['catalog_slice_passed'] = False
            if mode == 'missing': stages.remove(qualification)
            if mode == 'repeated': stages.append(copy.deepcopy(qualification))
            if mode == 'late': stages.remove(qualification); stages.append(qualification)
            if mode == 'failed': qualification['returncode'] = 3
            if mode == 'drift': after['stdout_sha256'] = 'd' * 64
            if mode == 'wrong-source': qualification['argv'][-1] = '/old-provider/qualifier.sql'
            if mode == 'preimage': value = receipt('preimage'); value['catalog_slice_passed'] = True
            with self.subTest(mode=mode), self.assertRaises(RuntimeError): self.validate(value)

    def test_retention_stages_require_exact_role_order_identity_and_original_success(self):
        for name in ('authentic_settlement_source_authority', 'retention_provider_authority',
                     'retention_catalog_rollback', 'retention_behavior_rollback'):
            for mode in ('missing', 'repeated', 'early', 'late', 'failed', 'role', 'endpoint', 'source', 'hash'):
                value = receipt(); stages = value['stages']
                stage = next(item for item in stages if item['stage'] == name)
                if mode == 'missing': stages.remove(stage)
                if mode == 'repeated': stages.append(copy.deepcopy(stage))
                if mode == 'early': stages.remove(stage); stages.insert(0, stage)
                if mode == 'before-provider':
                    stages.remove(stage); stages.insert(next(i for i,x in enumerate(stages) if x['stage']=='retention_provider_authority'),stage)
                if mode == 'late': stages.remove(stage); stages.append(stage)
                if mode == 'failed': stage['returncode'] = 1
                if mode == 'role': stage['argv'][stage['argv'].index('-U') + 1] = 'service_role'
                if mode == 'endpoint': stage['argv'][stage['argv'].index('-h') + 1] = '127.0.0.1'
                if mode == 'source': stage['argv'][-1] = '/old/retention.sql'
                if mode == 'hash': stage.pop('stdout_sha256')
                with self.subTest(stage=name, mode=mode), self.assertRaises(RuntimeError): self.validate(value)
        for value in (None, {}, dict(retention_behavior(), table_and_catalog_rollback_verified=False)):
            with self.subTest(result=value), self.assertRaises(RuntimeError):
                self.validate(dict(receipt(), retention_qualification=value))

    def test_original_business_cli_is_bound_to_exact_image_and_fixture(self):
        for marker, replacement in (('--execution', ORDINARY), ('--tournament', ORDINARY),
                                    ('--image', 'preimage'), ('--case', 'timeout')):
            value = receipt()
            stage = next(s for s in value['stages'] if s['stage'] == 'actual_business_order')
            stage['argv'][stage['argv'].index(marker) + 1] = replacement
            with self.subTest(marker=marker), self.assertRaises(RuntimeError): self.validate(value)
        value = receipt('preimage')
        value['stages'].insert(0, {'stage': 'install_candidate', 'returncode': 0, 'argv': []})
        with self.assertRaises(RuntimeError): self.validate(value)



class HostedLifecycleTests(unittest.TestCase):
    def test_private_fixture_requires_observed_background_maintenance_off(self):
        socket_path = SOURCE.parent / 'work/socket'
        for setting in (None, 'on'):
            value = dict(receipt('preimage')['server_endpoint'])
            value.pop('autovacuum', None)
            if setting is not None:
                value['autovacuum'] = setting
            with self.subTest(autovacuum=setting), self.assertRaises(RuntimeError):
                W.validate_server_endpoint(value, socket_path)
        self.assertIn("'autovacuum',current_setting('autovacuum')", W.SERVER_ENDPOINT_QUERY)

    def test_bootstrap_endpoint_preserves_listener_socket_and_diagnostic_identity_controls(self):
        socket_path = SOURCE.parent / 'work/socket'
        value = dict(user='fixture_bootstrap', session_user='fixture_bootstrap',
                     port='5432', address=None, listen_addresses='',
                     autovacuum='off',
                     unix_socket_directories=str(socket_path))
        W.validate_server_endpoint(value, socket_path)
        for key, changed in [('listen_addresses','127.0.0.1'), ('unix_socket_directories','/tmp'),
                             ('address','127.0.0.1'), ('port','5433'), ('user','postgres'),
                             ('session_user','postgres')]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                W.validate_server_endpoint(dict(value, **{key: changed}), socket_path)
        for changed in (None, {}, dict(value, unobserved=True)):
            with self.subTest(value=changed), self.assertRaises(RuntimeError):
                W.validate_server_endpoint(changed, socket_path)
        for key in value:
            changed = dict(value); del changed[key]
            with self.subTest(missing=key), self.assertRaises(RuntimeError):
                W.validate_server_endpoint(changed, socket_path)

    def test_privileged_endpoint_readback_is_required_before_business(self):
        good = receipt('preimage')
        mutations = []
        missing = copy.deepcopy(good); del missing['server_endpoint']; mutations.append(missing)
        missing = copy.deepcopy(good); missing['stages'].pop(0); mutations.append(missing)
        duplicate = copy.deepcopy(good); duplicate['stages'].insert(0, copy.deepcopy(duplicate['stages'][0])); mutations.append(duplicate)
        failed = copy.deepcopy(good); failed['stages'][0]['returncode'] = 1; mutations.append(failed)
        wrong_role = copy.deepcopy(good); command = wrong_role['stages'][0]['argv']; command[command.index('-U') + 1] = 'postgres'; mutations.append(wrong_role)
        wrong_socket = copy.deepcopy(good); command = wrong_socket['stages'][0]['argv']; command[command.index('-h') + 1] = '/tmp'; mutations.append(wrong_socket)
        late = copy.deepcopy(good); late['stages'].append(late['stages'].pop(0)); mutations.append(late)
        for changed in mutations:
            with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                W.validate_receipt(changed, EXECUTION, ORDINARY, TOURNAMENT,
                                   'preimage', MANIFEST_SHA, SOURCE, PG)

    def test_cleanup_first_failure_and_original_deadline_are_sticky(self):
        W.cleanup_negative_controls()
        outcome=W.CleanupOutcome(); outcome.failed('first failure'); outcome.observed_stopped()
        self.assertFalse(outcome.qualifies()); self.assertEqual(outcome.errors,['first failure'])
        self.assertEqual(W.command_budget(30,20,10),7)
        with self.assertRaises(TimeoutError): W.command_budget(30,27,10)

    def test_forced_client_cleanup_never_erases_failure_and_reaps_original_handle(self):
        class Client:
            pid = 12345
            def __init__(self, code): self.returncode = code; self.waits = 0
            def poll(self): return self.returncode
            def wait(self, timeout): self.waits += 1; self.returncode = -9; return -9
        client = Client(None); entry = {}; outcome = W.CleanupOutcome()
        with patch.object(W.os, 'killpg') as kill, \
                patch.object(W, 'process_group_absent', return_value=True), \
                patch.object(W.time, 'monotonic', return_value=1):
            self.assertTrue(W.finish_clients([(client,entry)], 30, outcome))
        kill.assert_called_once_with(client.pid, signal.SIGKILL)
        self.assertEqual(client.waits, 1); self.assertEqual(entry['terminal_returncode'], -9)
        outcome.observed_stopped()
        self.assertFalse(outcome.qualifies()); self.assertEqual(len(outcome.errors),1)
        # A live group exhausts the original deadline; it never earns a new one.
        client = Client(0); outcome = W.CleanupOutcome()
        with patch.object(W.os,'killpg'),patch.object(W,'process_group_absent',return_value=False), \
                patch.object(W.time,'monotonic',return_value=30):
            self.assertFalse(W.finish_clients([(client,{})],30,outcome))
        self.assertFalse(outcome.qualifies())

    def test_sequence_numeric_authority_refuses_rounded_bigints(self):
        row={'start':'1','increment':'1','minimum':'1','maximum':'9223372036854775807',
             'cache':'1','type':'bigint','cycle':False}
        W.sequence_negative_controls(row)

    def test_uuid_collision_with_canonical_refund_actor_refuses(self):
        with patch.object(W.uuid,'uuid4',side_effect=[EXECUTION,ORDINARY,W.REFUND_ACTOR]), \
                self.assertRaisesRegex(RuntimeError,'collision'): W.new_identity('candidate')
        with patch.object(W.uuid,'uuid4',side_effect=[EXECUTION,ORDINARY,TOURNAMENT]):
            args=W.new_identity('candidate')
        self.assertEqual((args.execution,args.ordinary_user,args.tournament),(EXECUTION,ORDINARY,TOURNAMENT))

    def test_still_live_process_group_is_not_terminal_evidence(self):
        with patch.object(W.os,'killpg',return_value=None): self.assertFalse(W.process_group_absent(123))
        with patch.object(W.os,'killpg',side_effect=ProcessLookupError): self.assertTrue(W.process_group_absent(123))
        with patch.object(W.os,'killpg',side_effect=PermissionError), self.assertRaises(PermissionError):
            W.process_group_absent(123)

    def test_case_original_failure_identity_and_financial_state_refuse(self):
        good={'scenario_observed':True,'cleanup_verified':True,'source_stable':True,
              'execution':EXECUTION,'fixture_tournament':TOURNAMENT,'image':'candidate','case':'timeout',
              'selected_before':{'amount':'2.00'},'selected_after':{'amount':'2.00'},
              'authority_before':{'function':'exact'},'authority_after':{'function':'exact'}}
        W.validate_case_result('timeout',json.dumps(good).encode(),EXECUTION,TOURNAMENT,'candidate')
        for key,value in [('scenario_observed',False),('cleanup_verified',False),('execution',ORDINARY),
                          ('selected_after',{'amount':'2.01'}),('authority_after',{'function':'changed'})]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                W.validate_case_result('timeout',json.dumps(dict(good,**{key:value})).encode(),EXECUTION,TOURNAMENT,'candidate')
        records=[{'execution':EXECUTION,'tournament':TOURNAMENT},
                 {'event':'terminal_source_oracle_result','observed':True,
                  'client_and_server_cleanup':True,'source_stable':True}]
        raw=lambda rs:'\n'.join(json.dumps(x) for x in rs).encode()
        W.validate_case_result('committed-refund',raw(records),EXECUTION,TOURNAMENT,'candidate')
        for key,value in [('observed',False),('client_and_server_cleanup',False),('source_stable',False),
                          ('event','commit_intent')]:
            damaged=copy.deepcopy(records);damaged[-1][key]=value
            with self.subTest(key=key),self.assertRaises(RuntimeError):
                W.validate_case_result('committed-refund',raw(damaged),EXECUTION,TOURNAMENT,'candidate')

    def test_every_candidate_case_retains_its_exact_stage_logs(self):
        value = receipt()
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder).resolve() / 'work'; work.mkdir(mode=0o700)
            out = work.parent / 'out'; out.mkdir(mode=0o700)
            (work / 'receipt.json').write_text(json.dumps(value))
            (work / W.LANE_RESULT).write_text('original lane result')
            for stage in value['stages']:
                for suffix in ('.stdout', '.stderr'):
                    (work / (stage['stage'] + suffix)).write_bytes(b'bounded case evidence')
            for case in value['business_cases']:
                (work / case['result_path']).write_bytes(b'original case result')
            kept = W.retained_evidence(work, out, value, b'{}')
            for stage in value['stages']:
                for suffix in ('.stdout', '.stderr'):
                    self.assertIn(stage['stage'] + suffix, kept)
            self.assertIn('committed-refund.jsonl', kept)

    def test_evidence_never_exports_pgdata_private_home_or_unrelated_file(self):
        with tempfile.TemporaryDirectory() as folder:
            work=Path(folder).resolve()/'work';work.mkdir(mode=0o700)
            out=work.parent/'out';out.mkdir(mode=0o700)
            for name in ['receipt.json','postgres.log','business-order.json','native.stdout','native.stderr']:
                (work/name).write_bytes(b'bounded original evidence')
            (work/'data').mkdir();(work/'data/PG_VERSION').write_bytes(b'17')
            (work/'home').mkdir();(work/'home/.spin-expiry.pgpass').write_bytes(b'')
            (work/'unrelated').write_bytes(b'not uploaded')
            kept=W.retained_evidence(work,out,{'stages':[{'stage':'native'}]},b'{}')
            self.assertEqual(set(kept),{'receipt.json','postgres.log','business-order.json','native.stdout','native.stderr'})
            self.assertFalse((out/'data').exists());self.assertFalse((out/'home').exists());self.assertFalse((out/'unrelated').exists())

    def test_all_images_run_in_order_and_stop_after_first_failure(self):
        scenarios=[([0]*index+[1],list(W.IMAGES[:index+1])) for index in range(len(W.IMAGES))]
        scenarios.append(([0]*len(W.IMAGES),list(W.IMAGES)))
        for outcomes,expected in scenarios:
            with self.subTest(outcomes=outcomes),patch.object(W,'source_controls',return_value=True), \
                    patch.object(W,'find_pg',return_value=PG),patch.object(W,'run_image',side_effect=outcomes) as run, \
                    patch.object(W.sys,'argv',['wrapper']),patch.object(W.sys,'platform','linux'), \
                    patch.object(W.os,'geteuid',return_value=1000),patch.object(W.signal,'signal'):
                result=W.main()
                self.assertEqual([call.args[0] for call in run.call_args_list],expected)
                self.assertEqual(result,1 if 1 in outcomes else 0)

    def test_failed_source_controls_prevent_native_allocation(self):
        with patch.object(W,'source_controls',return_value=False),patch.object(W,'run_image') as run, \
                patch.object(W.sys,'argv',['wrapper']):
            self.assertEqual(W.main(),1)
        run.assert_not_called()


class CompletedRetentionTests(unittest.TestCase):
    def validate(self, value):
        return W.validate_receipt(value, EXECUTION, ORDINARY, TOURNAMENT,
                                  'retention-completed', MANIFEST_SHA, SOURCE, PG)

    def test_success_is_receipt_eligibility_only_with_no_business_cases(self):
        self.assertEqual(self.validate(completed_receipt()), [])
        self.assertEqual(W.completed_retention_output(json.dumps(completed_result()).encode()), completed_result())
        self.assertEqual(W.IMAGES[:3], ('preimage', 'candidate', 'retention-completed'))
        self.assertEqual({image:W.CASES[image] for image in W.IMAGES[:3]}, {'preimage': ('order',), 'candidate': ('order', 'timeout', 'committed-refund'),
                                  'retention-completed': ()})

    def test_exact_source_pins_and_every_relative_include_are_staged(self):
        files = completed_source_files()
        W.validate_completed_sources(files)
        manifest = W.decode(files[W.COMPLETED_MANIFEST])
        self.assertEqual(len(manifest['files']), 6)
        self.assertTrue(set(W.COMPLETED_INPUTS) <= set(W.REPLACEMENTS))
        for name in W.COMPLETED_INPUTS:
            missing = dict(files); del missing[name]
            with self.subTest(missing=name), self.assertRaises(RuntimeError): W.validate_completed_sources(missing)
            changed = dict(files); changed[name] += b'changed'
            with self.subTest(changed=name), self.assertRaises(RuntimeError): W.validate_completed_sources(changed)
        for shared in ('database-state.sql', 'component-inputs.sql'):
            changed = dict(files)
            changed['scripts/qualification/fixtures/spin-history-retention/' + shared] += b'changed'
            with self.subTest(shared=shared), self.assertRaises(RuntimeError): W.validate_completed_sources(changed)

        files = completed_source_files(); manifest = W.decode(files[W.COMPLETED_MANIFEST])
        manifest['consumed_retention_manifest']['sha256'] = '0' * 64
        files[W.COMPLETED_MANIFEST] = json.dumps(manifest).encode()
        with patch.object(W, 'COMPLETED_MANIFEST_SHA256', W.digest(files[W.COMPLETED_MANIFEST])), \
                self.assertRaisesRegex(RuntimeError, 'dependency revision'):
            W.validate_completed_sources(files)

    def test_include_graph_rejects_undeclared_or_missing_include_even_if_rebound(self):
        for include in ('completed-start-authority.json', '../../../../missing.sql'):
            files = completed_source_files(); manifest = W.decode(files[W.COMPLETED_MANIFEST])
            name = W.COMPLETED_RESTORE
            files[name] += ('\n\\ir ' + include + '\n').encode()
            manifest['files'][name] = W.pin(files[name])
            files[W.COMPLETED_MANIFEST] = json.dumps(manifest).encode()
            with patch.object(W, 'COMPLETED_MANIFEST_SHA256', W.digest(files[W.COMPLETED_MANIFEST])), \
                    self.assertRaises(RuntimeError): W.validate_completed_sources(files)

    def test_each_phase_requires_original_role_source_success_identity_and_order(self):
        for name in W.completed_sql_stages(SOURCE):
            for mode in ('missing', 'repeated', 'early', 'late', 'failed', 'role', 'endpoint', 'source', 'hash'):
                value = completed_receipt(); stages = value['stages']
                stage = next(item for item in stages if item['stage'] == name)
                if mode == 'missing': stages.remove(stage)
                if mode == 'repeated': stages.append(copy.deepcopy(stage))
                if mode == 'early': stages.remove(stage); stages.insert(0, stage)
                if mode == 'before-provider':
                    stages.remove(stage); stages.insert(next(i for i,x in enumerate(stages) if x['stage']=='retention_provider_authority'),stage)
                if mode == 'late':
                    # Move before the prior phase; moving the last stage to the
                    # end would not mutate the protocol.
                    index = stages.index(stage); stages[index-1], stages[index] = stage, stages[index-1]
                if mode == 'failed': stage['returncode'] = 1
                if mode == 'role': stage['argv'][stage['argv'].index('-U') + 1] = 'service_role'
                if mode == 'endpoint': stage['argv'][stage['argv'].index('-h') + 1] = '127.0.0.1'
                if mode == 'source': stage['argv'][-1] = '/old/retention.sql'
                if mode == 'hash': stage.pop('stdout_sha256')
                with self.subTest(stage=name, mode=mode), self.assertRaises(RuntimeError): self.validate(value)

    def test_completed_estate_cannot_reach_money_or_unfinished_cases(self):
        for stage in ('real_funded_paid_seat_fixture', 'actual_business_order', 'actual_business_committed_refund',
                      'spin_catalog_before', 'install_candidate', 'retention_catalog_rollback', 'retention_behavior_rollback'):
            value = completed_receipt(); value['stages'].append({'stage': stage, 'returncode': 0, 'argv': []})
            with self.subTest(stage=stage), self.assertRaises(RuntimeError): self.validate(value)
        for key, bad in (('natural_aging', {}), ('business_scenario_passed', True), ('business_qualified', True),
                         ('full_qualification', True), ('catalog_slice_passed', True), ('retention_qualification', retention_behavior()),
                         ('cleanup_errors', ['original stop failed']), ('cleanup_verified', False),
                         ('hosted_cleanup_observed', False), ('original_clients_terminal', False),
                         ('source_stable', False), ('native_status', 'business_scenario_passed_cleanup_observed')):
            with self.subTest(key=key), self.assertRaises(RuntimeError): self.validate(dict(completed_receipt(), **{key: bad}))
        for image in ('preimage', 'candidate'):
            for stage in ('restore_completed_start', 'retention_completed_eligibility'):
                value = receipt(image); value['stages'].append({'stage': stage, 'returncode': 0, 'argv': []})
                with self.subTest(image=image, stage=stage), self.assertRaises(RuntimeError):
                    W.validate_receipt(value, EXECUTION, ORDINARY, TOURNAMENT, image, MANIFEST_SHA, SOURCE, PG)

    def test_result_refuses_changed_receipt_missing_rollback_overclaims_and_duplicate_json(self):
        for key, value in completed_result().items():
            if key.startswith('sequence_') and isinstance(value, dict): continue
            changed = completed_result(); changed[key] = not value if type(value) is bool else None
            with self.subTest(key=key), self.assertRaises(RuntimeError): W.validate_completed_retention(changed)
        for key in ('sequence_before', 'sequence_after'):
            for wrong in (None, {}, {'last_value': 1}):
                with self.subTest(key=key, wrong=wrong), self.assertRaises(RuntimeError):
                    W.validate_completed_retention(dict(completed_result(), **{key: wrong}))
        good = json.dumps(completed_result()).encode()
        for output in (b'', good + b'\n' + good, good.replace(b'"old_deleted": 1', b'"old_deleted": 1, "old_deleted": 1')):
            with self.subTest(output=output), self.assertRaises(RuntimeError): W.completed_retention_output(output)

    def test_completed_original_output_and_cleanup_required_before_allocation_disposal(self):
        # Only the adapter protocol is simulated; no PG command executes.
        for mode in ('success', 'changed-output', 'failed-cleanup', 'changed-pure-output', 'missing-pure-output'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as folder:
                root = Path(folder).resolve(); allocation = root / 'allocation'; allocation.mkdir(mode=0o700)
                args = W.argparse.Namespace(execution=EXECUTION, ordinary_user=ORDINARY,
                                            tournament=TOURNAMENT, image='retention-completed')
                def staged(allocation, manifest, files):
                    (allocation / 'source').mkdir(mode=0o700)
                    return b'{}'
                def qualified(args, allocation, raw, manifest, pg):
                    work = allocation / 'work'; work.mkdir(mode=0o700)
                    value = completed_receipt(allocation / 'source')
                    value['source_manifest_sha256'] = W.digest(raw)
                    if mode == 'failed-cleanup': value['cleanup_errors'] = ['original fast-stop failure']
                    for stage in value['stages']:
                        output = (json.dumps(completed_result()).encode() if stage['stage'] == 'retention_completed_eligibility'
                                  else json.dumps(pure_result()).encode() if stage['stage'] == W.PURE_STAGE
                                  else b'original protocol output')
                        stage['stdout_sha256'] = W.digest(output)
                        if mode == 'changed-output' and stage['stage'] == 'retention_completed_eligibility': output += b'changed'
                        if mode == 'changed-pure-output' and stage['stage'] == W.PURE_STAGE: output += b'changed'
                        if not (mode == 'missing-pure-output' and stage['stage'] == W.PURE_STAGE):
                            (work / (stage['stage'] + '.stdout')).write_bytes(output)
                        (work / (stage['stage'] + '.stderr')).write_bytes(b'')
                    (work / 'receipt.json').write_text(json.dumps(value))
                    return value
                with patch.object(W, 'ROOT', root), patch.object(W, 'new_identity', return_value=args), \
                        patch.object(W, 'source_packet', return_value=({'files': {}}, {})), \
                        patch.object(W.tempfile, 'mkdtemp', return_value=str(allocation)), \
                        patch.object(W, 'stage_packet', side_effect=staged), patch.object(W, 'qualify', side_effect=qualified):
                    result = W.run_image('retention-completed', PG)
                self.assertEqual(result, 0 if mode == 'success' else 1)
                self.assertEqual(allocation.exists(), mode != 'success')
                output = root / 'artifacts/spin-expiry' / EXECUTION
                if mode == 'missing-pure-output':
                    # Incomplete original logs refuse export/disposal; the exact
                    # receipt and remaining evidence stay in the owned allocation.
                    self.assertTrue((allocation / 'work/receipt.json').exists())
                    self.assertFalse((output / 'receipt.json').exists())
                else:
                    self.assertTrue((output / 'receipt.json').exists())
                    self.assertTrue((output / 'retention_completed_eligibility.stdout').exists())
                self.assertEqual(json.loads((output / 'RESULT.json').read_text())['passed'], mode == 'success')


class PureEvidenceTests(unittest.TestCase):
    def validate(self, value, image='candidate'):
        return W.validate_receipt(value, EXECUTION, ORDINARY, TOURNAMENT, image,
                                  MANIFEST_SHA, SOURCE, PG)

    def test_exact_sources_embedded_bodies_and_include_graph(self):
        files = pure_source_files()
        W.validate_pure_sources(files)
        self.assertEqual(set(W.decode(files[W.PURE_MANIFEST])['files']),
                         {W.PURE_COMPONENT, W.PURE_SHAPE, W.PURE_PREIMAGE, W.PURE_QUALIFIER, W.PURE_ORACLE})
        self.assertFalse(any('terminal' in name or 'receipt-lane' in name for name in W.PURE_INPUTS))
        for name in W.PURE_INPUTS:
            missing = dict(files); missing.pop(name)
            modified = dict(files); modified[name] += b'changed'
            for value in (missing, modified):
                with self.subTest(name=name), self.assertRaises(RuntimeError): W.validate_pure_sources(value)

    def test_rebound_manifest_cannot_hide_embedded_authority_or_include_drift(self):
        for mode in ('component', 'shape', 'preimage', 'embedded_preimage', 'preimage_commit', 'preimage_error', 'include', 'scope', 'role'):
            files = pure_source_files(); manifest = W.decode(files[W.PURE_MANIFEST])
            if mode in ('component', 'shape'):
                path = W.PURE_COMPONENT if mode == 'component' else W.PURE_SHAPE
                files[path] += b'-- source no longer matches embedded body\n'
                manifest['files'][path] = W.pin(files[path])
            if mode == 'preimage':
                # Even rebinding the manifest cannot redefine the original HEAD bytes.
                files[W.PURE_PREIMAGE] += b'-- original authority changed\n'
                manifest['files'][W.PURE_PREIMAGE] = W.pin(files[W.PURE_PREIMAGE])
                manifest['regression_preimage']['sha256'] = W.digest(files[W.PURE_PREIMAGE])
            if mode == 'embedded_preimage':
                files[W.PURE_QUALIFIER] = files[W.PURE_QUALIFIER].replace(
                    b'$mixed_preimage_source$-- SOURCE-ONLY', b'$mixed_preimage_source$-- CHANGED', 1)
                manifest['files'][W.PURE_QUALIFIER] = W.pin(files[W.PURE_QUALIFIER])
            if mode == 'preimage_commit': manifest['regression_preimage']['commit'] = '0' * 40
            if mode == 'preimage_error': manifest['regression_preimage']['control_sqlstate'] = 'P0001'
            if mode == 'include':
                files[W.PURE_QUALIFIER] += b'\n\\ir spin-mixed-basis-terminal.sql\n'
                manifest['files'][W.PURE_QUALIFIER] = W.pin(files[W.PURE_QUALIFIER])
            if mode == 'scope': manifest['full_qualification'] = True
            if mode == 'role': manifest['stage']['role'] = 'service_role'
            files[W.PURE_MANIFEST] = json.dumps(manifest).encode()
            with self.subTest(mode=mode), patch.object(W, 'PURE_MANIFEST_SHA256', W.digest(files[W.PURE_MANIFEST])), \
                    self.assertRaises(RuntimeError): W.validate_pure_sources(files)

    def test_partial_original_result_exact_counts_types_and_no_extra_claims(self):
        raw = json.dumps(pure_result()).encode()
        self.assertEqual(W.pure_output(b'BEGIN\nROLLBACK\n' + raw), pure_result())
        for output in (b'', raw+b'\n'+raw, b'{bad}\n'+raw, raw[:-1],
                       raw.replace(b'"full_qualification": false', b'"full_qualification": false, "full_qualification": false')):
            with self.subTest(output=output[:40]), self.assertRaises((RuntimeError, ValueError)):
                W.pure_output(output)
        for key, original in pure_result().items():
            wrong = dict(pure_result()); wrong[key] = (not original if type(original) is bool else None)
            with self.subTest(key=key), self.assertRaises(RuntimeError): W.validate_pure_result(wrong)
        for wrong in (dict(pure_result(), shape_positive=True), dict(pure_result(), new_claim=True)):
            with self.assertRaises(RuntimeError): W.validate_pure_result(wrong)

    def test_every_original_image_requires_pure_phase_before_retention_or_money(self):
        for image in W.IMAGES[:3]:
            original = completed_receipt() if image == 'retention-completed' else receipt(image)
            self.validate(original, image)
            for mode in ('missing', 'repeated', 'early', 'before-provider', 'late', 'role', 'identity', 'failed', 'hash', 'result'):
                value = copy.deepcopy(original); stages = value['stages']
                stage = next(item for item in stages if item['stage'] == 'mixed_pure_evidence_rollback')
                if mode == 'missing': stages.remove(stage)
                if mode == 'repeated': stages.append(copy.deepcopy(stage))
                if mode == 'early': stages.remove(stage); stages.insert(0, stage)
                if mode == 'before-provider':
                    stages.remove(stage); stages.insert(next(i for i,x in enumerate(stages) if x['stage']=='retention_provider_authority'),stage)
                if mode == 'late': stages.remove(stage); stages.append(stage)
                if mode == 'role': stage['argv'][stage['argv'].index('-U')+1] = 'fixture_bootstrap'
                if mode == 'identity': stage['argv'][-1] = '/old/pure.sql'
                if mode == 'failed': stage['returncode'] = 1
                if mode == 'hash': stage.pop('stdout_sha256')
                if mode == 'result': value['mixed_pure_qualification'] = None
                with self.subTest(image=image, mode=mode), self.assertRaises(RuntimeError): self.validate(value,image)

    def test_original_images_cases_and_budgets_unchanged(self):
        self.assertEqual(W.IMAGES[:3], ('preimage','candidate','retention-completed'))
        self.assertEqual({image:W.CASES[image] for image in W.IMAGES[:3]}, {'preimage':('order',), 'candidate':('order','timeout','committed-refund'),
                                  'retention-completed':()})
        source = Path(W.__file__).read_text()
        self.assertIn('deadline = time.monotonic() + 240', source)
        self.assertIn("'cleanup_deadline_seconds': 30", source)


class ReceiptLaneTests(unittest.TestCase):
    def validate(self, value, image='candidate'):
        return W.validate_receipt(value,EXECUTION,ORDINARY,TOURNAMENT,image,MANIFEST_SHA,SOURCE,PG)

    def test_sealed_authentic_inputs_include_graph_and_embedded_components(self):
        files=lane_source_files(); W.validate_lane_sources(files)
        spec=importlib.util.spec_from_file_location('lane_session_custody',W.ROOT/W.LANE_PROGRAM)
        lane=importlib.util.module_from_spec(spec);spec.loader.exec_module(lane)
        self.assertEqual(lane.SESSION_PATH,W.LANE_SESSION)
        self.assertEqual(lane.SESSION_SHA,W.digest(files[W.LANE_SESSION]))
        self.assertEqual(W.IMAGES[:3],('preimage','candidate','retention-completed'))
        self.assertEqual({image:W.CASES[image] for image in W.IMAGES[:3]},{'preimage':('order',),'candidate':('order','timeout','committed-refund'),
                                 'retention-completed':()})
        for name in W.LANE_INPUTS:
            changed=dict(files);changed[name]+=b'changed'
            with self.subTest(path=name),self.assertRaises((RuntimeError,ValueError)):
                W.validate_lane_sources(changed)
        missing=dict(files);del missing[W.PURE_ORACLE]
        with self.assertRaises(RuntimeError): W.validate_lane_sources(missing)

    def test_resealed_embedded_drift_and_include_omission_still_refuse(self):
        for mode in ('body','include','capture','session','cohort-preimage','cohort-guard'):
            files=lane_source_files();manifest=W.decode(files[W.LANE_MANIFEST])
            if mode=='body':
                name=W.LANE_BASE+'component-inputs.sql';files[name]=files[name].replace(b'PERFORM public.',b'PERFORM changed.',1)
            elif mode=='include':
                manifest['relative_include_graph'].pop('scripts/qualification/spin-receipt-lane.sql')
                name=None
            elif mode=='cohort-preimage':
                manifest['cohort_guard_preimage']['transaction_body_sha256']='0'*64
                name=None
            elif mode=='cohort-guard':
                name='scripts/qualification/spin-receipt-lane.sql'
                files[name]=files[name].replace(b'480be3139fe0878e637ce54f533a2170',b'0'*32,1)
            else:
                name=W.LANE_BASE+'authority.json' if mode=='capture' else W.LANE_SESSION
                files[name]+=b'\n'
            if name:manifest['files'][name]=W.pin(files[name])
            files[W.LANE_MANIFEST]=(json.dumps(manifest)+'\n').encode()
            with patch.object(W,'LANE_MANIFEST_SHA256',W.digest(files[W.LANE_MANIFEST])),self.subTest(mode=mode),self.assertRaises(RuntimeError):
                W.validate_lane_sources(files)

    def test_exact_original_outputs_and_physical_hint_only_difference(self):
        outputs=lane_originals(); raw=json.dumps(lane_races()).encode()
        result=W.lane_outputs(outputs,raw,EXECUTION,lane_source_files())
        self.assertEqual(result['catalog'],lane_catalog());self.assertFalse(result['full_qualification'])
        for mode in ('retained-handler','changed-business','changed-proc','missing-hint','malformed','duplicate','catalog-control'):
            changed=copy.deepcopy(outputs)
            if mode in ('malformed','duplicate'):
                changed['receipt_lane_catalog']+=b'{' if mode=='malformed' else b'\n'+changed['receipt_lane_catalog']
            elif mode=='catalog-control':
                row=lane_catalog();row['altered_binding_refusals']=6
                changed['receipt_lane_catalog']=json.dumps(row).encode()
            else:
                row=W.lane_json(changed['receipt_lane_after'])
                if mode=='retained-handler':row['handler']={'owner':'postgres'}
                if mode=='changed-business':row['business']['retained']=[{'amount':1}]
                if mode=='changed-proc':row['catalog']['retained']='changed'
                if mode=='missing-hint':del row['relation_trigger_hints']
                changed['receipt_lane_after']=json.dumps(row).encode()
            with self.subTest(mode=mode),self.assertRaises((RuntimeError,ValueError)):
                W.lane_outputs(changed,raw,EXECUTION,lane_source_files())

    def test_session_protocol_refuses_wrong_role_lock_identity_rows_and_missing_cases(self):
        W.validate_lane_races(lane_races(),EXECUTION,lane_source_files())
        for mode in ('missing','repeat','reorder','role','pid','wait','blocker','affected','truncate','metadata'):
            value=lane_races();rows=value['cases']
            if mode=='missing':rows.pop()
            if mode=='repeat':rows.append(copy.deepcopy(rows[0]))
            if mode=='reorder':rows[:2]=reversed(rows[:2])
            if mode=='role':rows[0]['role']='postgres'
            if mode=='pid':rows[0]['writer_pid']=999
            if mode=='wait':rows[0]['wait']['wait_event']='relation'
            if mode=='blocker':rows[0]['wait']['blockers']=[999]
            if mode=='affected':rows[0]['affected_rows']=1
            if mode=='truncate':rows[7]['sqlstate']='42501'
            if mode=='metadata':rows[5]['wait']=copy.deepcopy(rows[0]['wait'])
            with self.subTest(mode=mode),self.assertRaises(RuntimeError):
                W.validate_lane_races(value,EXECUTION,lane_source_files())

    def test_reverse_cohort_protocol_requires_observed_before_and_four_refusals(self):
        raw=json.dumps(lane_races()).encode(); files=lane_source_files()
        value=W.lane_outputs(lane_originals(),raw,EXECUTION,files)['catalog']
        self.assertIs(value['original_cohort_mismatch_reproduced'],True)
        self.assertEqual(value['reverse_prerequisite_refusals'],4)
        for key,bad in [('original_cohort_mismatch_reproduced',None),
                        ('original_cohort_mismatch_reproduced',False),
                        ('original_cohort_mismatch_reproduced',1),
                        ('reverse_prerequisite_refusals',None),
                        ('reverse_prerequisite_refusals',3),
                        ('reverse_prerequisite_refusals',5),
                        ('reverse_prerequisite_refusals',True)]:
            outputs=lane_originals(); row=lane_catalog()
            if bad is None: del row[key]
            else: row[key]=bad
            outputs['receipt_lane_catalog']=json.dumps(row).encode()
            with self.subTest(key=key,bad=bad),self.assertRaises(RuntimeError):
                W.lane_outputs(outputs,raw,EXECUTION,files)

    def test_session_cleanup_authority_source_and_qualification_claims_fail_closed(self):
        for mode in ('foreign-execution','helper-acl','helper-owner','source','dead-client','live-backend',
                     'unknown-verifier','changed-state','failure','missing-transcript','overclaim'):
            value=lane_races()
            if mode=='foreign-execution':value['execution']=ORDINARY
            if mode=='helper-acl':value['shared_helper_authority']['acl']='{postgres=X/postgres}'
            if mode=='helper-owner':value['shared_helper_authority']['owner']='service_role'
            if mode=='source':value['source_sha256'][W.LANE_SESSION]='0'*64
            if mode=='dead-client':value['clients'][0]['client_exit']=-9
            if mode=='live-backend':value['backend_cleanup']['backends']=1
            if mode=='unknown-verifier':value['verifier_client']['client_exit']=None
            if mode=='changed-state':value['after']['business']['public.hand_history']=[{'id':'fake'}]
            if mode=='failure':value['failure']={'type':'TimeoutError'}
            if mode=='missing-transcript':value['transcripts'].pop(next(iter(value['transcripts'])))
            if mode=='overclaim':value['financial_completion_qualified']=True
            with self.subTest(mode=mode),self.assertRaises(RuntimeError):
                W.validate_lane_races(value,EXECUTION,lane_source_files())

    def test_phase_protocol_requires_original_candidate_only_roles_order_and_identity(self):
        self.validate(receipt())
        for name in W.LANE_STAGES:
            for mode in ('missing','repeated','early','role','argv','failed','digest'):
                value=receipt();stages=value['stages'];row=next(x for x in stages if x['stage']==name)
                if mode=='missing':stages.remove(row)
                if mode=='repeated':stages.append(copy.deepcopy(row))
                if mode=='early':stages.remove(row);stages.insert(1,row)
                if mode=='role':
                    if '-U' in row['argv']:row['argv'][row['argv'].index('-U')+1]='fixture_bootstrap'
                    else:row['argv'][0]='/other/python'
                if mode=='argv':row['argv'][-1]='/other/source'
                if mode=='failed':row['returncode']=1
                if mode=='digest':row['stdout_sha256']='f'*64
                with self.subTest(stage=name,mode=mode),self.assertRaises(RuntimeError):self.validate(value)
        for image in ('preimage','retention-completed'):
            value=receipt(image) if image=='preimage' else completed_receipt()
            value['stages'].append(next(x for x in receipt()['stages'] if x['stage']=='receipt_lane_install'))
            with self.subTest(image=image),self.assertRaises(RuntimeError):self.validate(value,image)

    def test_actual_finite_wait_refuses_early_completion_foreign_blocker_and_deadline(self):
        spec=importlib.util.spec_from_file_location('lane_finite_wait',Path(__file__).resolve().parents[2]/W.LANE_PROGRAM)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        class Holder: pid=102
        class Writer:
            pid=103
            def __init__(self,result=None):self.result=result
            def poll(self):return self.result
        class Observer:
            def __init__(self,value):self.value=value;self.calls=0
            def json(self,query):self.calls+=1;return self.value
        expected={'pid':103,'wait_event_type':'Lock','wait_event':'advisory','blockers':[102]}
        observer=Observer(expected)
        with patch.object(module.time,'monotonic',return_value=1):
            self.assertEqual(module.wait_for_block(observer,Holder(),Writer(),'advisory',2),expected)
        with patch.object(module.time,'monotonic',return_value=1),self.assertRaisesRegex(RuntimeError,'completed'):
            module.wait_for_block(observer,Holder(),Writer('0'),'advisory',2)
        for value in (None,dict(expected,blockers=[999]),dict(expected,wait_event='relation')):
            observer=Observer(value)
            with patch.object(module.time,'monotonic',side_effect=[1,3]),patch.object(module.time,'sleep') as pause, \
                    self.subTest(value=value),self.assertRaises(TimeoutError):
                module.wait_for_block(observer,Holder(),Writer(),'advisory',2)
            self.assertEqual(observer.calls,1);pause.assert_called_once_with(0.01)

    def test_snapshot_comparison_keeps_exact_decimal_difference(self):
        first=W.lane_json(b'{"amount":9007199254740992.01}')
        second=W.lane_json(b'{"amount":9007199254740992.02}')
        self.assertNotEqual(first,second)
        self.assertEqual(str(second['amount']-first['amount']),'0.01')

    def test_real_rpc_protocol_requires_entry_wait_canonical_row_and_unchanged_replay(self):
        for mode in ('positive-rake','pre-entry-write','duplicate','no-real-row','replay-result','replay-tuple',
                     'wrong-key','attempt-count','error','unrolled-row','foreign-key'):
            value=lane_races();rpc=value['cases'][-1]
            if mode=='positive-rake':rpc['first_result']['rake']={'success':True,'rake_amount':1}
            if mode=='pre-entry-write':rpc['pre_entry_receipt_write_locks']=1
            if mode=='duplicate':rpc['created_receipts']=2
            if mode=='no-real-row':rpc['receipt_before_replay']['rows']=[]
            if mode=='replay-result':rpc['replay_result']['commissions']=[{'amount':1}]
            if mode=='replay-tuple':rpc['receipt_after_replay']['rows'][0]['ctid']='(0,2)'
            if mode=='wrong-key':rpc['receipt_after_replay']['rows'][0]['row']['hand_id']=ORDINARY
            if mode=='attempt-count':
                rpc['receipt_before_replay']['rows'][0]['row']['attempt_count']=2
                rpc['receipt_after_replay']['rows'][0]['row']['attempt_count']=2
            if mode=='error':
                rpc['receipt_before_replay']['rows'][0]['row']['error']='unknown'
                rpc['receipt_after_replay']['rows'][0]['row']['error']='unknown'
            if mode=='unrolled-row':rpc['rollback_receipts']=1
            if mode=='foreign-key':rpc['receipt_fk_count']=1
            with self.subTest(mode=mode),self.assertRaises(RuntimeError):
                W.validate_lane_races(value,EXECUTION,lane_source_files())

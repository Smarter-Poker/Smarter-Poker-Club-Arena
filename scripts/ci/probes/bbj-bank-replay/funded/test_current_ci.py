"""Finite current-route identity/attempt regressions; no SQL or application execution."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import subprocess
import queue

import deadline
from types import SimpleNamespace
from unittest.mock import patch

import current_ci as ci
from execution import finish_owned_teardown, dispose_owned_case_database
from custody import FundedSourceCustody
from retained import RetainedModules, INSTALLER_PREFIX, literal_installer_transport


class CurrentAccountingIdentityTests(unittest.TestCase):
    def setUp(self):
        self.workspace = Path('/owned/checkout')
        self.commit = 'a' * 40
        self.source = 'b' * 40
        self.env = dict(GITHUB_ACTIONS='true', CI='true', GITHUB_REPOSITORY=ci.REPOSITORY,
                        GITHUB_JOB='accounting_postgres', GITHUB_SERVER_URL='https://github.com',
                        GITHUB_WORKFLOW_REF=ci.WORKFLOW+'refs/pull/42/merge', GITHUB_SHA=self.commit,
                        GITHUB_WORKSPACE=str(self.workspace), GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='1',
                        RUNNER_ENVIRONMENT='github-hosted', RUNNER_OS='Linux', RUNNER_ARCH='X64',
                        RUNNER_NAME='GitHub Actions original hosted runner', GITHUB_EVENT_NAME='pull_request',
                        GITHUB_REF='refs/pull/42/merge')
        self.event = {'number':42, 'pull_request': {'head': {'sha':self.source, 'repo':{'full_name':ci.REPOSITORY}},
                      'base': {'ref':'main', 'repo':{'full_name':ci.REPOSITORY}}}}

    def identity(self, environment=None, event=None, parents=None):
        return ci.identity(environment or self.env, event or self.event, self.commit,
                           [self.source, 'c'*40] if parents is None else parents, self.workspace)

    def _original_driver_transport(self, bound, budget, writes, *, eof=False, on_write=None):
        """Use the literal original Psql methods with modeled pipes; no process/SQL."""
        driver = bound.driver
        queues = []
        class BufferedQueue(queue.Queue):
            def __init__(self):
                super().__init__()
                queues.append(self)
        def write(payload):
            writes.append(payload)
            if on_write is not None:
                on_write()
            marker = payload.rsplit('\\echo ',1)[-1].rstrip('\n')
            queues[0].put(None if eof else marker)
            return len(payload)
        process = SimpleNamespace(stdin=SimpleNamespace(write=write,flush=lambda:None),
                                  stdout=iter(()),stderr=iter(()),pid=42,poll=lambda:0)
        driver.queue = SimpleNamespace(Queue=BufferedQueue,Empty=queue.Empty)
        driver.subprocess = SimpleNamespace(Popen=lambda *a,**k:process,PIPE=-1)
        driver.threading = SimpleNamespace(Thread=lambda **kw:SimpleNamespace(start=lambda:None))
        original = (driver.Psql,driver.Psql.sql,driver.Psql.one,driver.Psql.close)
        selected = deadline.install_driver_deadline(driver,budget,literal_dispatch=bound.literal_dispatch)
        self.assertEqual((selected,selected.sql,selected.one,selected.close),original)
        records = []
        return selected(['modeled-only'],{},'installer_transport',records),records

    def test_original_installer_transport_preserves_sealed_query_and_barrier(self):
        bound = RetainedModules(FundedSourceCustody(),None,ci.CASES[0])
        source = next(row['sql'] for row in bound.custody.read_json('supplement/AUDIT-EXPECTED.json')['dispatches']
                      if row['sql'].startswith(INSTALLER_PREFIX))
        budget,_ = self.budget(300,90)
        writes = []
        with self.alarms():
            connection,records = self._original_driver_transport(bound,budget,writes)
            self.assertEqual(connection.sql(source),[])
            for query in ('SELECT 1','ROLLBACK'):
                self.assertEqual(connection.sql(query),[])
        wire = writes[0]
        self.assertTrue(wire.startswith(INSTALLER_PREFIX+'\nSELECT $bbj_literal_'))
        start = len(INSTALLER_PREFIX+'\nSELECT ')
        end = wire.index('$',start+1)+1
        tag = wire[start:end]
        body,suffix = wire[end:].split(tag,1)
        self.assertEqual(INSTALLER_PREFIX+body,source)
        self.assertEqual(suffix,'\n\\gexec\n\\echo '+records[0]['barrier']+'\n')
        self.assertEqual(records[0]['sql'],source)
        self.assertEqual(records[0]['status'],'BARRIER_REACHED')
        for query,wire,record in zip(('SELECT 1','ROLLBACK'),writes[1:],records[1:]):
            self.assertEqual(wire,query+';\n\\echo '+record['barrier']+'\n')
        transport = [row for row in budget.events if row['operation']=='persistent_transport']
        self.assertEqual(transport[0]['payload'],source.rstrip().rstrip(';')+';\n\\echo '+records[0]['barrier']+'\n')
        self.assertEqual(transport[0]['wire_payload'],writes[0])
        self.assertFalse(transport[0]['cleanup'])
        self.assertTrue(transport[-1]['cleanup'])

    def test_installer_transport_refuses_changed_source_or_barrier_before_write(self):
        bound = RetainedModules(FundedSourceCustody(),None,ci.CASES[0])
        source = next(row['sql'] for row in bound.custody.read_json('supplement/AUDIT-EXPECTED.json')['dispatches']
                      if row['sql'].startswith(INSTALLER_PREFIX))
        budget,_ = self.budget(300,90)
        writes = []
        with self.alarms():
            connection,records = self._original_driver_transport(bound,budget,writes)
            with self.assertRaisesRegex(RuntimeError,'Unrecognized original installer'):
                connection.sql(source.replace('-- SCRATCH','-- CHANGED',1))
        self.assertEqual(writes,[])
        self.assertEqual(records[0]['status'],'ATTEMPTED')
        original = source.rstrip().rstrip(';')+';\n\\echo '
        for barrier in ('g8_barrier_short\n','g8_barrier_'+'a'*32+'\nSELECT 1;\n','g8_barrier_'+'A'*32+'\n'):
            with self.subTest(barrier=barrier),self.assertRaisesRegex(RuntimeError,'Exact original installer barrier'):
                bound.literal_dispatch(original+barrier)
        for changed in (source.replace('1000ms','999ms',1),source.replace('15000ms','16000ms',1),source[:-1]):
            with self.subTest(source_boundary=changed[:75]),self.assertRaises(RuntimeError):
                literal_installer_transport(changed)
        audit = bound.custody.read_json('supplement/AUDIT-EXPECTED.json')
        original_read = bound.custody.read_json
        for mutation in ('hash','metadata'):
            changed = copy.deepcopy(audit)
            installer = next(row for row in changed['dispatches'] if row['sql'].startswith(INSTALLER_PREFIX))
            if mutation == 'hash':installer['sha256']='0'*64
            else:
                installer['sql']=installer['sql'].replace('-- SCRATCH','-- CHANGED',1)
                installer['sha256']=hashlib.sha256(installer['sql'].encode()).hexdigest()
            with self.subTest(authority=mutation),patch.object(bound.custody,'read_json',side_effect=lambda name:
                    changed if name=='supplement/AUDIT-EXPECTED.json' else original_read(name)):
                with self.assertRaises(RuntimeError):RetainedModules(bound.custody,None,ci.CASES[0])

    def test_installer_transport_error_or_late_write_never_reaches_a_barrier(self):
        for late in (False,True):
            with self.subTest(late=late):
                bound = RetainedModules(FundedSourceCustody(),None,ci.CASES[0])
                source = next(row['sql'] for row in bound.custody.read_json('supplement/AUDIT-EXPECTED.json')['dispatches']
                              if row['sql'].startswith(INSTALLER_PREFIX))
                budget,clock = self.budget(300,90)
                writes = []
                with self.alarms():
                    connection,records = self._original_driver_transport(bound,budget,writes,eof=True,
                        on_write=(lambda:clock.advance(61)) if late else None)
                    with self.assertRaises(deadline.DeadlineExpired if late else RuntimeError):connection.sql(source)
                self.assertEqual(len(writes),1)
                self.assertEqual(records[0]['sql'],source)
                self.assertEqual(records[0]['status'],'ATTEMPTED' if late else 'PSQL_EXIT')
                if late:
                    self.assertTrue(budget.execution_refused)
                    self.assertGreater(budget.remaining(True),0)

    def _run_audit_selection_boundary(self, bound, models, choice):
        """Model only the real installer-to-planner connection; never execute SQL."""
        supplement = bound.supplement
        expected = dict(database='fixture_base', database_oid='123', system_identifier='456',
                        data_directory='/modeled/data', socket_directory='/modeled/socket')
        boundary = {**expected, 'role':'postgres', 'session_role':'postgres', 'superuser':True,
                    'socket_only':True, 'replication_role':'origin', 'server_version':'17.11',
                    'allow_privileged_anon_grant':None, 'users':0, 'clubs':0, 'legs':0, 'snapshots':0}
        events = bound.custody.read_json('opening_adapter/EVENT-TRIGGERS-EXPECTED.json')
        commands = []
        class ReachedOriginalDispatch(RuntimeError):
            pass
        first = models['functions'][0]['statements'][0]
        def sql(value):
            commands.append(value)
            if value == first:
                raise ReachedOriginalDispatch('Modeled boundary; no DDL executed')
        def one(query):
            if query == supplement.Q.BOUNDARY_QUERY:
                return copy.deepcopy(boundary)
            if query == supplement.A.CONTEXT:
                return {'modeled_context_only':True}
            if query == supplement.CATALOG_QUERY:
                return {'event_triggers':events, 'default_acl':[]}
            if query == supplement.A.NO_NESTED_SWEEP:
                return {'eligible_grant_sweep':0, 'graphql_oid_collision':0}
            raise AssertionError('Unexpected modeled query')
        case = SimpleNamespace(capture=lambda *args: {'raw':{x['relation']:[] for x in models['tables']}})
        original_read = supplement.read
        def read(path):
            return models if Path(path).name == 'EXPECTED.json' else original_read(path)
        log = {'expected_identity':expected}
        with patch.object(supplement,'read',side_effect=read), \
             patch.object(supplement,'verify_sources',return_value=bound.supplement_sources()), \
             patch.object(supplement,'libraries',return_value=(None,None,None,None,None,case)), \
             patch.object(supplement,'_collect',return_value={'passed':True,'backup_preimage_selection':choice}), \
             patch.object(supplement.A,'capture'), patch.object(supplement.A,'validate_capture'):
            try:
                supplement.install(SimpleNamespace(sql=sql,one=one),log)
            except Exception as error:
                return log, commands, error, ReachedOriginalDispatch
        self.fail('Modeled installer must stop before any real dispatch')

    def test_complete_collector_preimage_reaches_original_audit_plan(self):
        bound = RetainedModules(FundedSourceCustody(), None, ci.CASES[0])
        models = bound.custody.read_json('supplement/EXPECTED.json')
        # Real first hosted capture: four public functions, five checked RI
        # builtins, six tables and two sequences. No captured run answers load.
        choice = {'functions':['before']*4+['after']*5,
                  'tables':['before']*3+['after']*3, 'sequences':['before','after']}
        original = copy.deepcopy(choice)
        log, commands, error, reached = self._run_audit_selection_boundary(bound,models,choice)
        self.assertIsInstance(error,reached)
        plan = log['audit_plan']
        self.assertEqual((len(plan['dispatches']),len(plan['events'])),(23,25))
        self.assertEqual(plan['dispatches'],[sql for kind in ('functions','tables','sequences')
            for item,phase in zip(models[kind],choice[kind]) if phase == 'before' for sql in item['statements']])
        self.assertEqual(choice,original)
        self.assertEqual(log['commit_status'],'NOT_ATTEMPTED')
        self.assertFalse(log['financial_helpers_invoked'])
        self.assertFalse(log['seed_invoked'])
        self.assertEqual(commands[-1],'ROLLBACK')
        self.assertNotIn('COMMIT',commands)
        # The same complete observation supports a strict source no-op.
        noop = {kind:['after']*len(value) for kind,value in choice.items()}
        self.assertEqual(bound.plan_complete_preimage(models,noop),
                         {'dispatches':[],'events':[],'move_replaced':False})

    def test_complete_preimage_binding_refuses_missing_or_changed_builtin_observations(self):
        bound = RetainedModules(FundedSourceCustody(), None, ci.CASES[0])
        models = bound.custody.read_json('supplement/EXPECTED.json')
        choice = {'functions':['before']*4+['after']*5,
                  'tables':['before']*3+['after']*3, 'sequences':['before','after']}
        mutations = {
            'missing builtin':lambda m,c:c['functions'].pop(),
            'extra builtin':lambda m,c:c['functions'].append('after'),
            'nonfinal builtin':lambda m,c:c['functions'].__setitem__(4,'before'),
            'builtin ddl':lambda m,c:m['builtins'][0]['statements'].append('SELECT 1'),
            'builtin metadata changed':lambda m,c:m['builtins'][0]['after'].__setitem__('owner','other'),
            'missing table':lambda m,c:c['tables'].pop(),
            'missing sequence':lambda m,c:c['sequences'].pop(),
            'unknown public phase':lambda m,c:c['functions'].__setitem__(0,'unknown'),
            'unknown category':lambda m,c:c.__setitem__('extra',[]),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                m,c = copy.deepcopy(models),copy.deepcopy(choice)
                mutate(m,c)
                log,commands,error,reached = self._run_audit_selection_boundary(bound,m,c)
                self.assertNotIsInstance(error,reached)
                self.assertIsInstance(error,(AssertionError,RuntimeError))
                self.assertEqual(log['statements'],[])
                self.assertEqual(log['commit_status'],'NOT_ATTEMPTED')
                self.assertEqual(commands[-1],'ROLLBACK')
                self.assertNotIn('COMMIT',commands)

    def test_real_checkout_and_current_pr_identity_are_both_recorded(self):
        result = self.identity()
        self.assertEqual((result['commit'], result['source_commit']), (self.commit, self.source))
        self.assertEqual((result['run_id'], result['run_attempt'], result['job']), ('123','1','accounting_postgres'))

    def test_wrong_route_and_missing_current_identity_are_refused(self):
        for field in self.env:
            changed = dict(self.env)
            changed.pop(field)
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                self.identity(changed)
        for field, value in [('GITHUB_JOB','other'), ('GITHUB_REPOSITORY','other/repo'),
                             ('RUNNER_ENVIRONMENT','self-hosted'), ('RUNNER_OS','macOS'),
                             ('RUNNER_ARCH','ARM64'), ('GITHUB_SHA','d'*40),
                             ('GITHUB_EVENT_NAME','workflow_dispatch'), ('GITHUB_RUN_ATTEMPT','01'),
                             ('GITHUB_WORKFLOW_REF',ci.WORKFLOW+'refs/heads/unrelated')]:
            changed = {**self.env, field:value}
            with self.subTest(field=field,value=value), self.assertRaises(RuntimeError):
                self.identity(changed)

    def test_fork_and_unrelated_parent_cannot_authorize_checkout(self):
        changed = copy.deepcopy(self.event)
        changed['pull_request']['head']['repo']['full_name'] = 'external/fork'
        with self.assertRaises(RuntimeError):
            self.identity(event=changed)
        with self.assertRaises(RuntimeError):
            self.identity(parents=['d'*40])

    def test_existing_scheduled_main_path_remains_exact(self):
        environment = {**self.env, 'GITHUB_EVENT_NAME':'schedule', 'GITHUB_REF':'refs/heads/main',
                       'GITHUB_WORKFLOW_REF':ci.WORKFLOW+'refs/heads/main'}
        self.assertEqual(self.identity(environment)['source_commit'], self.commit)
        environment['GITHUB_REF'] = 'refs/heads/other'
        with self.assertRaises(RuntimeError):
            self.identity(environment)

    def test_exclusive_attempt_preserves_uncertain_original(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'ATTEMPT.json'
            original = {'status':'ATTEMPTED_OUTCOME_UNCERTAIN','uuid':'original'}
            ci.write_exclusive(path, original)
            with self.assertRaises(FileExistsError):
                ci.write_exclusive(path, {'status':'PASSED'})
            self.assertEqual(json.loads(path.read_text()), original)

    def test_case_identity_is_fresh_and_cannot_be_reused_or_mutated(self):
        with tempfile.TemporaryDirectory() as directory:
            run = ci.CurrentAccountingRun.__new__(ci.CurrentAccountingRun)
            run.output=Path(directory);run.token='current-invocation';run.identity={'commit':self.commit}
            run.runtime={'runtime_verified':True};run._cases={};run.assert_pristine=lambda:None
            run.verify_provider_bytes=lambda:None
            run.require_case_time=lambda:None
            run.timing={'job_deadline_unix':ci.time.time()+899,'case_execution_seconds':5,'cleanup_reserve_seconds':5}
            run.job_deadline_monotonic=ci.time.monotonic()+899
            first, _ = run.new_case(ci.CASES[0])
            second, _ = run.new_case(ci.CASES[1])
            self.assertNotEqual(first['opening_operation_id'], second['opening_operation_id'])
            self.assertNotEqual(first['move_operation'], second['move_operation'])
            self.assertNotEqual(first['case_attempt_id'], second['case_attempt_id'])
            with self.assertRaises(RuntimeError):
                run.new_case(ci.CASES[0])
            first['move_operation']='changed'
            with self.assertRaises(RuntimeError):
                run.require_case(first)

    def test_seed_is_claimed_before_callback_and_never_repeated(self):
        with tempfile.TemporaryDirectory() as directory:
            run = ci.CurrentAccountingRun.__new__(ci.CurrentAccountingRun)
            state={'directory':Path(directory),'physical':{'database':'owned'},'opening_claimed':True,'seed_claimed':False}
            run._cases={ci.CASES[0]:state}
            run.claim_seed(ci.CASES[0])
            self.assertTrue(state['seed_claimed'])
            with self.assertRaises(RuntimeError):
                run.claim_seed(ci.CASES[0])
            self.assertEqual(json.loads((Path(directory)/'SEED-ATTEMPT.json').read_text())['status'],
                             'ATTEMPTED_OUTCOME_UNCERTAIN')

    def test_seed_without_physical_clone_or_opening_is_refused(self):
        run = ci.CurrentAccountingRun.__new__(ci.CurrentAccountingRun)
        for physical, opening in [(None,True), ({'database':'owned'},False)]:
            run._cases={ci.CASES[0]:{'physical':physical,'opening_claimed':opening,'seed_claimed':False}}
            with self.subTest(physical=physical, opening=opening), self.assertRaises(RuntimeError):
                run.claim_seed(ci.CASES[0])

    def test_runtime_mismatch_refuses_before_binary_execution(self):
        run = ci.CurrentAccountingRun.__new__(ci.CurrentAccountingRun)
        run.runtime=None
        with patch.object(ci.subprocess,'run') as process, self.assertRaises(RuntimeError):
            run.verify_provider_bytes()
        process.assert_not_called()
        with tempfile.TemporaryDirectory() as directory:
            run.pg_bin=Path(directory)
            run.runtime={'runtime_verified':True,'actual_binaries':{}}
            for name in ci.PROVIDER_BINARIES:
                path=run.pg_bin/name;path.write_text('observed hosted bytes')
                run.runtime['actual_binaries'][name]={'sha256':ci.sha(path)}
            run.verify_provider_bytes()
            (run.pg_bin/'psql').write_text('changed after observation')
            with self.assertRaises(RuntimeError):run.verify_provider_bytes()

    def test_historical_review_cannot_supply_current_case(self):
        run = ci.CurrentAccountingRun.__new__(ci.CurrentAccountingRun)
        run._cases={}
        with self.assertRaises(RuntimeError):
            run.require_case({'native_execution_authorized':True,'accepted_for_isolated_native_execution':True})

    def test_missing_or_wrong_job_deadline_refuses_before_case(self):
        run=ci.CurrentAccountingRun.__new__(ci.CurrentAccountingRun)
        run.identity={'repository':ci.REPOSITORY,'commit':self.commit,'run_id':'123','run_attempt':'1','job':'accounting_postgres'}
        with self.assertRaises(RuntimeError):
            run.bind_job_timing(None)
        with tempfile.TemporaryDirectory() as directory, patch.object(ci.time,'time',return_value=1000):
            run.output=Path(directory)
            timing={**run.identity,'job_started_at_unix':990,'job_deadline_unix':1890,
                    'case_execution_seconds':600,'cleanup_reserve_seconds':120}
            for mutation in ({'run_id':'other'}, {'job_deadline_unix':2000}, {'cleanup_reserve_seconds':400},
                             {'job_started_at_unix':1001,'job_deadline_unix':1901}):
                with self.subTest(mutation=mutation), self.assertRaises(RuntimeError):
                    run.bind_job_timing({**timing,**mutation})
            run.bind_job_timing(timing)
            with patch.object(ci.time,'time',return_value=1200), self.assertRaises(RuntimeError):
                run.require_case_time()

    def budget(self, execution=20, cleanup=10):
        clock=SimpleNamespace(wall=1000.0, monotonic_now=0.0)
        clock.time=lambda:clock.wall
        clock.monotonic=lambda:clock.monotonic_now
        def advance(seconds):
            clock.wall+=seconds;clock.monotonic_now+=seconds
        clock.advance=advance
        return deadline.CaseDeadline(1900,execution,cleanup,clock),clock

    def alarms(self):
        # Modeled timers only. These tests neither wait nor start a process.
        from contextlib import ExitStack
        stack=ExitStack()
        stack.enter_context(patch.object(deadline.signal,'getsignal',return_value=deadline.signal.SIG_DFL))
        stack.enter_context(patch.object(deadline.signal,'getitimer',return_value=(0.0,0.0)))
        stack.enter_context(patch.object(deadline.signal,'signal'))
        stack.enter_context(patch.object(deadline.signal,'setitimer'))
        return stack

    def test_original_caps_and_remaining_case_time_are_both_enforced(self):
        budget,clock=self.budget()
        for cap in (0,-1,float('inf'),float('nan'),None,True):
            with self.subTest(invalid_cap=cap),self.assertRaises(ValueError):budget.limit(cap)
        self.assertEqual(budget.limit(650),20)
        self.assertEqual(budget.limit(5),5)
        clock.advance(9)
        self.assertEqual(budget.limit(650),11)
        clock.advance(11)
        with self.assertRaises(deadline.DeadlineExpired):budget.limit(650)
        self.assertEqual(budget.limit(60,True),10)
        for cleanup in (False,True):
            for overrun in (0,1):
                with self.subTest(cleanup=cleanup,overrun=overrun):
                    exhausted,elapsed=self.budget()
                    elapsed.advance((30 if cleanup else 20)+overrun)
                    cap=exhausted.remaining(cleanup)
                    self.assertLessEqual(cap,0)
                    called=[]
                    with self.alarms(),self.assertRaises(deadline.DeadlineExpired):
                        with exhausted.bounded('remaining_cap',cap,cleanup):called.append('must not execute')
                    self.assertEqual(called,[])
                    self.assertEqual(exhausted.events[-1]['error_type'],'DeadlineExpired')
                    self.assertEqual(exhausted.events[-1]['status'],'FAILED_OR_UNCERTAIN')
                    if not cleanup:self.assertTrue(exhausted.execution_refused)

    def test_cleanup_budget_is_aggregate_and_independent_refusals_remain_visible(self):
        budget,clock=self.budget()
        with self.alarms():
            with budget.bounded('rollback',60,True):clock.advance(8)
            with self.assertRaises(deadline.DeadlineExpired):
                with budget.bounded('unlock',60,True) as cap:
                    self.assertEqual(cap,2);clock.advance(2)
            called=[]
            with self.assertRaises(deadline.DeadlineExpired):
                with budget.bounded('close',5,True):called.append('must not wait')
        self.assertEqual(called,[])
        self.assertEqual([r['operation'] for r in budget.events],['rollback','unlock','close'])
        self.assertGreaterEqual(budget.cleanup_used,10)

    def test_late_persistent_result_is_uncertain_and_cannot_continue(self):
        budget,clock=self.budget()
        stream=SimpleNamespace(write=lambda value:clock.advance(21),flush=lambda:None)
        process=SimpleNamespace(stdin=stream,stdout=None,stderr=None,pid=42)
        driver=SimpleNamespace(queue=queue,subprocess=SimpleNamespace(Popen=lambda *a,**k:process,PIPE=-1))
        class Original:
            def __init__(self):self.q=driver.queue.Queue();self.p=driver.subprocess.Popen(['owned'])
            def sql(self,sql,timeout=60):return self.p.stdin.write(sql)
            def one(self,sql):return self.sql(sql)
            def close(self):pass
        driver.Psql=Original
        original_methods=(Original.sql,Original.one,Original.close)
        with self.alarms():
            selected=deadline.install_driver_deadline(driver,budget)
            self.assertIs(selected,Original)
            self.assertEqual((selected.sql,selected.one,selected.close),original_methods)
            connection=selected()
            with self.assertRaises(deadline.DeadlineExpired):connection.sql('COMMIT')
            with self.assertRaises(deadline.DeadlineExpired):connection.sql('SELECT 1')
        self.assertTrue(budget.execution_refused)
        self.assertTrue(any(row.get('status')=='FAILED_OR_UNCERTAIN' for row in budget.events))

    def test_original_expected_negative_error_does_not_become_deadline_failure(self):
        budget,_=self.budget()
        with self.alarms():
            with self.assertRaises(ValueError):
                with budget.bounded('original_negative',60):
                    raise ValueError('original expected negative control')
        self.assertFalse(budget.execution_refused)
        self.assertEqual(budget.limit(60),20)

    def test_interruption_closes_execution_but_preserves_independent_cleanup(self):
        budget,_=self.budget()
        with self.alarms():
            with self.assertRaises(KeyboardInterrupt):
                with budget.bounded('selected_case',20):raise KeyboardInterrupt()
            with self.assertRaises(deadline.DeadlineExpired):budget.limit(60)
            with budget.bounded('rollback',60,True):pass
        self.assertFalse(budget.report()['timeout_is_cancellation'])
        self.assertFalse(budget.report()['automatic_retry'])

    def test_command_timeout_retains_partial_output_and_never_redispatches(self):
        budget,_=self.budget()
        process=SimpleNamespace(pid=42,returncode=None)
        process.poll=lambda:process.returncode
        def kill():process.returncode=-9
        process.kill=kill
        process.wait=lambda timeout:process.returncode
        def communicate(**kwargs):raise subprocess.TimeoutExpired(['owned'],kwargs['timeout'],output='partial',stderr='partial error')
        process.communicate=communicate
        with self.alarms(),patch.object(deadline.subprocess,'Popen',return_value=process) as spawn:
            with self.assertRaises(subprocess.TimeoutExpired):budget.run(['owned'],env={},timeout=650)
        self.assertEqual(spawn.call_count,1)
        self.assertEqual(budget.processes[0]['stdout'],'partial')
        self.assertEqual(budget.processes[0]['stderr'],'partial error')
        self.assertEqual(budget.processes[0]['exit_after_reap'],-9)
        self.assertTrue(budget.execution_refused)

    def test_backward_wall_clock_cannot_extend_case_deadline(self):
        budget,clock=self.budget()
        clock.advance(20);clock.wall-=100
        with self.assertRaises(deadline.DeadlineExpired):budget.limit(60)

    def test_cleanup_does_not_rearm_an_expired_enclosing_execution_timer(self):
        budget,clock=self.budget()
        with self.alarms(),patch.object(deadline.signal,'getitimer',return_value=(0.5,0.0)),patch.object(deadline.signal,'setitimer') as timer:
            with budget.bounded('cleanup',2,True):clock.advance(1)
        self.assertEqual([call.args[1] for call in timer.call_args_list],[2,0])

    def test_buffered_rows_cannot_renew_original_statement_deadline(self):
        budget,clock=self.budget(300,90)
        buffered=SimpleNamespace(rows=['row1','row2','barrier'],gets=0)
        class BufferedQueue:
            def get(self,timeout):buffered.gets+=1;return buffered.rows.pop(0)
            def put(self,value):buffered.rows.append(value)
        def write(payload):
            if payload=='ROLLBACK':buffered.rows[:]=['barrier']
        process=SimpleNamespace(stdin=SimpleNamespace(write=write,flush=lambda:None),stdout=None,stderr=None,pid=42)
        driver=SimpleNamespace(queue=SimpleNamespace(Queue=BufferedQueue,Empty=queue.Empty),
                               subprocess=SimpleNamespace(Popen=lambda *a,**k:process,PIPE=-1))
        class Original:
            def __init__(self):self.q=driver.queue.Queue();self.p=driver.subprocess.Popen(['owned'])
            def sql(self,sql,timeout=60):
                started=clock.monotonic();self.p.stdin.write(sql);self.p.stdin.flush()
                while True:
                    line=self.q.get(timeout=max(.001,timeout-(clock.monotonic()-started)))
                    if line=='barrier':return 'late success'
                    clock.advance(30.1)  # Buffered reads are immediate; elapsed processing is not.
            def one(self,sql):return self.sql(sql)
            def close(self):pass
        driver.Psql=Original
        methods=(Original.sql,Original.one,Original.close)
        with self.alarms():
            connection=deadline.install_driver_deadline(driver,budget)()
            with self.assertRaises(deadline.DeadlineExpired):connection.sql('COMMIT')
            self.assertEqual(buffered.gets,2)  # The late barrier was never accepted.
            self.assertTrue(budget.execution_refused)
            connection.sql('ROLLBACK')  # Independently bounded cleanup remains possible.
        self.assertEqual((Original.sql,Original.one,Original.close),methods)

    def test_late_command_preserves_observed_streams_and_exit_without_retry(self):
        budget,clock=self.budget(300,90)
        process=SimpleNamespace(pid=42,returncode=0)
        process.poll=lambda:process.returncode
        process.kill=lambda:None
        process.wait=lambda timeout:process.returncode
        def communicate(**kwargs):clock.advance(301);return 'observed output','observed error'
        process.communicate=communicate
        with self.alarms(),patch.object(deadline.subprocess,'Popen',return_value=process) as spawn:
            with self.assertRaises(deadline.DeadlineExpired):budget.run(['owned'],env={},timeout=650)
            with self.assertRaises(deadline.DeadlineExpired):budget.run(['must not start'],env={})
        self.assertEqual(spawn.call_count,1)
        self.assertEqual(budget.processes[0]['stdout'],'observed output')
        self.assertEqual(budget.processes[0]['stderr'],'observed error')
        self.assertEqual(budget.processes[0]['exit'],0)
        self.assertEqual(budget.processes[0]['status'],'FAILED_OR_UNCERTAIN')

    def test_final_teardown_interrupts_cannot_skip_later_owned_stages(self):
        names=('postflight','clients','helpers','physical','release','evidence')
        for interrupted in ('postflight','clients','physical'):
            for error_type in (KeyboardInterrupt,SystemExit):
                with self.subTest(stage=interrupted,error=error_type.__name__):
                    budget,_=self.budget(300,90)
                    ledger={'status':'PASS_IMPLEMENTED_SUBSETS_ONLY'}
                    called=[]
                    def action(name):
                        def run():
                            called.append(name)
                            if name==interrupted:raise error_type('original interrupt')
                        return run
                    finish_owned_teardown(ledger,budget,**{name:action(name) for name in names})
                    self.assertEqual(called,list(names))
                    self.assertEqual(ledger['teardown_failures'][0]['errors'][0]['error_type'],error_type.__name__)
                    self.assertEqual(ledger['status'],'TEARDOWN_FAILED_OUTCOME_UNCERTAIN')
                    self.assertTrue(budget.execution_refused)
                    self.assertFalse(ledger['cleanup']['inactive_proven'])

    def test_case_disposal_uses_one_drop_barrier_and_refuses_unproven_backends(self):
        bound=RetainedModules(FundedSourceCustody(),None,ci.CASES[0])
        db=ci.CASES[0].lower()
        backend={'pid':42,'backend_start':'2026-09-17 08:32:56.72583+00',
                 'backend_type':'client backend','database':db,'database_oid':'48580',
                 'state':'idle','xact_start':None}
        owner={'constructor_status':'RETURNED','exit_after_cleanup':0,'cleanup':[],
               'physical':{k:backend[k] for k in ('pid','backend_start','database','database_oid')}}
        def run(backends,owners=None,*,oid='48580',count=None,drop_error=None,absence=True):
            calls=[];disposal={}
            observation={'oid':oid,'sessions':len(backends) if count is None else count,'backends':backends}
            def command(args,*,cleanup):
                self.assertTrue(cleanup)
                query=args[-1];calls.append(query)
                if query.startswith('WITH sessions AS MATERIALIZED'):
                    return SimpleNamespace(stdout=json.dumps(observation))
                if query == 'DROP DATABASE '+db:
                    if drop_error is not None:raise drop_error
                    return SimpleNamespace(stdout='DROP DATABASE\n')
                self.assertTrue(query.startswith('SELECT to_jsonb(NOT EXISTS'))
                return SimpleNamespace(stdout=json.dumps(absence))
            try:
                dispose_owned_case_database(db,'48580',[owner] if owners is None else owners,
                    disposal,command,['psql'],bound.identity.canonical_oid,
                    bound.parser.decode_catalog_result,(db,))
            except (RuntimeError,ValueError,TimeoutError) as error:
                return calls,disposal,error
            return calls,disposal,None
        # Old one-shot count refused the same exiting-client observation.
        with self.assertRaisesRegex(RuntimeError,'still has sessions'):
            bound.identity.require_owned_database_identity('48580','48580',1)
        for rows in ([],[backend],[{**backend,'pid':43,'backend_type':'autovacuum worker',
                                   'state':'active','xact_start':'2026-09-17 08:33:00+00'}]):
            with self.subTest(accepted=rows):
                calls,disposal,error=run(rows)
                self.assertIsNone(error)
                self.assertEqual(len(calls),3)
                self.assertEqual(calls[1],'DROP DATABASE '+db)
                self.assertEqual(disposal['before_observation']['backends'],rows)
                self.assertEqual(disposal['before']['sessions'],len(rows))
                self.assertEqual(disposal['normalized_existing_oid'],'48580')
                self.assertEqual(disposal['status'],'ABSENT_PROVEN')
        for mutation in ({'pid':43},{'backend_start':'different backend start'},
                         {'state':'active'},{'state':'idle in transaction'},
                         {'xact_start':'2026-09-17 08:33:00+00'},
                         {'backend_type':'parallel worker'},{'database_oid':'48581'},
                         {'database':'other'},{'pid':True},{'backend_start':None}):
            with self.subTest(refused=mutation):
                calls,disposal,error=run([{**backend,**mutation}])
                self.assertIsNotNone(error)
                self.assertEqual(len(calls),1)
                self.assertNotIn('status',disposal)
        for kwargs in ({'count':True},{'count':2},{'oid':'48581'},
                       {'owners':[{**owner,'exit_after_cleanup':None}]},
                       {'owners':[{**owner,'exit_after_cleanup':1}]},
                       {'owners':[{**owner,'exit_after_cleanup':False}]},
                       {'owners':[{**owner,'cleanup':[{'status':'ERROR'}]}]},
                       {'owners':[{**owner,'constructor_status':'FAILED'}]}):
            with self.subTest(refused_metadata=kwargs):
                calls,disposal,error=run([backend],**kwargs)
                self.assertIsNotNone(error)
                self.assertEqual(len(calls),1)
        calls,disposal,error=run([backend,backend])
        self.assertIsNotNone(error)
        self.assertEqual(len(calls),1)
        for error in (RuntimeError('database is being accessed by other users'),
                      TimeoutError('DROP result unknown')):
            calls,disposal,actual=run([backend],drop_error=error)
            self.assertIs(actual,error)
            self.assertEqual(len(calls),2)  # No retry or invented absence after an unknown DROP.
            self.assertNotIn('status',disposal)
        calls,disposal,error=run([],absence=False)
        self.assertIsNotNone(error)
        self.assertEqual(len(calls),3)
        self.assertNotIn('status',disposal)

    def job_response(self):
        return {'total_count':1,'jobs':[{'id':42,'run_id':123,'name':ci.ACCOUNTING_JOB_NAME,
                'runner_name':self.env['RUNNER_NAME'],'head_sha':self.source,'status':'in_progress',
                'conclusion':None,'completed_at':None,'labels':['ubuntu-latest'],
                'started_at':'1970-01-01T00:16:30Z'}]}

    def test_actual_job_start_supplies_finite_caps_without_invocation_time(self):
        selected,timing=ci.timing_observation(self.identity(),self.job_response(),1000)
        self.assertEqual(selected['id'],42)
        self.assertEqual(timing['job_started_at_unix'],990)
        self.assertEqual(timing['job_deadline_unix'],1890)
        self.assertEqual((timing['case_execution_seconds'],timing['cleanup_reserve_seconds']),(300,90))
        with self.assertRaises(RuntimeError):ci.timing_observation(self.identity(),self.job_response(),1501)

    def test_timing_refuses_ambiguous_or_wrong_current_job(self):
        mutations=({'run_id':124},{'head_sha':'d'*40},{'runner_name':'different'},
                   {'status':'completed'},{'labels':['self-hosted']},{'started_at':None},
                   {'started_at':'1970-01-01T00:17:00Z'})
        for mutation in mutations:
            response=self.job_response();response['jobs'][0].update(mutation)
            with self.subTest(mutation=mutation),self.assertRaises(RuntimeError):
                ci.timing_observation(self.identity(),response,1000)
        for response in ({'total_count':0,'jobs':[]},
                         {'total_count':2,'jobs':self.job_response()['jobs']*2},
                         {'total_count':101,'jobs':self.job_response()['jobs']}):
            with self.subTest(response=response),self.assertRaises(RuntimeError):
                ci.timing_observation(self.identity(),response,1000)

    def timing_producer_context(self,directory):
        from contextlib import ExitStack
        stack=ExitStack()
        directory=str(Path(directory).resolve())
        environment={**self.env,'GITHUB_WORKSPACE':directory,'RUNNER_TEMP':directory,
                     'GITHUB_EVENT_PATH':str(Path(directory)/'event.json'),'GH_TOKEN':'modeled-token-only'}
        Path(environment['GITHUB_EVENT_PATH']).write_text(json.dumps(self.event))
        def git(arguments,**kwargs):
            return {('rev-parse','--show-toplevel'):directory,('status','--porcelain','--untracked-files=no'):'',
                    ('rev-parse','HEAD'):self.commit,
                    # actions/checkout depth=1: the raw commit retains parents,
                    # while Git's revision walker treats HEAD as a shallow root.
                    ('cat-file','-p',self.commit):'tree ' + 'c'*40 + '\nparent ' + self.source + '\n\nPR merge\n',
                    ('show','-s','--format=%P','HEAD'):''}[tuple(arguments[3:])]
        stack.enter_context(patch.dict(ci.os.environ,environment,clear=True))
        stack.enter_context(patch.object(ci.subprocess,'check_output',side_effect=git))
        stack.enter_context(patch.object(ci.time,'time',return_value=1000))
        return stack

    def test_shallow_pr_checkout_retains_authoritative_parent_identity(self):
        from unittest.mock import MagicMock
        # Actual PR4733 checkout/log and attempt1 REST source identities.
        self.commit='fff56d9ab3ae6519130e50f882e3724939309849'
        self.source='f6a292dd06a3deaa1b48cd8eaa462178df52b8c0'
        base='03a82d9ea218ab01f74b5939b272f5f6a7d156fb'
        self.env.update(GITHUB_SHA=self.commit,GITHUB_RUN_ID='35187063376',
                        RUNNER_NAME='GitHub Actions 1000150378',
                        GITHUB_REF='refs/pull/4733/merge',
                        GITHUB_WORKFLOW_REF=ci.WORKFLOW+'refs/pull/4733/merge')
        self.event['number']=4733
        self.event['pull_request']['head']['sha']=self.source
        body=self.job_response();job=body['jobs'][0]
        job.update(id=105091407834,run_id=35187063376,started_at='2026-09-17T05:47:10Z')
        response=MagicMock(status=200);response.read.return_value=json.dumps(body).encode()
        response.__enter__.return_value=response
        opener=MagicMock();opener.open.return_value=response
        headers='tree f89d8ac211fee52f44ba320de4c5ffeabc682d65\nparent '+base+'\nparent '+self.source+'\n\nMerge\n'
        with tempfile.TemporaryDirectory() as directory,self.timing_producer_context(directory),\
                patch.object(ci.time,'time',return_value=1789624070),\
                patch.object(ci.urllib.request,'build_opener',return_value=opener):
            original_git=ci.subprocess.check_output.side_effect
            def shallow_git(arguments,**kwargs):
                if tuple(arguments[3:])==('cat-file','-p',self.commit):return headers
                return original_git(arguments,**kwargs)
            ci.subprocess.check_output.side_effect=shallow_git
            path=Path(directory).resolve()/'bbj-job-timing-35187063376-1.json'
            ci.produce_job_timing(directory,path)
            packet=json.loads(path.read_text())
            self.assertEqual(packet['identity']['commit'],self.commit)
            self.assertEqual(packet['identity']['source_commit'],self.source)
            self.assertEqual(packet['job']['head_sha'],self.source)
            self.assertEqual(packet['timing']['job_started_at_unix'],1789624030)
            self.assertEqual(opener.open.call_count,1)
            self.assertFalse(any(call.args[0][3:4]==['show'] for call in ci.subprocess.check_output.call_args_list))
            class ModeledCustody:
                def receipt(self):return {'manifest_sha256':'c'*64}
            output=Path(directory).resolve()/'artifacts/bbj-bank-replay/funded'
            output.parent.mkdir(parents=True)
            run=ci.CurrentAccountingRun(directory,'/unexecuted/postgresql',output,ModeledCustody())
            self.assertEqual(run.identity,packet['identity'])
            self.assertEqual(run.read_job_timing(str(path)),packet['timing'])
            self.assertNotIn('GH_TOKEN',run.child_env)
            self.assertEqual(run.attempt['funded_cases_executed'],[])
            # Commit-message text must not manufacture a missing parent.
            with self.assertRaises(RuntimeError):
                head,parents=ci.checkout_identity(lambda *args:self.commit if args[0]=='rev-parse' else
                                                 'tree '+'c'*40+'\nparent '+base+'\n\nparent '+self.source)
                ci.identity(ci.os.environ,self.event,head,parents,Path(directory))
            with self.assertRaises(RuntimeError):
                ci.checkout_identity(lambda *args:self.commit if args[0]=='rev-parse' else
                                     'tree '+'c'*40+'\nparent invalid\n\nMerge')

    def test_timing_producer_is_single_read_exclusive_and_receipt_is_bound(self):
        from unittest.mock import MagicMock
        raw=json.dumps(self.job_response()).encode()
        response=MagicMock(status=200);response.read.return_value=raw
        response.__enter__.return_value=response
        opener=MagicMock();opener.open.return_value=response
        with tempfile.TemporaryDirectory() as directory,self.timing_producer_context(directory),patch.object(ci.urllib.request,'build_opener',return_value=opener):
            path=Path(directory).resolve()/'bbj-job-timing-123-1.json'
            ci.produce_job_timing(directory,path)
            self.assertNotIn('modeled-token-only',path.read_text())
            self.assertEqual(opener.open.call_count,1)
            with self.assertRaises(RuntimeError):ci.produce_job_timing(directory,path)
            self.assertEqual(opener.open.call_count,1)
            run=ci.CurrentAccountingRun.__new__(ci.CurrentAccountingRun)
            run.identity=json.loads(path.read_text())['identity'];run.output=Path(directory)/'receipt';run.output.mkdir()
            timing=run.read_job_timing(str(path));self.assertEqual(timing['job_started_at_unix'],990)
            packet=json.loads(path.read_text());packet['timing']['job_started_at_unix']=1000;path.write_text(json.dumps(packet))
            with self.assertRaises(RuntimeError):run.read_job_timing(str(path))
            self.assertEqual(json.loads((run.output/'JOB-TIMING-SOURCE.json').read_text())['timing'],timing)

    def test_timing_api_failure_is_redacted_without_retry(self):
        from unittest.mock import MagicMock
        opener=MagicMock();opener.open.side_effect=OSError('modeled-token-only private response')
        with tempfile.TemporaryDirectory() as directory,self.timing_producer_context(directory),patch.object(ci.urllib.request,'build_opener',return_value=opener):
            path=Path(directory).resolve()/'bbj-job-timing-123-1.json'
            with self.assertRaises(RuntimeError) as observed:ci.produce_job_timing(directory,path)
            self.assertNotIn('modeled-token-only',str(observed.exception))
            self.assertNotIn('private response',str(observed.exception))
            self.assertEqual(opener.open.call_count,1)
            self.assertFalse(path.exists())
            self.assertEqual(ci.timing_refusal_reason(observed.exception),'TIMING_TRANSPORT_OR_DECODING_REFUSED')
        self.assertEqual(ci.timing_refusal_reason(RuntimeError('PR source is not in the actual checkout identity')),
                         'PR_SOURCE_NOT_CHECKOUT_PARENT')
        self.assertEqual(ci.timing_refusal_reason(RuntimeError('modeled-token-only private response')),
                         'LOCAL_OPERATION_REFUSED')
        self.assertEqual(ci.timing_refusal_reason(ci.TimingRequestRefused('modeled-token-only private response')),
                         'LOCAL_OPERATION_REFUSED')
        response=MagicMock(status=200)
        body=self.job_response();body['jobs'][0]['runner_name']='wrong'
        response.read.return_value=json.dumps(body).encode();response.__enter__.return_value=response
        opener=MagicMock();opener.open.return_value=response
        with tempfile.TemporaryDirectory() as directory,self.timing_producer_context(directory),\
                patch.object(ci.urllib.request,'build_opener',return_value=opener):
            path=Path(directory).resolve()/'bbj-job-timing-123-1.json'
            with self.assertRaises(RuntimeError) as observed:ci.produce_job_timing(directory,path)
            self.assertEqual(ci.timing_refusal_reason(observed.exception),'JOB_IDENTITY_MISMATCH')
            self.assertEqual(opener.open.call_count,1)
            self.assertFalse(path.exists())

#!/usr/bin/env python3
"""Portable refusal/cleanup tests; these do not execute Docker or systemd."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('native_import_proof',
    Path(os.environ.get('ENGINE_NATIVE_IMPORT_TEST_SUBJECT',
         Path(__file__).with_name('engine-native-import-proof.py'))))
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


def request():
    return {'source_sha': 'a'*40, 'server_tree': 'b'*40, 'image_id': 'sha256:'+'c'*64,
            'archive_sha256': 'd'*64, 'archive_bytes': 1234,
            'build_contract': 'clean-server-archive-v1', 'platform': 'linux/amd64',
            'main_daemon_id': 'owned-main-daemon', 'runtime_hashes': {'engine/a.js': 'e'*64}}


class IdentityTests(unittest.TestCase):
    def test_exact_request(self):
        self.assertTrue(proof.validate_request(request()))

    def test_malformed_identity_refusals(self):
        for key, value in [('source_sha', 'a'*39), ('server_tree', 'B'*40),
                           ('image_id', 'tag:latest'), ('archive_sha256', 'd'*63),
                           ('archive_bytes', True), ('archive_bytes', 0),
                           ('archive_bytes', 2*1024**3+1), ('main_daemon_id', ''),
                           ('platform', 'linux/arm64'), ('build_contract', 'unchecked-v0')]:
            with self.subTest(key=key, value=value):
                r = request(); r[key] = value
                with self.assertRaises(RuntimeError): proof.validate_request(r)

    def test_runtime_path_and_digest_refusals(self):
        for files in [{}, {'../a': 'e'*64}, {'/a': 'e'*64}, {'a//b': 'e'*64},
                      {'./a': 'e'*64}, {'a/': 'e'*64}, {'a': 'bad'}, {'a': 5}]:
            with self.subTest(files=files):
                r = request(); r['runtime_hashes'] = files
                with self.assertRaises(RuntimeError): proof.validate_request(r)

    def test_bounded_unit_limits(self):
        self.assertTrue(proof.assert_limits({'memory.max':str(proof.LIMIT),
            'memory.swap.max':'0', 'cpu.max':'100000 100000'}))
        for key,value in [('memory.max','max'),('memory.max','1073741824'),
                          ('memory.swap.max','1'),('cpu.max','max 100000'),
                          ('cpu.max','200000 100000'),('cpu.max','0 0')]:
            with self.subTest(key=key,value=value):
                limits={'memory.max':str(proof.LIMIT),'memory.swap.max':'0','cpu.max':'100000 100000'}
                limits[key]=value
                with self.assertRaises(RuntimeError): proof.assert_limits(limits)

    def test_cgroup_prefix_cannot_match_sibling(self):
        self.assertTrue(proof.contained('/a/service/child','/a/service'))
        self.assertTrue(proof.contained('/a/service','/a/service'))
        self.assertFalse(proof.contained('/a/service-other','/a/service'))

    def test_signal_handlers_restore_even_on_cancellation(self):
        original = {s: object() for s in (signal.SIGTERM,signal.SIGHUP,signal.SIGINT)}
        handlers = dict(original)
        def replace(sig, handler):
            before=handlers[sig]; handlers[sig]=handler; return before
        with patch.object(proof.signal,'signal',side_effect=replace):
            with self.assertRaises(InterruptedError):
                with proof.catch_termination(): handlers[signal.SIGTERM](signal.SIGTERM,None)
        self.assertEqual(handlers,original)


class SourcePackageTests(unittest.TestCase):
    def archive(self, *, omit=None, extra=None, duplicate=None, symlink=None):
        result=io.BytesIO()
        with tarfile.open(fileobj=result,mode='w:gz') as tf:
            for name in sorted(proof.BINARIES):
                if name==omit: continue
                entry=tarfile.TarInfo('docker/'+name); data=('fixture bytes '+name).encode()
                if name==symlink:
                    entry.type=tarfile.SYMTYPE;entry.linkname='/bin/sh';tf.addfile(entry)
                else:
                    entry.size=len(data);tf.addfile(entry,io.BytesIO(data))
                    if name==duplicate: tf.addfile(entry,io.BytesIO(data))
            if extra:
                entry=tarfile.TarInfo(extra);entry.size=1;tf.addfile(entry,io.BytesIO(b'x'))
        return result.getvalue()

    def fetch(self, data, root, *, wrong_hash=False, changed_url=False, size_delta=0):
        class Response(io.BytesIO):
            def geturl(self): return 'https://unexpected.invalid/' if changed_url else proof.DOCKER_URL
        with patch.object(proof,'DOCKER_BYTES',len(data)+size_delta), \
             patch.object(proof,'DOCKER_SHA256','0'*64 if wrong_hash else hashlib.sha256(data).hexdigest()), \
             patch.object(proof.urllib.request,'urlopen',return_value=Response(data)):
            return proof.fetch_binaries(root)

    def test_complete_pinned_package(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); destination=self.fetch(self.archive(),root)
            self.assertEqual({p.name for p in destination.iterdir()},proof.BINARIES)
            self.assertFalse((root/'docker-static.tgz').exists())
            self.assertTrue(all(p.stat().st_mode&0o777==0o755 for p in destination.iterdir()))

    def test_digest_url_size_and_member_refusals(self):
        cases=[({}, {'wrong_hash':True}),({}, {'changed_url':True}),({}, {'size_delta':-1}),
               ({}, {'size_delta':1}),({'omit':'ctr'},{}),({'extra':'docker/unknown'},{}),
               ({'extra':'../outside'},{}),({'duplicate':'docker'},{}),({'symlink':'runc'}, {})]
        for archive_args,fetch_args in cases:
            with self.subTest(archive_args=archive_args,fetch_args=fetch_args):
                with tempfile.TemporaryDirectory() as d:
                    with self.assertRaises(RuntimeError):
                        self.fetch(self.archive(**archive_args),Path(d),**fetch_args)


class CleanupTests(unittest.TestCase):
    root=Path('/tmp/engine-native-import-unit-test')
    unit='ca-engine-import-'+'a'*16+'.service'

    def cleanup(self, *, active=False, cgroup=False, mount=False, stop_timeout=False,
                remove_fail=False, observer_timeout=False):
        remaining={'root':True}; commands=[]
        def exists(p):
            if p==self.root: return remaining['root']
            if str(p).startswith('/sys/fs/cgroup/'): return cgroup
            return False
        def run(args, **kwargs):
            commands.append(args)
            if 'stop' in args and stop_timeout: raise subprocess.TimeoutExpired(args,30)
            if 'is-active' in args:
                if observer_timeout: raise subprocess.TimeoutExpired(args,10)
                return subprocess.CompletedProcess(args,0 if active else 3,'active' if active else 'inactive')
            if 'rm' in args:
                self.assertEqual(args,['sudo','-n','rm','-rf','--',str(self.root)])
                if not remove_fail: remaining['root']=False
                return subprocess.CompletedProcess(args,1 if remove_fail else 0,'')
            return subprocess.CompletedProcess(args,0,'')
        mounts='1 2 3:4 / '+str(self.root)+'/data rw - overlay overlay rw\n' if mount else ''
        with patch.object(proof,'run',side_effect=run), \
             patch.object(Path,'exists',exists),patch.object(Path,'is_symlink',return_value=False), \
             patch.object(Path,'read_text',return_value=mounts):
            return proof.cleanup_import(self.root,self.unit,Path('/owned-evidence')),commands

    def test_complete_cleanup(self):
        facts,commands=self.cleanup()
        self.assertTrue(all(v for k,v in facts.items() if k!='cleanup_errors'))
        self.assertEqual(facts['cleanup_errors'],[])
        self.assertTrue(any('rm' in a for a in commands))

    def test_stop_timeout_does_not_abandon_other_observations(self):
        facts,commands=self.cleanup(stop_timeout=True)
        self.assertFalse(facts['unit_stop_completed'])
        self.assertTrue(facts['unit_inactive'])
        self.assertTrue(facts['owned_files_removed'])
        self.assertEqual(facts['cleanup_errors'],[{'stage':'stop_unit','error_type':'TimeoutExpired'}])

    def test_refuse_deletion_with_live_unit_cgroup_mount_or_unreadable_state(self):
        for opts in [{'active':True},{'cgroup':True},{'mount':True},{'observer_timeout':True}]:
            with self.subTest(opts=opts):
                facts,commands=self.cleanup(**opts)
                self.assertFalse(facts['owned_files_removed'])
                self.assertFalse(any('rm' in a for a in commands))

    def test_failed_removal_stays_failed(self):
        facts,_=self.cleanup(remove_fail=True)
        self.assertFalse(facts['owned_files_removed'])

    def test_unowned_cleanup_targets_refuse_before_commands(self):
        for root,unit in [(Path('/var/lib/docker'),self.unit),(self.root,'docker.service'),
                          (Path('/tmp/engine-native-import-x/..'),self.unit)]:
            with self.subTest(root=root,unit=unit),patch.object(proof,'run') as run:
                with self.assertRaises(RuntimeError):proof.cleanup_import(root,unit,Path('/unused'))
                run.assert_not_called()


class NativeMatrixProtocolTests(unittest.TestCase):
    """Simulated receipts test acceptance logic, never native execution."""
    def matrix(self, mutation=None, unexpectedly_pass=False):
        calls=[]
        def invoke(archive, metadata, expected, output, *, fault=None):
            calls.append((str(output),dict(metadata),dict(expected),fault))
            if output.name=='native-import-success':
                return {'status':'passed'}
            name=output.name.removeprefix('native-import-')
            record={'status':'failed','stage':'awaiting_external_cancellation' if fault else name,
                'failure_type':'InterruptedError' if fault else 'RuntimeError',
                'failure_code':{'image_identity':'imported immutable image identity differs',
                    'runtime_bytes':'imported runtime bytes differ',
                    'external_cancellation':'native import proof interrupted'}[name],
                'resource_observation_before_stop':{'memory.max':str(proof.LIMIT),
                    'memory.swap.max':'0','cpu.max':'100000 100000', 'memory_peak':123456,
                    'memory_events':{'oom':0,'oom_kill':0}},
                'before':{'memory_events':{'oom':0,'oom_kill':0}},
                'resource_observation_after_stop':{'memory.max':str(proof.LIMIT),
                    'memory.swap.max':'0','cpu.max':'100000 100000', 'memory_peak':123456,
                    'memory_events':{'oom':0,'oom_kill':0}},
                'worker_external_cancellation_sent':bool(fault),'unit_exit_code':1,
                'cleanup_errors':[]}
            for key in ('daemon_alive_before_requested_stop','daemon_stopped',
                'managed_containerd_stopped_before_parent_cleanup','unit_stop_completed',
                'unit_inactive','owned_cgroup_absent','owned_mounts_absent','owned_files_removed'):
                record[key]=True
            if mutation: mutation(record)
            (output/'native-import-receipt.json').write_text(json.dumps(record))
            if not unexpectedly_pass: raise RuntimeError('expected failed operation')
            return {'status':'passed'}
        with tempfile.TemporaryDirectory() as d, \
                patch.object(proof.sys,'platform','linux'), \
                patch.dict(proof.os.environ,{'GITHUB_ACTIONS':'true'}), \
                patch.object(proof,'prove_import',side_effect=invoke):
            result=proof.prove_import_matrix(Path('/owned/archive'),request(),
                                            request()['runtime_hashes'],Path(d))
        return result,calls

    def test_four_fresh_operations_and_exact_fault_requests(self):
        result,calls=self.matrix()
        self.assertEqual(len(calls),4)
        self.assertEqual(len({c[0] for c in calls}),4)
        self.assertEqual(result['status'],'passed')
        self.assertFalse(result['production_host_import_qualified'])
        self.assertFalse(result['cold_cache_or_total_host_budget_proved'])
        self.assertEqual(calls[0][1],request())
        self.assertEqual(calls[1][1]['image_id'],'sha256:'+'0'*64)
        self.assertNotEqual(calls[2][2],calls[0][2])
        self.assertEqual(calls[3][3],'cancel_after_load')
        for name in ('image_identity','runtime_bytes','external_cancellation'):
            self.assertEqual(result['cases'][name]['operation_receipt']['status'],'failed')

    def test_missing_or_wrong_refusal_cannot_earn_execution_credit(self):
        for key,value in [('stage','daemon_start'),('status','passed'),
            ('failure_type','TimeoutExpired'),('failure_code',None),
            ('unit_exit_code',None),('unit_exit_code',True),('unit_exit_code',0),
            ('worker_external_cancellation_sent',None)]:
            with self.subTest(key=key,value=value),self.assertRaises(RuntimeError):
                self.matrix(lambda r:r.update({key:value}))

    def test_faults_require_actual_containment_and_uncontaminated_memory(self):
        mutations=[lambda r:r.pop('resource_observation_before_stop'),
            lambda r:r.update(resource_observation_failure='unknown'),
            lambda r:r['resource_observation_before_stop'].update({'memory.max':'max'}),
            lambda r:r['resource_observation_before_stop'].update(memory_peak=proof.LIMIT+1),
            lambda r:r['resource_observation_before_stop']['memory_events'].update(oom=1),
            lambda r:r['resource_observation_before_stop']['memory_events'].update(oom_kill=1),
            lambda r:r.pop('resource_observation_after_stop'),
            lambda r:r.update(resource_observation_after_stop_failure='RuntimeError'),
            lambda r:r['resource_observation_after_stop']['memory_events'].update(oom=1),
            lambda r:r['resource_observation_after_stop']['memory_events'].update(oom_kill=1),
            lambda r:r['resource_observation_after_stop'].update({'memory.max':'max'}),
            lambda r:r['resource_observation_after_stop'].update(memory_peak=proof.LIMIT+1)]
        for change in mutations:
            with self.subTest(change=change),self.assertRaises(RuntimeError):self.matrix(change)

    def test_each_native_fault_cleanup_fact_is_mandatory(self):
        for key in ('daemon_alive_before_requested_stop','daemon_stopped',
            'managed_containerd_stopped_before_parent_cleanup','unit_stop_completed',
            'unit_inactive','owned_cgroup_absent','owned_mounts_absent','owned_files_removed'):
            with self.subTest(key=key),self.assertRaises(RuntimeError):
                self.matrix(lambda r:r.update({key:False}))
        with self.assertRaises(RuntimeError):self.matrix(lambda r:r.update(cleanup_errors=['unknown']))

    def test_fault_operation_success_is_rejected(self):
        with self.assertRaises(RuntimeError):self.matrix(unexpectedly_pass=True)



class WorkerStartupMemoryTests(unittest.TestCase):
    def run_worker(self, *, oom_phase, successful_import=False):
        """Run the worker's real sequencing with controlled processes and commands."""
        with tempfile.TemporaryDirectory(prefix='engine-native-import-', dir='/tmp') as tmp:
            root = Path(tmp)
            archive = root / 'fixture-archive.tar'
            archive.write_bytes(b'controlled test bytes, never loaded')
            data = request()
            data.update(archive=str(archive), archive_bytes=archive.stat().st_size,
                        archive_sha256=hashlib.sha256(archive.read_bytes()).hexdigest())
            request_path = root / 'request.json'
            if successful_import:
                data['runtime_hashes']={'engine/a.js':hashlib.sha256(b'runtime bytes').hexdigest()}
            request_path.write_text(json.dumps(data))
            class Daemon:
                pid = 20002
                stopped = False
                def poll(self): return 0 if self.stopped else None
                def terminate(self): self.stopped = True
                def wait(self, timeout): self.stopped = True; return 0
            daemon = Daemon()
            class ProcEntry:
                name = '20003'
                def __truediv__(self, child): return self
                def resolve(self): return root / 'bin/containerd'
            info = {'ServerVersion':proof.DOCKER_VERSION, 'Driver':'overlayfs',
                    'DriverStatus':[['driver-type','io.containerd.snapshotter.v1']],
                    'CgroupDriver':'systemd','CgroupVersion':'2',
                    'DockerRootDir':str(root/'data'),'Images':0,'Containers':0,
                    'ID':'controlled-private-daemon'}
            def run(args, **kwargs):
                if 'info' in args:
                    output=json.dumps(info)
                elif 'inspect' in args:
                    output=json.dumps([{'Id':data['image_id'] if successful_import else 'sha256:'+'0'*64,'Architecture':'amd64','Os':'linux',
                        'Config':{'Labels':{'org.opencontainers.image.revision':data['source_sha'],
                        'com.smarterpoker.engine.source-tree':data['server_tree'],
                        'com.smarterpoker.engine.build-contract':'clean-server-archive-v1'}}}])
                elif 'cp' in args:
                    emitted=root/'runtime/engine/a.js'; emitted.parent.mkdir(parents=True); emitted.write_bytes(b'runtime bytes')
                    output=''
                else:
                    self.assertTrue(any(action in args for action in ('load','create','rm')))
                    output='controlled command response'
                return subprocess.CompletedProcess(args,0,output)
            count = 0
            def snapshot(owner, pids):
                nonlocal count
                threshold = 1 if oom_phase=='startup' else (4 if successful_import else 3)
                events=int(count >= threshold) if oom_phase else 0
                count += 1
                return {'memory.max':str(proof.LIMIT),'memory.swap.max':'0',
                    'cpu.max':'100000 100000','memory_peak':123456,
                    'memory_events':{'oom':events,'oom_kill':events}, 'verified_pids':pids}
            original_resolve=Path.resolve
            original_iterdir=Path.iterdir
            original_exists=Path.exists
            def resolve(path,*args,**kwargs):
                return path if path==request_path else original_resolve(path,*args,**kwargs)
            def iterdir(path):
                return iter([ProcEntry()]) if path==Path('/proc') else original_iterdir(path)
            def exists(path):
                return False if path==Path('/proc/20003') else original_exists(path)
            with patch.object(proof.sys,'platform','linux'), patch.object(proof.os,'geteuid',return_value=0), \
                    patch.dict(proof.os.environ,{'GITHUB_ACTIONS':'true'}), \
                    patch.object(proof,'run',side_effect=run), \
                    patch.object(proof,'resource_snapshot',side_effect=snapshot), \
                    patch.object(proof.subprocess,'Popen',return_value=daemon), \
                    patch.object(proof.signal,'signal'), \
                    patch.object(Path,'resolve',resolve), patch.object(Path,'iterdir',iterdir), \
                    patch.object(Path,'exists',exists):
                raised = None
                try:
                    proof.worker(request_path)
                except RuntimeError as error:
                    raised = error
            observed=json.loads((root/'worker-receipt.json').read_text())
            return observed, raised

    def test_real_worker_receipt_retains_pre_daemon_oom_baseline(self):
        observed, error=self.run_worker(oom_phase='startup')
        self.assertIsInstance(error,RuntimeError)
        self.assertEqual(observed['status'],'failed')
        self.assertEqual(observed['stage'],'image_identity')
        self.assertEqual(observed['before']['memory_events'],{'oom':0,'oom_kill':0})
        self.assertEqual(observed['ready']['memory_events'],{'oom':1,'oom_kill':1})
        self.assertEqual(observed['resource_observation_before_stop']['memory_events'],
                         {'oom':1,'oom_kill':1})

    def test_shutdown_oom_cannot_turn_a_successful_load_into_a_pass(self):
        observed,error=self.run_worker(oom_phase='shutdown',successful_import=True)
        self.assertIsInstance(error,RuntimeError)
        self.assertEqual(observed['status'],'failed')
        self.assertEqual(observed['resource_observation_before_stop']['memory_events'],
                         {'oom':0,'oom_kill':0})
        self.assertEqual(observed['resource_observation_after_stop']['memory_events'],
                         {'oom':1,'oom_kill':1})
        self.assertEqual(observed['resource_observation_after_stop_failure'],'RuntimeError')

    def test_clean_worker_sequence_keeps_success(self):
        observed,error=self.run_worker(oom_phase=None,successful_import=True)
        self.assertIsNone(error)
        self.assertEqual(observed['status'],'passed')
        self.assertEqual(observed['stage'],'complete')
        self.assertNotIn('resource_observation_after_stop_failure',observed)


if __name__=='__main__':unittest.main()

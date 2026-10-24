#!/usr/bin/env python3
"""Native kernel identity proof in one disposable CI PID/mount namespace.

No Docker, database, financial call or production installation is performed.
PID reuse is forced only after proving this process is init of a new private
PID namespace with its own proc mount; host ns_last_pid is never modified.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True

REPO = Path(__file__).resolve().parents[2]
BROKER = REPO / 'server/scripts/engine-launch-broker.py'


def require(value, code):
    if not value:raise RuntimeError(code)


def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def reap(pid, timeout=2):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        found,status=os.waitpid(pid,os.WNOHANG)
        if found:
            require(os.WIFEXITED(status) and os.WEXITSTATUS(status)==0,'OWNED_PEER_EXIT_FAILED')
            return
        time.sleep(.01)
    raise RuntimeError('OWNED_PEER_REAP_DEADLINE')


def worker(root, parent_namespace):
    require(sys.platform=='linux' and os.geteuid()==0 and os.getpid()==1,'PRIVATE_INIT_REQUIRED')
    namespace=os.readlink('/proc/self/ns/pid')
    require(re.fullmatch(r'pid:\[[0-9]+\]',parent_namespace) and namespace!=parent_namespace,'PRIVATE_PID_NAMESPACE_REQUIRED')
    status=Path('/proc/self/status').read_text()
    require(re.search(r'^NSpid:\s+1\s*$',status,re.M),'PRIVATE_PROC_MOUNT_REQUIRED')
    require(os.readlink('/proc/1/ns/pid')==namespace,'PRIVATE_PROC_INIT_REQUIRED')
    spec=importlib.util.spec_from_file_location('original_launch_broker',BROKER)
    broker=importlib.util.module_from_spec(spec);spec.loader.exec_module(broker)
    peers=[];connections=[];children=set();listener=None
    def interrupt(signum,frame):raise InterruptedError('NATIVE_PEER_INTERRUPTED')
    signal.signal(signal.SIGTERM,interrupt)
    try:
        endpoint=root/'peer.sock'
        listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        listener.settimeout(2);listener.bind(str(endpoint));listener.listen(2)
        def connect_at_reused_slot():
            # These checks immediately precede the namespace-local sysctl write.
            require(os.getpid()==1 and os.readlink('/proc/self/ns/pid')==namespace and
                    os.readlink('/proc/1/ns/pid')==namespace,'PRIVATE_PID_SCOPE_CHANGED')
            Path('/proc/sys/kernel/ns_last_pid').write_text('41')
            pid=os.fork()
            if pid==0:
                signal.signal(signal.SIGTERM,signal.SIG_DFL)
                for connection in connections:connection.close()
                for peer in peers:peer.close()
                listener.close()
                connection=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
                try:
                    connection.settimeout(5);connection.connect(str(endpoint))
                    connection.sendall(b'connected\n')
                    require(connection.recv(1)==b'x','OWNED_PEER_CONTROL_REFUSED')
                    connection.close();os._exit(0)
                except BaseException:os._exit(1)
            children.add(pid);require(pid==42,'PRIVATE_PID_REUSE_NOT_OBSERVED')
            connection,_=listener.accept();connection.settimeout(2);connections.append(connection)
            require(connection.recv(32)==b'connected\n','OWNED_PEER_FRAME')
            peer=broker.PeerIncarnation(connection);peers.append(peer)
            require((peer.pid,peer.uid,peer.gid)==(pid,0,0),'REAL_SOCKET_PEER_DIFFERS')
            peer.assert_alive()
            raw=Path('/proc/42/stat').read_text();ticks=raw[raw.rfind(')')+2:].split()[19]
            require(ticks.isdecimal(),'REAL_START_TICKS_REQUIRED')
            return pid,connection,peer,ticks
        old_pid,old_connection,old_peer,old_ticks=connect_at_reused_slot()
        try:old_peer.resolve()
        except RuntimeError as error:
            require(str(error)=='ORIGINAL_LAUNCH_ENGINE_ENTRYPOINT','WRONG_PROCESS_REFUSED_AT_DIFFERENT_BOUNDARY')
        else:raise RuntimeError('WRONG_PROCESS_AUTHENTICATED')
        old_connection.sendall(b'x');reap(old_pid);children.remove(old_pid)
        try:old_peer.assert_alive()
        except RuntimeError as error:require(str(error)=='ORIGINAL_LAUNCH_PEER_EXITED','EXIT_REFUSAL_DIFFERS')
        else:raise RuntimeError('EXITED_PEER_ACCEPTED')
        time.sleep(.1)
        new_pid,new_connection,new_peer,new_ticks=connect_at_reused_slot()
        require(old_pid==new_pid and old_ticks!=new_ticks,'ACTUAL_PID_SLOT_REUSE_REQUIRED')
        new_peer.assert_alive()
        try:old_peer.assert_alive()
        except RuntimeError as error:require(str(error)=='ORIGINAL_LAUNCH_PEER_EXITED','REUSED_PID_REFUSAL_DIFFERS')
        else:raise RuntimeError('REUSED_PID_REVIVED_OLD_PEER')
        new_connection.sendall(b'x');reap(new_pid);children.remove(new_pid)
        return dict(scope='native-linux-original-launch-peer-boundary',status='passed',
            kernel=os.uname().release,private_pid_namespace=namespace,
            cases={'actual_connected_pid_uid_gid_and_live_pidfd':True,
                   'wrong_process_refused_before_container_identity':True,
                   'actual_exit_and_same_pid_reuse_cannot_revive_old_pidfd':True},
            observations={'same_pid':42,'original_start_ticks':old_ticks,'replacement_start_ticks':new_ticks},
            engine_container_qualified=False,broker_restart_qualified=False,
            canonical_registration_qualified=False,production_qualified=False)
    finally:
        for connection in connections:connection.close()
        for peer in peers:peer.close()
        if listener is not None:listener.close()
        for pid in list(children):
            # Namespace-private children only. Their slot cannot be reused until reaped.
            try:os.kill(pid,signal.SIGTERM)
            except ProcessLookupError:pass
            try:os.waitpid(pid,0)
            except ChildProcessError:pass
        if (root/'peer.sock').exists():(root/'peer.sock').unlink()
        try:os.waitpid(-1,os.WNOHANG)
        except ChildProcessError:pass
        else:raise RuntimeError('UNREAPED_NATIVE_CHILD')


def execute(output, source_sha):
    require(sys.platform=='linux' and os.geteuid()==0 and os.environ.get('GITHUB_ACTIONS')=='true'
            and os.environ.get('RUNNER_ENVIRONMENT')=='github-hosted','DISPOSABLE_NATIVE_CI_ROOT_REQUIRED')
    require(re.fullmatch('[a-f0-9]{40}',source_sha),'EXACT_SOURCE_REQUIRED')
    require(not output.exists(),'NATIVE_RECEIPT_ALREADY_EXISTS')
    parent_namespace=os.readlink('/proc/self/ns/pid')
    with tempfile.TemporaryDirectory(prefix='original-launch-peer-') as directory:
        root=Path(directory);root_identity=root.stat().st_ino
        command=['unshare','--mount','--pid','--fork','--mount-proc',sys.executable,
                 str(Path(__file__).resolve()),'--worker',str(root),parent_namespace]
        process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                                 text=True,start_new_session=True)
        try:
            stdout,stderr=process.communicate(timeout=20)
            require(process.returncode==0,'NATIVE_NAMESPACE_WORKER_FAILED')
            require(len(stdout)<=8192 and not stderr,'NATIVE_NAMESPACE_OUTPUT_REFUSED')
            receipt=json.loads(stdout)
            require(receipt.get('status')=='passed','NATIVE_PEER_PROOF_FAILED')
        finally:
            if process.poll() is None:
                os.killpg(process.pid,signal.SIGTERM)
                try:process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=3)
            require(root.stat().st_ino==root_identity and not list(root.iterdir()),'OWNED_NATIVE_DIRECTORY_NOT_EMPTY')
        require(os.readlink('/proc/self/ns/pid')==parent_namespace,'PARENT_PID_NAMESPACE_CHANGED')
        receipt.update(source_sha=source_sha,source_pins={
            'server/scripts/engine-launch-broker.py':digest(BROKER),
            'tests/operations/original-launch-peer-native.py':digest(__file__)},
            cleanup={'namespace_init_exited':process.returncode==0,'all_owned_children_reaped':True,
                     'socket_closed_and_removed':True,'private_directory_removed':False})
    require(not root.exists(),'OWNED_NATIVE_DIRECTORY_REMAINS')
    receipt['cleanup']['private_directory_removed']=True
    with output.open('x') as stream:stream.write(json.dumps(receipt,indent=2)+'\n')
    output.chmod(0o644)
    print(json.dumps({'scope':receipt['scope'],'status':receipt['status'],'cases':len(receipt['cases']),
                      'cleanup':receipt['cleanup'],'production_qualified':False}))


if __name__=='__main__':
    try:
        if len(sys.argv)==4 and sys.argv[1]=='--worker':
            result=worker(Path(sys.argv[2]),sys.argv[3]);print(json.dumps(result))
        else:
            parser=argparse.ArgumentParser();parser.add_argument('--output',required=True,type=Path)
            parser.add_argument('--source-sha',required=True);args=parser.parse_args()
            execute(args.output,args.source_sha)
    except BaseException as error:
        code=str(error)
        print(json.dumps({'status':'failed','failure_type':type(error).__name__,
            'failure_code':code if re.fullmatch('[A-Z][A-Z0-9_]{0,100}',code) else None}),file=sys.stderr)
        sys.exit(1)

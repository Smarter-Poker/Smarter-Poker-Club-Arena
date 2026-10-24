#!/usr/bin/env python3
"""Inactive original-launch identity component. No canonical ACK or DB authority.

This executable is deliberately absent from the production installer. The
Accounting commit port must be integrated before any production activation.
SO_PEERPIDFD binds the connected process itself; a caller-supplied PID, token,
container name, generation or kernel snapshot is never accepted as identity.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import select
import socket
import stat
import struct
import subprocess
import sys
import time
import uuid

CONTAINER = 'club-arena-engine'
STATE_ROOT = Path('/var/lib/club-arena/original-launch-broker')
SOCKET_ROOT = Path('/run/club-arena-original-launch')
SOCKET_PATH = SOCKET_ROOT / 'broker.sock'
FRAME_LIMIT = 4096
# Linux v6.8 include/uapi/asm-generic/socket.h, also present since Linux6.5.
# An unsupported kernel must refuse; pidfd_open(PID) would reintroduce reuse.
SO_PEERPIDFD = 77


def require(value, reason):
    if not value:
        raise RuntimeError('ORIGINAL_LAUNCH_' + reason)


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'DUPLICATE_FIELD')
        result[key] = value
    return result


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def unknown(reason):
    require(reason in {'canonical_registration_unavailable', 'peer_unproven',
                       'persistence_unavailable', 'request_refused'}, 'REASON')
    return dict(kind='unknown', reason=reason, startAuthority=False,
                noStartAuthority=False, financialMutationAuthority=False)


def request_frame(raw):
    require(isinstance(raw, bytes) and 0 < len(raw) <= FRAME_LIMIT and
            raw.endswith(b'\n') and raw.count(b'\n') == 1, 'FRAME')
    value = json.loads(raw.decode('utf-8', errors='strict'), object_pairs_hook=unique)
    require(isinstance(value, dict) and set(value) == {'version', 'operation'} and
            type(value['version']) is int and value['version'] == 1 and
            value['operation'] == 'acquireOriginalLaunch', 'REQUEST')
    return value


def bounded_read(path, limit=4096):
    with Path(path).open('rb') as source:
        raw = source.read(limit + 1)
    require(0 < len(raw) <= limit, 'PROCESS_OBSERVATION_SIZE')
    return raw


def process_snapshot(pid):
    root = Path('/proc') / str(pid)
    raw = bounded_read(root / 'stat').decode()
    # comm can contain spaces and parentheses; starttime is field22.
    fields = raw[raw.rfind(')') + 2:].split()
    require(len(fields) >= 20 and fields[19].isdigit(), 'PROCESS_START')
    group = bounded_read(root / 'cgroup').decode().strip().splitlines()
    require(len(group) == 1 and group[0].startswith('0::/'), 'CGROUP_V2')
    cgroup = group[0][3:]
    require(all(part not in {'.', '..'} for part in cgroup.split('/')), 'CGROUP_PATH')
    command = bounded_read(root / 'cmdline').split(b'\0')
    require(command[-1] == b'', 'PROCESS_COMMAND')
    command.pop()
    require(len(command) == 2 and Path(os.fsdecode(command[0])).name == 'node' and
            command[1] == b'dist/index.js', 'ENGINE_ENTRYPOINT')
    require(os.readlink(root / 'cwd') == '/app', 'ENGINE_CWD')
    executable = (root / 'exe').stat()
    namespace = (root / 'ns/pid').stat()
    cgroup_stat = (Path('/sys/fs/cgroup') / cgroup.lstrip('/')).stat()
    boot = bounded_read('/proc/sys/kernel/random/boot_id').decode().strip()
    require(str(uuid.UUID(boot)) == boot, 'KERNEL_BOOT')
    return dict(kernel_boot_id=boot, pid=pid, process_start_ticks=fields[19],
                cgroup_path=cgroup, cgroup_inode=cgroup_stat.st_ino,
                pid_namespace_inode=namespace.st_ino,
                executable_device=executable.st_dev, executable_inode=executable.st_ino)


def container_snapshot():
    template = ('{"container_id":{{json .Id}},"image_id":{{json .Image}},'
                '"pid":{{json .State.Pid}},"running":{{json .State.Running}},'
                '"name":{{json .Name}},"release_sha":'
                '{{json (index .Config.Labels "org.opencontainers.image.revision")}}}')
    result = subprocess.run(['docker', 'container', 'inspect', '--format', template, CONTAINER],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3, check=True)
    require(0 < len(result.stdout) <= 128 * 1024, 'DOCKER_RESPONSE')
    # Docker emits only these six requested fields, never env/secrets or mounts.
    value = json.loads(result.stdout, object_pairs_hook=unique)
    require(isinstance(value, dict) and set(value) ==
            {'container_id','image_id','pid','running','name','release_sha'}, 'DOCKER_IDENTITY')
    require(re.fullmatch('[a-f0-9]{64}', value['container_id']) and
            re.fullmatch('sha256:[a-f0-9]{64}', value['image_id']) and
            isinstance(value['release_sha'], str) and re.fullmatch('[a-f0-9]{40}', value['release_sha']) and
            value['name'] == '/' + CONTAINER and value['running'] is True and
            type(value['pid']) is int and value['pid'] > 0, 'DOCKER_IDENTITY')
    return value


class PeerIncarnation:
    def __init__(self, connection):
        require(sys.platform == 'linux', 'LINUX_REQUIRED')
        self.fd = None
        try:
            self.pid, self.uid, self.gid = struct.unpack('3i', connection.getsockopt(
                socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
            self.fd = connection.getsockopt(socket.SOL_SOCKET, SO_PEERPIDFD)
            os.set_inheritable(self.fd, False)
            require(self.pid > 0 and self.uid == 0 and self.gid == 0, 'ENGINE_PEER')
            self.assert_alive()
        except BaseException:
            self.close()
            raise

    def assert_alive(self):
        require(self.fd is not None and not select.select([self.fd], [], [], 0)[0], 'PEER_EXITED')
        info = bounded_read('/proc/self/fdinfo/' + str(self.fd)).decode()
        pids = re.findall(r'^Pid:\s+([0-9]+)$', info, re.MULTILINE)
        require(pids == [str(self.pid)], 'PEER_PIDFD_IDENTITY')

    def resolve(self):
        self.assert_alive()
        before = process_snapshot(self.pid)
        container = container_snapshot()
        require(container['pid'] == self.pid and
                (before['cgroup_path'].endswith('/docker-' + container['container_id'] + '.scope') or
                 before['cgroup_path'].endswith('/docker/' + container['container_id'])), 'ENGINE_MAIN_PROCESS')
        after = process_snapshot(self.pid)
        self.assert_alive()
        require(before == after, 'INCARNATION_CHANGED')
        return {**before, 'uid':self.uid, 'gid':self.gid,
                **{key:container[key] for key in ('container_id', 'image_id', 'release_sha')}}

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


class PendingIdentityStore:
    """Durable local preparation only. These records are NOT registrations."""
    def __init__(self, root=STATE_ROOT, owner_uid=0):
        self.root = Path(root)
        self.owner_uid = owner_uid
        self.fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            details = os.fstat(self.fd)
            require(details.st_uid == owner_uid and stat.S_IMODE(details.st_mode) == 0o700, 'STORE_OWNER')
        except BaseException:
            os.close(self.fd)
            raise

    def prepare(self, identity):
        require(isinstance(identity, dict) and set(identity) == {
            'kernel_boot_id','pid','process_start_ticks','cgroup_path','cgroup_inode',
            'pid_namespace_inode','executable_device','executable_inode','uid','gid',
            'container_id','image_id','release_sha'}, 'IDENTITY_FIELDS')
        require(str(uuid.UUID(identity['kernel_boot_id'])) == identity['kernel_boot_id'] and
                type(identity['pid']) is int and identity['pid'] > 0 and
                isinstance(identity['process_start_ticks'], str) and
                re.fullmatch('[1-9][0-9]{0,19}', identity['process_start_ticks']) and
                isinstance(identity['cgroup_path'], str) and identity['cgroup_path'].startswith('/') and
                len(identity['cgroup_path']) <= 512 and
                all(type(identity[key]) is int and identity[key] > 0 for key in
                    ('cgroup_inode','pid_namespace_inode','executable_inode')) and
                type(identity['executable_device']) is int and identity['executable_device'] >= 0 and
                type(identity['uid']) is int and identity['uid'] == 0 and
                type(identity['gid']) is int and identity['gid'] == 0 and
                re.fullmatch('[a-f0-9]{64}', identity['container_id']) and
                re.fullmatch('sha256:[a-f0-9]{64}', identity['image_id']) and
                re.fullmatch('[a-f0-9]{40}', identity['release_sha']), 'IDENTITY_SHAPE')
        digest = hashlib.sha256(encode(identity)).hexdigest()
        name = digest + '.json'
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        except FileNotFoundError:
            value = dict(version=1, kind='pending_local_identity', identity_sha256=digest,
                         pending_ref=str(uuid.uuid4()), identity=identity, canonical_committed=False)
            temporary = '.' + str(uuid.uuid4()) + '.pending'
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=self.fd)
            try:
                with os.fdopen(fd, 'wb') as output:
                    output.write(encode(value)); output.flush(); os.fsync(output.fileno())
                try:
                    os.link(temporary, name, src_dir_fd=self.fd, dst_dir_fd=self.fd, follow_symlinks=False)
                except FileExistsError:
                    pass  # A concurrent exact record must be read and verified below.
                os.fsync(self.fd)
            finally:
                os.unlink(temporary, dir_fd=self.fd)
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        with os.fdopen(fd, 'rb') as source:
            details = os.fstat(source.fileno())
            require(stat.S_ISREG(details.st_mode) and details.st_uid == self.owner_uid and
                    stat.S_IMODE(details.st_mode) == 0o600 and 0 < details.st_size <= FRAME_LIMIT, 'STORE_RECORD')
            raw = source.read(FRAME_LIMIT + 1)
        value = json.loads(raw.decode('utf-8', errors='strict'), object_pairs_hook=unique)
        require(set(value) == {'version','kind','identity_sha256','pending_ref','identity','canonical_committed'} and
                type(value['version']) is int and value['version'] == 1 and value['kind'] == 'pending_local_identity' and
                value['canonical_committed'] is False and value['identity_sha256'] == digest and
                value['identity'] == identity and str(uuid.UUID(value['pending_ref'])) == value['pending_ref'], 'STORE_MISMATCH')
        # A previous attempt may have linked the record but lost its directory
        # fsync acknowledgement. Replays must prove persistence again as well.
        os.fsync(self.fd)
        return value

    def close(self):
        os.close(self.fd)


def handle(connection, store):
    peer = None
    reason = 'request_refused'
    try:
        deadline = time.monotonic() + 3
        raw = bytearray()
        while not raw.endswith(b'\n'):
            remaining = deadline - time.monotonic()
            require(remaining > 0, 'REQUEST_DEADLINE')
            connection.settimeout(remaining)
            part = connection.recv(FRAME_LIMIT + 1 - len(raw))
            require(part, 'INCOMPLETE_REQUEST')
            raw.extend(part)
            require(len(raw) <= FRAME_LIMIT, 'REQUEST_SIZE')
        request_frame(bytes(raw))
        reason = 'peer_unproven'
        peer = PeerIncarnation(connection)
        identity = peer.resolve()
        reason = 'persistence_unavailable'
        store.prepare(identity)
        peer.assert_alive()
        # No database adapter exists yet. Local durable bytes must never be
        # promoted into a committed registration or a successful warm session.
        reason = 'canonical_registration_unavailable'
    except Exception:
        pass
    finally:
        if peer is not None:
            peer.close()
    connection.settimeout(3)
    connection.sendall(encode(unknown(reason)))


def serve_inactive():
    require(sys.platform == 'linux' and os.geteuid() == 0, 'ROOT_LINUX_REQUIRED')
    # Explicit CLI acknowledgement is component-only, not an activation flag.
    require(sys.argv[1:] == ['--inactive-component'], 'INACTIVE_COMPONENT_ONLY')
    for root in (STATE_ROOT, SOCKET_ROOT):
        details = root.lstat()
        require(stat.S_ISDIR(details.st_mode) and details.st_uid == 0 and
                stat.S_IMODE(details.st_mode) == 0o700, 'ROOT_DIRECTORY')
    lock = os.open(STATE_ROOT / '.broker.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    store = PendingIdentityStore()
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    identity = None
    try:
        listener.bind(str(SOCKET_PATH))  # Refuse an existing socket; never steal it.
        os.chmod(SOCKET_PATH, 0o600)
        identity = SOCKET_PATH.lstat().st_ino
        listener.listen(4)
        while True:
            connection, _ = listener.accept()
            with connection:
                try:
                    handle(connection, store)
                except (BrokenPipeError, ConnectionResetError, TimeoutError):
                    pass  # Durable pending identity survives a lost reply.
    finally:
        listener.close(); store.close(); os.close(lock)
        if identity is not None and SOCKET_PATH.lstat().st_ino == identity:
            SOCKET_PATH.unlink()


if __name__ == '__main__':
    try:
        serve_inactive()
    except BaseException:
        # No process snapshots, Docker env, credentials or raw exceptions.
        print('ORIGINAL_LAUNCH_BROKER_REFUSED', file=sys.stderr)
        sys.exit(1)

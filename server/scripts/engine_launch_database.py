"""Inactive host-only transport for Accounting's original-launch API.

No import-time connection, installer, credential creation, image enrollment or
engine wiring. The caller must retain its exact pending identity across unknown
outcomes. Only explicit immutable-reader calls resolve uncertain transactions.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import signal
import stat
import subprocess
import sys
import threading
import time
from uuid import UUID

_ROOT = Path("/var/lib/club-arena/original-launch-broker")
_PSQL = "/usr/lib/postgresql/16/bin/psql"
_PRINCIPAL = "f06_original_launch_broker"
_SECONDS = 3.0
_LIMIT = 8192
_FALSE = {"startAuthority": False, "noStartAuthority": False, "financialMutationAuthority": False}
_OPERATIONS = {
    "register": ("f06_register_original_launch", ("uuid", "jsonb"), False),
    "read_registration": ("f06_read_original_launch", ("uuid", "jsonb"), True),
    "terminate": ("f06_record_original_termination", ("uuid", "uuid", "text", "jsonb"), False),
    "read_termination": ("f06_read_original_termination", ("uuid", "uuid", "text", "jsonb"), True),
    "bind": ("f06_bind_original_launch", ("uuid", "uuid", "text"), False),
    "append": ("f06_append_original_attempt", ("jsonb",), False),
    "read_attempt": ("f06_read_original_attempt", ("jsonb",), True),
}


class Refusal(Exception):
    """An unavailable observation; never evidence of rollback or no start."""


@dataclass(frozen=True)
class Observation:
    state: str = "unknown"
    evidence_json: str | None = None
    historical: bool = True
    startAuthority: bool = False
    noStartAuthority: bool = False
    financialMutationAuthority: bool = False


def _json(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Refusal("duplicate_field")
        result[key] = value
    return result


def _parse(raw):
    def nonfinite(_):
        raise Refusal("nonfinite")
    return json.loads(raw, object_pairs_hook=_object, parse_constant=nonfinite)


def _uuid(value):
    if not isinstance(value, str) or str(UUID(value)) != value:
        raise Refusal("uuid")
    return value


def _text(value, limit):
    if not isinstance(value, str) or not 1 <= len(value) <= limit \
            or any(ord(c) < 32 for c in value):
        raise Refusal("text")
    return value


def _identity(value):
    strings = {"kernel_boot_id", "cgroup_path", "container_id", "image_id",
               "process_start_ticks", "release_sha"}
    numbers = {"pid", "cgroup_inode", "pid_namespace_inode", "executable_inode",
               "executable_device", "uid", "gid"}
    if not isinstance(value, dict) or set(value) != strings | numbers:
        raise Refusal("identity")
    _uuid(value["kernel_boot_id"])
    for name, pattern in {
        "container_id": r"[0-9a-f]{64}", "image_id": r"sha256:[0-9a-f]{64}",
        "release_sha": r"[0-9a-f]{40}", "process_start_ticks": r"[1-9][0-9]{0,19}",
    }.items():
        if not isinstance(value[name], str) or not re.fullmatch(pattern, value[name]):
            raise Refusal("identity_value")
    path = _text(value["cgroup_path"], 512)
    if not path.startswith("/") or any(p in (".", "..") for p in path.split("/")):
        raise Refusal("cgroup")
    for name in numbers:
        floor = 0 if name in ("uid", "gid", "executable_device") else 1
        if type(value[name]) is not int or value[name] < floor:
            raise Refusal("identity_number")
    if value["uid"] != 0 or value["gid"] != 0:
        raise Refusal("engine_peer")


def _attempt(value):
    if not isinstance(value, dict) or set(value) != {
        "version", "attempt_id", "original", "registration_ref", "game_format_id"
    } or type(value["version"]) is not int or value["version"] != 1:
        raise Refusal("attempt")
    _uuid(value["attempt_id"])
    _uuid(value["registration_ref"])
    _text(value["game_format_id"], 128)
    original = value["original"]
    ids = {"admission_id", "tournament_id", "table_id", "lease_generation", "custody_id", "permit_id"}
    counters = {"lifecycle", "admission_revision", "hand_number"}
    if not isinstance(original, dict) or set(original) != ids | counters:
        raise Refusal("original")
    for key in ids:
        _uuid(original[key])
    for key in counters:
        v = original[key]
        if not isinstance(v, str) or not re.fullmatch(r"[1-9][0-9]{0,18}", v) \
                or int(v) > 9223372036854775807:
            raise Refusal("original_counter")


def _request(operation, args):
    if operation not in _OPERATIONS:
        raise Refusal("operation")
    _, types, _ = _OPERATIONS[operation]
    if len(args) != len(types):
        raise Refusal("arguments")
    # Take an independent bounded value before validation or process creation.
    encoded = _json(args).encode()
    if len(encoded) > _LIMIT:
        raise Refusal("request_size")
    values = _parse(encoded)
    for value, kind in zip(values, types):
        if kind == "uuid":
            _uuid(value)
    if operation in ("register", "read_registration"):
        _identity(values[1])
    elif operation in ("append", "read_attempt"):
        _attempt(values[0])
    elif operation == "bind":
        _text(values[2], 128)
    else:
        _text(values[2], 512)
        evidence = values[3]
        if not isinstance(evidence, dict) or set(evidence) != {
            "identity", "mechanism", "remaining_descendants", "observed_at"
        } or evidence["mechanism"] != "pidfd-exit-and-cgroup-empty" \
                or type(evidence["remaining_descendants"]) is not int \
                or evidence["remaining_descendants"] != 0:
            raise Refusal("termination")
        _identity(evidence["identity"])
        _text(evidence["observed_at"], 64)  # Canonical SQL validates timestamptz.
    return values


def _result(operation, args, value):
    if not isinstance(value, dict):
        raise Refusal("result")
    if value.get("kind") == "unknown":
        if set(value) != {"kind", "reason", *_FALSE} \
                or any(value[k] is not False for k in _FALSE):
            raise Refusal("unknown_shape")
        _text(value["reason"], 128)
        return Observation()
    if operation in ("append", "read_attempt"):
        request = args[0]
        keys = {*request, "kind", "marker_id", "marker_hash", "producer_receipt_ref"}
        if set(value) not in (keys, keys | {"startAuthority"}) \
                or value.get("kind") != "original_attempt_ack" \
                or _json({k: value.get(k) for k in request}) != _json(request):
            raise Refusal("attempt_result")
        if "startAuthority" in value and value["startAuthority"] is not False:
            raise Refusal("historical_authority")
        if operation == "read_attempt" and value.get("startAuthority") is not False:
            raise Refusal("reader_authority")
        _uuid(value["marker_id"])
        _uuid(value["producer_receipt_ref"])
        if not re.fullmatch(r"[0-9a-f]{64}", value["marker_hash"]):
            raise Refusal("marker_hash")
    else:
        if any(value.get(k) is not False for k in _FALSE):
            raise Refusal("authority")
        if operation in ("register", "read_registration"):
            keys = {"version", "kind", "registration_ref", "pending_ref", "identity_hash", *_FALSE}
            if set(value) != keys or type(value["version"]) is not int or value["version"] != 1 \
                    or value["kind"] != "original_launch_registration" or value["pending_ref"] != args[0]:
                raise Refusal("registration_result")
            _uuid(value["registration_ref"])
            if not re.fullmatch(r"[0-9a-f]{64}", value["identity_hash"]):
                raise Refusal("database_identity_hash")
        elif operation == "bind":
            if set(value) != {"kind", "registration_ref", "admission_id", *_FALSE} \
                    or value["kind"] != "original_launch_binding" \
                    or value["admission_id"] != args[0] or value["registration_ref"] != args[1]:
                raise Refusal("binding_result")
        else:
            if set(value) != {"version", "kind", "registration_ref", "termination_receipt_ref", *_FALSE} \
                    or type(value["version"]) is not int or value["version"] != 1 \
                    or value["kind"] != "local_termination_record" or value["registration_ref"] != args[0]:
                raise Refusal("termination_result")
            _uuid(value["termination_receipt_ref"])
    historical = _OPERATIONS[operation][2] or value.get("startAuthority") is False
    return Observation("immutable_readback" if _OPERATIONS[operation][2] else "commit_ack",
                       _json(value), historical)


def _open_private(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 \
                or stat.S_IMODE(s.st_mode) != 0o600 or not 0 < s.st_size <= maximum:
            raise Refusal("private_file")
        return fd
    except BaseException:
        os.close(fd)
        raise


@contextmanager
def _environment():
    if sys.platform != "linux" or os.geteuid() != 0:
        raise Refusal("host_root_required")
    # Root-only parent ownership keeps passfile/CA descriptors out of engine
    # mounts. No inherited PG*, service-role credential or psql startup file.
    for path in (_ROOT, *_ROOT.parents):
        s = path.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
            raise Refusal("private_directory")
    if stat.S_IMODE(_ROOT.stat().st_mode) != 0o700:
        raise Refusal("private_directory_mode")
    fds = []
    try:
        config_fd = _open_private(_ROOT / "database.json", 4096)
        fds.append(config_fd)
        config = _parse(os.read(config_fd, 4097))
        if not isinstance(config, dict) or set(config) != {"host", "port", "dbname"}:
            raise Refusal("database_profile")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,252}", config["host"]) \
                or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_-]{0,62}", config["dbname"]) \
                or type(config["port"]) is not int or not 1 <= config["port"] <= 65535:
            raise Refusal("database_profile_value")
        password = _open_private(_ROOT / "database.pass", 8192)
        fds.append(password)
        certificate = _open_private(_ROOT / "database-ca.pem", 65536)
        fds.append(certificate)
        yield {
            "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
            "PGHOST": config["host"], "PGPORT": str(config["port"]),
            "PGDATABASE": config["dbname"], "PGUSER": _PRINCIPAL,
            "PGPASSFILE": f"/proc/self/fd/{password}",
            "PGSSLROOTCERT": f"/proc/self/fd/{certificate}",
            "PGSSLMODE": "verify-full", "PGCHANNELBINDING": "require",
            "PGGSSENCMODE": "disable",
            "PGCONNECT_TIMEOUT": "2", "PGCLIENTENCODING": "UTF8",
            "PGAPPNAME": "f06-original-launch-broker",
        }, (password, certificate)
    finally:
        for fd in fds:
            os.close(fd)


class BrokerDatabase:
    """One bounded physical client at a time; no automatic mutation retries."""

    def __init__(self):
        self._lock = threading.Lock()
        self._retained: subprocess.Popen | None = None

    def observe(self, operation, *args) -> Observation:
        if not self._lock.acquire(blocking=False):
            return Observation()
        try:
            if self._retained is not None:
                if self._retained.poll() is None:
                    return Observation()
                self._retained = None
            values = _request(operation, args)
            with _environment() as (env, fds):
                return _result(operation, values, self._execute(operation, values, env, fds))
        except (Refusal, OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
            # Never expose raw stderr, SQL, credentials or request identities.
            return Observation()
        finally:
            self._lock.release()

    def _execute(self, operation, values, env, fds):
        function, types, readonly = _OPERATIONS[operation]
        expressions = []
        for value, kind in zip(values, types):
            text = _json(value) if kind == "jsonb" else value
            # Hex-only SQL literals; arbitrary user text never becomes SQL or
            # a psql backslash command. No request/secret is passed in argv.
            expressions.append("convert_from(decode('" + text.encode().hex() +
                               "','hex'),'UTF8')::" + kind)
        marker = "F06_COMMIT_" + secrets.token_hex(16)
        sql = "\n".join([
            "BEGIN ISOLATION LEVEL READ COMMITTED" + (" READ ONLY;" if readonly else ";"),
            "SET LOCAL statement_timeout='1500ms';", "SET LOCAL lock_timeout='250ms';",
            "SET LOCAL idle_in_transaction_session_timeout='1500ms';",
            "SET LOCAL client_min_messages='error';",
            f"SELECT 1 / ((session_user='{_PRINCIPAL}' AND current_user='{_PRINCIPAL}')::int);",
            f"SELECT smarter_private.{function}({','.join(expressions)});",
            "COMMIT;", r"\echo " + marker, "",
        ]).encode()
        deadline = time.monotonic() + _SECONDS
        process = subprocess.Popen(
            [_PSQL, "-X", "-w", "-q", "-A", "-t", "--set=ON_ERROR_STOP=1", "--file=-"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=env, pass_fds=fds, start_new_session=True, bufsize=0,
        )
        self._retained = process
        buffers = {"stdout": bytearray(), "stderr": bytearray()}
        remaining = memoryview(sql)
        try:
            with selectors.DefaultSelector() as selector:
                for stream, name, event in [
                    (process.stdin, "stdin", selectors.EVENT_WRITE),
                    (process.stdout, "stdout", selectors.EVENT_READ),
                    (process.stderr, "stderr", selectors.EVENT_READ),
                ]:
                    os.set_blocking(stream.fileno(), False)
                    selector.register(stream, event, name)
                while selector.get_map():
                    wait = deadline - time.monotonic()
                    if wait <= 0:
                        raise Refusal("transport_deadline")
                    for key, _ in selector.select(wait):
                        if key.data == "stdin":
                            n = os.write(key.fd, remaining[:4096])
                            remaining = remaining[n:]
                            if not remaining:
                                selector.unregister(key.fileobj)
                                key.fileobj.close()
                        else:
                            chunk = os.read(key.fd, 4096)
                            if not chunk:
                                selector.unregister(key.fileobj)
                                continue
                            buffers[key.data].extend(chunk)
                            cap = _LIMIT if key.data == "stdout" else 2048
                            if len(buffers[key.data]) > cap:
                                raise Refusal("transport_output_limit")
            code = process.wait(timeout=max(0.001, deadline - time.monotonic()))
            if time.monotonic() >= deadline:
                raise Refusal("transport_deadline")
            lines = buffers["stdout"].decode("utf-8").splitlines()
            # ON_ERROR_STOP + a marker after COMMIT + successful process exit:
            # a returned function row alone cannot satisfy this boundary.
            if code != 0 or len(lines) != 3 or lines[0] != "1" or lines[2] != marker:
                raise Refusal("commit_unconfirmed")
            return _parse(lines[1])
        finally:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=0.25)
                except subprocess.TimeoutExpired:
                    pass  # Retain the actual client; a later call cannot overlap it.
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()
            if process.poll() is not None:
                self._retained = None

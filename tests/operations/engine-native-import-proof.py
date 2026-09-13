#!/usr/bin/env python3
"""Fresh Docker import proof, exclusively in a disposable Linux Actions runner."""
import hashlib
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket as socket_module
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

DOCKER_VERSION = "29.7.2"
DOCKER_URL = "https://download.docker.com/linux/static/stable/x86_64/docker-29.7.2.tgz"
DOCKER_SHA256 = "803d433f226db4776e1768fd319fc6c6e4935a456acf84fcc0080818b854bc8f"
DOCKER_BYTES = 85700518
LIMIT = 512 * 1024 * 1024
BINARIES = {"docker", "dockerd", "docker-init", "docker-proxy", "containerd",
            "containerd-shim-runc-v2", "ctr", "runc"}


@contextmanager
def catch_termination():
    def interrupted(signum, frame):
        raise InterruptedError("native import proof interrupted")
    previous = {sig: signal.signal(sig, interrupted)
                for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)}
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def require(value, message):
    if not value:
        raise RuntimeError(message)


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def run(args, *, timeout=30, check=True, env=None):
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=timeout, env=env)
    if check:
        require(result.returncode == 0,
                f"native import command failed ({result.returncode}): {result.stdout[-6000:]}")
    return result


def assert_limits(values):
    require(values["memory.max"] == str(LIMIT), "import memory limit absent or different")
    require(values["memory.swap.max"] == "0", "import swap limit differs")
    quota, period = values["cpu.max"].split()
    require(quota.isdecimal() and period.isdecimal()
            and int(quota) == int(period) > 0, "import CPU limit differs")
    return True


def validate_request(request):
    for key in ("source_sha", "server_tree"):
        require(isinstance(request.get(key), str)
                and re.fullmatch("[0-9a-f]{40}", request[key]), "invalid source identity")
    require(isinstance(request.get("image_id"), str)
            and re.fullmatch("sha256:[0-9a-f]{64}", request["image_id"]), "invalid image identity")
    require(isinstance(request.get("archive_sha256"), str)
            and re.fullmatch("[0-9a-f]{64}", request["archive_sha256"]), "invalid archive identity")
    require(type(request.get("archive_bytes")) is int
            and 0 < request["archive_bytes"] <= 2 * 1024**3, "invalid archive size")
    require(request.get("build_contract") == "clean-server-archive-v1"
            and request.get("platform") == "linux/amd64", "invalid archive contract")
    require(request.get('fault') in {None, 'cancel_after_load'}, 'unknown native fault mode')
    require(isinstance(request.get("main_daemon_id"), str)
            and request["main_daemon_id"].strip(), "main daemon identity required")
    require(isinstance(request.get("runtime_hashes"), dict)
            and 0 < len(request["runtime_hashes"]) <= 20000, "runtime comparison required")
    for name, value in request["runtime_hashes"].items():
        require(isinstance(name, str) and name and '\0' not in name and not name.startswith("/")
                and all(part not in {"", ".", ".."} for part in name.split("/"))
                and isinstance(value, str) and re.fullmatch("[0-9a-f]{64}", value),
                "invalid runtime comparison identity")
    return True


def cgroup(pid):
    rows = Path(f"/proc/{pid}/cgroup").read_text().splitlines()
    require(len(rows) == 1 and rows[0].startswith("0::/"), "unified cgroup required")
    return rows[0][3:]


def contained(child, parent):
    return child == parent or child.startswith(parent.rstrip("/") + "/")


def resource_snapshot(owner, required_pids):
    group = cgroup(owner)
    require(re.fullmatch(r"/system.slice/ca-engine-import-[0-9a-f]+\.service", group),
            "unexpected native importer cgroup")
    base = Path("/sys/fs/cgroup") / group.lstrip("/")
    values = {name: (base / name).read_text().strip()
              for name in ("memory.max", "memory.swap.max", "cpu.max")}
    assert_limits(values)
    for pid in required_pids:
        require(contained(cgroup(pid), group), "import process escaped the bounded group")
    events = {key: int(value) for key, value in
              (row.split() for row in (base / "memory.events").read_text().splitlines())}
    return {**values, "cgroup": group, "memory_peak": int((base / "memory.peak").read_text()),
            "memory_events": events, "verified_pids": required_pids}


def fetch_binaries(root):
    archive = root / "docker-static.tgz"
    deadline = time.monotonic() + 180
    with urllib.request.urlopen(DOCKER_URL, timeout=30) as response, archive.open("xb") as output:
        require(response.geturl() == DOCKER_URL, "Docker source URL changed")
        total = 0
        while True:
            require(time.monotonic() < deadline, "Docker source download deadline")
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            require(total <= DOCKER_BYTES, "Docker source exceeded pinned size")
            output.write(chunk)
    require(total == DOCKER_BYTES and digest(archive) == DOCKER_SHA256,
            "Docker source checksum mismatch")
    destination = root / "bin"
    destination.mkdir()
    found = set()
    with tarfile.open(archive, "r:gz") as source:
        for member in source:
            if member.isdir() and member.name.rstrip("/") == "docker":
                continue
            require(member.name.startswith("docker/"), "unexpected Docker package path")
            name = member.name.removeprefix("docker/")
            require(name in BINARIES and name not in found and member.isreg()
                    and 0 < member.size <= 160 * 1024 * 1024,
                    "unexpected Docker package member")
            found.add(name)
            with source.extractfile(member) as input_file, (destination / name).open("xb") as output:
                shutil.copyfileobj(input_file, output, 1024 * 1024)
            require((destination / name).stat().st_size == member.size, "truncated Docker binary")
            (destination / name).chmod(0o755)
    require(found == BINARIES, "Docker package binary set differs")
    archive.unlink()
    return destination


def private_containerd_configuration(root):
    """No host config imports, storage paths, listeners or CRI services."""
    return ("version = 3\n"
            + "root = " + json.dumps(str(root / "containerd-data")) + "\n"
            + "state = " + json.dumps(str(root / "containerd-state")) + "\n"
            + 'disabled_plugins = ["io.containerd.grpc.v1.cri", '
              '"io.containerd.cri.v1.images", "io.containerd.cri.v1.runtime"]\n'
            + "[grpc]\naddress = " + json.dumps(str(root / "containerd.sock")) + "\n"
            + "[ttrpc]\naddress = " + json.dumps(str(root / "containerd-ttrpc.sock")) + "\n"
            + '[debug]\naddress = ""\nlevel = "warn"\n[metrics]\naddress = ""\n')


def verify_process_identity(process, command):
    require(process.poll() is None, "owned process exited before identity observation")
    require(Path(f"/proc/{process.pid}/exe").resolve(strict=True) == Path(command[0]),
            "owned process executable differs")
    observed = Path(f"/proc/{process.pid}/cmdline").read_bytes().split(b"\0")
    require(observed == [os.fsencode(arg) for arg in command] + [b""],
            "owned process command differs")


def verify_containerd_ownership(process, command, endpoint):
    verify_process_identity(process, command)
    matches = []
    for entry in Path("/proc").iterdir():
        if entry.name.isdecimal():
            try:
                if (entry / "exe").resolve(strict=True) == Path(command[0]):
                    matches.append(int(entry.name))
            except FileNotFoundError:
                continue
    require(matches == [process.pid], "one exact owned private containerd required")
    endpoint_stat = endpoint.lstat()
    require(stat.S_ISSOCK(endpoint_stat.st_mode) and endpoint_stat.st_uid == 0,
            "private containerd endpoint is not an owned socket")
    # A successful API response alone could come from another runtime. Linux
    # peer credentials bind the actual listener to our live pinned process.
    with socket_module.socket(socket_module.AF_UNIX, socket_module.SOCK_STREAM) as peer:
        peer.settimeout(2)
        peer.connect(str(endpoint))
        credentials = peer.getsockopt(socket_module.SOL_SOCKET, socket_module.SO_PEERCRED,
                                      struct.calcsize("3i"))
    require(struct.unpack("3i", credentials) == (process.pid, 0, 0),
            "private containerd socket peer differs")
    return {"pid": process.pid, "executable": command[0], "command": command,
            "socket": str(endpoint), "socket_peer_pid": process.pid,
            "socket_peer_uid": 0, "socket_peer_gid": 0}


def stop_owned_process(process, result, label):
    if process is not None:
        try:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    result[label + "_required_kill"] = True
                    result["status"] = "failed"
                    process.kill()
                    process.wait(timeout=3)
        except Exception as error:
            result[label + "_stop_failure"] = type(error).__name__
            result["status"] = "failed"
    result[label + "_stopped"] = process is not None and process.poll() is not None
    if not result[label + "_stopped"]:
        result["status"] = "failed"


def worker(request_path):
    require(sys.platform == "linux" and os.geteuid() == 0
            and os.environ.get("GITHUB_ACTIONS") == "true", "owned CI root worker required")
    request_path = Path(request_path).resolve()
    root = request_path.parent
    require(root.parent == Path("/tmp")
            and re.fullmatch(r"engine-native-import-[A-Za-z0-9_-]+", root.name),
            "unexpected native import root")
    request = json.loads(request_path.read_text())
    validate_request(request)
    archive = Path(request["archive"])
    require(archive.is_absolute() and archive.is_file() and not archive.is_symlink(),
            "native import archive must be a regular owned file")
    require(archive.stat().st_size == request["archive_bytes"]
            and digest(archive) == request["archive_sha256"], "native import archive changed")
    binaries = root / "bin"
    socket = root / "docker.sock"
    data_root = root / "data"
    env = {"PATH": str(binaries) + ":/usr/sbin:/usr/bin:/sbin:/bin",
           "DOCKER_CONFIG": str(root / "client-config"), "DOCKER_TMPDIR": str(root / "tmp")}
    (root / "tmp").mkdir()
    configuration = {
        "hosts": ["unix://" + str(socket)], "data-root": str(data_root),
        "exec-root": str(root / "exec"), "pidfile": str(root / "dockerd.pid"),
        "bridge": "none", "iptables": False, "ip6tables": False,
        "ip-forward": False, "ip-masq": False, "userland-proxy": False,
        "features": {"containerd-snapshotter": True, "embedded-containerd": False},
        "containerd": str(root / "containerd.sock"),
        "containerd-namespace": "owned-engine-import",
        "exec-opts": ["native.cgroupdriver=systemd"], "log-level": "warn",
    }
    config_path = root / "daemon.json"
    config_path.write_text(json.dumps(configuration))
    docker = [str(binaries / "docker"), "--host", "unix://" + str(socket),
              "--config", str(root / "client-config")]
    result = {"status": "failed", "production_host_import_qualified": False,
              "producer_authenticated": False, "scope": "fresh-isolated-native-import",
              "stage": "daemon_start", "input_archive_was_prepared_in_same_CI_runner": True}
    daemon = None
    runtime = None
    runtime_command = [str(binaries / "containerd"), "--config", str(root / "containerd.toml")]
    # Docker 29.7.2's JSON tag is singular but its accepted option is plural.
    # Use the directly bound CLI flag so the intended value is actually set.
    daemon_command = [str(binaries / "dockerd"), "--config-file", str(config_path),
                      "--containerd-plugins-namespace", "owned-engine-import-plugins"]
    endpoint = root / "containerd.sock"
    daemon_log = root / "daemon.log"
    try:
        before = resource_snapshot(os.getpid(), [os.getpid()])
        result["before"] = before
        result["stage"] = "configuration_validation"
        validation = {"status": "failed", "exit_code": None,
                      "configuration_sha256": digest(config_path),
                      "command": daemon_command + ["--validate"]}
        result["docker_configuration_validation"] = validation
        response = run(validation["command"], timeout=15, check=False, env=env)
        (root / "configuration-validation.log").write_text(response.stdout)
        validation["exit_code"] = response.returncode
        require(response.returncode == 0, "private Docker configuration validation failed")
        require(digest(config_path) == validation["configuration_sha256"],
                "private Docker configuration changed during validation")
        validation["status"] = "passed"
        result["stage"] = "daemon_start"
        for name in ("containerd-data", "containerd-state", "containerd.sock", "containerd-ttrpc.sock"):
            candidate = root / name
            require(not candidate.exists() and not candidate.is_symlink(), "private runtime path already exists")
        (root / "containerd.toml").write_text(private_containerd_configuration(root))
        with (root / "containerd.log").open("w") as log:
            runtime = subprocess.Popen(runtime_command, stdout=log, stderr=subprocess.STDOUT, env=env)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            require(runtime.poll() is None, "private containerd exited before readiness")
            if endpoint.exists():
                try:
                    result["private_containerd"] = verify_containerd_ownership(runtime, runtime_command, endpoint)
                    break
                except (FileNotFoundError, ConnectionRefusedError, TimeoutError):
                    # bind() can create the pathname immediately before listen().
                    # Retry only incomplete readiness, never a wrong identity.
                    pass
            time.sleep(0.1)
        require("private_containerd" in result, "private containerd readiness deadline")
        require(digest(config_path) == validation["configuration_sha256"],
                "private Docker configuration changed before startup")
        with daemon_log.open("w") as log:
            daemon = subprocess.Popen(daemon_command, stdout=log, stderr=subprocess.STDOUT, env=env)
        deadline = time.monotonic() + 45
        info = None
        while time.monotonic() < deadline:
            require(daemon.poll() is None, "private Docker daemon exited before readiness")
            response = run(docker + ["info", "--format", "{{json .}}"], timeout=5, check=False, env=env)
            if response.returncode == 0:
                info = json.loads(response.stdout)
                break
            time.sleep(0.2)
        require(info is not None, "private Docker daemon readiness deadline")
        require(info["ServerVersion"] == DOCKER_VERSION and info["Driver"] == "overlayfs"
                and ["driver-type", "io.containerd.snapshotter.v1"] in info["DriverStatus"]
                and info["CgroupDriver"] == "systemd" and info["CgroupVersion"] == "2"
                and info["DockerRootDir"] == str(data_root)
                and info["Images"] == 0 and info["Containers"] == 0
                and info["ID"] != request["main_daemon_id"], "fresh daemon identity differs")
        verify_process_identity(daemon, daemon_command)
        result["private_containerd"] = verify_containerd_ownership(runtime, runtime_command, endpoint)
        result["private_containerd_ownership_verified"] = True
        pids = [os.getpid(), daemon.pid, runtime.pid]
        # Preserve the pre-daemon OOM baseline; startup failures cannot be
        # erased when checking that an intended refusal was uncontaminated.
        result["ready"] = resource_snapshot(os.getpid(), pids)
        result['stage'] = 'archive_load'
        run(docker + ["image", "load", "--input", str(archive)], timeout=120, env=env)
        require(digest(archive) == request["archive_sha256"], "archive changed during load")
        if request.get('fault') == 'cancel_after_load':
            # CI-only fault boundary: parent sends SIGTERM to this unit's actual
            # main process after the real daemon has loaded the complete image.
            result['stage'] = 'awaiting_external_cancellation'
            checkpoint = root / 'cancel-ready.pending.json'
            checkpoint.write_text(json.dumps({
                'source_sha': request['source_sha'], 'archive_sha256': request['archive_sha256']}))
            checkpoint.replace(root / 'cancel-ready.json')
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                time.sleep(0.1)
            raise RuntimeError('expected external worker cancellation did not arrive')
        tag = "club-arena-engine:" + request["source_sha"]
        result['stage'] = 'image_identity'
        image = json.loads(run(docker + ["image", "inspect", tag], env=env).stdout)
        require(len(image) == 1, "one imported image required")
        image = image[0]
        labels = image["Config"]["Labels"]
        require(image["Id"] == request["image_id"]
                and image["Architecture"] == "amd64" and image["Os"] == "linux"
                and labels["org.opencontainers.image.revision"] == request["source_sha"]
                and labels["com.smarterpoker.engine.source-tree"] == request["server_tree"]
                and labels["com.smarterpoker.engine.build-contract"] == "clean-server-archive-v1",
                "imported immutable image identity differs")
        result['stage'] = 'runtime_bytes'
        run(docker + ["create", "--name", "owned-output-reader", tag], env=env)
        output = root / "runtime"
        run(docker + ["cp", "owned-output-reader:/app/dist", str(output)], timeout=60, env=env)
        hashes = {}
        for file in output.rglob("*"):
            require(not file.is_symlink(), "unexpected runtime symlink")
            if file.is_file() and not file.name.endswith((".d.ts", ".d.ts.map", ".tsbuildinfo")):
                hashes[str(file.relative_to(output))] = digest(file)
        require(hashes and hashes == request["runtime_hashes"], "imported runtime bytes differ")
        result['stage'] = 'image_cleanup'
        run(docker + ["rm", "owned-output-reader"], env=env)
        run(docker + ["image", "rm", tag], env=env)
        empty = json.loads(run(docker + ["info", "--format", "{{json .}}"], env=env).stdout)
        require(empty["Images"] == 0 and empty["Containers"] == 0, "private image cleanup failed")
        after = resource_snapshot(os.getpid(), pids)
        require(after["memory_events"]["oom"] == before["memory_events"]["oom"]
                and after["memory_events"]["oom_kill"] == before["memory_events"]["oom_kill"],
                "native import experienced an OOM")
        result.update(status="passed", after=after, runtime_files_matched=len(hashes),
                      image_id=image["Id"], daemon_version=info["ServerVersion"],
                      driver=info["Driver"], daemon_id=info["ID"],
                      private_images_and_containers_absent=True,
                      docker_source_sha256=DOCKER_SHA256, archive_sha256=request["archive_sha256"])
    except BaseException as error:
        result['status'] = 'failed'
        result['failure_type'] = type(error).__name__
        known_refusals = {'imported immutable image identity differs',
                          'imported runtime bytes differ', 'native import proof interrupted'}
        result['failure_code'] = str(error) if str(error) in known_refusals else None
        raise
    finally:
        for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(sig, signal.SIG_IGN)
        result['daemon_alive_before_requested_stop'] = daemon is not None and daemon.poll() is None
        result['containerd_alive_before_requested_stop'] = runtime is not None and runtime.poll() is None
        if result['daemon_alive_before_requested_stop'] and result['containerd_alive_before_requested_stop']:
            try:
                verify_process_identity(daemon, daemon_command)
                verify_containerd_ownership(runtime, runtime_command, endpoint)
                result['resource_observation_before_stop'] = resource_snapshot(
                    os.getpid(), [os.getpid(), daemon.pid, runtime.pid])
            except Exception as error:
                result['resource_observation_failure'] = type(error).__name__
                result['status'] = 'failed'
        # Dockerd is a client of the runtime we own: stop the client first,
        # then explicitly stop and reap the runtime. Neither may be shared.
        stop_owned_process(daemon, result, "daemon")
        stop_owned_process(runtime, result, "containerd")
        result["managed_containerd_stopped_before_parent_cleanup"] = (
            result["containerd_stopped"] and not Path(f"/proc/{runtime.pid}").exists())
        if (not result["managed_containerd_stopped_before_parent_cleanup"]
                or not result['daemon_alive_before_requested_stop']
                or not result['containerd_alive_before_requested_stop']):
            result["status"] = "failed"
        try:
            # The worker still owns the unit here. A daemon dying from an OOM
            # during shutdown is not a clean stop, even when every PID is gone.
            result['resource_observation_after_stop'] = resource_snapshot(os.getpid(), [os.getpid()])
            for counter in ('oom', 'oom_kill'):
                require(result['resource_observation_after_stop']['memory_events'][counter]
                        == result['before']['memory_events'][counter],
                        'native import shutdown was contaminated by an OOM')
        except Exception as error:
            result['resource_observation_after_stop_failure'] = type(error).__name__
            result['status'] = 'failed'
        if result['status'] == 'passed':
            result['stage'] = 'complete'
        (root / "worker-receipt.json").write_text(json.dumps(result, indent=2) + "\n")
    require(result["status"] == "passed", "native import proof failed")


def cleanup_import(root, unit, output):
    """Collect every independent cleanup fact even when a cleanup command fails."""
    require(root.parent == Path('/tmp') and not root.is_symlink()
            and re.fullmatch(r'engine-native-import-[A-Za-z0-9_-]+', root.name),
            'unexpected cleanup root')
    require(re.fullmatch(r'ca-engine-import-[0-9a-f]{16}\.service', unit),
            'unexpected cleanup unit')
    facts = {key: False for key in ('unit_stop_completed', 'unit_inactive',
             'owned_cgroup_absent', 'owned_mounts_absent', 'owned_files_removed')}
    errors = []

    def attempt(stage, action):
        try:
            return action()
        except Exception as error:
            # Never discard the other cleanup checks or leak arbitrary subprocess text.
            errors.append({'stage': stage, 'error_type': type(error).__name__})
            return None

    stopped = attempt('stop_unit', lambda: run(
        ['sudo', '-n', 'systemctl', 'stop', unit], timeout=30, check=False))
    # A unit that failed before startup or was already collected may be absent.
    facts['unit_stop_completed'] = stopped is not None
    active = attempt('observe_unit', lambda: run(
        ['systemctl', 'is-active', unit], timeout=10, check=False))
    facts['unit_inactive'] = (active is not None and active.returncode != 0
                             and active.stdout.strip() in {'inactive', 'failed', 'unknown'})
    facts['owned_cgroup_absent'] = attempt('observe_cgroup', lambda:
        not (Path('/sys/fs/cgroup/system.slice') / unit).exists()) is True
    if (root / 'daemon.log').exists():
        attempt('retain_daemon_log', lambda: shutil.copyfile(
            root / 'daemon.log', output / 'native-import-daemon.log'))
    if (root / 'containerd.log').exists():
        attempt('retain_containerd_log', lambda: shutil.copyfile(
            root / 'containerd.log', output / 'native-import-containerd.log'))
    if (root / 'configuration-validation.log').exists():
        attempt('retain_configuration_validation_log', lambda: shutil.copyfile(
            root / 'configuration-validation.log', output / 'native-import-configuration-validation.log'))
    mountinfo = attempt('observe_mounts', lambda: Path('/proc/self/mountinfo').read_text())
    if mountinfo is not None:
        facts['owned_mounts_absent'] = not any(
            len(row.split()) > 4 and
            (row.split()[4] == str(root) or row.split()[4].startswith(str(root) + '/'))
            for row in mountinfo.splitlines())
    if all(facts[k] for k in ('unit_inactive', 'owned_cgroup_absent', 'owned_mounts_absent')):
        removed = attempt('remove_owned_files', lambda: run(
            ['sudo', '-n', 'rm', '-rf', '--', str(root)], timeout=30, check=False))
        facts['owned_files_removed'] = (removed is not None and removed.returncode == 0
                                        and not root.exists())
    return {**facts, 'cleanup_errors': errors}


def execute_unit(command, unit, root, output, request):
    """A real fault is signalled only after the worker's post-load checkpoint."""
    signalled = False
    with (output / 'native-import-unit.log').open('w') as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 275
            while process.poll() is None:
                require(time.monotonic() < deadline, 'native import unit whole deadline')
                ready = root / 'cancel-ready.json'
                if request.get('fault') == 'cancel_after_load' and not signalled and ready.exists():
                    checkpoint = json.loads(ready.read_text())
                    require(checkpoint == {key: request[key] for key in
                            ('source_sha', 'archive_sha256')}, 'native fault checkpoint differs')
                    run(['sudo', '-n', 'systemctl', 'kill', '--kill-whom=main',
                         '--signal=SIGTERM', unit], timeout=10)
                    signalled = True
                time.sleep(0.1)
            return process.returncode, signalled
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


def prove_import(archive, normalization, runtime_hashes, output, *, fault=None):
    with catch_termination():
        return _prove_import(archive, normalization, runtime_hashes, output, fault=fault)


def _prove_import(archive, normalization, runtime_hashes, output, *, fault=None):
    require(sys.platform == "linux" and os.environ.get("GITHUB_ACTIONS") == "true",
            "fresh import proof requires disposable Linux Actions")
    root = Path(tempfile.mkdtemp(prefix="engine-native-import-", dir="/tmp"))
    unit = "ca-engine-import-" + os.urandom(8).hex() + ".service"
    output = Path(output)
    receipt = {"status": "failed", "production_host_import_qualified": False,
               "producer_authenticated": False}
    try:
        fetch_binaries(root)
        request = {**normalization, "archive": str(Path(archive).resolve()),
                   "runtime_hashes": runtime_hashes,
                   'fault': fault,
                   "main_daemon_id": run(["docker", "info", "--format", "{{.ID}}"]).stdout.strip()}
        validate_request(request)
        (root / "request.json").write_text(json.dumps(request))
        command = ["sudo", "-n", "systemd-run", "--quiet", "--wait", "--pipe", "--collect",
                   "--unit", unit, "--setenv=GITHUB_ACTIONS=true",
                   "--property=MemoryMax=" + str(LIMIT), "--property=MemorySwapMax=0",
                   "--property=CPUQuota=100%", "--property=TasksMax=256",
                   "--property=RuntimeMaxSec=240", "--property=TimeoutStopSec=20",
                   "--property=KillMode=control-group", "--property=Restart=no",
                   "--property=Delegate=yes", sys.executable, str(Path(__file__).resolve()),
                   "--worker", str(root / "request.json")]
        code, signalled = execute_unit(command, unit, root, output, request)
        if (root / "worker-receipt.json").exists():
            receipt = json.loads((root / "worker-receipt.json").read_text())
        receipt['worker_external_cancellation_sent'] = signalled
        receipt['unit_exit_code'] = code
        require(code == 0 and receipt["status"] == "passed",
                "fresh bounded Docker import failed")
    except BaseException as error:
        receipt['status'] = 'failed'
        receipt['parent_failure_type'] = type(error).__name__
        raise
    finally:
        # A second catchable cancellation cannot interrupt the bounded cleanup.
        for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(sig, signal.SIG_IGN)
        receipt.update(cleanup_import(root, unit, output))
        if not all(receipt.get(k) is True for k in
                   ("unit_stop_completed", "unit_inactive", "owned_cgroup_absent",
                    "owned_mounts_absent", "owned_files_removed")) or receipt['cleanup_errors']:
            receipt["status"] = "failed"
        (output / "native-import-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    require(receipt["status"] == "passed", "fresh import or owned cleanup failed")
    return receipt


def prove_import_matrix(archive, normalization, runtime_hashes, output):
    """Reuse one engine archive; each case gets a fresh bounded daemon/store."""
    require(sys.platform == 'linux' and os.environ.get('GITHUB_ACTIONS') == 'true',
            'native import matrix requires disposable Linux Actions')
    output = Path(output)
    cases = {}
    normal_dir = output / 'native-import-success'
    normal_dir.mkdir()
    cases['success'] = prove_import(archive, normalization, runtime_hashes, normal_dir)
    for name in ('image_identity', 'runtime_bytes', 'external_cancellation'):
        target = output / ('native-import-' + name)
        target.mkdir()
        metadata = dict(normalization)
        expected = dict(runtime_hashes)
        fault = None
        if name == 'image_identity':
            metadata['image_id'] = 'sha256:' + '0'*64
            require(metadata['image_id'] != normalization['image_id'], 'fault image identity collided')
        elif name == 'runtime_bytes':
            first = sorted(expected)[0]
            expected[first] = ('0' if expected[first][0] != '0' else '1') + expected[first][1:]
        else:
            fault = 'cancel_after_load'
        refused = False
        try:
            prove_import(archive, metadata, expected, target, fault=fault)
        except RuntimeError:
            refused = True
        require(refused, 'deliberately invalid native import unexpectedly passed')
        observed = json.loads((target / 'native-import-receipt.json').read_text())
        stage = 'awaiting_external_cancellation' if fault else name
        require(observed['status'] == 'failed' and observed.get('stage') == stage,
                'native fault failed at a different or unobserved stage')
        require(observed.get('failure_type') == ('InterruptedError' if fault else 'RuntimeError'),
                'native fault did not observe its intended refusal')
        expected_reason = {'image_identity': 'imported immutable image identity differs',
                           'runtime_bytes': 'imported runtime bytes differ',
                           'external_cancellation': 'native import proof interrupted'}[name]
        require(observed.get('failure_code') == expected_reason,
                'native fault did not reach its exact refusal condition')
        validation = observed.get('docker_configuration_validation', {})
        require(validation.get('status') == 'passed' and type(validation.get('exit_code')) is int
                and validation['exit_code'] == 0, 'native fault configuration validation was not observed')
        snapshot = observed.get('resource_observation_before_stop')
        require(snapshot is not None and not observed.get('resource_observation_failure'),
                'native fault process containment was not observed')
        stopped_snapshot = observed.get('resource_observation_after_stop')
        require(stopped_snapshot is not None and not observed.get('resource_observation_after_stop_failure'),
                'native fault final resource state was not observed')
        assert_limits(stopped_snapshot)
        require(type(stopped_snapshot.get('memory_peak')) is int
                and 0 < stopped_snapshot['memory_peak'] <= LIMIT,
                'native fault final memory peak differs')
        for counter in ('oom', 'oom_kill'):
            require(snapshot['memory_events'][counter] == observed['before']['memory_events'][counter]
                    == stopped_snapshot['memory_events'][counter],
                    'native fault was contaminated by an OOM')
        require(observed.get('worker_external_cancellation_sent') is bool(fault),
                'native cancellation delivery differs')
        require(type(observed.get('unit_exit_code')) is int
                and observed['unit_exit_code'] != 0, 'native refusal exit was not observed')
        assert_limits(snapshot)
        require(type(snapshot.get('memory_peak')) is int
                and 0 < snapshot['memory_peak'] <= LIMIT, 'native fault memory peak differs')
        for key in ('private_containerd_ownership_verified', 'containerd_alive_before_requested_stop',
                    'containerd_stopped', 'daemon_alive_before_requested_stop', 'daemon_stopped',
                    'managed_containerd_stopped_before_parent_cleanup', 'unit_stop_completed',
                    'unit_inactive', 'owned_cgroup_absent', 'owned_mounts_absent', 'owned_files_removed'):
            require(observed.get(key) is True, 'native fault cleanup incomplete: ' + key)
        # Intended refusals already have status=failed. Worker shutdown errors
        # must therefore be rejected independently before earning fault credit.
        for key in ('daemon_required_kill', 'containerd_required_kill',
                    'daemon_stop_failure', 'containerd_stop_failure'):
            require(key not in observed, 'native fault shutdown contaminated: ' + key)
        require(observed.get('cleanup_errors') == [], 'native fault cleanup reported errors')
        cases[name] = {'expected_refusal_observed': True, 'operation_receipt': observed}
    return {'scope': 'isolated-native-import-and-refusal-tests', 'status': 'passed',
            'cases': cases, 'production_host_import_qualified': False,
            'producer_authenticated': False, 'cold_cache_or_total_host_budget_proved': False}


if __name__ == "__main__":
    require(len(sys.argv) == 3 and sys.argv[1] == "--worker", "owned worker invocation required")
    with catch_termination():
        worker(sys.argv[2])

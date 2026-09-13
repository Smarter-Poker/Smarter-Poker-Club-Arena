#!/usr/bin/env python3
"""Real Linux build and cgroup OOM proof; runs only in disposable CI."""
import json
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
BUILDER = "club-arena-engine-bounded-v1"
CONTAINER = f"buildx_buildkit_{BUILDER}0"
NODE = "node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5"
LIMIT = 1073741824


def run(args, *, timeout=60, check=True, env=None):
    result = subprocess.run(args, cwd=ROOT, env=env, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f"command failed ({result.returncode}): {args}\n{result.stdout[-24000:]}")
    return result


def inspect(name):
    return json.loads(run(["docker", "inspect", name]).stdout)[0]


def counter(name):
    text = run(["docker", "exec", CONTAINER, "cat", f"/sys/fs/cgroup/{name}"]).stdout
    if name == "memory.events":
        return {k: int(v) for k, v in (line.split() for line in text.splitlines())}
    return text.strip()


def runtime_hashes(directory):
    return {str(p.relative_to(directory)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in directory.rglob("*") if p.is_file()
            and not p.name.endswith((".d.ts", ".d.ts.map", ".tsbuildinfo"))}


def wrapper_fault(temp, out, mode, sentinel, before, owned_tags):
    """Exercise production wrapper cleanup before the harness removes anything."""
    repo = Path(temp, f"wrapper-{mode}")
    server = repo / "server"
    (server / "src").mkdir(parents=True)
    (server / "package.json").write_text('{}\n')
    (server / "tsconfig.json").write_text('{}\n')
    (server / "src" / "fixture.txt").write_text('wrapper cleanup fault only\n')
    marker = "ENGINE_WRAPPER_CANCEL_READY"
    command = ("process.exit(23)" if mode == "failure" else
               f"console.log('{marker}');setInterval(()=>{{}},1000)")
    (server / "Dockerfile").write_text(f'FROM {NODE}\nRUN node -e "{command}"\n')
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
                "ENGINE_BUILD_CONTEXT_ROOT": str(repo / "contexts"),
                "ENGINE_BUILD_LOCK_FILE": str(repo / "build.lock")})
    run(["git", "-C", str(repo), "init", "--quiet"], env=env)
    run(["git", "-C", str(repo), "add", "server"], env=env)
    run(["git", "-C", str(repo), "-c", "user.name=Resource Proof",
         "-c", "user.email=resource-proof@example.invalid", "commit", "--quiet",
         "-m", f"Isolated wrapper {mode} fixture"], env=env)
    sha = run(["git", "-C", str(repo), "rev-parse", "HEAD"], env=env).stdout.strip()
    tag = f"engine-build-wrapper-{mode}-{os.getpid()}:proof"
    owned_tags.append(tag)
    args = ["bash", str(ROOT / "server/scripts/build-engine-image.sh"), str(repo), sha, tag]
    log = out / f"wrapper-{mode}.log"
    started = time.monotonic()
    with log.open("w") as stream:
        process = subprocess.Popen(args, cwd=ROOT, env=env, stdout=stream,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        try:
            if mode.endswith("cancellation"):
                deadline = time.monotonic() + 120
                while not re.search(rf"^#\d+\s+\d+(?:\.\d+)? {marker}$",
                                    log.read_text(), re.MULTILINE):
                    if process.poll() is not None or time.monotonic() >= deadline:
                        raise RuntimeError("wrapper cancellation never reached its real build step")
                    time.sleep(0.2)
                if mode == "parent-cancellation":
                    process.send_signal(signal.SIGTERM)
                else:
                    os.killpg(process.pid, signal.SIGTERM)
            code = process.wait(timeout=120)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=10)
    after = inspect(sentinel)
    remaining = run(["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}",
                     "--filter", f"reference={tag}*"]).stdout.strip()
    facts = {
        "fixture_sha": sha, "exit_code": code,
        "duration_seconds": round(time.monotonic() - started, 3),
        "builder_stopped_before_harness_cleanup": not inspect(CONTAINER)["State"]["Running"],
        "source_staging_removed_before_harness_cleanup": not list((repo / "contexts").iterdir()),
        "final_and_candidate_tags_absent_before_harness_cleanup": not remaining,
        "neighbor_unchanged_before_harness_cleanup": (
            after["State"]["Running"]
            and after["State"]["StartedAt"] == before["State"]["StartedAt"]
            and after["RestartCount"] == before["RestartCount"]),
    }
    if mode == "failure":
        facts["real_build_step_exit_23_observed"] = "exit code: 23" in log.read_text()
        if not facts["real_build_step_exit_23_observed"]:
            raise RuntimeError("wrapper failure did not reach its intended real build failure")
    if mode.endswith("cancellation"):
        facts["signal_delivery"] = ("SIGTERM to the wrapper PID after real RUN output"
                                    if mode == "parent-cancellation" else
                                    "SIGTERM to the wrapper process group after real RUN output")
        if code != 143:
            raise RuntimeError(f"wrapper cancellation returned an unexpected status: {facts}")
    if code == 0 or not all(v for k, v in facts.items() if k.endswith("before_harness_cleanup")):
        raise RuntimeError(f"real wrapper {mode} cleanup failed: {facts}")
    return facts


def cleanup_resources(receipt, before, sentinel, image_reader, owned_tags):
    """Removal is proved by successful inventories, never a failed inspect."""
    cleanup = {}
    errors = []

    def attempt(stage, action):
        try:
            return action()
        except Exception as error:
            errors.append({"stage": stage, "error_type": type(error).__name__})
            return None

    def names(kind):
        field = ".Names" if kind == "container" else ".Name"
        args = ["docker", kind, "ls"]
        if kind == "container":
            args.append("--all")
        observed = run(args + ["--format", "{{json " + field + "}}"], timeout=15, check=False)
        if observed.returncode != 0:
            raise RuntimeError("resource cleanup inventory was unavailable")
        values = [json.loads(line) for line in observed.stdout.splitlines()]
        if any(not isinstance(value, str) or not value or
               not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", value) for value in values):
            raise RuntimeError("resource cleanup inventory was malformed")
        return set(values)

    def images():
        observed = run(["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}"],
                       timeout=15, check=False)
        if observed.returncode != 0:
            raise RuntimeError("image cleanup inventory was unavailable")
        values = observed.stdout.splitlines()
        if any(value != "<none>:<none>" and
               not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]*(?::<none>)?", value)
               for value in values):
            raise RuntimeError("image cleanup inventory was malformed")
        return set(values)

    def owns_image(name, image):
        return name == image or re.fullmatch(re.escape(image) + r"-candidate-[0-9]+", name)

    receipt["neighbor_alive_before_cleanup"] = False
    if before is not None:
        current = attempt("observe_neighbor", lambda: inspect(sentinel))
        if current is not None:
            try:
                receipt["neighbor_alive_before_cleanup"] = (
                    current["State"]["Running"] is True
                    and current["State"]["StartedAt"] == before["State"]["StartedAt"]
                    and current["RestartCount"] == before["RestartCount"])
            except (KeyError, TypeError):
                errors.append({"stage": "observe_neighbor", "error_type": "MalformedObservation"})
    containers = (sentinel, image_reader, CONTAINER)
    for name in containers:
        attempt("remove_container:" + name,
                lambda name=name: run(["docker", "rm", "--force", name], timeout=30, check=False))
    attempt("remove_builder", lambda: run(
        ["docker", "buildx", "rm", "--force", BUILDER], timeout=30, check=False))
    volume = f"{CONTAINER}_state"
    attempt("remove_volume", lambda: run(
        ["docker", "volume", "rm", volume], timeout=30, check=False))
    # A failed wrapper can leave only its exact generated candidate name. Preserve
    # unrelated names even when they happen to share an owned tag's prefix.
    initial_images = attempt("inventory_images_before_removal", images)
    to_remove = set(owned_tags)
    if initial_images is not None:
        to_remove.update(name for name in initial_images
                         if any(owns_image(name, image) for image in owned_tags))
    for image in sorted(to_remove):
        attempt("remove_image:" + image,
                lambda image=image: run(["docker", "image", "rm", "--force", image],
                                       timeout=30, check=False))
    remaining_containers = attempt("inventory_containers", lambda: names("container"))
    remaining_volumes = attempt("inventory_volumes", lambda: names("volume"))
    remaining_images = attempt("inventory_images_after_removal", images)
    for name in containers:
        cleanup[name] = remaining_containers is not None and name not in remaining_containers
    cleanup[volume] = remaining_volumes is not None and volume not in remaining_volumes
    for image in owned_tags:
        cleanup[image] = remaining_images is not None and not any(
            owns_image(name, image) for name in remaining_images)
    receipt["cleanup"] = cleanup
    receipt["cleanup_errors"] = errors
    verified = (receipt["neighbor_alive_before_cleanup"] is True
                and all(cleanup.values()) and not errors)
    if not verified:
        receipt["status"] = "failed"
    return verified


def main(*, target_sha=None, reference_directory=None, evidence_directory=None, temporary_root=None, image_ready=None):
    if sys.platform != "linux" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("resource proof requires a disposable Linux Actions runner")
    sha = target_sha if target_sha is not None else run(["git", "rev-parse", "HEAD"]).stdout.strip()
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RuntimeError("resource proof requires one exact target commit")
    reference_directory = Path(reference_directory) if reference_directory is not None else ROOT / "server/dist"
    if not reference_directory.is_absolute() or not reference_directory.is_dir():
        raise RuntimeError("resource proof reference directory must exist and be absolute")
    tag = f"club-arena-engine:{sha}"
    sentinel = f"engine-build-sentinel-{os.getpid()}"
    failed_tag = f"engine-build-oom-{os.getpid()}"
    image_reader = f"engine-build-output-{os.getpid()}"
    out = Path(evidence_directory) if evidence_directory is not None else ROOT / "work" / "engine-build-resource-proof"
    if not out.is_absolute():
        raise RuntimeError("resource proof evidence directory must be absolute")
    out.mkdir(parents=True, exist_ok=True)
    receipt = {"source_sha": sha, "scope": "isolated-build-resource-containment",
               "production_certificate": False, "status": "failed"}
    before = None
    owned_tags = [tag, failed_tag]
    try:
        run(["docker", "run", "--detach", "--name", sentinel, "--memory", "256m",
             "--memory-swap", "256m", NODE, "node", "-e", "setInterval(()=>{},1000)"], timeout=120)
        before = inspect(sentinel)
        with tempfile.TemporaryDirectory(prefix="engine-build-budget-", dir=temporary_root) as temp:
            env = {**os.environ, "ENGINE_BUILD_CONTEXT_ROOT": f"{temp}/contexts",
                   "ENGINE_BUILD_LOCK_FILE": f"{temp}/build.lock"}
            built = run(["bash", str(ROOT / "server/scripts/build-engine-image.sh"),
                         str(ROOT), sha, tag], timeout=1740, env=env, check=False)
            (out / "engine-build.log").write_text(built.stdout)
            if built.returncode:
                raise RuntimeError(f"bounded engine build failed: {built.stdout[-20000:]}")
            peaks = [line.split("=", 1)[1] for line in built.stdout.splitlines()
                     if line.startswith("ENGINE_BUILD_MEMORY_PEAK_BYTES=")]
            if len(peaks) != 1:
                raise RuntimeError("bounded engine build did not report its memory peak")
            receipt["engine_build_memory_peak"] = int(peaks[0])
            if inspect(CONTAINER)["State"]["Running"]:
                raise RuntimeError("successful build left its builder running")
            if list(Path(temp, "contexts").iterdir()):
                raise RuntimeError("successful build left source staging behind")
            receipt["image_id"] = inspect(tag)["Id"]
            run(["docker", "create", "--name", image_reader, tag])
            image_output = Path(temp, "image-dist")
            run(["docker", "cp", f"{image_reader}:/app/dist", str(image_output)])
            expected = runtime_hashes(reference_directory)
            actual = runtime_hashes(image_output)
            if not expected or expected != actual:
                delta = {"missing": sorted(expected.keys() - actual.keys()),
                         "extra": sorted(actual.keys() - expected.keys()),
                         "changed": sorted(k for k in expected.keys() & actual.keys()
                                           if expected[k] != actual[k])}
                (out / "runtime-output-difference.json").write_text(json.dumps(delta, indent=2))
                raise RuntimeError("runtime emission differs from the full typechecked CI build")
            receipt["typechecked_runtime_files_matched"] = len(expected)
            receipt["runtime_file_hashes"] = actual
            if any(name.endswith((".test.js", ".spec.js")) or "/__tests__/" in name
                   for name in actual):
                raise RuntimeError("unit-test entrypoints were included in the runtime image")
            # Reuse this exact successful build; do not compile a second image.
            # The archives are temporary, never uploaded or loaded on production.
            raw_archive = Path(temp, "engine-image-save.tar")
            normalized_archive = Path(temp, "engine-image-canonical.tar")
            run(["docker", "image", "save", "--output", str(raw_archive), tag], timeout=120)
            module_spec = importlib.util.spec_from_file_location(
                "engine_archive", ROOT / "server/scripts/engine-image-archive.py")
            archive_module = importlib.util.module_from_spec(module_spec)
            module_spec.loader.exec_module(archive_module)
            server_tree = run(["git", "rev-parse", f"{sha}:server"]).stdout.strip()
            receipt["archive_normalization"] = archive_module.normalize_engine_archive(
                raw_archive, normalized_archive, source_sha=sha,
                server_tree=server_tree, image_id=receipt["image_id"])
            # Load this same normalized archive with a separately owned daemon
            # and containerd in one bounded systemd cgroup. No second compile.
            import_spec = importlib.util.spec_from_file_location(
                "engine_native_import", ROOT / "tests/operations/engine-native-import-proof.py")
            import_module = importlib.util.module_from_spec(import_spec)
            import_spec.loader.exec_module(import_module)
            receipt["isolated_native_import"] = import_module.prove_import_matrix(
                normalized_archive, receipt["archive_normalization"], actual, out)
            if image_ready is not None:
                # This is provisional. The caller must not publish artifacts or
                # upload outputs until this function returns after final cleanup.
                image_ready(normalized_archive, receipt["archive_normalization"],
                            reference_directory, image_output)
            run(["docker", "buildx", "inspect", BUILDER, "--bootstrap"], timeout=120)
            receipt["memory_max"] = counter("memory.max")
            receipt["swap_max"] = counter("memory.swap.max")
            receipt["cpu_max"] = counter("cpu.max")
            assert receipt["memory_max"] == str(LIMIT)
            assert receipt["swap_max"] == "0"
            assert receipt["cpu_max"] == "100000 100000"
            events_before = counter("memory.events")
            fault = Path(temp, "oom")
            fault.mkdir()
            (fault / "Dockerfile").write_text(
                f"FROM {NODE}\n"
                "RUN node --max-old-space-size=4096 -e \"const held=[];"
                "for(;;)held.push(Buffer.alloc(16*1024*1024,1))\"\n")
            result = run(["docker", "buildx", "build", "--builder", BUILDER,
                          "--load", "--progress", "plain", "-t", failed_tag, str(fault)],
                         timeout=240, check=False)
            (out / "contained-oom.log").write_text(result.stdout)
            events_after = counter("memory.events")
            receipt["fault_exit_code"] = result.returncode
            receipt["events_before"] = events_before
            receipt["events_after"] = events_after
            receipt["memory_peak"] = int(counter("memory.peak"))
            if result.returncode == 0 or events_after["oom_kill"] <= events_before["oom_kill"]:
                raise RuntimeError("fault did not demonstrate a contained cgroup OOM kill")
            if run(["docker", "image", "inspect", failed_tag], check=False).returncode == 0:
                raise RuntimeError("failed build published an image")
            receipt["wrapper_failure"] = wrapper_fault(
                temp, out, "failure", sentinel, before, owned_tags)
            receipt["wrapper_cancellation"] = wrapper_fault(
                temp, out, "cancellation", sentinel, before, owned_tags)
            receipt["wrapper_parent_cancellation"] = wrapper_fault(
                temp, out, "parent-cancellation", sentinel, before, owned_tags)
            after = inspect(sentinel)
            assert after["State"]["Running"]
            assert after["State"]["StartedAt"] == before["State"]["StartedAt"]
            assert after["RestartCount"] == before["RestartCount"]
            receipt["sentinel_unchanged"] = True
            receipt["status"] = "passed"
    finally:
        cleanup_verified = cleanup_resources(receipt, before, sentinel, image_reader, owned_tags)
        (out / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        if not cleanup_verified:
            raise RuntimeError("isolated resource proof cleanup or neighbor survival failed")
    print(json.dumps(receipt, indent=2))
    return receipt


if __name__ == "__main__":
    main()

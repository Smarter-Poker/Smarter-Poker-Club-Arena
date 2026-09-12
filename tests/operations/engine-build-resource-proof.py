#!/usr/bin/env python3
"""Real Linux build and cgroup OOM proof; runs only in disposable CI."""
import json
import hashlib
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


def main():
    if sys.platform != "linux" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("resource proof requires a disposable Linux Actions runner")
    sha = run(["git", "rev-parse", "HEAD"]).stdout.strip()
    tag = f"club-arena-engine:{sha}"
    sentinel = f"engine-build-sentinel-{os.getpid()}"
    failed_tag = f"engine-build-oom-{os.getpid()}"
    image_reader = f"engine-build-output-{os.getpid()}"
    out = ROOT / "work" / "engine-build-resource-proof"
    out.mkdir(parents=True, exist_ok=True)
    receipt = {"source_sha": sha, "scope": "isolated-build-resource-containment",
               "production_certificate": False, "status": "failed"}
    before = None
    owned_tags = [tag, failed_tag]
    try:
        run(["docker", "run", "--detach", "--name", sentinel, "--memory", "256m",
             "--memory-swap", "256m", NODE, "node", "-e", "setInterval(()=>{},1000)"], timeout=120)
        before = inspect(sentinel)
        with tempfile.TemporaryDirectory(prefix="engine-build-budget-") as temp:
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
            expected = runtime_hashes(ROOT / "server/dist")
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
        cleanup = {}
        if before is not None:
            try:
                current = inspect(sentinel)
                receipt["neighbor_alive_before_cleanup"] = (
                    current["State"]["Running"]
                    and current["State"]["StartedAt"] == before["State"]["StartedAt"]
                    and current["RestartCount"] == before["RestartCount"])
            except RuntimeError:
                receipt["neighbor_alive_before_cleanup"] = False
        for name in [sentinel, image_reader, CONTAINER]:
            run(["docker", "rm", "--force", name], check=False)
            cleanup[name] = run(["docker", "inspect", name], check=False).returncode != 0
        run(["docker", "buildx", "rm", "--force", BUILDER], check=False)
        volume = f"{CONTAINER}_state"
        run(["docker", "volume", "rm", volume], check=False)
        cleanup[volume] = run(["docker", "volume", "inspect", volume], check=False).returncode != 0
        for image in owned_tags:
            # Also remove a candidate if a defective wrapper leaked one; the
            # pre-cleanup assertions above must still fail in that case.
            named = run(["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}",
                         "--filter", f"reference={image}*"], check=False)
            for candidate in named.stdout.splitlines():
                run(["docker", "image", "rm", "--force", candidate], check=False)
            run(["docker", "image", "rm", "--force", image], check=False)
            remaining = run(["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}",
                             "--filter", f"reference={image}*"], check=False)
            cleanup[image] = remaining.returncode == 0 and not remaining.stdout.strip()
        receipt["cleanup"] = cleanup
        if not all(cleanup.values()):
            receipt["status"] = "failed"
        (out / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        if not all(cleanup.values()):
            raise RuntimeError("isolated resource proof cleanup failed")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()

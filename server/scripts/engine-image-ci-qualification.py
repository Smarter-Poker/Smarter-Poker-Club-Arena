#!/usr/bin/env python3
"""PR-only image custody qualification. These artifacts never authorize release."""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile

spec = importlib.util.spec_from_file_location("production_engine_bundle", Path(__file__).with_name("engine-image-ci-bundle.py"))
production = importlib.util.module_from_spec(spec)
spec.loader.exec_module(production)
REPOSITORY = production.REPOSITORY
WORKFLOW = ".github/workflows/engine-build-resource-proof.yml"
PRODUCER_JOB = "Compile the engine and contain a real build OOM"
CONTRACT = production.CONTRACT
ARCHIVE_LIMIT = production.ARCHIVE_LIMIT
DESCRIPTOR_LIMIT = production.DESCRIPTOR_LIMIT
require = production.require
exact_keys = production.exact_keys
hex_value = production.hex_value
positive = production.positive
encode = production.encode
decode = production.decode
file_identity = production.file_identity
read_regular = production.read_regular
check_runtime = production.check_runtime
runtime_directory_hashes = production.runtime_directory_hashes
github_api = production.github_api


def event_context(environment):
    path = Path(environment.get("GITHUB_EVENT_PATH", ""))
    require(path.is_absolute(), "QUALIFICATION_EVENT_PATH")
    _, raw = read_regular(path, 4 * 1024 * 1024, retain=True)
    event = decode(raw)
    require(isinstance(event, dict), "QUALIFICATION_EVENT_OBJECT")
    return event


def context(target, environment, platform):
    require(platform == "linux" and environment.get("GITHUB_ACTIONS") == "true",
            "QUALIFICATION_DISPOSABLE_CI_REQUIRED")
    require(environment.get("GITHUB_EVENT_NAME") == "pull_request" and
            environment.get("GITHUB_REPOSITORY") == REPOSITORY, "QUALIFICATION_PR_REQUIRED")
    event = event_context(environment)
    pr = event.get("pull_request", {})
    number = str(pr.get("number", ""))
    require(positive(number) and type(pr.get("number")) is int and
            event.get("number") == pr["number"] and pr.get("state") == "open" and
            event.get("action") in {"opened", "reopened", "synchronize"}, "QUALIFICATION_PR_EVENT")
    require(all((pr.get(side, {}).get("repo") or {}).get("full_name") == REPOSITORY
                for side in ("head", "base")) and pr.get("base", {}).get("ref") == "main",
            "QUALIFICATION_SAME_REPOSITORY_MAIN_BASE")
    control = environment.get("GITHUB_SHA", "")
    head, base = pr.get("head", {}).get("sha"), pr.get("base", {}).get("sha")
    run_id, attempt = environment.get("GITHUB_RUN_ID", ""), environment.get("GITHUB_RUN_ATTEMPT", "")
    require(all(hex_value(value, 40) for value in (control, target, head, base)) and target == head,
            "QUALIFICATION_SOURCE_IDENTITY")
    require(positive(run_id) and positive(attempt), "QUALIFICATION_RUN_IDENTITY")
    merge_ref = "refs/pull/" + number + "/merge"
    require(environment.get("GITHUB_REF") == merge_ref and
            environment.get("GITHUB_WORKFLOW_REF") == REPOSITORY + "/" + WORKFLOW + "@" + merge_ref,
            "QUALIFICATION_WORKFLOW_REF")
    return {"purpose": "qualification-only", "repository": REPOSITORY, "workflow": WORKFLOW,
            "workflow_control_sha": control, "source_sha": head, "pr_head_sha": head,
            "pr_base_sha": base, "pr_number": number, "merge_ref": merge_ref,
            "run_id": run_id, "run_attempt": attempt}


def verify_git_source(identity, run):
    require(run(["git", "rev-parse", "HEAD"]) == identity["workflow_control_sha"],
            "QUALIFICATION_CONTROL_CHECKOUT")
    parents = run(["git", "rev-list", "--parents", "-n", "1", identity["workflow_control_sha"]]).split()
    require(len(parents) == 3 and parents[0] == identity["workflow_control_sha"] and
            parents[2] == identity["pr_head_sha"] and hex_value(parents[1], 40),
            "QUALIFICATION_MERGE_PARENTS")
    # The event/API PR base can precede the actual synthetic merge's main parent.
    # Bind both identities and require forward ancestry inside fetched main.
    main = run(["git", "rev-parse", "--verify", "refs/remotes/origin/main^{commit}"])
    require(hex_value(main, 40), "QUALIFICATION_MAIN_IDENTITY")
    run(["git", "merge-base", "--is-ancestor", identity["pr_base_sha"], parents[1]])
    run(["git", "merge-base", "--is-ancestor", parents[1], main])
    identity["merge_base_sha"] = parents[1]
    require(run(["git", "rev-parse", "--verify", identity["source_sha"] + "^{commit}"]) ==
            identity["source_sha"], "QUALIFICATION_EXACT_SOURCE")
    tree = run(["git", "rev-parse", identity["source_sha"] + ":server"])
    require(hex_value(tree, 40), "QUALIFICATION_SERVER_TREE")
    return tree


def check_identity(identity):
    exact_keys(identity, ("purpose", "repository", "workflow", "workflow_control_sha", "source_sha",
                          "pr_head_sha", "pr_base_sha", "merge_base_sha", "pr_number", "merge_ref", "server_tree",
                          "run_id", "run_attempt", "image_id"), "QUALIFICATION_IDENTITY_SHAPE")
    require(identity["purpose"] == "qualification-only" and identity["repository"] == REPOSITORY and
            identity["workflow"] == WORKFLOW, "QUALIFICATION_PROFILE")
    require(all(hex_value(identity[key], 40) for key in
                ("workflow_control_sha", "source_sha", "pr_head_sha", "pr_base_sha", "merge_base_sha", "server_tree")) and
            identity["source_sha"] == identity["pr_head_sha"], "QUALIFICATION_SOURCE_IDENTITY")
    require(all(positive(identity[key]) for key in ("run_id", "run_attempt", "pr_number")) and
            identity["merge_ref"] == "refs/pull/" + identity["pr_number"] + "/merge", "QUALIFICATION_RUN_IDENTITY")
    require(isinstance(identity["image_id"], str) and
            re.fullmatch(r"sha256:[0-9a-f]{64}", identity["image_id"]) is not None, "IMAGE_IDENTITY")


def descriptor(identity, normalization, runtime_hashes, reference_hashes):
    """Create only after the caller's actual image/reference comparison passed.

    normalize_engine_archive supplies normalization. This function validates
    its exact contract but does not manufacture a build or native proof.
    """
    check_identity(identity)
    check_runtime(runtime_hashes)
    check_runtime(reference_hashes)
    require(runtime_hashes == reference_hashes, "REFERENCE_RUNTIME_MISMATCH")
    exact_keys(normalization, ("version", "scope", "image_id", "source_sha", "server_tree",
                              "build_contract", "input_sha256", "archive_sha256", "archive_bytes",
                              "layers", "platform", "producer_authenticated", "host_import_qualified"),
               "NORMALIZATION_SHAPE")
    require(type(normalization["version"]) is int and normalization["version"] == 1 and
            normalization["scope"] == "engine-image-archive-normalization", "NORMALIZATION_VERSION")
    require(all(normalization[key] == identity[key] for key in
                ("image_id", "source_sha", "server_tree")), "NORMALIZATION_IDENTITY")
    require(normalization["build_contract"] == CONTRACT and normalization["platform"] == "linux/amd64" and
            normalization["producer_authenticated"] is False and
            normalization["host_import_qualified"] is False, "NORMALIZATION_CONTRACT")
    require(hex_value(normalization["archive_sha256"], 64) and
            hex_value(normalization["input_sha256"], 64) and
            type(normalization["archive_bytes"]) is int and
            1024 <= normalization["archive_bytes"] <= ARCHIVE_LIMIT and
            type(normalization["layers"]) is int and 1 <= normalization["layers"] <= 64,
            "ARCHIVE_IDENTITY")
    return {"schema": "engine-ci-qualification-image-v1", "identity": identity,
            "build_contract": CONTRACT, "platform": "linux/amd64",
            "archive": {"file": "engine-image.tar", "sha256": normalization["archive_sha256"],
                        "bytes": normalization["archive_bytes"]},
            "runtime_hashes": runtime_hashes,
            "host_import_qualified": False, "deployment_authorized": False}



def write_bundle(destination, archive, identity, normalization, reference_directory, image_directory):
    """Package an already built/normalized image in the existing CI job.

    The caller supplies the image's actual copied runtime directory and the
    independently typechecked reference. No extra compiler or daemon is started.
    The canonical tar is hardlinked on the same filesystem, avoiding another
    full image copy; the later consumer must still rehash its received bytes.
    A failure never returns upload outputs and never deletes an existing bundle.
    """
    reference = runtime_directory_hashes(reference_directory)
    image = runtime_directory_hashes(image_directory)
    value = descriptor(identity, normalization, image, reference)
    archive = Path(archive)
    expected_archive = {"sha256": value["archive"]["sha256"], "bytes": value["archive"]["bytes"]}
    require(file_identity(archive, ARCHIVE_LIMIT) == expected_archive, "PRODUCER_ARCHIVE_BYTES")
    destination = Path(destination)
    require(destination.is_absolute(), "BUNDLE_DESTINATION")
    # The parent directory belongs to the workflow's private temporary area.
    # mkdir refuses an existing directory, file or symlink without replacing it.
    destination.mkdir(mode=0o700, parents=False, exist_ok=False)
    os.link(archive, destination / "engine-image.tar", follow_symlinks=False)
    require(file_identity(destination / "engine-image.tar", ARCHIVE_LIMIT) == expected_archive,
            "PRODUCER_ARCHIVE_CHANGED")
    raw = encode(value)
    require(len(raw) <= DESCRIPTOR_LIMIT, "PRODUCER_DESCRIPTOR_SIZE")
    with (destination / "engine-image.json").open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    directory_fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    return {"identity": identity, "archive_sha256": expected_archive["sha256"],
            "archive_bytes": expected_archive["bytes"],
            "descriptor_sha256": hashlib.sha256(raw).hexdigest(),
            "typechecked_runtime_files_matched": len(image),
            "host_import_qualified": False, "deployment_authorized": False}



def validate_descriptor(value, expected):
    check_identity(expected["identity"])
    exact_keys(expected, ("identity", "archive_sha256", "archive_bytes", "descriptor_sha256",
                          "artifact_id", "artifact_digest"), "EXPECTED_SHAPE")
    require(positive(expected["artifact_id"]) and hex_value(expected["artifact_digest"], 64) and
            hex_value(expected["descriptor_sha256"], 64) and hex_value(expected["archive_sha256"], 64) and
            type(expected["archive_bytes"]) is int and 1024 <= expected["archive_bytes"] <= ARCHIVE_LIMIT,
            "EXPECTED_OUTPUTS")
    exact_keys(value, ("schema", "identity", "build_contract", "platform", "archive", "runtime_hashes",
                       "host_import_qualified", "deployment_authorized"), "DESCRIPTOR_SHAPE")
    require(value["schema"] == "engine-ci-qualification-image-v1" and value["identity"] == expected["identity"],
            "DESCRIPTOR_IDENTITY")
    require(value["build_contract"] == CONTRACT and value["platform"] == "linux/amd64" and
            value["host_import_qualified"] is False and value["deployment_authorized"] is False,
            "DESCRIPTOR_CONTRACT")
    check_runtime(value["runtime_hashes"])
    require(value["archive"] == {"file": "engine-image.tar", "sha256": expected["archive_sha256"],
                                  "bytes": expected["archive_bytes"]}, "DESCRIPTOR_ARCHIVE")



def validate_files(directory, expected):
    directory = Path(directory)
    require(directory.is_absolute() and directory.is_dir() and not directory.is_symlink(), "OWNED_DIRECTORY")
    require({p.name for p in directory.iterdir()} == {"engine-image.tar", "engine-image.json"}, "BUNDLE_MEMBERS")
    descriptor_path = directory / "engine-image.json"
    first, raw = read_regular(descriptor_path, DESCRIPTOR_LIMIT, retain=True)
    require(first["sha256"] == expected["descriptor_sha256"], "DESCRIPTOR_DIGEST")
    value = decode(raw)
    validate_descriptor(value, expected)
    require(file_identity(directory / "engine-image.tar", ARCHIVE_LIMIT) ==
            {"sha256": expected["archive_sha256"], "bytes": expected["archive_bytes"]}, "ARCHIVE_DIGEST")
    return value



def assert_current_identity(expected, environment):
    identity = expected["identity"]
    check_identity(identity)
    current = context(identity["source_sha"], environment, sys.platform)
    require(all(identity[key] == value for key, value in current.items()), "QUALIFICATION_CURRENT_CONTEXT")


def validate_github_metadata(repository, run, artifact, jobs, expected, environment):
    identity = expected["identity"]
    assert_current_identity(expected, environment)
    require(repository.get("full_name") == REPOSITORY and type(repository.get("id")) is int and
            repository["id"] > 0, "GITHUB_REPOSITORY")
    repo_id = repository["id"]
    require(type(run.get("id")) is int and str(run["id"]) == identity["run_id"] and
            type(run.get("run_attempt")) is int and str(run["run_attempt"]) == identity["run_attempt"] and
            run.get("event") == "pull_request" and run.get("path") == WORKFLOW and
            run.get("head_sha") == identity["pr_head_sha"] and
            (run.get("repository") or {}).get("id") == repo_id and
            (run.get("head_repository") or {}).get("id") == repo_id and
            (run.get("status"), run.get("conclusion")) in
            {("in_progress", None), ("completed", "success")}, "GITHUB_RUN")
    require(isinstance(run.get("pull_requests"), list) and len(run["pull_requests"]) == 1 and
            run["pull_requests"][0].get("number") == int(identity["pr_number"]) and
            run["pull_requests"][0].get("head", {}).get("sha") == identity["pr_head_sha"] and
            run["pull_requests"][0].get("base", {}).get("sha") == identity["pr_base_sha"],
            "QUALIFICATION_RUN_PR")
    require(type(artifact.get("id")) is int and str(artifact["id"]) == expected["artifact_id"] and
            artifact.get("name") == f"engine-image-qualification-{identity['run_id']}-{identity['run_attempt']}" and
            artifact.get("digest") == "sha256:" + expected["artifact_digest"] and artifact.get("expired") is False and
            (artifact.get("workflow_run") or {}).get("id") == run["id"] and
            (artifact.get("workflow_run") or {}).get("head_sha") == identity["pr_head_sha"] and
            (artifact.get("workflow_run") or {}).get("repository_id") == repo_id and
            (artifact.get("workflow_run") or {}).get("head_repository_id") == repo_id, "GITHUB_ARTIFACT")
    require(type(jobs.get("total_count")) is int and 0 < jobs["total_count"] <= 100 and
            isinstance(jobs.get("jobs"), list) and len(jobs["jobs"]) == jobs["total_count"], "GITHUB_JOB_PAGE")
    producers = [job for job in jobs["jobs"] if job.get("name") == PRODUCER_JOB]
    require(len(producers) == 1, "GITHUB_PRODUCER_UNIQUE")
    producer = producers[0]
    require(producer.get("run_id") == run["id"] and producer.get("head_sha") == identity["pr_head_sha"] and
            producer.get("status") == "completed" and producer.get("conclusion") == "success" and
            type(producer.get("id")) is int and producer["id"] > 0, "GITHUB_PRODUCER_SUCCESS")
    return producer["id"]



def validate_merge_metadata(identity, commit, comparison):
    require(isinstance(commit, dict) and commit.get("sha") == identity["workflow_control_sha"] and
            isinstance(commit.get("parents"), list) and
            [row.get("sha") for row in commit["parents"] if isinstance(row, dict)] ==
            [identity["merge_base_sha"], identity["pr_head_sha"]] and len(commit["parents"]) == 2,
            "QUALIFICATION_API_MERGE_PARENTS")
    same = identity["pr_base_sha"] == identity["merge_base_sha"]
    require(isinstance(comparison, dict) and
            (comparison.get("base_commit") or {}).get("sha") == identity["pr_base_sha"] and
            (comparison.get("merge_base_commit") or {}).get("sha") == identity["pr_base_sha"] and
            comparison.get("status") == ("identical" if same else "ahead") and
            type(comparison.get("ahead_by")) is int and
            (comparison["ahead_by"] == 0 if same else comparison["ahead_by"] > 0) and
            type(comparison.get("behind_by")) is int and comparison["behind_by"] == 0,
            "QUALIFICATION_API_BASE_ANCESTRY")


def admit(directory, expected, environment, api=github_api):
    assert_current_identity(expected, environment)
    validate_files(directory, expected)
    identity = expected["identity"]
    run_id, attempt, artifact_id = identity["run_id"], identity["run_attempt"], expected["artifact_id"]
    repository = api("repos/" + REPOSITORY)
    run = api(f"repos/{REPOSITORY}/actions/runs/{run_id}/attempts/{attempt}")
    artifact = api(f"repos/{REPOSITORY}/actions/artifacts/{artifact_id}")
    jobs = api(f"repos/{REPOSITORY}/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100")
    job_id = validate_github_metadata(repository, run, artifact, jobs, expected, environment)
    commit = api(f"repos/{REPOSITORY}/git/commits/{identity['workflow_control_sha']}")
    comparison = api(f"repos/{REPOSITORY}/compare/{identity['pr_base_sha']}...{identity['merge_base_sha']}?per_page=1&page=1")
    validate_merge_metadata(identity, commit, comparison)
    validate_files(directory, expected)
    return {"scope": "same-run-pr-image-qualification", "status": "passed", "purpose": "qualification-only",
            "identity": identity, "producer_job_id": job_id, "artifact_id": artifact_id,
            "archive_sha256": expected["archive_sha256"], "archive_bytes": expected["archive_bytes"],
            "descriptor_sha256": expected["descriptor_sha256"], "artifact_digest": expected["artifact_digest"],
            "production_admission": False, "host_import_qualified": False, "deployment_authorized": False}


def require_refusal(action, reason):
    try:
        action()
    except ValueError as error:
        require(str(error) == "ENGINE_CI_IMAGE_" + reason, "QUALIFICATION_WRONG_REFUSAL")
        return {"refused": True, "reason": reason}
    raise ValueError("ENGINE_CI_IMAGE_QUALIFICATION_MISSING_REFUSAL")


def qualify_received(directory, expected, evidence, environment, api=github_api):
    """The positive path uses live API reads, then bounded real-byte negative cases.

    No environment/event/source identities are replaced. The artifact metadata
    fault changes only the deliberately wrong expected digest and reads the same
    actual GitHub artifact again. Portable tests inject api explicitly.
    """
    assert_current_identity(expected, environment)
    directory, evidence = Path(directory), Path(evidence)
    runner_temp = Path(environment.get("RUNNER_TEMP", ""))
    require(runner_temp.is_absolute() and runner_temp.is_dir() and not runner_temp.is_symlink(),
            "QUALIFICATION_RUNNER_TEMP")
    require(directory.is_absolute() and directory.parent.resolve() == runner_temp.resolve(),
            "QUALIFICATION_RECEIVED_PATH")
    require(evidence.is_absolute() and evidence.parent.resolve() == runner_temp.resolve() and
            not evidence.exists() and not evidence.is_symlink(), "QUALIFICATION_EVIDENCE_PATH")
    evidence.mkdir(mode=0o700)
    receipt = {"status": "failed", "purpose": "qualification-only", "production_admission": False,
               "host_import_qualified": False, "deployment_authorized": False}
    try:
        receipt["positive_admission"] = admit(directory, expected, environment, api)
        bad_expected = copy.deepcopy(expected)
        digest = bad_expected["artifact_digest"]
        bad_expected["artifact_digest"] = ("0" if digest[0] != "0" else "1") + digest[1:]
        refusals = {"live_artifact_digest": require_refusal(
            lambda: admit(directory, bad_expected, environment, api), "GITHUB_ARTIFACT")}
        stale = copy.deepcopy(expected)
        stale["identity"]["run_attempt"] = str(int(stale["identity"]["run_attempt"]) + 1)
        # Current-context refusal is checked against the genuine event; no API
        # response or GITHUB_RUN_ATTEMPT is fabricated for this negative case.
        refusals["stale_identity"] = require_refusal(
            lambda: validate_github_metadata({}, {}, {}, {}, stale, environment), "QUALIFICATION_CURRENT_CONTEXT")
        refusals["production_profile"] = require_refusal(
            lambda: production.validate_files(directory, expected), "IDENTITY_SHAPE")
        with tempfile.TemporaryDirectory(prefix="qualification-refusal-", dir=evidence) as owned:
            fault = Path(owned)
            (fault / "engine-image.tar").write_bytes(b"deliberately truncated received image")
            os.link(directory / "engine-image.json", fault / "engine-image.json", follow_symlinks=False)
            refusals["archive_bytes"] = require_refusal(
                lambda: validate_files(fault, expected), "ARCHIVE_DIGEST")
            (fault / "engine-image.json").unlink()
            (fault / "engine-image.tar").unlink()
            os.link(directory / "engine-image.tar", fault / "engine-image.tar", follow_symlinks=False)
            (fault / "engine-image.json").write_bytes(b"{}\n")
            refusals["descriptor_bytes"] = require_refusal(
                lambda: validate_files(fault, expected), "DESCRIPTOR_DIGEST")
        # Re-read real custody/provenance after all refusals and fault cleanup.
        receipt["final_admission"] = admit(directory, expected, environment, api)
        receipt.update(status="passed", refusals=refusals, owned_fault_files_removed=not Path(owned).exists())
        require(receipt["owned_fault_files_removed"], "QUALIFICATION_FAULT_CLEANUP")
        return receipt
    except BaseException as error:
        receipt["status"] = "failed"
        receipt["failure_type"] = type(error).__name__
        raise
    finally:
        (evidence / "qualification-receipt.json").write_bytes(encode(receipt))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--expected", required=True)
    parser.add_argument("--evidence", required=True)
    args = parser.parse_args()
    _, raw = read_regular(Path(args.expected), 16384, retain=True)
    result = qualify_received(args.directory, decode(raw), args.evidence, dict(os.environ))
    print(json.dumps(result))


if __name__ == "__main__":
    main()

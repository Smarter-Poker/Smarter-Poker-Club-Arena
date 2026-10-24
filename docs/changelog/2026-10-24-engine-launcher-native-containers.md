# The engine launcher is proved on real Docker (2026-10-24)

## Why

Releases 735e (04:54 UTC) and f16e (06:17 UTC) both rolled back on the 75 s
cutover budget because the old engine's stop (up to 50 s) and the new
container's create (~22 s) were paid in series. #7891 creates the
replacement during the outgoing SIGTERM grace and starts it only after the
old process exits. Its law tests drive the real `engine-up.sh` against a fake
Docker. That proves ordering, not Docker's behaviour: whether a container can
be created on a port that is still being served, whether creation runs any
application code, and whether a premature start is refused.

## What

`tests/operations/engine-up-native-containers.py`, run by the new
`Engine Launcher Native Containers` workflow on every PR that touches the
launcher, the server Dockerfile, the test or the workflow. On GitHub's
isolated Docker daemon (the fixture refuses `DOCKER_HOST`/`DOCKER_CONTEXT`,
uses a fixture-only seal and touches only UUID-labelled containers) it builds
a tiny image from the server Dockerfile's pinned Node base and proves:

1. `docker create` succeeds on the serving port while the old server still
   answers, and starts no process;
2. a start before the old server exits is refused with "port is already
   allocated" and runs nothing;
3. this checkout's actual `engine-up.sh` enters `docker create` while its
   `docker stop` is still in progress, and enters `docker start` only after
   the stop returned. A thin wrapper around the real Docker CLI holds each
   edge open so a serial launcher cannot pass by accident.

The workflow names no launcher path: only the sealed release transaction
may (`tests/engine-release-seal.law.test.ts`). The test resolves this
checkout's own launcher and Dockerfile.

## Measured

- #7891's launcher (sha256 `560b0abd...`): all three stages pass.
- `main`'s serial launcher (before #7891): stages 1-2 pass; stage 3 fails
  ("actual launcher omitted an overlap or exit boundary").

## Docker finding, recorded so nobody reuses a refused container

On Docker 29.9.2, a container whose start was refused on port allocation
can later start "running" but never publishes the port: `docker port` is
empty and connections are refused. The first draft of this test reused such
a container for the positive start and failed for exactly that reason. The
refusal is now proved on a separate throwaway container. The launcher never
retries a start on the same container (a failed start exits under `set -e`,
and the original release recovery replaces the container), so this does not
affect production. Any future retry path must create a fresh container.

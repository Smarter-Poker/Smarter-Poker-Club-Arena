# Explicit private containerd for the CI import proof

The Docker 29.7.2 import proof could start a private Docker daemon while Docker selected the runner's existing containerd. The proof correctly refused to proceed when it could not find exactly one process using its pinned private containerd executable. A private Docker data directory alone does not disable Docker's system-runtime discovery.

The worker now starts containerd from the same checksum-pinned static Docker package, using an explicit configuration with private root, state and Unix sockets. Docker receives that exact socket and separate owned namespaces; embedded containerd is explicitly disabled. The worker verifies the runtime executable, complete command, unique PID, socket type/owner and Linux socket peer credentials before importing. Both daemon processes remain in the original combined 512 MiB, zero-swap, one-CPU unit. No production daemon or runtime is changed.

Shutdown stops Docker first, then stops and reaps its owned containerd. Runtime early exit, missing ownership, forced stop, incomplete cleanup and startup-through-shutdown OOM contamination fail the proof. Both daemon logs are retained. Portable tests cover these refusals and the narrow socket bind/listen readiness race; actual native qualification is still required.

Upstream selection logic: [Docker 29.7.2 initContainerd](https://github.com/moby/moby/blob/6a43e3d5afddf4111da0f864bbc7cae5d7e95001/daemon/command/daemon_unix.go#L119) and [system-runtime discovery](https://github.com/moby/moby/blob/6a43e3d5afddf4111da0f864bbc7cae5d7e95001/daemon/command/daemon.go#L1150). Its [static build pins containerd 2.3.3](https://github.com/moby/moby/blob/6a43e3d5afddf4111da0f864bbc7cae5d7e95001/Dockerfile#L138).

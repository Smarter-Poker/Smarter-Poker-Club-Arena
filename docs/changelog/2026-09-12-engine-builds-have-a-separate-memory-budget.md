# Engine builds have a separate memory budget

The 11:16 UTC engine publication compiled TypeScript on the production host
until 11:22:47. During that build, global memory pressure stopped public health
and SSH responses; the kernel killed the running engine at 11:22:43. The same
engine image restarted automatically. The build and engine kill are confirmed
by the host journal; allocation history for every participating process is not
fully reconstructed.

Uncached image builds now use one dedicated, digest-pinned BuildKit container
with a 1280 MiB memory limit, zero swap and one CPU. The publisher verifies both
Docker configuration and the effective cgroup limits before compiling. It
refuses to start with less than the builder budget plus 512 MiB of available
host memory. TypeScript uses a 768 MiB heap; runtime engine settings are unchanged.
There is no fallback to the unbounded daemon builder.

The builder stops on completion or cancellation. Its cache stays available
with automatic collection configured for a 2 GB target. The committed server
archive, immutable image labels, release locks and certified cutover remain in
place. This is a build containment change, not an application memory-leak fix.

Validation includes the executable release-law suite and a separate Linux job
that builds the exact engine, reads actual cgroup limits, deliberately causes a
build OOM, and checks that a neighboring container neither exits nor restarts.
The job retains its build logs, memory peak, OOM counters and cleanup receipt.
Passing those checks does not substitute for installation and live release proof.

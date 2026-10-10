# The compiler bounds both heap generations

The isolated canonical 556fe3 build was killed at 2026-10-08T17:24:35Z by the kernel
inside its exact 640 MiB BuildKit memory cgroup. Node PID 2848159 had 584652 KiB
anonymous RSS, 44652 KiB file RSS and 16904 KiB page tables. This was a real
cgroup OOM, not an increased build timeout. The identical candidate compiled
in 43.1 seconds in hosted resource proof 37806873914, matching all 1280 runtime
outputs. The earlier fee911 timeout remains unexplained; its later successful
observed build is separate evidence.

`--max-old-space-size=512` caps old space, not total process memory. The canonical
Dockerfile now also sets `--max-semi-space-size=4`, explicitly bounding the young
generation while preserving old-space 512 MiB, container 640 MiB, no additional swap, one CPU,
the 1500-second build deadline, the exact emit project and every runtime module.
No retry, cache purge, replacement compiler or production publisher is added.

Node 22.23.2 documents that young generation is three times semi-space and its
default depends on detected memory. Its bundled libuv reads the cgroup v2 leaf
memory limits without walking parents. Our nested compiler cgroup inherited
the container limit. A difference in detected memory or young-generation sizing
is therefore a plausible explanation, **not a demonstrated historical cause**: we
did not capture the killed compiler's effective V8 sizing. The explicit cap
removes that configuration variability; it does not guarantee a total RSS bound.

Sources: [Node 22.23.2 CLI](https://nodejs.org/download/release/v22.23.2/docs/api/cli.html#--max-semi-space-sizesize-in-mib)
and [its bundled libuv memory reader](https://github.com/nodejs/node/blob/v22.23.2/deps/uv/src/unix/linux.c#L2067-L2095).

The existing resource-proof workflow now refuses an absent/changed heap profile
before building and records that profile in its actual receipt. Focused tests
reject the old implicit profile, changed limits/project and duplicate compiler
commands. The full checked-build/output equality, native cgroup/OOM containment
and cleanup checks remain mandatory. Local source checks are not a native build
or deployment claim; the changed candidate still needs those actual proofs.

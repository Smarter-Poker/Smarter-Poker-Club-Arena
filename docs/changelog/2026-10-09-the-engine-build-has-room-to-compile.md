# The Engine Build Has Room To Compile

## What Broke

Every engine image build of current main died in the Dockerfile emit step
`node --max-old-space-size=512 ./node_modules/typescript/bin/tsc --project tsconfig.emit.json`
with "JavaScript heap out of memory" (exit 134). The Hetzner publisher run for
main 1235b47a63 on 2026-10-09 18:05 UTC refused with "bounded immutable engine
image build failed", and the live engine stayed on a9e3ca8b. The runtime source
had simply outgrown a 512 MiB compiler heap inside the 640 MiB no-swap builder.

## Measurements

The emit was measured on the exact tsconfig.emit.json project with TypeScript
5.9.3 under Node 22 (the image runtime) and Node 24:

| Heap limit | Result                                    | Peak RSS                                    |
| ---------- | ----------------------------------------- | ------------------------------------------- |
| 512 MiB    | heap exhaustion, exit 134                 | 644 MiB                                     |
| 544 MiB    | success                                   | not sampled                                 |
| 768 MiB    | success, 539 MiB heap used at exit        | 729 MiB                                     |
| 1024 MiB   | success, 592 to 603 MiB heap used at exit | 721 to 733 MiB (Node 22), 814 MiB (Node 24) |

Earlier owner measurements at 600, 700 and 900 MiB heaps peaked at about 830 to
870 MB RSS. The emit therefore needs a heap between 512 and 544 MiB and peaks
near 830 MiB RSS.

The first real bounded Linux build on this pull request (Engine Build Resource
Containment run 37972415820, 1024 MiB heap, 1536 MiB builder) passed with all
1308 runtime files matching the typechecked build, and reported a cgroup
`memory.peak` of 1322455040 bytes (1261 MiB). That counter includes page cache
from dependency install and layer export, but it is the only in-boundary
measurement, so the builder was sized against it: 1536 MiB would have left
only 22%, and 2048 MiB leaves 62%.

## The Fix

- `server/Dockerfile` raises the compiler heap to 1024 MiB, about 88% above
  the smallest heap that completes.
- `server/scripts/build-engine-image.sh` raises the bounded builder to
  2048 MiB with memory-swap equal to memory (no swap), 62% above the
  kernel peak below and about 2.5 times the highest compiler RSS. The builder identity moves to
  `club-arena-engine-bounded-v4` so the existing stopped v3 builder, whose
  640 MiB configuration is immutable, is never resized or reused; the wrapper
  would otherwise refuse it as drifted.
- The host headroom gate keeps its 256 MiB reserve on top of the full builder
  limit, so a build now requires 2359296 KiB (2304 MiB) available. engine-01
  has about 25 GB available.
- `EngineBuildHeadroomLost`, the Grafana build headroom panel and the engine
  memory runbook now read the same 2304 MiB gate. They previously still named
  an 896 MiB builder that was no longer the code.

## What Did Not Change

The build stays inside one owned cgroup with zero swap and one CPU, with exact
cgroup readback, the same immutable source extraction, image provenance,
cancellation and cleanup. There is no unbounded fallback. The real Linux
resource proof (`tests/operations/engine-build-resource-proof.py`) still
compares every emitted runtime file with the fully typechecked CI build and
still demonstrates a contained cgroup OOM kill, now against the 2048 MiB limit.

## Proof

- `tests/engine-release-seal.law.test.ts` pins the new builder identity and
  limit, the exact headroom boundary (accept at 2359296 KiB, refuse one KiB
  below), and a new law that the Dockerfile heap and the builder limit move
  together: one 1024 MiB heap, a 2048 MiB no-swap builder, the heap at most two
  thirds of the builder, and both at least 40% above the measured need,
  including the kernel peak.
- `tests/operations/engine-build-resource-proof.test.py` follows the new limit.
- The Engine Build Resource Containment workflow runs the real bounded build on
  this pull request and reports its kernel `memory.peak`.

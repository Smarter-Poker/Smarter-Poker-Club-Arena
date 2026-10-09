# Runtime emission releases each compiler program

The canonical bc90f5 image build exhausted V8's 512 MiB old-generation heap
while emitting the complete runtime on October 9. It exited 134 after about
60 seconds. The builder retained its 640 MiB memory limit, no additional swap,
one CPU, and original 1,500-second deadline. Earlier c449 and 7af inputs had
passed those same limits. This failure was a JavaScript heap exhaustion;
it is distinct from the earlier kernel OOM and the older unexplained timeout.

`server/Dockerfile` now invokes `server/scripts/emit-runtime.mjs` in the same
canonical build step. The helper derives every root from the existing emit
project and partitions the sorted set into sequential TypeScript programs,
each at most 64 files and 1 MiB of source. Each child retains the explicit
512 MiB old-generation and 4 MiB semi-space limits. It finishes before the
next child starts, releasing the previous program's ASTs. A source exceeding
the bound, invalid configuration, syntax error, failed child or skipped emit
refuses the build. No roots are excluded and there is no retry or fallback.
The original Docker cgroup, CPU, swap and deadline remain unchanged.

The independent full TypeScript check remains in required CI. The existing
resource-containment workflow still compares every emitted JavaScript and
source-map byte with its separately checked complete runtime. This parity
gate is essential: future cross-file type-dependent emit must not silently
change when a program is partitioned. The workflow now also runs real compiler
regressions for complete partitioning, multi-batch byte equality, failure
propagation, and refusal of changed heap/configuration inputs.

Local verification: full checked runtime compilation passed; all 1,302 output
files from 652 current roots matched the sequential emitter byte for byte,
with zero missing, extra or changed files. Four real-emitter regressions and
eight resource-evidence tests passed. Local compiler measurements are not a
Linux cgroup/image proof; the final source still requires the existing native
bounded build, hosted resource qualification and exact image verification.

No application runtime source, player behavior, financial logic, maintenance
clock or predecessor qualification was changed. Source was reread after edit.

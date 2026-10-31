# Bounded native legacy census candidate

The original admission reserves another full used heap before Inspector creates
its result array, although the marked census needs only bounded matching owners.
The public ABI-specific V8 addon uses the same HeapProfiler::QueryObjects entry,
including its conservative stack marker and full GC, then refuses more than
22,096 matches before constructing any managed result array. The ceiling derives
from the five existing group limits (18,000 total) and 4,096 prototype-cache limit.
The predicate stops retaining additional matches at the22,097th match; a sticky overflow refuses the whole capture; it never certifies a truncated owner set.

Node22.23.2 api.cc7415–7429 implements Array::New(values,n) with one NewFixedArray(n)
and NewJSArrayWithElements. FixedArray SizeFor is header+capacity*element size
(fixed-array.h115–116); 64-bit slots are at most8bytes. The candidate reserves
four full pointer-width slots per maximum match plus64KiB for headers/alignment:
772,608 bytes, in addition to the unchanged32MiB cleanup reserve. Native local
handles/vector and typed-array off-heap conversion remain covered by the unchanged
8*usedHeap+32MiB process admission. JSTypedArray::GetBuffer reuses its existing
JSArrayBuffer (js-array-buffer.cc238–274), allocating backing store off heap.
Fresh actual heap admission is checked before and after QueryObjects. Deadlines
are checked before capture, in the predicate, after capture and after Array::New;
V8 native execution itself is not interruptible by that deadline.

The original full-heap Inspector fallback remains unchanged. The new route
requires a protected-control source pin, immutable candidate artifact descriptor,
file hashes, exact Node/V8/modules/platform/architecture/pointer-compression match,
and a compiled source-hash export. Same-context and namespace filtering follows
Inspector's MatchPrototypePredicate; proxy chains execute no traps. Globals use
RAII through every refusal. Existing synchronous marker restoration and cleanup
remain authoritative.

Local Mac ARM64 scaled near-limit qualification uses actual available process
memory and the unchanged process formula; it proves bounded output while the old
managed formula refuses. It is not a production-size timing/capacity certificate.
Pinned Linux qualification, candidate image/control integration, protected checks,
installation and actual affected custody/runtime proof remain required. No live
native load, GC, restart, financial operation or publication was performed here.

The isolated scan-deadline fixture calibrates one real native scan and expires a
second scan midway through its predicate span. Native phase counters prove valid
predicate visits occurred before expiry, no result array was allocated, and the
actual marked collector restored prototypes and removed its holder. This proves
result refusal/restoration after native return, not interruption of GC or a
guarantee that an external absolute timeout can finish cleanup while V8 blocks.
Unknown/deadline cleanup failures retain existing no-retry/restart refusal.

The required image resource proof also composes this exact CPP binary with the
actual pinned EED constructors and all29 deployed runtime hashes. It runs only
the existing detached-drained positive and detached-job-during-await refusal
cases, performs the physical marker census and projector over exact imported
prototype identities, checks full original-object membership and invokes the
unchanged original guard/serializer with isolated mocked durable readback.
The default33historical cases stay unchanged. The native composition uses a
network-disabled, read-only candidate container with separate task-owned
scratch and mandatory verified cleanup. Mac2case composition passed locally;
actual Linux image composition remains required hosted evidence.

### Provider-only representative scale before activation

The eight small native cases and two real EED guard cases do not establish
35-million-object or 3.913-GB heap capacity. The existing immutable-image
prewarm route now requires one bounded candidate-only scale qualification when
the authoritative serving container/health/seal identity is one of the five
legacy profiles. Unknown, drifted or competing ownership refuses rather than
skipping. Degraded HTTP503 identity remains readable. No application, Inspector,
production configuration or network is loaded by the disposable fixture.

The fixed fixture retains 35M shallow objects, requires actual used heap at
least3,913,011,648bytes and additional heap at most322,107,592bytes, preserves
the original32MiB reserve and actual8x process-memory admission, and checks
complete native visits plus exact synthetic detached-owner membership. Its
20-second bound measures the native query component, not the whole production
legacy guard. Full disposable startup/allocation/query/exit/cleanup must finish
within40seconds, including5seconds reserved for cleanup. GC remains internally
nonpreemptible; a deadline failure refuses qualification.

Before this one attempt the host must have36GiB plus8GiB explicit live-host
margin available. The private container has36GiB/no swap, one CPU,32PIDs,
read-only root, no network, no inherited environment, no healthcheck, no restart
and bounded output/tmpfs. Actual cgroup controls are checked before allocation.
A durable image/fixture/controller-bound positive receipt is reused by the
receiver and later transaction, avoiding a second allocation. One-shot intent,
nonblocking resource lock and exact labelled-container cleanup preserve unknown
outcomes; an interrupted/refused attempt is never automatically repeated.

This scale gate executes only in the existing protected provider staging route
before any notice/intake/runtime operation. Local controller tests are boundary
proof, not native-scale proof. Ordinary exact-head Linux build/eight cases/EED
two-case evidence remains required before protected merge. Full scale remains
explicitly pending until the exact immutable candidate passes provider staging;
that pending preactivation proof does not prevent eligible protected merge.

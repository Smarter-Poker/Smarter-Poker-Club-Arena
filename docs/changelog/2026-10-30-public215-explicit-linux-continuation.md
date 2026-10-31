# Preserve finite Public215 Linux evidence across an interrupted collector

**File:** `scripts/ci/public215-linux-preflight.mjs` (previous lines 115–182).
**What existed:** the collector discarded the failing context and command outcome,
and a final health failure could replace the original error. Every new explicit
run executed all contexts, despite six genuine Linux exit-zero receipts already
retained from run 41031099835, attempt 1.

**What changed:** durable attempt files identify phase, offset, context and request
hash. Fixed contract labels, numeric HTTP/command/SSH/native exits, allowlisted
signals, errno and native terminal codes provide actionable failures without raw
stderr, bodies, redirects or credentials. The remote command reports its actual
native terminal independently of the SSH status; resource and lock guards are
unchanged. Final health diagnostics preserve the primary failure.

An embedded explicit R7 handoff pins the original provider run/attempt/head,
contract and source/SSH/collector steps, artifact ID/name/archive digest, all 16
member byte lengths/hashes, six context/request identities, source, immutable image
and unchanged global serving identity. The artifact uses the official bounded
302-to-200 download with authentication on the API leg only. An isolated Python
stdlib ZIP reader validates the entire archive before writing any member. Each
inherited receipt must also match its exact current prepared request and model.
The six original result/exit files are copied verbatim; only the other 101 contexts
execute. Final census remains 107, with explicit predecessor lineage. The workflow's
four inputs, source admission, all quality gates and full final independent
numerical comparison remain unchanged. There is no retry, scan or release action.

**Why:** third actual run 41031099835 passed source admission and existing-image
resolution, produced six exact-reference-validated receipts, then failed before a
seventh receipt. The original seventh failure remains unknown; this change does
not infer a data defect or claim parity, certification, activation or fleet loading.

**Verified:** reread the owning collector and its existing invoked contract tests.
Focused collector/source contracts pass, including strict provenance, original
byte reuse, hostile ZIPs, token isolation, typed redaction and primary-error
retention. The actual pinned provider metadata/archive and six current original
request/model bindings also passed the new read-only admission functions. No
engine, SQL, model, seed or M2 operation was performed by this source change.
**TypeScript:** no TypeScript source changed; normal repository pre-push checks
remain mandatory. Hosted checks, protected merge and the explicit hosted Linux
continuation are separate remaining delivery evidence.

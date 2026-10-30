# V31 model ingress and existing staged-image identification

## Change 1: scoped model operations enter the existing replay gate

**Files:** `supabase/migrations/20261030023627_v31_model_operations_enter_the_scoped_replay_gate.sql`, `scripts/ci/probes/horse-phase4-certified-solver/{model-ingress-before.sql,model-ingress-after.sql,run-model-ingress-pg17.sh,run-pg17.sh,README.md}`, `tests/v31-model-ingress-operations.test.mjs`, `scripts/ci/test-v4-policy-metadata.mjs`.

**What existed:** The original migration `20260908181724`, lines 143–156 and 172–209, allowed eight legacy operation names in the nonce table and ingress function. The authenticated producer already sent `prepare_model`, `freeze_model` and `model_freeze_authority`. Consequently the first private preparation failed before writing a model. The existing required V31 native gate did not exercise this transition.

**What changed:** A generated, new migration checks the exact installed function and validated constraint preimages, replaces the operation CHECK with a fully validated explicit extension, and replaces the ingress function without changing its identity, owner or execution ACL. COMPACTOR alone may prepare/freeze; M2 alone may request freeze authority. All eight legacy operations retain their existing actor domain. The 300-second freshness, canonical nonzero SHA-256, principal/nonce replay key and service-only access remain intact. One transaction, one lock attempt, 1-second lock timeout and 5-second statement timeout remain mandatory. Exact function, validated CHECK and security metadata live proofs accompany installation.

**Why:** The producer and database replay owner disagreed on operation names. No certification, source, holdout, model quality or promotion gate needs relaxing.

**Regression protection:** The existing required V31 PostgreSQL 17 gate now runs the actual original function/CHECK and proves all three expected operations fail before installation. It then applies the maintained migration over 31,055 synthetic historical nonce rows and proves correct actors pass while wrong actors, replay across operation/body changes, stale/future times, missing identities, zero/noncanonical digests and unknown operations fail. It checks retained historical bytes, original function OID/owner/ACL/search path and all 24 legacy actor/operation combinations. The existing metadata runner imports the source contract, enforcing it through the same required gate while keeping the workflow and unrelated qualification source bindings byte-identical. The isolated focused runner is available for this transition without the rest of the corpus fixture.

**Verified:** Re-read the final SQL and connected probes. Native focused transition passed on real PostgreSQL 17.11; combined Node source/preflight contracts passed. This is source qualification, not an installation or certified-data claim.

**TypeScript:** Not applicable to this change; no TypeScript or runtime model/encoder source changed.

## Change 2: identify one existing admitted engine image without building it

**Files:** `scripts/ci/public215-linux-preflight.mjs` (input validation and existing-image resolver, lines 11–85; pinned execution, lines 139–154), `scripts/ci/public215-linux-preflight.test.mjs` (new resolver regressions, lines 54–84).

**What existed:** The finite preflight required a caller-known immutable image ID, although the existing engine transaction builds its canonical candidate tag before waiting for activation. A completed build could therefore be unusable when its immutable ID was not exposed by an in-progress job's logs.

**What changed:** The explicit `resolve-existing` selection resolves only `club-arena-engine:<exact candidate SHA>` once. Under the existing host flock and daily exclusion it reads the immutable ID and verifies OCI revision, exact server tree, clean-build contract and unchanged running container. The controller retains that exact identity and pins every subsequent context execution and terminal receipt to it. Manual immutable IDs continue unchanged. Missing images or busy hosts fail closed.

**Why:** This removes a metadata discovery deadlock without building, pulling, tagging, starting or activating an image. Existing protected ancestry, all source shards, production doors, frozen ten-file graph, resource limits and 107-context terminal requirements remain enforced.

**Verified:** Re-read the full controller and test diff. The existing workflow string-input schema is unchanged. Eight focused preflight tests passed, including single lookup, immutable receipt, metadata mismatch and missing/locked host refusals. No host discovery or release operation was performed by this source change.

**TypeScript:** Not applicable; the modified controller and tests are native JavaScript.

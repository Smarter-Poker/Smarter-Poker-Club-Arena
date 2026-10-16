# Legacy learning qualifies shared locked batches once

## Change 1: remove repeated parsing inside the original exception owner

**File:** `supabase/migrations/20261016131548_legacy_learning_retirement_validates_each_locked_batch_once_.sql`

**What existed:** The installed private purge `dcce64d000c3d5e45cc8faf1f6e83e92` parsed each member batch and every tuple again for each requested hand (original migration lines181–194). Production receipts reached the unchanged two-second soft budget after approximately60–90 hands. A focused native250-hand, three-shared-batch fixture measured0.537s in repeated parsing within a0.574s original call.

**What changed:** A forward-only exact-preimage/owner/ACL/search-path guard patches only that function's batch qualification loop and local declarations. After the original batch row lock, it caches requested hands' presence and invalid/newer timestamp flags for that batch for this call. Duplicate facts combine invalidity with OR. The original immutable payload and all unrelated tuple strings stay in the batch, not in a persistent cache. A refused hand discards newly loaded keys outside the already admitted16MiB union. Original per-hand protected checks and unfinished-work rechecks still run. Final compaction still rewrites each selected batch once under the held locks.

**Why:** Shared-batch parsing was repeated hundreds of times even though its source row was already locked for this transaction. Reusing only the derived per-call flags removes that measured CPU cost without weakening qualification or adding a job, index, new API, persistent cache or schedule.

**Preserved:** Explicit boolean/string human and reported evidence, all history/atomic/normal certificates, financial and F06/BBJ/outbox/knockout guards, newer facts in every member batch, capacity and maintenance locks, immutable exception/replay protections,250 requested-hand/2-second/16MiB original bounds, service permissions and financial/statistical records.

**Verified:** YES, source and diff reread. Existing maintained legacy native harness now applies and refuses replay of the follow-up migration, then runs all prior protections against the optimized owner. It invokes the focused cache comparison through its existing CI call; no new workflow is required. NativePG17.11/ICU qualification passed48 assertions including old/new whole raw/batch/exception postimage equivalence except actual transition time, byte-identical protected records, batch-only copies, same-batch and cross-batch newer vetoes, malformed rollback, and actual native instrumentation showing five distinct source batches qualified once for250 requested hands. Isolated clusters were stopped and removed.

The final focused old/new fixture measured0.607096s versus0.093670s (~6.48x). These are local observations, not a production throughput guarantee. Exact provenance and seven qualified function postimages are in `docs/evidence/horse-retention/legacy-batch-cache-2026-10-16.json`.

**TypeScript:** PASS, `npx tsc --noEmit` on this candidate. Policy canonical comparison and whitespace validation passed. No TypeScript runtime changes.

**Delivery:** Not pushed, protected-merged, installed or production-verified by this source preparation. Root owns production and the active foreground operation. Never replay the prior installed migration.

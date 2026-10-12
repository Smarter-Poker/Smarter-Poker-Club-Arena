# The inventory seal publishes bounded committed rows

## Scope and checkpoint

Diamond Wallet resume delegated inventory-seal source correction. Parent owns protected integration, production installation and live verification. Owned branch `fix/weekly-close-bounded-seal-20261012`, base `e8757d1d0290152a169e97c1ea88520757bab81b`. This corrects existing **uninstalled** migration `20261012135622` from merged PR #6762. Its version was confirmed absent and production advance remained original `6deca79658f44ffb149316167441b2bf`; installed historical migrations remain immutable. No production writes performed by this task.

Fresh canonical policy reading at 2026-10-12 15:44:57 UTC: version 2.9, manifest `a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`; owner `b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349`, operating law `a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5`, hardening `d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e`, references `adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555`. Read repository AGENTS, CLAUDE, AGENT-PLAYBOOK, PUBLISHING, MIGRATION-LAW, canonical storage guide and directly affected source/consumers. Policy comparison passed. Prerequisite PR #6761 scheduler/report postimages remain exact installation guards; the parent owns their installation order.

## Change 1: original seal and broken partial-copy replacement

**File:** `supabase/migrations/20261012135622_the_inventory_seal_assembles_bucket_by_bucket.sql`, former lines 1-119.
**What existed:** original advance copied every assembled checkpoint row and issue in one transaction before its immutable header. The merged, uninstalled #6762 instead attempted 400,000-row partial writes into historical tables whose deferred header foreign keys reject partial commits.
**What changed:** private logged build rows and issues persist across the existing close calls, with a forward-only durable cursor. Historical tables, foreign keys and immutable headers stay intact. Published views require both the immutable header and a completed build marker. Existing five authoritative readers consume historical rows plus published build rows; directly affected checkpoint callers return truthful pending status until every due boundary is sealed. The same global advisory lock serializes the single boundary source cache. No new schedule or repair loop.
**Why:** commit bounded pages without exposing incomplete evidence or making a final bulk copy. Each page caps both 32,768 candidates and a conservative 32 MiB encoded budget. The cost uses four times the greater of actual JSON text bytes and stored JSONB bytes plus row overhead, preventing compressed TOAST values from bypassing the encoded budget. An individually oversized row is refused. Publication independently compares complete sets, row/issue checksums and population readback before inserting the header.
**Verified:** YES, source reread and native original-failure/corrected-success proof. Exact prerequisites, 13 postimage hashes, replay refusal, grants and storage isolation are retained in migration source.
**TypeScript:** PASS.

## Change 2: maintained regression and schema contracts

**Files:** `scripts/dev/test-inventory-seal-bounded.py`, `tests/fixtures/inventory-seal-bounded/`, existing inventory seal law test and schema manifest, `.github/workflows/ci.yml`.
**What existed:** source assertions treated partial historical copies as committed progress; no real deferred-FK commit proof.
**What changed:** isolated PostgreSQL 17 fixtures run the actual old functions, original #6762 and corrected migration. Existing required accounting shard 3 invokes the finite native regression. Contracts describe the new private relations/functions and preserve existing safeguards.
**Why:** protect real commit, rollback, crash recovery, visibility, publication equivalence, concurrency, backlog/cache switching, checksum refusal, ACLs and immutability, including highly compressible and individually oversized payload boundaries.
**Verified:** YES. Focused law tests pass; native qualification receipts retained below. Phantom table/function/column checks and diff whitespace checks pass. No browser or client/engine release is required by this database-only correction.
**TypeScript:** PASS.

## Evidence and remaining acceptance

Native 3,400,000-row fixture: old whole-copy transaction generated **2,722,767,256 WAL bytes**; corrected maximum transaction **104,180,912 bytes**, below 128 MiB. Exact immutable header counts/checksums/population, real reader projection, partial invisibility, crash resume and duplicate/refusal behavior passed. Retained receipt and PostgreSQL log: `/Volumes/SmarterArchives/agent-evidence/weekly-close-bounded-seal-20261012/large-3400000/`. This core run preceded the truthful backlog refinement and stricter encoded-byte cost; the unchanged core volume result is retained, and the final small suite qualifies those affected paths. No repeated large fixture was needed.

Final small qualification includes wrong-cache refusal, two concurrent callers, historical-boundary cache switching and resumed durable cursor, truthful backlog readiness, compressed 5 MiB rows requiring separate pages and compressed 9 MiB row refusal. Receipts are archived in the same task evidence directory. Original #6762 actually fails the deferred foreign key on a 430,000-row partial commit; corrected source commits bounded progress.

Per-call maximum duration is **unknown** because retained large logs did not record duration. The existing scheduler's 240-second timeout remains unchanged; it is not full weekly-close correctness proof. Round-four/report preparation is owned separately and unresolved here. Required hosted checks, protected merge, exact ordered installation/history/readback and affected live scheduled-close/Realtime proof remain pending with the parent. No claim that the entire weekly close is fixed or installed is made from these local results.

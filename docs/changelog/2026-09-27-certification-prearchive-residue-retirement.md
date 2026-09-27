# Certification Pre-Archive Residue Retirement

## Change #1 — Separate The Five Clean August Identity Shadows

**File:** `supabase/migrations/20260927042756_certification_cleanup_removes_five_prearchive_public_user_residue.sql`
**Lines:** 1-310; exact preimages, refusal checks, and final delete
**What existed:** One proposed cleanup grouped five clean August `public.users` shadows with a September identity that has protected diamond financial testimony.
**What changed:** The migration now targets only the five August rows whose complete production readback was empty. It pins each ID, email, username, exact `NULL` avatar, timestamps, whole protected-surface state, and the unchanged `public.users` trigger/foreign-key delete graph before deleting exactly five rows.
**Why:** The September identity is not an orphan and cannot share the clean-row deletion path. Splitting it preserves financial testimony and keeps the August correction fail closed.
**Verified:** YES — file reread, exhaustive live readback was read-only, focused contracts and migration uniqueness passed.
**TypeScript:** PASS — focused Vitest TypeScript contracts passed.

## Change #2 — Archive The September Identity Before Exact Retirement

**File:** `supabase/migrations/20260927045612_archive_and_retire_prearchive_certification_identity.sql`
**Lines:** 1-361; source preflight, immutable archive DDL, snapshot verification, and two exact deletes
**What existed:** Identity `a28421ff-9f27-4a99-81dd-2e18884d616c` retained a `public.users` shadow and signup diagnostic after its Auth/profile deletion. Six original diamond testimony rows and one profile-deletion row still correctly name that UUID. No existing archive was both semantically valid for the whole identity context and protected by an immutable UPDATE/DELETE guard.
**What changed:** A serializable, one-transaction migration creates a private no-FK `ca_test_account_identity_archive`, snapshots whole-row identity/signup/profile-deletion and all diamond testimony JSON, pins source hashes, enables RLS, grants service-role SELECT only, and installs an UPDATE/DELETE refusal trigger. It re-verifies the original financial rows before and after deleting only signup error `9105` and the exact `public.users` row.
**Why:** The identity residue can be retired without erasing, reassigning, or changing any financial history only after its complete context has durable immutable testimony.
**Verified:** YES — source reread and read-only live preimage/hash/catalog checks completed; no production mutation or DDL probe was performed.
**TypeScript:** PASS — focused Vitest TypeScript contracts passed.

## Change #3 — Retain Regression Contracts

**File:** `tests/unit/certificationCleanupRemovesFivePrearchivePublicUserResidue.test.ts`; `tests/unit/certificationIdentityArchiveRetirement.test.ts`
**Lines:** 1-179 and 1-110; complete source-contract suites
**What existed:** The earlier contract covered the mixed six-row proposal and did not distinguish protected diamond testimony.
**What changed:** Contracts now lock the five-row scope, exact username/avatar preimages, all catalog refusal surfaces, unchanged `public.users` delete graphs, immutable archive ACL/trigger/no-FK rules, archive-before-delete ordering, exact two-delete limit, and the prohibition on financial-row mutation.
**Why:** Future edits must fail if they widen deletion, weaken immutability, or treat protected testimony as disposable residue.
**Verified:** YES — focused suites passed after final formatting.
**TypeScript:** PASS — focused Vitest TypeScript contracts passed.

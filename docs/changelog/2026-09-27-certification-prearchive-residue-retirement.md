# Certification Pre-Archive Residue Retirement

## Resumption Receipt

Policy version 2.9 was freshly emitted at `2026-09-27T05:39:10.501Z` from the canonical owner policy, operating law, hardening standard, and reference index. Manifest SHA-256: `7663cc909626f7e9966931d27166ad8774addc801f7ad1898a2d7564bc13c378`. The repository instructions, publishing route, full Club Arena Console skill, and current task state were reread before continuation. The owned checkout is `/Volumes/SmarterWork/agent-work/create-club-cert-selector-fix` on `agent/cowork/retire-prearchive-cert-residue`; the operation owner is this task. Scope is limited to reserved certification identities, migration evidence, protected delivery, and final Create Club certification. Real clubs, unions, horses, users, wallets, chips, and settings are excluded.

## Change #1 — Separate The Five Clean August Identity Shadows

**File:** `supabase/migrations/20260927042756_certification_cleanup_removes_five_prearchive_public_user_residue.sql`
**Lines:** 1-313; exact preimages, refusal checks, and final delete
**What existed:** One proposed cleanup grouped five clean August `public.users` shadows with a September identity that has protected diamond financial testimony.
**What changed:** The migration now targets only the five August rows whose complete production readback was empty. It pins each ID, email, username, exact `NULL` avatar, timestamps, whole protected-surface state, and the unchanged `public.users` trigger/foreign-key delete graph before deleting exactly five rows. Its exhaustive catalog guard has a bounded 15-minute statement budget because the live 884-surface scan correctly exceeded the original 120-second budget and rolled back without mutation.
**Why:** The September identity is not an orphan and cannot share the clean-row deletion path. Splitting it preserves financial testimony and keeps the August correction fail closed.
**Verified:** YES — file reread, exhaustive live readback was read-only, focused contracts and migration uniqueness passed.
**TypeScript:** PASS — focused Vitest TypeScript contracts passed.

## Change #2 — Archive The September Identity Before Exact Retirement

**File:** `supabase/migrations/20260927045612_archive_and_retire_prearchive_certification_identity.sql`
**Lines:** 1-364; source preflight, immutable archive DDL, snapshot verification, and two exact deletes
**What existed:** Identity `a28421ff-9f27-4a99-81dd-2e18884d616c` retained a `public.users` shadow and signup diagnostic after its Auth/profile deletion. Six original diamond testimony rows and one profile-deletion row still correctly name that UUID. No existing archive was both semantically valid for the whole identity context and protected by an immutable UPDATE/DELETE guard.
**What changed:** A serializable, one-transaction migration creates a private no-FK `ca_test_account_identity_archive`, snapshots whole-row identity/signup/profile-deletion and all diamond testimony JSON, pins source hashes, enables RLS, grants service-role SELECT only, and installs an UPDATE/DELETE refusal trigger. It re-verifies the original financial rows before and after deleting only signup error `9105` and the exact `public.users` row. Its exhaustive serializable catalog guard has a bounded 15-minute statement budget, matching the proven seven-minute production scan with safe headroom.
**Why:** The identity residue can be retired without erasing, reassigning, or changing any financial history only after its complete context has durable immutable testimony.
**Verified:** YES — source reread and read-only live preimage/hash/catalog checks completed; no production mutation or DDL probe was performed.
**TypeScript:** PASS — focused Vitest TypeScript contracts passed.

## Change #3 — Retain Regression Contracts

**File:** `tests/unit/certificationCleanupRemovesFivePrearchivePublicUserResidue.test.ts`; `tests/unit/certificationIdentityArchiveRetirement.test.ts`
**Lines:** 1-180 and 1-111; complete source-contract suites
**What existed:** The earlier contract covered the mixed six-row proposal and did not distinguish protected diamond testimony.
**What changed:** Contracts now lock the five-row scope, exact username/avatar preimages, all catalog refusal surfaces, unchanged `public.users` delete graphs, immutable archive ACL/trigger/no-FK rules, archive-before-delete ordering, exact two-delete limit, and the prohibition on financial-row mutation.
**Why:** Future edits must fail if they widen deletion, weaken immutability, or treat protected testimony as disposable residue.
**Verified:** YES — focused suites passed after final formatting.
**TypeScript:** PASS — focused Vitest TypeScript contracts passed.

## Change #4 — Retire The Last Pre-Archive Club-Create Shadow

**File:** `supabase/migrations/20260927053730_retire_last_prearchive_club_create_identity.sql`; `tests/unit/lastPrearchiveClubCreateIdentityRetirement.test.ts`
**Lines:** 1-182 and 1-79; complete one-time migration and source contract
**What existed:** One August 31 Club Create certification identity survived only as an exact Auth-less `public.users` row after its older workflow cleanup. It had no authority, custody, gameplay, audit, archive, asset, UUID, or email-bearing surface across the complete production catalog.
**What changed:** A byte-pinned, serializable, freeze-refusing transaction scans every current public identity-bearing UUID column, every Auth/Storage UUID column, and every other Auth/Public email-bearing column, refuses delete-graph drift, and deletes exactly the one unchanged row. Its contract forbids wider deletes and pins all guards before mutation.
**Why:** Global certification cleanup cannot be claimed while the historical shadow remains, and widening the reusable cleanup RPC would weaken its live-marker boundary.
**Verified:** YES — the preimage and 935 public, 65 Auth/Storage, and 22 other email-bearing surfaces were read-only audited before source creation; production installation remains a separate gate.
**TypeScript:** PASS — focused source contract added.

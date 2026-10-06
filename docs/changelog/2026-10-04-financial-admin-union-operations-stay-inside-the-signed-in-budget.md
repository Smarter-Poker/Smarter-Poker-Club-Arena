# Financial Admin Union Operations Stay Inside The Signed-In Budget

Migration `20261004153522_union_ops_reports_stay_inside_the_signed_in_budget` is reserved and prepared, not applied. This entry records source evidence only; merge, database application, publication, and signed-in production verification remain separate gates.

## Read Before Change

- Production `fn_union_agent_risk_report` expanded all `rake_records.player_contributions` and scanned all wallet transactions before joining the requested union roster. Its exact definition hash was `89e2a62ef34afbf1cda9465d052ae46e`.
- Production `fn_union_distribution_check` read exact signed `rake_records`, `agent_commissions`, and `rakeback_periods`, but its OR join planned across large ledgers. Its exact definition hash was `2347e9268b84a1685e37af32d8b050e8`.
- Production held roughly 4.4 million rake records, 15.6 million agent commissions, and 4.1 million wallet transactions. The three signed-in reads reproduced statement timeout failures at roughly 8–10 seconds.
- Cron job 121 (`union-law-selftest`) ran the global audit directly. Its latest observed successful run took 17.5 seconds; earlier history included a 120-second timeout and a 262-second success. That daily audit was being executed again on every Integrity tab load.
- Live membership evidence intentionally differs by contract: risk follows the canonical `union_clubs` roster plus the house club; distribution preserves `clubs.union_id` plus the house club. Risk's signed authority remains `rake_records/player_contributions` because production `rake_attributions` rejects negative amounts; signed reversals and open-ended `created_at >= p_since` semantics are part of both pinned preimages and are retained.
- The Financial Admin shark console closed before `UnionOpsPanel`; the panel then drew standalone rounded dashboard controls and a generic settlement dialog outside the approved chassis.
- The union selector used discoverable `unionService.getUnions()` rows and treated every selection as runnable even though the operation RPCs require exact `fn_is_union_overseer` authority.
- The browser called the intentionally private `fn_union_settlement_cascade` weekly coordinator. That function is postgres-only; the supported browser contract is read-only preview and recorded-round review while the audited close runs automatically.

## Changed Files

### Change 1 — Exact Indexed Database Readers And Cached Law Verdict

**File:** `supabase/migrations/20261004153522_union_ops_reports_stay_inside_the_signed_in_budget.sql`
**What existed:** Global scans, any-union risk authorization, direct interactive global self-test execution, and no full signed club/time rake index.
**What changed:** Adds an online full `(club_id, created_at) INCLUDE (rake_amount)` index with exact shape assertions; bounds signed `rake_records/player_contributions` by the union's host clubs before JSON expansion; maps each contributing player once with the rule already owned by `fn_union_rake_paid_by_club` (real `union_clubs` membership before the house fallback, then oldest membership and club-id tie-breakers); scopes the remaining risk sources through the full roster; retains signed/open-ended rake and commission semantics; enforces requested-union oversight; adds a least-privilege `fn_union_overseer_options()` reader whose rows use that exact predicate; persists the scheduled law verdict with least-privilege grants; rejects missing, inactive, failed, newer, or older-than-36-hours audit state; seeds one current verdict during migration; and repoints the existing cron through its verified PostgreSQL 17 `cron.alter_job(bigint,text,text,text,text,boolean)` signature.
**Why:** Make the three signed-in reads truthful and bounded without changing accounting authority or conservation arithmetic.
**Verified:** YES — reread after edits; focused PostgreSQL 17 fixture passes.
**TypeScript:** N/A.

### Change 2 — Strict Service Failures And Read-Only Settlement Evidence

**File:** `src/services/UnionOpsService.ts`
**What existed:** Risk, distribution, law, and settlement-round read failures could become empty/null success; the Integrity tab executed the full self-test; preview identity was not validated.
**What changed:** All four reads throw; the law read calls the cached-status RPC; timeout and visible failure copy is safe and title-cased; the authorized union list rejects null, malformed, duplicate, or wrong-type rows instead of converting them to false empty; a preview must match the requested union, carry a nonempty ordered exact date/timestamp period, and contain complete nested rounds with finite nonnegative money, integer counts, arrays, and boolean flags. Every shortfall row now requires its SQL-emitted UUID keys, its nullable-or-nonblank display-name key, and finite nonnegative rendered amounts; each short-count must equal its detail length and `has_blockers` must exactly reflect those counts, without inventing unsafe arithmetic equality across independently rounded values. Integrity completion must match the requested union and window with a nonnegative integer signal count; and the dead browser wrapper for the private weekly settlement coordinator is removed.
**Why:** A timeout or malformed authority response must never render as “no activity,” and browser settlement evidence must remain an exact read-only review rather than pretend it can execute the private coordinator.
**Verified:** YES — reread and focused unit/component tests pass.
**TypeScript:** PASS.

### Change 3 — Active-Tab Reads, Race Guards, And Console-Native Operations

**Files:** `src/components/union/UnionOpsPanel.tsx`, `src/components/union/UnionOpsPanel.css`
**What existed:** Every panel load serialized a Hierarchy probe before all tabs, stale async completions could supersede a newer tab/union, controls/cards were generic rounded UI, and settlement presented an unsupported execute action.
**What changed:** Each tab owns only its read; effect cleanup invalidates old generations; changing unions keys and remounts the entire stateful panel before the new read starts; the integrity mutation binds to its invocation target and suppresses stale/unmounted completion effects; union changes clear stale previews; date-only and timestamp preview bounds print as their exact UTC contract dates; every touched target is at least 44 px; the linked tablist implements Arrow/Home/End keyboard behavior without unresolved `aria-controls`, keeps Refresh outside the tablist, and labels the active panel; status cannot coexist with tab content; successful unavailable reports render explicit honest messages; unnamed agents never fall back to UUIDs; settlement history is bounded by a horizontal scroller at 393 px; database names are title-cased; money values use `compactChips`; the commission policy band retains one decimal instead of rounding half points to whole percentages; Hierarchy, report, and table dividers are engraved rows using approved console colors; and scheduled settlement review is a read-only riveted console portaled to `document.body`, with a flex-start scroll origin plus safe auto-centering, background scroll locked and restored, top-context initial focus, an X and one Close lit word, focus trap, Escape/backdrop close, and trigger focus restoration. Round 2+3 pending is labelled exactly; an unrecorded Round 1 never produces a false Clear state and is explicitly not estimated.
**Why:** Remove duplicate work, stale financial effects, and an unsupported private mutation while preserving the approved Club Arena console chassis.
**Verified:** YES — reread and focused component tests pass, including deferred read/sweep races, read-only settlement, authority refusal, mobile overflow and dialog contract assertions.
**TypeScript:** PASS.

### Change 4 — Keep Operations Inside The Existing Shark Chassis

**File:** `src/pages/FinancialAdminHub.tsx`
**What existed:** The shark console ended before Union Operations content; the revenue chart could report negative responsive dimensions.
**What changed:** The selected union panel renders inside the existing shark console, `ResponsiveContainer` has `minWidth={0}`, and only exact server-authorized overseer options can mount a panel or expose controls. Empty, failed, or tampered selections mount nothing.
**Why:** Preserve one approved frame per surface and remove the observed chart sizing warning.
**Verified:** YES — reread and focused Financial Admin component tests pass.
**TypeScript:** PASS.

### Change 5 — Focused Regression And PostgreSQL 17 Proof

**Files:** `tests/unit/UnionOpsService.settlement.test.ts`, `tests/components/union-operations-name-their-union.test.tsx`, `tests/components/union-ops-settlement-receipt.test.tsx`, `tests/components/FinancialAdminHub.scope-status.test.tsx`, `tests/fixtures/union-ops-financial-admin/bootstrap.sql`, `tests/fixtures/union-ops-financial-admin/assertions.sql`, `scripts/dev/test-union-ops-financial-admin-postgres.sh`
**What existed:** No focused proof covered timeout-to-empty behavior, membership-store disagreement, signed tournament reversals, exact index selection, cached-law freshness, authorized selector scope, stale reads/sweeps, preview identity, or the private settlement boundary.
**What changed:** Adds production-shaped PostgreSQL 17 schemas and 70,000 unrelated/in-scope rows, including the production non-negative `rake_attributions` constraint and cancellation `source`/`metadata`; proves signed direct arithmetic from a linked positive tournament row and `atomic_cancel_tournament` reversal with identical `player_contributions`, a house-hosted player whose older house membership still loses to real `union_clubs` membership and is attributed exactly once, future corrections, arbitrary lower bounds, risk/distribution membership laws, union owner/admin and house owner/admin option inclusion, ordinary/anonymous/cross-union exclusion, least-privilege option grants and deterministic order, full-index plans for both risk and distribution, sub-eight-second focused runtime, cache seed/freshness/missing/inactive/newer-failed behavior, strict client failures, active-tab reads, stale-completion suppression, keyed union-state removal, strict preview shape, no browser settlement coordinator call, exact authorized-list failure/empty/stale-scope behavior, one-decimal policy bands, and portaled dialog focus/scroll behavior.
**Why:** Prove arithmetic and refusal paths instead of treating a retry or a local render as production evidence.
**Verified:** YES — PostgreSQL 17 fixture and 126 focused Vitest cases pass.
**TypeScript:** PASS.

### Change 6 — Owned Schema And Source Contracts

**Files:** `scripts/ci/schema-manifest.d/club-data-financial-admin-budget.json`, `tests/fixtures/union-ops-financial-admin/source-binding.json`, this changelog
**What existed:** The new cache table/status functions and focused proof bundle had no task-owned schema/source declaration.
**What changed:** Declares only the new table and three new functions in an owned schema fragment; pins the exact focused source and proof files; records read-before, after, and verification evidence here. The generated live base schema manifest remains untouched.
**Why:** Keep the phantom-reference and source-integrity gates honest without claiming unapplied objects are live.
**Verified:** YES — the focused runner enforces the three financial source hashes before PostgreSQL starts; repository-wide source-binding, schema-contract, and phantom-reference checks pass.
**TypeScript:** N/A.

## Verification

- `scripts/dev/test-union-ops-financial-admin-postgres.sh` — PASS on PostgreSQL 17.
- Focused Vitest: the Union Ops service/panel/receipt files plus the Financial Admin scope-status file — PASS, 4 files and 126 tests.
- `npx tsc --noEmit -p tsconfig.app.json` — PASS.
- `node scripts/ci/check-schema-contract.mjs` — PASS, zero missing live contract names and zero phantoms.
- `node scripts/ci/check-phantom-tables.mjs` — PASS, zero phantom tables/RPCs.
- `python3 scripts/ci/verify-source-bindings.py` — PASS; the new runner-enforced bundle pins the exact migration, bootstrap, and assertions.
- Concurrent migration preamble parser — PASS; only `idx_rake_records_union_signed_window` precedes `BEGIN`.
- Title Case and painted-text checks — PASS.
- `CI=1 npx playwright test tests/e2e/tap-sweep-rules.spec.ts --project=chromium` — PASS, 7 tests; this server-free mode avoids the stale-tree development-server guard and exercises the retained mobile tap-sweep contract without credentials.
- `git diff --check` — PASS.

No broad suite, production mutation, migration apply, commit, push, merge, publication, or release action was performed in this worktree.

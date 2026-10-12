# Stats Owner Workspace

## Change #1 — Owner-Only Persistence

**File:** `supabase/migrations/20261003140226_stats_owner_workspace.sql`
**What existed:** Stats had no durable owner workspace for reports, leak lifecycle, goals, study collections, layout, presentation privacy or controlled alerts.
**What changed:** Added eight owner-RLS tables and narrow authenticated RPCs. Report retries are SHA-256 sealed: exact retries return the original row and a changed payload under the same key is refused. Study collections and leak evidence link owned hand ids and reuse `ca_hand_notes` rather than copying notes or tags. Alerts are evaluated only on an explicit Stats refresh, retain their last reading and trigger, and honor their cooldown.
**Why:** Phase 8 requires durable, least-privilege state without local storage, background repair loops or model claims.
**Verified:** YES — source re-read; native PostgreSQL ownership, replay, cross-owner and anonymous-refusal fixture passed.
**TypeScript:** PASS

## Change #2 — Typed Workspace Service

**File:** `src/services/StatsWorkspaceService.ts`
**What existed:** No client contract could read or write the workspace.
**What changed:** Added typed RLS-scoped reads and RPC writes with explicit error outcomes and HandNotesService enrichment.
**Why:** UI actions must reach authoritative owner-only persistence and must not manufacture success.
**Verified:** YES — focused service tests passed.
**TypeScript:** PASS

## Change #3 — Console Workspace And Workflows

**Files:** `src/components/stats/StatsWorkspacePanel.tsx`, `src/components/stats/StatsWorkspacePanel.css`, `src/pages/stats/WorkspaceTab.tsx`, `src/pages/PlayerStatsPage.tsx`
**What existed:** No owner Workspace tab or usable report, goal, study, layout, privacy and alert workflows.
**What changed:** Added a painted-console owner-only workspace, distinct loading/error/empty states and accessible forms for every persisted workflow. The page now lazy-loads an owner-only Workspace tab, saves each immutable rule snapshot with range and club evidence, applies a validated saved tab layout, restores the default layout on demand, evaluates supported alerts on Stats refresh, and requires an honest goal baseline.
**Why:** Phase 8 requires connected workflows, not storage-only stubs.
**Verified:** YES — component tests and app TypeScript passed.
**TypeScript:** PASS

## Change #4 — Presentation-Safe Page And Exports

**Files:** `src/pages/PlayerStatsPage.css`, `src/pages/stats/statsCsvExport.ts`, `src/pages/stats/OverviewTab.tsx`, `src/components/stats/StatsShareCard.tsx`
**What existed:** A privacy preference could not prevent private figures from appearing on screen, in CSV or on a share card.
**What changed:** Persisted presentation mode now hides private page artifacts from visual and accessibility output and masks every CSV/share-card value and player identity while retaining explicit presentation-mode metadata.
**Why:** A privacy mode must change every disclosure surface, not only its label.
**Verified:** YES — focused export/component tests and app TypeScript passed.
**TypeScript:** PASS

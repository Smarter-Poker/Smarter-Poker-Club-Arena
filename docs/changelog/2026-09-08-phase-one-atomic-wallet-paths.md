# Phase One Atomic Wallet Paths

Status: Phase 1 of 12 complete for the canonical agent wallet paths and financial entrypoint baseline defined below. Published and verified September 8, 2026.

User authorized a dependency-ordered build of the 109-item audit plus nine explicit acceptance requirements. The original report remains on codex/club-arena-comprehensive-audit-backlog; the user explicitly approved its publication, the normal Hetzner pipeline and Sentry uploads in the latest request.

Build order (12 phases): 1 canonical agent wallet paths and financial entrypoint baseline; 2 cash-game conservation and departure; 3 interrupted-game durability and cross-system failures; 4 tournaments, SNG, Spins, satellites and all bounties; 5 rake hierarchy, BBJ/main/backup/promo and effective-date rounding; 6 remaining cashier, ticket, issuance and diamond paths; 7 identity, tenant and account lifecycle; 8 lobby, seating and realtime clients; 9 history, historical incidents, statistics and configuration; 10 player protection/support/club operations; 11 every page/control/accessibility/visual state; 12 performance, restore, release compatibility and cross-phase acceptance. This is the user's newly authorized execution order; prior programme numbers remain historical references, not concurrent phase-completion claims.

Every phase requires an owner, source baseline, independent expected outcomes, negative/concurrency/recovery tests, merged source and actual deployment evidence. The nine additions map respectively to phases 9, 1/6/12, 7, 5/9, 2/4/5/6, 3/12, 12, all financial phases, and every phase. No watcher/reconciler, blanket lockdown, guessed historical payment or forced engine restart.

Before changes: WalletService.ts:425 routes agentSelfTransfer through fn_wallet_type_transfer/public.wallets. AgentPortalPage.tsx:225 passes auth user ID; AgentFinancialPortal.tsx:178 passes agents.id. Both render agents.player_wallet_balance rather than club_members.chip_balance. AgentService.ts:699 creates a new op ID every call and accepts truthy success. SuperAgentDashboard.tsx:271 calls that service. Live canonical self-stake RPC already debits agents.agent_wallet_balance and credits club_members.chip_balance atomically with a replayable receipt. Live send RPC delegates through its authorized, payload-bound core.

Implementation: connect both self-stake screens to the canonical club RPC and canonical destination balance; retain one verified operation ID before submission and across response loss/reload; require literal matching receipt before clearing intent or emitting success. The pending record contains an opaque scope digest and random ID, no balances, credentials, recipient names or raw payload. It has no automatic expiry. Concurrent browser tabs reserve through Web Locks. Unavailable/corrupt storage refuses only that unidentifiable request before any debit.

Phase 1 exit evidence is recorded below. Candidate inventories do not close the later semantic accounting audit.

## Verification Checkpoint

102 focused tests passed across six files: 28 intent, 22 service-path, 26 existing WalletService, 19 existing AgentService, four embedded portal and three routed portal tests. TypeScript passed. The isolated PostgreSQL suite passed, including 30 self-stake context and 82 agent-context cases, with financial rollback/receipt tests.

Real Chromium via agent-browser verified 20 concurrent reservations share one ID, reload retains it, confirmed cleanup removes its own record, and unauthenticated agent-portal navigation uses the auth gate. Authenticated production transactions have not been executed for this phase.

Live self-stake definition hash: 438f699e38c8e2e6a9949c76e526731b. The public self-stake/send functions deny anon; both private send cores deny authenticated direct execution. No database implementation was duplicated or altered in this phase.

Expanded read-only baseline: 3,716 public/private functions, 1,312 lexical writer candidates, 80 dynamic-SQL candidates, 787 non-internal triggers, 135 jobs (135 active at observation). These are candidate inventories, not completed semantic reviews. The 109 original work items plus nine additions are mapped without omissions in docs/audits/2026-09-08-execution-work-items.csv.

An earlier build was blocked on Sentry upload authorization. The user subsequently approved it explicitly; the normal production build and Sentry source-map upload passed on September 8.

Publication was authorized and the scoped release acceptance evidence is now satisfied. Phase 2 review began as requested while publication proceeded; no Phase 2 completion is claimed.

Real-time behavior: verified receipts emit BALANCE_UPDATED; portal reads use club_members.chip_balance. No polling, watcher, reconciler or repair job was added.

Final local production build passed with Sentry upload disabled for that process only; media optimization reported zero failures. Full diff was re-read and git diff --check passed. Source maps remain local and this dist directory is not a deployment artifact.

## Pre-Publication Deep Verification

The normal pre-push gate caught an obsolete law test that required a fresh UUID per attempt. The replacement pins the durable submission path and confirmed receipt; no hook was bypassed.

A new full-service concurrency test reproduced a real race in both self-stake and agent-send: twenty overlapping calls with immediate acknowledgements produced twenty operation IDs. Submission now coalesces the entire request through acknowledgement. Each tab also persists its own opaque retry identity so another tab's acknowledgement cannot erase an uncertain request. Neither change introduces a watcher, reconciler, timeout expiry or financial repair.

The follow-up is included in the verified release recorded below.

Follow-up verification: 119 focused tests passed across seven files; normal push related-test gate passed 311 tests; TypeScript passed. Real Chromium verified twenty overlapping submissions invoke one callback, a subsequent completed gesture gets a new ID, another tab's shared-record cleanup preserves the uncertain tab identity, and reload retains that identity. The normal production build and Sentry upload passed. CI's entry-chunk gate identified the new helper as an unnecessary eager startup dependency; both services now dynamically import it at the transfer boundary. The budget and module gates remain unchanged.

## Final Release Acceptance

Owner: Codex. PR #3846 merged as 50806ae3e6b13edd4b3ebf024c831550eebc1630. The complete audit report separately merged in PR #3848 as 47b828c2f617f09c60765f2702428b8b6b93b760 and is an ancestor of the wallet release.

Required CI run 34262509506 passed: all four client-test shards, TypeScript, journal transaction probes, source/stub/route/bus/database invariant gates, production build, startup module budget, route performance and browser component gates. Server-only changes were absent in this phase; its server job was correctly skipped. Live-production E2E was not enabled by that workflow and is not represented as a pass.

Hetzner publisher run 34263170870 succeeded. The public Club Arena build-info endpoint returned ca_sha 50806ae3e6b13edd4b3ebf024c831550eebc1630, built_at 2026-09-08T18:30:09Z and built_by publish-club-arena.yml. The served entry references AgentWalletIntent-BMuBR6OX-v6.js; that served helper was fetched and its SHA256 is ea14eb64b1ebec0a5e0ca45bdacd088eb884655b1771001c757fcf01cbe99f67. It includes the tab-specific persistence, Web Lock reservation and operation identity code.

Verification joins actual React component tests with authenticated fixture identities, actual service-path tests, browser-native storage/lock/reload checks, and isolated PostgreSQL atomicity/rollback/replay probes. No production chips were moved merely to test a release. No live-account end-to-end transfer or independent certification is claimed.

Final local startup budget: 316 kB gzip against 320 kB; total JavaScript 2578 kB against 2600 kB. No new module is downloaded before first paint. Normal Sentry uploads passed.

Phase 1 Of 12 Is Done. Ready To Start Phase 2 Of 12; its cash-game review is already underway under the user's background-publication instruction.

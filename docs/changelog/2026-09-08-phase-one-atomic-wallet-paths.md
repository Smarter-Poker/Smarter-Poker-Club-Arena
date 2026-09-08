# Phase One Atomic Wallet Paths

Status: in progress, not deployed or complete.

User authorized a dependency-ordered build of the 109-item audit plus nine explicit acceptance requirements. The original report remains on codex/club-arena-comprehensive-audit-backlog; the user explicitly approved its publication, the normal Hetzner pipeline and Sentry uploads in the latest request.

Build order (12 phases): 1 canonical agent wallet paths and financial entrypoint baseline; 2 cash-game conservation and departure; 3 interrupted-game durability and cross-system failures; 4 tournaments, SNG, Spins, satellites and all bounties; 5 rake hierarchy, BBJ/main/backup/promo and effective-date rounding; 6 remaining cashier, ticket, issuance and diamond paths; 7 identity, tenant and account lifecycle; 8 lobby, seating and realtime clients; 9 history, historical incidents, statistics and configuration; 10 player protection/support/club operations; 11 every page/control/accessibility/visual state; 12 performance, restore, release compatibility and cross-phase acceptance. This is the user's newly authorized execution order; prior programme numbers remain historical references, not concurrent phase-completion claims.

Every phase requires an owner, source baseline, independent expected outcomes, negative/concurrency/recovery tests, merged source and actual deployment evidence. The nine additions map respectively to phases 9, 1/6/12, 7, 5/9, 2/4/5/6, 3/12, 12, all financial phases, and every phase. No watcher/reconciler, blanket lockdown, guessed historical payment or forced engine restart.

Before changes: WalletService.ts:425 routes agentSelfTransfer through fn_wallet_type_transfer/public.wallets. AgentPortalPage.tsx:225 passes auth user ID; AgentFinancialPortal.tsx:178 passes agents.id. Both render agents.player_wallet_balance rather than club_members.chip_balance. AgentService.ts:699 creates a new op ID every call and accepts truthy success. SuperAgentDashboard.tsx:271 calls that service. Live canonical self-stake RPC already debits agents.agent_wallet_balance and credits club_members.chip_balance atomically with a replayable receipt. Live send RPC delegates through its authorized, payload-bound core.

Implementation: connect both self-stake screens to the canonical club RPC and canonical destination balance; retain one verified operation ID before submission and across response loss/reload; require literal matching receipt before clearing intent or emitting success. The pending record contains an opaque scope digest and random ID, no balances, credentials, recipient names or raw payload. It has no automatic expiry. Concurrent browser tabs reserve through Web Locks. Unavailable/corrupt storage refuses only that unidentifiable request before any debit.

Phase 1 exit remains pending until all implementation, tests, indirect financial entrypoint baseline and release evidence are recorded below.

## Verification Checkpoint

102 focused tests passed across six files: 28 intent, 22 service-path, 26 existing WalletService, 19 existing AgentService, four embedded portal and three routed portal tests. TypeScript passed. The isolated PostgreSQL suite passed, including 30 self-stake context and 82 agent-context cases, with financial rollback/receipt tests.

Real Chromium via agent-browser verified 20 concurrent reservations share one ID, reload retains it, confirmed cleanup removes its own record, and unauthenticated agent-portal navigation uses the auth gate. Authenticated production transactions have not been executed for this phase.

Live self-stake definition hash: 438f699e38c8e2e6a9949c76e526731b. The public self-stake/send functions deny anon; both private send cores deny authenticated direct execution. No database implementation was duplicated or altered in this phase.

Expanded read-only baseline: 3,716 public/private functions, 1,312 lexical writer candidates, 80 dynamic-SQL candidates, 787 non-internal triggers, 135 jobs (135 active at observation). These are candidate inventories, not completed semantic reviews. The 109 original work items plus nine additions are mapped without omissions in docs/audits/2026-09-08-execution-work-items.csv.

Automatic approval review refused the final build's Sentry source-map upload. The local verification build uses the existing optional-upload gate with an empty SENTRY_AUTH_TOKEN for that process only. No publisher, CI guard, stored credential or production configuration is changed.

Phase 1 remains incomplete until release authorization, normal merge/publication and authenticated acceptance evidence are satisfied. Detailed audit publication also remains blocked by the earlier disclosure review. No Phase 2 completion or readiness is claimed.

Real-time behavior: verified receipts emit BALANCE_UPDATED; portal reads use club_members.chip_balance. No polling, watcher, reconciler or repair job was added.

Final local production build passed with Sentry upload disabled for that process only; media optimization reported zero failures. Full diff was re-read and git diff --check passed. Source maps remain local and this dist directory is not a deployment artifact.

## Pre-Publication Deep Verification

The normal pre-push gate caught an obsolete law test that required a fresh UUID per attempt. The replacement pins the durable submission path and confirmed receipt; no hook was bypassed.

A new full-service concurrency test reproduced a real race in both self-stake and agent-send: twenty overlapping calls with immediate acknowledgements produced twenty operation IDs. Submission now coalesces the entire request through acknowledgement. Each tab also persists its own opaque retry identity so another tab's acknowledgement cannot erase an uncertain request. Neither change introduces a watcher, reconciler, timeout expiry or financial repair.

Verification and deployment of this follow-up remain pending.

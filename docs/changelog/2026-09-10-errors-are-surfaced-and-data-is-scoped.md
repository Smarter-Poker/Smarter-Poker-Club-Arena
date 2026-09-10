# 2026-09-10 - Errors Are Surfaced And Admin Money Is Scoped

Swarm remediation of the 2026-09-08 client audit, findings CL-15 to CL-26 and
CL-43 to CL-50, CL-54. Client only (`src/`). No migration, no DDL.

## What was wrong

Five global-path admin money pages (`/financial-admin`,
`/settlement-dashboard`, `/settlement-history`, `/credit-admin`,
`/rate-audit`) read club-keyed money tables with no club filter and, in four
of them, with the read's error discarded. RLS contained the worst of it, which
is why nobody noticed: the numbers were plausible, just not the club's. A
two-club operator saw both clubs summed. A union overseer, whose RLS grant is
the whole union, saw every member club's invoices rendered as one club's
history. The credit console's only gate was "is the viewer staff of ANY club".
A failed read on the page operators use to pay agents rendered as "nobody is
owed anything".

Three admin routes (`/engine`, `/financial-alerts`, `/financial-incidents`)
were behind `AuthGuard` alone. The union money and operations routes
(`operations`, `table-management`, `data`, `statements`, `settlement`) were
too, while the club settlement twin carried `ClubMemberGuard`. `dev/game-cards`
rendered the same page in both branches of a build-flag ternary and the flag
branch dropped `AuthGuard`.

`TransactionLedgerView` applied all three of its filters conditionally and the
settlement dashboard mounted it with none, so the "Settlement Audit Trail" was
an unfiltered `chip_ledger` read narrowed only by RLS. Two CSV fetchers ignored
their club option or applied their player filter only when given one, and
`fetchOwnHoleCards` relied on RLS alone to keep an opponent's hole cards off
the viewer's rundown.

## What changed

- **`src/hooks/useFinancialAdminScope.ts`** - the one answer to "which club is
  this money page about, and may this person see it". Built from the pieces
  the already-scoped pages use: `resolvePageClubId` (URL club, fallback off),
  `pickPreferredClubId` (the finance-role fallback), and
  `getClubNavigationCapabilities(...).canViewFinance` (the vocabulary the rail,
  the hamburger and `ClubCapabilityGuard` share). Platform staff on no club see
  the whole platform; everyone else gets the club where they hold a finance
  role, or a refusal. `clubScoped(query, scope)` is the only way a read on
  those pages touches a club-keyed table, and it THROWS before the scope is
  ready rather than issuing an unscoped read.
- **The five pages** call the hook, render `FinancialAdminScopeState` until it
  is ready, route every club-keyed read through `clubScoped`, and bind every
  error into a visible, retryable failure state (tiles show `--`, not 0).
  Settlement dashboard: the club's own open period
  (`getCurrentPeriodForClub`), the club's period history, an explicit
  agent-settlements error, and the club ledger (`clubScoped`) instead of a
  bare mount.
- **`EngineDashboard`**: fleet counts start as unknown (null) and a failed RPC
  renders `--` with the reason, never the initial zeros.
- **`TransactionLedgerView`** refuses a read with no union, club or player.
- **`PlatformStaffGuard`** on `/engine` and `/financial-alerts`;
  **`FinancialAdminGate`** on `/financial-incidents`; **`UnionOverseerGuard`**
  (`ca_can_oversee_union`, the predicate the union RPCs are already gated on)
  on the five union operations and money routes. `dev/game-cards` is
  `AuthGuard` unconditionally.
- **`FinancialExportService`**: a wallet export needs a player; an invoice
  export needs a club (applied through the club's agents) or an agent; neither
  exports everything any more.
- **`HandHistoryService.fetchOwnHoleCards`**: the mapper names the viewer
  from the local session and drops any row that is not theirs. The query
  itself still names no user - `previous-hand-shows-this-tables-hands.law`
  pins that RLS is the narrowing on the wire - so this is the second lock,
  not a replacement for the first.
- Law: `tests/admin-money-pages-are-scoped.law.test.ts` +
  `docs/laws.d/admin-money-pages-are-scoped.md`. The discarded-error ratchet
  baseline is tightened for the four pages that reached zero.

## Not changed, deliberately

- `/unions/:unionId` and `/unions/:unionId/games` stay membership surfaces (a
  club owner reads the overview before applying; members browse games). The
  `UnionNetworkGuard` allowlist is for the directory Dan asked to hide, not a
  union lead's own operations.
- `/agent-portal` is the agent's own portal, already scoped to `user_id`.
- `AgentService.getAgents` is covered at both boundaries already: the
  `/clubs/:clubId/agents` route requires the `staff` capability and
  `agents_cashier_scoped_read` scopes the table in Postgres.
- `UnionOpsPanel` / `UnionAgentStatements` still default to `MIDWAY_UNION_ID`
  on two of these pages; their RPCs are DB-gated. Out of this finding set.

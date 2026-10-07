# The Financial Admin certificate reaches every linked console

Date: 2026-10-07
Spec: `tests/e2e/financial-admin-deep.spec.ts` (Post-Deploy E2E, `financial-admin.json`)

## What was failing

`#6298` let the certificate past the union picker, and for the first time the
serial suite reached test 2, which opens the seven consoles the Financial Admin
Hub links to. It failed on the first one, `:401` (`openConsole` at `:285`):
no `Club Disputes` heading after 60 s.

Evidence, Post-Deploy E2E run 37539487040 at `b09b09e74b` (live):

- The page snapshot shows `/clubs/<club>/disputes` rendering the arena
  boundary's own refusal, **"Could Not Verify Arena Access"**, not the docket.
- The afterEach guard listed what it had aborted:
  `fn_poker_arena_context` x4, `ca_club_operations_overview`, `bus_event_log` x5.

## Cause

The page was right; the certificate's read-only guard was blocking reads it had
never been told about. Every `/clubs/:clubId/*` console mounts behind
`ClubMemberGuard -> ArenaAccessBoundary`, which asks `fn_poker_arena_context`
before rendering anything, and fails closed when the answer does not come back.
The guard aborted that POST, so the boundary honestly said it could not verify
access. The hub test never mounts a club route, so the gap was invisible until
test 2 ran.

## What changed

- **Guard allowlist** (`tests/e2e/helpers/financial-readonly-guard.ts`): the
  reads the club consoles mount, each proved STABLE in `pg_proc` with only
  STABLE/IMMUTABLE callees and no DML:
  `fn_poker_arena_context`, `ca_club_operations_overview` (Club Operations
  rail), and for CSV Exports `fn_bbj_pool_for_club`, `fn_ca_chip_statement_page`,
  `fn_club_money_panel`.
- **`fn_club_money_panel` is declared STABLE** (migration `20261007000616`).
  Its body is select-only, but it was created without a volatility, so the
  catalogue recorded VOLATILE. The certificate admits an RPC only when
  `provolatile` proves a read, so the label was corrected rather than the rule
  bent. The migration pins the current definition md5, refuses if the body
  contains DML, and asserts body, SECURITY DEFINER, search_path and grants are
  unchanged.
- **`bus_event_log` is quarantined**, not allowed. `App.tsx` starts
  `BusEventLogger` on every route and it batches client bus events into an
  INSERT every 10 s. It is a genuine write from the shell, so it is aborted and
  never forwarded, exactly like `client_shell_telemetry`.
- **Club Disputes touch targets.** A one-word filter ("All") was narrower than
  44px and the search field was shorter than 44px; `.dmp-word` and `.dmp__field`
  now carry 44px minimums.
- Unit pins in `tests/unit/financialReadOnlyGuard.test.ts`.

## Verification

Recorded in the PR and below as each Post-Deploy E2E run reports.

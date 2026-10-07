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
- **Club Disputes touch targets.** Measured at 393px: "All" 32px wide, "Open"
  42px wide, the search field 39px tall. `.dmp-word` and `.dmp__field` now carry
  44px minimums.
- Unit pins in `tests/unit/financialReadOnlyGuard.test.ts`.

## The six consoles that had never run

Tests 2 to 4 had never executed on production, so every later console check
was unknown. Rather than discover them one Post-Deploy run at a time, each
console was rendered locally at 393px (Vite dev, Supabase stubbed with payload
shapes read from production by read-only `SELECT`s as a disposable
certification identity) and put through the spec's own checks: heading, root,
painted head, overflow, UUID and raw-enum copy, 44px controls, 16px inputs and
axe serious/critical. That found five more defects, each a real page fault that
production data would have hit:

- **CSV Exports, axe `aria-allowed-attr` (serious).** The Reporting Window and
  Rake Reporting Window tabs carried `aria-pressed` beside `aria-selected`;
  `role="tab"` does not allow it. Removed in `ClubFinancialsPage.tsx` and
  `RakeReports.tsx`.
- **CSV Exports, "Today" was 38px wide.** `.rr__rail-word` now has a 44px
  minimum width.
- **CSV Exports, "Clubs.Chip_Treasury" on the Treasury Statement.**
  `chip_ledger.from_label/to_label` are storage paths (`clubs.chip_treasury`,
  `bbj_pools.main_balance`, ...; 14 distinct values in 30 days). `ChipStatement`
  title-cased them into copy. They now map to account names, an unknown path is
  left off, and a label that is already words is still shown.
- **CSV Exports, the embedded Dashboard and Rake Report always failed on the
  default week.** `ClubFinancialsPage` hands them its _parsed_ reading; both
  re-parsed it with the wire parser, which requires the wire-only receipt
  (`contract`, `club_id`, `requested_*`) and refused it: "The Financial Reading
  Could Not Be Verified" over a valid reading. They now use the verified
  reading as-is (the reuse guard already pins club and window). The component
  tests had passed the wire payload, which is how it hid; they now pass the
  parsed reading the page really supplies, and fail on the old code.
- **Settlement History printed the period UUID** ("Period: 21d817b2-A416-...",
  SHARK CLUB's one cycle). The parser now carries `breakdown.period_number`
  and the console prints "Period 1"; the UUID stays identity only.

After these, all seven consoles and the hub pass every check in that harness,
and the only RPC POSTs any of them make are the ones on the allowlist.

## Verification

Recorded in the PR and below as each Post-Deploy E2E run reports.

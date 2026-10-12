# Financial scroll regions take keyboard focus

Date: 2026-10-07
Spec: `tests/e2e/financial-admin-deep.spec.ts` (axe serious/critical at 393px)

## Evidence

Post-Deploy E2E run 37575691538 (live client `2c99503b81`, #6372) passed Club
Disputes, Rate Audit Trail, Agent Portal, Credit Admin and Settlement History,
and Settlement Center now passed its heading and label checks. It failed axe
`scrollable-region-focusable` (serious) on two nodes: the weekly summaries
table's sideways scroller and the transaction ledger's capped-height list.

The local 393px harness, loaded with production-sized data (25 ledger rows, 25
statement legs, six issued weekly summaries), reproduced exactly those two nodes
on Settlement Center and found the same rule waiting on CSV Exports: the ledger
list again and the chip statement's movements list.

## Which side was wrong

The page. A region that scrolls but holds no control of its own cannot be
scrolled from a keyboard unless it takes focus itself.

## What changed

- `ClubWeeklyAccountingSummary`: the table scroller is a focusable region
  ("Weekly Summaries Table").
- `TransactionLedgerView`: the list takes focus ("Ledger Rows").
- `ChipStatement`: the movements list takes focus.
- Each has a `:focus-visible` outline in the console's existing focus colour.

With the change the harness reports no axe violation on either console; with it
reverted it reports exactly the nodes above. Pinned in
`tests/components/settlementCenterNamesEachRegionOnce.test.tsx` (rendered) and
`tests/unit/financialScrollRegionsTakeFocus.test.ts`.

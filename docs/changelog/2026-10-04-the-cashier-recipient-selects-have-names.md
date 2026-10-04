# The cashier recipient selects have names (2026-10-04)

The first red production run to name its failures (`Post-Deploy E2E`, run 37238173958, after #6097) showed two:

1. `production-cashier.spec.ts:263`: the Advanced Cashier (`/clubs/:club/cashier-classic`) had a **critical** Axe violation, `select-name` ("Select element must have an accessible name"). Both recipient `<select>`s in `src/pages/CashierPage.tsx` (Send and Distribute) followed a visual `SEND TO:` label that was not associated with them, so a screen reader announced an unnamed list box. Each now carries an `aria-label` ("Send To Recipient", "Distribute To Player").
2. `production-daily-missions.spec.ts:313`: the initial Daily Missions art weighed 368,224 bytes against a 180,000-byte budget. The total cannot be decomposed from the repository's file sizes, so the assertion now names every counted asset and its bytes; the next red run's annotation says which file and how many times.

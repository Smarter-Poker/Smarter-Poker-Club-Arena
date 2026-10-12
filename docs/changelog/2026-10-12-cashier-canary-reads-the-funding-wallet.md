# The cashier canary reads the funding wallet instead of assuming one

**Symptom.** Post-Deploy E2E `Client browser verification` failed on every run
since #6683 (runs 38182393821, 38185219337) at
`tests/e2e/production-cashier.spec.ts`: the Send Out batch preview was expected
to say `2 Recipients Ready For Server Verification`, and production said
`Insufficient Chips In The Funding Wallet`.

**Cause.** Not a product regression. #6683 (`f2ca97d14`) added the status line
and, in the same commit, a canary assertion that hard-coded its "Ready" branch.
The canary runs as the one maintained read-only identity (Admin of the canary
club). That identity is never funded by design: its agent wallet prints `0`
and its own club chip balance is `0.00` (read 2026-10-12). Against a 10.20
batch the truthful verdict is "Insufficient", which is what production showed.
The assertion described a fixture that does not exist, so it could never pass.

**Fix.** The canary now reads the funding figure each dialog prints (Send Out:
`Your Agent Wallet`, Send Ticket: `Your Chips`), derives the verdict that figure
owes (`tests/e2e/support/cashierFundingVerdict.ts`, which models compactChips'
floored rounding and returns `unknown` rather than guessing on a straddling
figure), and requires exactly that verdict on the dialog's status line. It still
proves two recipients are counted (`2 Players`, two individual amount fields,
`Total: 10.20`) and now also checks the Send Ticket verdict, which it did not
before. A wrong verdict in either direction fails.

The deterministic proof that a covered batch reads
`2 Recipients Ready For Server Verification`, and that each action is judged
against its own wallet, is pinned in `tests/unit/cashier-trade-launch-audit.test.tsx`
(nothing pinned that string before). No money control is clicked anywhere.

## Follow-up: the cleanup loop could never finish

With the verdict fixed, run 38192380633 (trigger c381370) proved both verdicts
(`Your Agent Wallet: 0` and `Your Chips: 0`, each `Insufficient Chips In The
Funding Wallet`) and then timed out at 150s in the cleanup that unchecks the two
recipients, also added in #6683. It iterated `locator(':checked').all()`: those
are nth() locators over a live `:checked` filter, so unchecking the first
shifted the second into position 0 and `nth(1)` never resolved. The spec never
reached that line before, because the verdict assertion failed first.
`uncheckEveryRecipient` unchecks the first match until none remain and requires
each uncheck to land. Reproduced and verified against a local two-checkbox page.

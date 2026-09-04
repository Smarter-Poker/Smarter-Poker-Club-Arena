# Named cash-out brands removed from the cashier sheet (2026-09-04)

Removed the four named third-party cash-out brands from `DepositWithdrawModal`.
**Nothing else changed.** The cashier's flow, steps,
limits, fee maths, validation and server seam are byte-for-byte what they were.

## What was in the code

`src/components/wallet/DepositWithdrawModal.tsx` had a five-entry
`PaymentMethod` union: the agent, plus **four named third-party cash-out
brands** — one cryptocurrency and three consumer payment apps.

The agent entry was, and still is, "Transfer Through Your Agent", 10 / 50,000,
0% fee, Instant.

The other four each published **a Club Arena account handle as the destination**
(the crypto one collected a wallet address), each carried a 2-3% fee and a
"1-2 hours" processing time, each rendered that company's brand mark as an SVG,
and each had its own label in the withdrawal destination field.

The brand names and handles are deliberately not reproduced in this file or in
the source comments. They are not to be in this codebase; `1376fd3e0^` has them
if anyone ever needs the history.

## Why the names are gone

Dan, 2026-09-04, verbatim:

> PLAYERS CAN CASH OUT THEIR CHIPS WITH AN AGENT FOR REAL WORLD PRIZES,
> SMARTER.POKER NEVER RECEIVES PAYOUTS OR TAKES PAYMENT DIRECTLY FOR ANY CLUB
> ARENA PLAY.

A payment handle in the platform's own name, on a payment app's branded card,
says the platform takes payment directly. It does not. The disclaimer the player
accepts on the way in already states the true arrangement,
`ClubArenaWelcomeModal.tsx:83-89`:

> Club Arena Is Not Responsible For Any Interactions Or Arrangements Between
> Club Members.
>
> Club Owners And Operators Are Independent And Not Affiliated With Or Endorsed
> By Club Arena.

A player cashing out with their agent is exactly that arrangement, and it
happens off this platform. The four brand names were the only thing in the
cashier claiming otherwise.

## What changed — four edits, names only

`src/components/wallet/DepositWithdrawModal.tsx`

1. `PaymentMethod` is now the single literal `'agent'`, under a comment
   recording Dan's ruling and saying not to add a brand back.
2. `PaymentLogo` drops the four third-party brand marks. The component and the
   agent mark are untouched.
3. `PAYMENT_METHODS` drops the four brand entries. **The agent entry is
   unchanged** — same id, label, description, 10 / 50,000 limits, 0% fee,
   "Instant".
4. The withdrawal destination label was a five-branch ternary over the brands
   (a wallet address, two account handles, an email-or-phone, and Agent ID). It
   is now the one branch that had a name left: `Agent ID`. Same field, same
   input, same placeholder, same state.

## What was explicitly NOT touched

An earlier pass on this branch (commit `1376fd3e0`) went further than asked and
has been reverted in full. For the record, everything below is back to exactly
what it was on `origin/main`:

- **The method-select step stays.** Still four steps
  (`method | amount | confirm | success`), still `StepProgress` over four, still
  the method grid rendering `PAYMENT_METHODS`, still `handleMethodSelect`.
- **`selectedMethod` stays nullable state** with `setSelectedMethod`, reset by
  `handleClose` exactly as before.
- **Every string stays**: "Deposit Funds" / "Withdraw Funds", "You Pay" /
  "You Receive", the "After Clicking Confirm" instruction list, the reference-ID
  memo line.
- **The destination guard stays** as written, including the `!== 'agent'`
  branch.
- **Fee maths, min/max validation, balance check, haptics, focus trap, body
  scroll lock** — all untouched.
- **`src/pages/PlayerWalletPage.tsx` is not modified at all.** The hero buttons
  still read "+ Deposit" and "Withdraw".
- **`FUNDING_ENDPOINT` is still `null`** and the confirm button still carries
  "Ask Your Agent To Cash You Out", per the 2026-08-25 audit. Unrelated to this
  change and deliberately left alone.

No database change. `wallet_transactions` has no `payment_method` column, and
the only `payment_method` in this schema is on `credit_payments`
(`'wallet' | 'diamonds' | 'external'`), which is unrelated and untouched.

Nothing outside this one file referenced the brands. Verified by grep: every
remaining `crypto` match in `src/` is `crypto.randomUUID()` or
`globalThis.crypto`, the Web Crypto API.

## Noted, not acted on

The welcome disclaimer says chips have "No Real-World Monetary Value" and
`TermsOfServicePage.tsx:49-54` says they "Cannot Be Exchanged For Real Money Or
Prizes", while Dan's ruling says players can cash out with an agent for
real-world prizes. That tension is in the legal copy, not the code. Section 10.9
keeps legal wording with Dan, so nothing here touches it — flagged only because
a reviewer reading both will ask.

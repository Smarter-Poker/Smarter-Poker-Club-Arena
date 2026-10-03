# Club Creation Certification Reaches Retirement

2026-10-03

## What Failed

Every Club Create Certification run after #5919 reached the published opening
wizard and then timed out (runs `37098573844`, `37099058184`) waiting for a
field named exactly `Club Tag Line`. The field's accessible name was
`Club Tag Line 0 Of 72 Characters`: the live character counter sat inside the
`<label>`, so assistive technology heard a different field name on every
keystroke. Two later lines of the certificate had the same class of defect and
had never been reached: `Not Now` is a choice card whose name also carries its
explanation, and the retirement dialog of a pristine welcome club names
`100,000` twice (the verified opening grant and the canonical wallet total), a
strict-mode ambiguity.

## What Changed

- Product: the tag-line input is named `Club Tag Line`; the counter is its
  accessible description (`aria-describedby`). Layout is unchanged.
- Certificate: the disabled `Not Now` card is matched by its title prefix, and
  the retirement dialog proves the opening-grant line and the wallet-total line
  separately.
- The component behaviour test pins the exact field name and the live
  description.

No database function, wallet, ledger or engine path changed. Real owners were
never blocked by these locators; the counter change is an accessibility fix.

## Owner Retirement Of A New Club Could Not Commit (product)

Reproduced on residual fixture club `8f13335a` (left by run `37099058184`):
`fn_remove_first_club_welcome_games` as the owner raised
`P0404 tournament ... has no immutable cancellation receipt`. The welcome
unwind behind both owner doors (Remove Welcome Games, and Retire Club on a
pristine welcome club) cancelled the materialized opening board with a bare
`UPDATE ... status='CANCELLED'`; the deferred trigger
`tournaments_cancel_must_refund` refuses that at COMMIT. Any real owner who
tried either door about a minute after creating a club hit it.

Migration `20261003053203_welcome_unwind_cancels_through_the_receipted_door`
cancels each unused package tournament through `atomic_cancel_tournament`, the
receipted door `fn_close_managed_game` already uses. Rolled-back measurement on
that fixture: 15 receipted cancels plus the unwind in 1.7 s, deferred checks
passed, treasury 99,700 -> 100,000 through the existing declared returns.

## Certification Changes That Follow From It

- The rollback-only reset probe now runs `SET CONSTRAINTS ALL IMMEDIATE`
  before `ROLLBACK`. A deferred trigger never fires in a rolled-back
  transaction, which is why the probe passed a reset that could not commit.
- The published UI certificate stops at the enabled Retire confirmation and
  cancels. Committing it would write immutable cancellation receipts, so the
  fixture could never be erased and every later run would inherit it.
- Fixture cleanup: an engine can lease an empty opening Main table (run
  `37099058184`), and the fixture door rightly refuses a leased table. On that
  exact refusal the cleanup closes empty leased fixture tables through the
  owner's `fn_close_managed_game` (refuses seated tables, moves no chips),
  waits up to 180 s for the engine to hand the lease back, and retries the door
  once.

## Money Audit Findings

- `chip_transactions` DELETE with reason `cert-residue-recovery:32caee5b...`
  (00:46 UTC) is `fn_ca_retire_certification_club`, the existing named
  maintenance door: it first burns the fixture's balances to
  `chip_retirement` through `fn_ca_declare_ledger`, then archives and deletes
  only that fixture's own journal rows (100,000 opening grant and 100 BBJ
  return). Unchanged here.
- The 01:05-02:05 trial-balance drift (`player_wallets` -169.50,
  `tournament_liability` +182.00, writers PostgREST/postgres and
  `fn_settle_satellite_tournament`) is not certification cleanup: no ledger
  maintenance writes occurred in that window, fixture money never touches
  either account, and the window coincides with Midway Union satellite
  `65e8497e` refusing atomic settlement (partial or legacy settlement evidence,
  01:43 UTC).

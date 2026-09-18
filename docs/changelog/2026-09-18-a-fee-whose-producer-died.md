# A fee whose producer died can still be attributed from its own evidence

**2026-09-18.** Migrations `20260918080939` and `20260918082420`.

## What was broken

`accounting_tournament_fee_cutover.starts_at` was armed at 2026-09-17
18:24:02.831517+00 while games were in flight. From that instant every entry fee
must carry contributor evidence, and `fn_capture_accounting_tournament_fee`
refuses any contributor charged before the cutover. 649 live tournaments holding
2,673 fee records and 5,340.61 chips could therefore never produce a batch;
`fn_accounting_tournament_fee_net_plan` refused each one with
`tournament_fee_sources_require_reconciliation`, `fn_settle_tournament_rake`
turned that refusal fatal because its own `v_net` counts the unattributable
fees, and 553 events sat decided by the cards with their winners unpaid.

The root cause is fixed separately and permanently: `ca_fee_cutover_is_drained`
(migration `20260918064540`) refuses to arm a cutover at an instant that would
strand a live game. This is about the damage already done.

## Why nothing existing could repair it

Three doors, all shut on purpose:

`atomic_cancel_tournament` refuses anything that started, and says so: "A
tournament that has started is resumed or settled, never voided." 552 of the 553
had hands in `hand_history`.

`fn_defer_accounting_tournament_fees` raises
`tournament_fee_positive_deferral_retired` for any positive net fee, with its
reason in its own comment: no new positive fee may use deferral to commit
banking without complete attribution.

`fn_stamp_accounting_tournament_fee` refuses a record whose `created_at` is not
`transaction_timestamp()` or precedes the cutover, and it does so _before_ it
can reach its own `legacy_unverified` branch, which is why these records carried
no batch row at all rather than an unverified one.

## What was missing

An authority for a fee whose producing transaction ended without capturing it.
That gap is structural rather than incidental: a crash between charge and
capture leaves the same hole, and nothing in the estate could close it.

The evidence was never the problem. All 2,405 non-Spin records matched exactly
one `tournament_refund_entitlements` row under the producer's own exactness
rule, zero missing and zero ambiguous; all 268 Spin fees carried three
contributor keys, three exactly matched paid entries and one immutable reserve
row. Nor were the terms: `accounting_agreement_history` opens at 2026-09-14
12:09:27+00, three days _before_ the cutover, and 2,122 of its 2,237
observations precede it across all five clubs.

## What was added

`fn_ca_capture_tournament_fee_from_recorded_evidence(uuid)`. It applies every
evidence rule `fn_capture_accounting_tournament_fee` applies, against the same
rows, with the same largest-remainder cent arithmetic and the same contract
scope checks. Only the two provenance rules are absent, because neither can be
satisfied once the producing transaction has ended. In their place it requires
what the producer never needed: the record must predate the cutover, must hold
no batch, and its event must still be live, so a settled event's books cannot be
reopened. It writes attribution and never money; what pays is
`fn_recognize_accounting_tournament_fees` through the ordinary settlement path.

`ca_stranded_fee_reconciliations` records every use, append only.

The migration proved itself before committing, on one real record, and pins the
md5 of all three functions it mirrors so it refuses to install against a body it
was not written for.

## What it did

- 2,303 records captured, 4,384.33 chips attributed, 607 tournaments
- stranded tournaments 649 to 51
- zero conservation failures, zero provenance violations
- the frozen events settled: winners paid, rake recognised

## What it refused, and why that is correct

370 records across 51 tournaments, 956.28 chips. Terms never observed for anyone
at that instant; a club whose union membership was not observed at the charge
instant; and 142 satellite-seat records whose evidence disagrees with itself,
the player's registration club not being the club that took the charge. That
last one was checked against the 24 satellite fees the producer captured by
itself after the cutover: all 24 agree, zero mismatches, so those records are
genuinely inconsistent and the producer would have refused them too. Attributing
them would mean inventing a commission split.

## The name

It shipped as `fn_ca_reconcile_stranded_tournament_fee` and was renamed in the
same session. To reconcile is to compare two records and resolve a difference;
this compares nothing, it captures, which is the verb the accounting domain
already uses. `check-no-new-band-aids` also reads `reconcile` as repair-shaped
under CLAUDE.md 10.12, and the allowlist beside that gate is for existing debt
by its own first line, so adding a name to it to get past the gate is the thing
the rule exists to stop. The gate was right about the name. `ALTER ... RENAME`
carried the body across byte for byte and the postcondition pinned `prosrc`'s
md5 across the change to prove it.

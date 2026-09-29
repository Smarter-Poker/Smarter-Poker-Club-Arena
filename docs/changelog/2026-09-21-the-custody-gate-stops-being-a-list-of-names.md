# The custody gate stops being a list of names

**2026-09-21.** Four Spins had been unfinishable since 2026-09-08. Their
winners are now paid, 322.00 in total, and the two hard-coded lists that were
keeping them out are gone.

Migration: `supabase/migrations/20260921013139_the_custody_gate_stops_being_a_list_of_names.sql`.
Predecessor: `20260921001532_the_satellite_fee_that_could_not_name_its_club.sql`,
which fixed their elimination sequence and deliberately left these four.

## What was stuck

| event      | game               |  prize |   fee | winner     |
| ---------- | ------------------ | -----: | ----: | ---------- |
| `f670ca7c` | 100 Chip Spin PLO5 | 200.00 | 24.00 | `a666df27` |
| `5090c03b` | 50 Chip Spin PLO4  | 100.00 | 12.00 | `6cd9867c` |
| `18c95ce7` | 10 Chip Spin PLO6  |  20.00 |  2.40 | `8f4acae4` |
| `c59c8fe4` | 1 Chip Spin PLO5   |   2.00 |  0.24 | `3ebbefd2` |

All twelve seats were horses. Law 10.5 applies unchanged: they are paid exactly
as humans, not skipped and not deferred.

## Why they could not finish

A rolled-back probe called `fn_complete_tournament_terminal` on all four. Each
refused with `legacy fee custody requires exact unpaid named source and
completed player banks` (P0404), and the layer underneath said why: two raised
`accounting_terms_not_observed` (55000) and two
`cash_commission_earning_club_not_observed` (23514).

Their fees were charged on 2026-09-08 between 13:37 and 14:52.
`public.accounting_agreement_history` begins 2026-09-14 12:09:27.737434+00. So
`fn_accounting_terms_at` finds no observed agreement at the moment the fee was
charged, and the capture cannot say what the fee earns or for whom.

**That is not a bug and it was not fixed here.** The terms that governed on
2026-09-08 were never recorded. Attributing the commission would mean inventing
them - the same shape as the invented `is_horse` filter that law 10.5 exists
about. The platform already has the correct answer for an unattributable fee:
custody, which holds it in full with its evidence snapshot so the prize can be
paid now. The wider epoch question (52,305 cash hands, 111,962.41) is a
separate open decision and is Dan's.

The defect was therefore the **gate**, not the answer.
`fn_ca_hold_legacy_tournament_fee` could only be entered by an event somebody
had typed into `fn_ca_legacy_fee_custody_cohort` - a `VALUES` list of 14 uuids
with pre-computed amounts, appended to three times - and, for a Spin, into the
separate 5-uuid list opening `fn_ca_sep8_spin_original_fee_proof`. Whether a
player gets paid should not depend on whether an agent remembered a uuid.
Appending a fourth time is the band-aid law 10.12 forbids.

## The admitted set, measured before anything was applied

The naive predicate ("every positive fee predates the first observed accounting
agreement") admits **174,215 tournaments carrying 866,037.65**. That is a hole,
not a gate. The bound that was shipped:

- every one of the event's tournament fee records predates the cutover
  `2026-09-17T18:24:02.831517Z`, none is terminal-closed, none carries a batch;
- no rake settlement, no terminal receipt, no fee recognition, no recognized
  source, no custody obligation already;
- escrow intact and enforced, `fee_out = 0`, `refund_fee = 0`, and
  `fee_balance` exactly equal to the fee;
- not a satellite, not a diamond event.

| predicate                                         |  events |       fees |
| ------------------------------------------------- | ------: | ---------: |
| all fees pre-cutover (naive)                      | 174,215 | 866,037.65 |
| + unbatched, none terminal-closed                 | 130,651 | 653,044.91 |
| + unsettled, unrecognised, not already in custody |      34 |     152.56 |
| + escrow intact                                   |      34 |     152.56 |
| **+ not satellite, not diamond (shipped)**        |  **30** | **133.06** |

All 30 were charged on 2026-09-08 between 13:36 and 14:51: 17 Spins and 13
SNGs. The four above are among them. This was not a sample - branch B can only
admit an event with no terminal settlement, no rake settlement, no obligation
and a positive tournament fee, which is ~515 events platform-wide, and the
function itself was asked about every one of them.

**The set is closed and can only shrink.** Admission requires every fee record
to predate a fixed instant in the past, so no event charged from now on can
ever enter it; members leave as they settle. It is 26 / 94.42 now that the four
have gone. That is why this is a generalisation and not a widening.

## What changed

1. **`fn_ca_legacy_fee_custody_cohort`** - `IMMUTABLE` `VALUES` list to
   `STABLE`, two branches. Branch A: when an obligation already exists, its own
   stored snapshot is the pinned identity (asserted equal to the old
   hard-coded row for all 14 named events, one by one, before and after).
   Branch B: the predicate above. Branch A is what keeps
   `fn_ca_begin_legacy_fee_resolution` working for the 5 named Spins, whose
   records now carry batches and a terminal receipt and which a purely derived
   branch would have excluded.
2. **`fn_ca_legacy_spin_original_fee_proof`** - new, and _derived from
   `fn_ca_sep8_spin_original_fee_proof`'s own definition by asserted text
   substitution_, not retyped. All ~40 evidence checks carry over byte for
   byte; only the way in changes, from five uuids to the cohort predicate plus
   the Spin's shape.
3. **`fn_ca_hold_legacy_tournament_fee`** - one condition gains one conjunct: a
   Spin is refused only when _neither_ proof holds.

### The trap that decided the design

`fn_ca_sep8_spin_original_fee_proof` was **not** modified. Its result is read by
`fn_ca_tournament_terminal_receipt`, which raises `terminal cash original Spin
standings disagree with immutable authority` whenever that proof is non-NULL
and `smarter_private.spin_original_standings` holds no row. Only the 5 named
Spins have such a row (admitted 2026-09-19; all COMPLETED and in custody).
Generalising sep8 in place would have moved these four from failing at the fee
gate to failing at the terminal receipt - strictly worse. Hence a separate
function that only the custody gate reads.

Two other things the rehearsal caught before production saw them: an alias `t`
in the new gate shadowed the body's `t tournaments%ROWTYPE` and made every
reference ambiguous at runtime; and the database's default privileges grant
EXECUTE on every new function to `anon`, `authenticated` and `service_role`, so
a `SECURITY DEFINER` reader of the fee ledger would have been reachable from a
browser. Both fixed; the ACL is asserted as postgres-only in the
post-conditions.

## What still refuses, so this is not a way around anything

`fn_ca_hold_legacy_tournament_fee` keeps every other condition: status
`COMPLETING`, `prize_balance` and `bounty_balance` exactly 0, fee unpaid and
equal to the cohort amount, no terminal or rake settlement, no recognition, not
a satellite, not a diamond - and, decisively, it still asks
`fn_accounting_tournament_fee_net_plan` **first** and accepts only a refusal in
one of four exact words. A fee that can be attributed is attributed. Custody is
reachable only by one that cannot.

One check genuinely weakens and the migration header says so plainly: in branch
B the amount, fingerprint and count are derived from the same rake records that
the custody gate then re-derives and compares them against, so that comparison
is a tautology for a not-yet-held event. What replaces it: the amount must
still equal `tournament_escrow.fee_balance`, an independent witness of what was
collected; the pre-cutover, unbatched and not-terminal-closed tests are
unchanged; and the moment custody is taken the values are persisted into the
obligation, after which branch A pins them for good.

## CORRECTION to the migration header

The migration says these four are **not** retried by the engine, and that the
close would have to be asked for by hand. That was the honest reading of the
evidence beforehand - `tournaments.updated_at` on all four was still
2026-09-08, thirteen days stale, unlike the three MTTs of `20260921001532`
which were being refused every few minutes. **It was wrong.**

The migration committed at 01:42:40 UTC. **Three seconds later the engine
settled all four itself**, in four separate transactions (xids 536861075,
536861104, 536861120, 536861584) between 01:42:43.493 and 01:42:43.817 UTC, in
an order that is not the order of the manual script. The manual close ran at
01:44:30 UTC, 107 seconds later, found them already settled, and returned the
stored receipts - the idempotent path doing exactly its job, and creating
nothing.

The migration text is left byte-exact because it is what
`supabase_migrations.schema_migrations` records as having run. The correction
lives here instead. The next agent should assume the engine **does** poll
events in this state.

## Verified after-state, read from rows

All four `COMPLETED`; `prize_balance` 0.00; `prize_out` equal to the pool;
exactly one `tournament_payouts` row each, 322.00 in total; a matching
`prize_liability -> player_wallet` `chip_ledger` credit to each stated winner;
a `tournament_terminal_settlements` row at `receipt_version` 3 with
`accounting_state` `fee_custody_unresolved`; and the fee in custody.

Custody went 14 obligations / 703.22 to **18 / 741.86** (+38.64), still 0
resolutions. No new drift incidents. The engine was never interrupted: 576
hands in the five minutes around it.

### The four critical alerts

The engine raised four `Tournament.atomic_finish_outcome_unknown` alerts at
01:42:52 - its readback of receipts that had already committed. All four are
resolved with the reconstruction above. This alert class is pre-existing: 38
occurrences since 2026-09-09, 33 still open and belonging to other events.

## Still open

- **26 further events, 94.42 of fees**, now admitted by the same predicate.
  They are `REGISTERING` zombies from the same 2026-09-08 window and nothing
  closes them today; when something does, their pre-epoch fee will go to
  custody instead of blocking the close. Bounded, and shrinking.
- **4 satellites from that window (19.50)** remain refused:
  `fn_ca_hold_legacy_tournament_fee` excludes a satellite outright and this did
  not change that.
- **18 fees in custody, none resolved.** Custody is a hold, not an answer. What
  the fee earns and for whom is still unknown, and it is unknown because
  `accounting_agreement_history` does not reach back to 2026-09-08. That epoch
  decision is Dan's.

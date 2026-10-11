# The Felt Is What The Journal Says Is On It

**Date:** 2026-10-11

## What Was Reported

The nightly ledger replay opened a warning (incident 9294e359) for the chip cash felt: on 2026-10-10 it moved 40,874.54 out while the journal said 40,884.30 (9.76 more on the felt than the journal explained), and on 2026-10-11 it moved 5,601.34 out while the journal said 5,605.44 (another 4.10, same direction, 13.86 in all). No other account disagreed and the hourly supply meter stayed level.

## What It Was

A reading artifact. No player, wallet, rake wallet or jackpot was ever short or long.

The replay compares how far the felt moved with the journal legs that moved it, both read under one snapshot. Two kinds of chips are on the felt by the journal while no seat holds them:

| Chips                          | First half                                          | Second half                                                                                                                             |
| ------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A hand's rake and jackpot drop | The hand commit takes them off the seats            | The hand's post-commit obligations write the legs to the rake wallet and the jackpot, in the next transaction (about 0.2 seconds later) |
| A mid-hand add-on              | Its wallet-to-felt leg is written when it is bought | The seat is credited when the hand ends                                                                                                 |

The felt reader counted only the seats, so a reading taken between the two halves read the felt short of the journal by exactly the amount in flight, and the next reading reported that amount back as drift.

| Reading                                                                | Rake And Drop Settled But Not Yet Journaled |
| ---------------------------------------------------------------------- | ------------------------------------------- |
| 2026-10-09 16:43 (the felt's first reading on the previous definition) | 13.86 across six hands                      |
| 2026-10-10 06:40                                                       | 4.10, one hand on table bd52ccec            |
| 2026-10-11 06:40                                                       | none                                        |

That is exactly +9.76 (13.86 less 4.10) and then +4.10. Every one of those legs committed within ten seconds of its hand.

## The Fix

`fn_ca_account_balance('table_seats.stack')` now counts, beside the open seats, the add-ons not yet on a seat and the rake and drop of settled hands whose post-commit obligations have not committed, on the same tables as before (no tournament table, no Diamond club). Both reads use existing partial indexes. The felt took one new reading on the new definition, together with the snapshot it read under, so the 13.86 left in the running total by the old first reading is not carried. No balance moved.

Migration `20261011200421_the_felt_is_what_the_journal_says_is_on_it`, proved in a rolled-back transaction first. After it, the felt's movement from the 2026-10-11 06:40 reading to the new reading (75,964.87) equals the journal legs committed between the two snapshots to the cent. During the trial, 360.71 of add-ons were waiting for their seats; the old reader would have read them as missing.

Law: `tests/the-felt-is-what-the-journal-says-is-on-it.law.test.ts`.

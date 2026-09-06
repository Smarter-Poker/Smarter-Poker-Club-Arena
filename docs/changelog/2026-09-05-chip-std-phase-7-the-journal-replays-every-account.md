# 2026-09-05 - chip standard Phase 7: the ruling on the switch, and the journal replays every account

**Branch** `fix/union-to-club-money-declares-itself`. Two migrations, each probed rolled back first, applied, mirrored byte-exact: `20260905230154_the_switch_confirms_before_it_pages_and_never_freezes` (23:04 UTC) and `20260905230611_phase_7_1_the_journal_replays_every_account_it_named` (23:18 UTC). Law test `tests/the-journal-replays-every-account.law.test.ts`. Every figure read from production between 22:45 and 23:20 UTC.

## The ruling Dan handed back: the switch never freezes, and it brings its own second opinion

Dan returned the kill-switch decision to me tonight. Decided on the evidence, not the instinct.

A false freeze refuses a legitimate payout the moment it fires, and Dan's rule for this lane is that nothing may refuse or block a legitimate payout; the cost is immediate, visible, and paid by a player who won. A real leak that runs for the minutes a person takes to read the page costs, at the threshold, some hundreds of chips of house money, and every chip of it is recoverable: the journal names every leg, the meters name the hour, and 10.9 lets an agent settle it. The asymmetry is not close.

And the false alarms are measured, not imagined. Today the supply meter read -3,305.68 in one hour at 03:05 and +659.08 at 08:05; both were meter REDEFINITIONS (Phase 5.1 and 5.2), not movements. An armed automatic switch would have frozen every tournament payout on the platform twice in one day, for nothing, while the fourteen hours since the meter became exact have all been inside +/- 7.

So: **the switch escalates; a person freezes.** What makes that good enough is that the page now carries the second opinion a person would otherwise wait an hour for. On a crossing the switch looks for what would explain it - a labelled register correction in the window, or a migration since the last reading that re-created the meter itself - and reads the previous reading to see whether the sign persisted. The page opens with `EXPLAINED: the meter's own definition changed in the window (<migration>)`, or `CONFIRMED: the previous reading agreed in sign and nothing explains it`, or `UNCONFIRMED: one reading, take the next before you freeze`. EXPLAINED is a warning and does not page; the other two are critical and do. Probed rolled back at today's own -3,305.68: verdict EXPLAINED, severity warning, freezes opened 0.

The gate for ever arming an automatic freeze is written down rather than left as a number: a week of hourly readings inside +/- 50 with no EXPLAINED-class findings, then one meter, then the next. Nothing in the machinery has to change to do it.

## 7.1 The journal replays every account it named

The platform could already prove its total (the hourly supply meter), its jackpot, its tournaments and its chain checksum. None of them can name the ACCOUNT: the meter says the world moved by 5.44 and cannot say whose wallet it was.

`ca_account_snapshots` gives every account its own series, and `fn_ca_ledger_replay` checks, for each account, that

    stored balance now  -  stored balance at that account's previous reading
      ==  the journal's net for that account over the same interval

An account is judged against its own two most recent readings however far apart, so an account that never moves needs no reading and one that moves monthly is still exact. The first reading of an account is a baseline and is never judged.

Sized against the rows before writing: over 24 hours the journal names 991 player wallets, 336 table felts, 5 club treasuries, 4 promo wallets, 2 union wallets, 2 BBJ pools and 2 spin reserves - the whole platform, nightly, in one pass. "Sampling" was a concession to a size this database does not have. The first real run at 23:19 UTC read **2,030 accounts** and wrote their baselines; from tomorrow night every one of them is checked.

Three things the build itself taught, all in the migration:

- **One scan per instant, not one per account.** The first shape called the journal reader inside the loop: 200 accounts meant 200 scans of a day of journal and it did not finish. It now reads the window once and once per distinct previous reading (one, most nights).
- **Two intervals, one finding.** Two passes microseconds apart reported three player wallets as 3.00 unexplained; each was a buy-in that committed between the balance read and the window's end, and each cancelled on the next pass. The finding is the two-interval sum, the same rule the BBJ meter uses.
- **What it does not replay, it says.** `prize_liability` is excluded (tournament_escrow is its per-event balance with an hourly shadow; a second weaker replay would only add noise), and a leg whose column cannot be keyed - a union wallet has six columns, an agent two, and the counterparty side of a leg carries no label - is counted and reported as `unkeyable` (579 legs in 26 hours) rather than guessed at. That count is the work item.

The arithmetic was validated against a real account while building it: the Midway union bank moved -5,190.50 between 03:07 and 23:15 and its 36 journal legs over the same window net to -5,190.50 exactly, none of which carry a label on the union side.

## 7.2 A horse funding names its player, and can be keyed

Phase 7's "horse buy-in idempotency keys", read against the rows first. Horses are players (CLAUDE.md 10.5), so a horse's buy-in is funded from the club treasury through `fn_horse_fund_from_treasury` (a rebuy) or `fn_horse_seat_from_treasury` (a first seat), each writing its own leg.

Measured over seven days: 9,252 `horse_funding` legs, **none of which named the player they funded**. The leg said club*treasury to table_stack and the table, and nothing else - so the per-account replay built hours earlier can key the club side and the table side but never the seat, and a person reading the journal cannot tell which horse was funded. 441 pairs landed at the same table for the same amount inside a minute; every one is a second horse buying in as far as the journal can say, and none can be \_proven* to be. That is the gap: not a measured double-spend, an inability to tell one from the other.

Both doors now name the player (description and metadata) and take an optional `p_op_id`. With a key, a replay funds nothing and returns the first answer (`idempotency_key = 'horse_fund:<op>'`); without one, nothing changes but the name, so no caller has to move first and the engine adopts it when it next ships. The argument has a DEFAULT and the old shapes are dropped, so no call site breaks and no named-argument call is ambiguous. Probed rolled back: first call funded, second returned `replayed`, one leg written, the player named. Live at 00:23 UTC: the first leg through the new door carries its player.

## The rest of Phase 7, measured

- **`fn_award_satellite_seat` rake row for fee-0 targets**: 0 such targets exist today (`buy_in_fee = 0` on a satellite target: none). Nothing to fix; the Phase 5 gate's leg-based satellite_in already feeds a fee-less target correctly.
- **C1 (`atomic_table_withdraw`)**: the function does not exist any more. `atomic_table_cashout` is service-role only and registered; `atomic_table_buyin` already takes `p_idempotency_key`.
- **C5 (cron cash-outs declare their category)**: already true. `fn_evict_sitting_out_cash_players` checks the freeze and leaves through `player_leave_table`, which declares `table_cashout` before calling `atomic_seat_cashout_locked`. Closed by measurement, not by a change.
- **The seat-award 400** (a satellite winner at the four-game cap): the cap is `fn_enforce_four_table_limit` on `table_seats`, and the award writes `tournament_players`, so the refusal cannot come from the award itself; no satellite alert of that shape has been raised in seven days. UNVERIFIED stays unverified rather than being "fixed" blind - it needs the reproduction, and the honest next step is to log the 400's body when it next happens.
- **C3 (bust rebuy through the pending ledger) and the PITR drill**: carried, and they are the last two items of the programme's original list.
- **chip_ledger partitioning** stays a dated cut of its own before December, blocked on the `ca_mint_ledger.chip_ledger_id` foreign key (a partitioned parent's unique key must carry the partition column).

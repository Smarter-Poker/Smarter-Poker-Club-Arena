# The spin that drew a prize and paid nobody

2026-09-08. Eleven `fn_spin_unpaid_check` criticals, 547.00 chips "drawn from
the reserve and credited 0 to players". **One player was genuinely owed. Ten
were not, and one of the ten would have been a 71.25 double-payment.**

pokerdale is paid: **3.00 chips**, obligation `d367f526` settled at 13:41:25,
after sitting unpaid since 03:05 the same morning.

## What the eleven actually were

| what                                                | count | chips    |
| --------------------------------------------------- | ----- | -------- |
| CANCELLED, and the whole draw returned              | 9     | 514.00   |
| paid an hour after the alert, incident never closed | 1     | 30.00    |
| **genuinely unpaid**                                | **1** | **3.00** |

**The nine cancelled spins returned every chip.** `spin_reserve_ledger` shows
`contribution +483.00`, `jackpot_draw −547.00`, `surplus_return +514.00`. The
cancellation path works. The detector has never heard of it — the view behind
the check computes `chips_short = prize_drawn − prize_credited` and does not
subtract `surplus_return`, so a spin that gave every chip back still reads as
514.00 short.

**One was paid and nobody told the incident.** ChipQueen won 30.00 on a 10 Chip
Spin PLO4; the alert fired at 19:50 and the recovery credit landed at 20:58,
same evening, with `category='prize'` and the tournament as
`related_entity_id`. The view now computes her as 0.00 short. The
`ca_drift_incidents` row stayed open anyway, because nothing re-reads it — and
`docs/laws.d/a-detector-re-reads-what-it-filed.md` is a law in this repo.

## The one that was real

**1 Chip Deep Stack Spin NLH**, Midway Union, 2026-09-08 03:05. Three players
paid 1.00 each. 2.76 went to the spin reserve as the entry contribution and
0.24 to rake — the buy-ins are fully accounted. The spin then drew 3.00 from
the reserve as the prize.

`tournament_players` records pokerdale at position 1, status `winner`, prize
3.00. `tournament_obligations` carries `amount_owed 3.00, amount_paid 0.00`,
source `engine.finishTournament`. The engine did its job.

**Then the escrow closed at zero, twelve seconds after that obligation was
written** — `close_note: "closed at zero"`, `reserve_in: 0.00`. The draw left
the reserve and never arrived. pokerdale had no prize leg and no prize credit,
while the same account was paid promptly for three other spins that hour.

### Paying it was completing a transfer, not minting

`spin_bonus_pools.balance` agrees with `spin_reserve_ledger` to the cent, so
the 3.00 really did leave the reserve. The escrow's own row says it never
arrived. The chips were in flight, not missing, so the settlement records the
credit that was never written (`fn_ca_escrow_apply(p_reserve_in => 3.00)`) and
then pays the winner. Reserve down 3.00 (already recorded), player up 3.00
(recorded now). Funding it from the club treasury instead would have charged
Midway Union twice for one prize.

## Two things the platform refused, and was right to

The settlement was refused twice before it went through, and both refusals were
this estate's own guards working exactly as designed:

1. **`adjustment_required`** — "source agent.probe is not a platform settle
   source; name an approved `ca_manual_adjustments` row". `fn_ca_adjustment_under_10_9`
   is the sanctioned path, and it enforces Dan's ruling **in the database**: the
   reason must be at least 200 characters naming every affected player and why,
   it must name the migration that carries it, and the approver is recorded as
   Dan's standing written approval of 2026-09-02. Condition 5 of 10.9 is not a
   convention here; it is a CHECK.
2. **`escrow_short`** — the settler will not pay from an escrow that does not
   hold the money. That is what forced the question "where did the 3.00 go?",
   which is what found the root cause.

## The 71.25 that must never be paid

`PLO4 Heads-Up 25` carries an obligation for 71.25 to AceGhost at place 1,
source `reconcile`. The tournament ended in a **chip-proportional deal on a
suspended heads-up**: AceGhost 47.50 (2,000 of 3,000 chips), the other seat
23.75 (1,000 of 3,000). Both credits are in `wallet_transactions`, timestamped
identically, totalling exactly the 71.25 prize pool.

The pool was paid in full. The obligation claims the _whole pool_ for first
place because the reconciler that wrote it did not know about the deal. Paying
it would have been a **71.25 double-payment** — and CLAUDE.md 10.9 says prefer
the witness that was there. The engine recorded the deal as it happened and the
payments match it exactly; the later reconstruction does not.

It is left unpaid and unsettled, flagged here, rather than voided on my own
authority in a migration about something else.

## Still owed after this

**431.57 across six obligations**, and the shape is already known:

- **2 × 180.00** on two `Sunday $200 Deep Stack` events. Both winners were
  credited their prize **minus exactly 180.00** (8,102.69 against a seat prize
  of 8,282.69; 13,261.68 against 13,441.68). An identical shortfall on two
  events is a mechanism, not a coincidence.
- **71.25** — not owed, see above.
- **0.32** across three rows, all `source='reconcile'`, on players credited far
  more than their seat prize. Cent residue; needs reading one at a time.

## Not fixed here

The view (`v_spin_unpaid_settlements`) still does not net `surplus_return`, and
the check still does not re-read what it filed. Both are DDL and both are
straightforward; they are deliberately not folded into a money migration.

**Escrow routing**: the credit landed on the player's SHARK CLUB membership,
not Midway Union where the spin was played, because `atomic_credit_wallet_and_log`
chooses the membership and the settle path does not set `app.ledger_club_id`.
The player is whole either way, so it is recorded rather than changed — but a
prize should land in the club that hosted the game.

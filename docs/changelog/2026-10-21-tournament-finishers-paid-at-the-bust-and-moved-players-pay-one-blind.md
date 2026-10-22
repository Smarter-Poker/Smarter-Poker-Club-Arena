# Tournament Finishers Are Paid At The Bust, And A Moved Player Pays One Blind

Dan, 2026-10-21:

1. "PAYOUTS FOR TOURNAMENTS WHEN A PLAYER BUSTS NEEDS TO BE REAL TIME PAYOUT,
   IT SHOULD NOT WAIT UNTIL THE END OF THE TOURNAMENT FOR A PLAYER TO GET PAID.
   THEY SHOULD GET THE CHIPS SENT TO THERE ACCOUNT AS SOON AS THEY BUST OUT."
2. "GOT MOVED INTO THE SMALL BLIND, PAID SMALL BLIND WERE DEALT IN AND THEN HAD
   TO PAY THE SMALL AND BB AGAIN. THIS BUG NEEDS TO BE FIXED."

## 1. Real-Time Tournament Payouts

**Cause.** The elimination doors (`fn_eliminate_tournament_player_atomic`,
`fn_claim_tournament_bounty_elimination`) recorded a provisional place and
moved no money. Every place and the Bubble Protection refund waited for
`fn_settle_tournament_places` at the end of the event.

**Fix (migration `20261021234526`, applied to production 23:45 UTC).** The
commit that records a bust now pays it. A deferred constraint trigger on
`tournament_players` (`playing -> eliminated`) and one on `tournaments`
(`prize_pool_finalized` turning true) run `fn_ca_pay_tournament_finishers_now`
at that commit. It pays only a final place:

- the event is RUNNING and its pool is finalized (late registration closed);
- not a satellite, and no final-table deal or place batch owns the event;
- no bust is still unrecorded (a `playing` row at zero chips).

The place is the terminal settlement's own rule (when the bust happened, then
the smaller same-hand stack), counted as live field plus rank. The engine's
sweep places are provisional by design (measured: 481 of 481 standings in a
526-entry event differed from their true place), so unpaid standings and their
prize cache are restamped to the true place. A paid place is never relabelled.
Money moves only through `fn_ca_settle_tournament_place_raw` /
`fn_ca_settle_tournament_bubble_raw`, the idempotent, escrow-capped obligation
doors the terminal uses, so the terminal later finds these places exactly
settled and pays only the rest. A refusal never blocks a bust: it rolls back
only the payment, writes one `tournament.real_time_payout_refused` alert per
event, and the terminal pays as before.

**Proof.** Rolled-back probe on RUNNING event 48d2a79d (526 entries, 53 paid):
places 53 to 46 paid 3.15 to 3.50, a replay paid nothing, escrow fell by exactly
what was paid, every obligation matched its standing and payout row, every
payout row named its wallet key. Live after the apply: 48d2a79d paid places 53
to 29 as they busted (positions 29 to 526 contiguous with 28 live), and the
Diamond event 211e5301 paid places 50 to 27 in Diamonds (ledger prize out 8,200
equals payout rows 8,200). No refusal alerts.

The engine's elimination toast now announces the place and prize the commit
left on the row (engine change, ships in the daily engine window).

## 2. A Moved Player In The Small Blind Paid A Second Blind

**Cause.** `noteTournamentArrival` billed an arrival in the small blind seat a
live big blind and kept it "on the hook" after it posted the small blind, on the
moving-button assumption that the small blind seat is the big blind next hand.
Under the tournament dead button (TDA Rule 30, live since 2026-09-25) that seat
is the BUTTON next hand, so the player paid the small blind and was then billed
a big blind from the button.

**Fix.** An arrival in the small blind seat is never charged an entry blind, and
every arrival's entry debt is settled by the first hand it is dealt. Only the
button seat, which would otherwise be dealt in free, carries the one live big
blind. `TournamentArrivalPosting.test.ts` and `DeadButtonEveryTableSize.test.ts`
pin the corrected rule.

# Diamond Phase 7: A Diamond Seat Adds Mid Hand

Status: Phase 7 Complete. Checklist Line Two Is Claimed. Public Funded Diamond Games Remain Closed And `cash_games_enabled` Remains False.

## Why The Chip Lane Cannot Be Copied

The chip lane takes the money when the player taps and lands the chips at the end of the hand, through the durable `table_pending_addons` ledger. Two steps, money first.

This arena cannot do that, and the reason is a constraint rather than a preference. The deferred trigger `zzz_diamond_seat_keeps_custody` requires a Diamond seat's `stack` to **equal** its custody balance at every COMMIT. A reservation made now and applied later is, by definition, a committed state in which the two disagree. There is no ordering of the chip lane's two steps that this arena permits, and there is no amount of care in the engine that changes that: the database refuses it.

The obvious escape is a holding pen, a second custody row the seat is not bound to, and it would work: a row with a null `seat_id` is invisible to both branches of that trigger. It was not taken. It needs a new value in a live money table's CHECK constraint, three new money functions, and a lane whose failure mode is Diamonds stranded in a pen belonging to a hand that ended. All of that to make a promise thirty seconds earlier.

## An Intent, Not A Debit

Nothing moves when the player taps. The engine records an intent, and when the hand ends the **whole** top-up happens in the one transaction the constraint allows, through `fn_poker_diamond_top_up`, the door that already exists and was already certified.

What the player gives up is real and is stated plainly, to them as well as here. The chip lane guarantees the money is committed the moment they tap. This guarantees only that it will be attempted the moment the hand ends, so a player who spends those Diamonds elsewhere in the intervening thirty seconds gets an honest refusal instead.

That is a narrower promise, and it is the widest one this constraint leaves. It is also worth noticing that the chip promise is not as wide as it looks: the chip lane re-sizes at landing and refunds the difference when the pot has moved the stack, which is why its own toast warns the player about exactly that.

## The Sentence Had To Change With It

The chip sentence ends "If The Pot Puts You Over The Table Maximum, The Difference Returns To Your Wallet." It is true because the chips were taken on the tap.

Nothing has been taken at a Diamond seat, so there is nothing to return. The Diamond sentence says what is actually true: the Diamonds land when the hand ends **and are taken then**, so keep them settled until it does. That is the less comfortable sentence and the honest one.

The accounting had to move with it too. The local balance, the session buy-in total, the rebuy count, the peak stack and the `CHIPS_ADDED` bus event all record a debit that has happened. A queued Diamond intent has not happened, so counting it would show the player a balance they still have and a session P/L built on a purchase nobody made. The lane returns before any of it, and the landing broadcasts the real stack.

## Sizing, Twice

The intent is sized against the stack **and** everything already intended for that seat, so three taps during one hand cannot promise more than the table can hold. It is measured again at landing, against the stack as it is by then, because the pot moved it while the intent waited. That is the whole reason the amount could not be fixed at request time.

Intents are keyed by request id rather than by player: the same tap retried overwrites itself, two genuine taps both count, and the SQL door de-duplicates a replay of the landing on the same id.

## Dropped, Not Retried

An intent that can no longer be honoured is dropped. The seat is gone, the seat is full, or the Diamonds were spent elsewhere.

This is the exact opposite of the rule one method below it, where an unresolved `table_pending_addons` row is deliberately left open for the next hand to pick up, and the difference is the whole point: that row is money already taken and dropping it would lose it. Nothing was taken here, so dropping costs nobody anything, and a queue that never empties is how a table stops dealing.

The lane is in memory only for the same reason. An intent lost to an engine restart costs the player nothing; a debit lost to a restart is the failure the durable chip ledger exists to prevent. There is nothing here worth making durable.

## What A Diamond Table Honestly Does Not Have

Seat changes and must-move, and they are unavailable **by construction** rather than by omission.

Both are provided by the cluster structure. `fn_cash_seat_change_request` looks its game up in `cash_games` and refuses a game that is not `must_move`. A Diamond table belongs to no cluster, the creation door writes a null `cluster_id`, and the boundary refuses a table that has one, so there is no game id to pass and no roster to spend a seat change from. Nothing has to be remembered to keep them off, which is the difference the phase exit criterion is asking about.

## Evidence

Eight assertions in `server/src/engine/DiamondCashBoundary.test.ts` for the engine half: the intent is recorded and `supabase.rpc` is never called during the hand; three taps are sized against each other and the third is refused; a retried tap is one intent and a second tap is two; a fraction is refused even as an intent; the landing is measured against the stack as it is by then, not as it was; an unhonourable intent is dropped; and nothing lands while a hand is running.

Seven in `tests/unit/aDiamondSeatAddsMidHand.test.ts` for the half the player sees, which is where a lane like this usually lies: that the mid-hand branch calls no money door, that the lane is memory only, that the early return sits **before** the debit accounting rather than after it, and that the Diamond sentence exists without the chip sentence having been overwritten.

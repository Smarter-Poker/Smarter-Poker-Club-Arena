# Diamond Phase 7: The Queue, And What It Tells You

Status: Phase 7 In Progress. Checklist Line Two Is NOT Claimed. Public Funded Diamond Games Remain Closed And `cash_games_enabled` Remains False.

## The Good News First

Waitlists, seat offers and multi-table flows already work at a Diamond table, end to end, and nothing had to be built for them. That is worth stating plainly because it was not obvious before it was checked.

The waitlist stores a row in `table_waitlist` and moves no money at all; the only thing it reserves is `hold_expires_at`, which is a flag rather than a stake. `fn_offer_open_seat` reads no asset. The Diamond cash-out fires it through the same wrapper a chip cash-out does. And the door the offer leads to is the right one: `atomic_table_buyin` has been an asset router since September 10, so a claimed offer lands on `fn_poker_diamond_buyin`, which honours the hold (it counts other players' live waitlist holds and refuses a seat that is being held for someone else) and settles the row to `seated` itself.

So this work is not about making the queue function. It is about what the queue tells a Diamond player, which was wrong in three places.

## A Refusal That Blamed The Player's Balance

Every Diamond refusal reached the player as the caller's generic fallback: **"Buy-in failed. Please check your balance and try again."**

Three of the refusals have nothing to do with a balance, and one of them, `diamond_cash_not_open`, is a table that is not open yet. So the arena told a waitlisted player who arrived on time, at a table it had just offered them, that they were short of Diamonds.

Thirteen refusals are translated now, matched on the SQL exception name rather than on its prose, because the prose is a sentence written for a log and these are sentences written for a player. The list covers the buy-in door, the custody functions under it, and the top-up door the cashier reaches through the same translator.

A second test reads the names back out of the migrations that raise them. A translation keyed on a name the database no longer uses is worse than no translation, because it looks handled and is dead.

## A Queue For A Seat That Cannot Be Taken

The lobby tested `full` before it tested the closed-arena gate, in both the panel and the table row. So the one board that could still offer an action while Diamond cash was closed was a board with **no seats on it**: a full table offered Join Waitlist.

The gate that sits below it already explained why that is wrong, for the non-full case: "Offering the action here would send the player to a panel whose only outcome is an error." The queue is the same thing one step removed, and worse, because the hold it promises lasts sixty seconds. The player is not queuing for later; they are queuing to be handed a seat they cannot take.

The closed gate comes first now. Leaving a queue stays reachable in both components, because a player already on one must always be able to get off.

## A Cap The Client Did Not Believe

`MultiTablePage` opened six tables on any screen 1024px or wider. The server enforces **four**, in three independent places: the chip buy-in body, the Diamond buy-in door, and the `table_seats` trigger that counts cash seats and tournament bookings across every arena. A Diamond seat and a chip seat take the same slot in all three.

The file's own note said exactly which direction that duplication may fail in: "this is the client refusing to offer a seat it knows the server would decline, and never the other way round." The reasoning was right and the number was stale. The cap was raised to six on August 21 and lowered back to four on September 2; this line was not part of that change. For ten days every desktop opened tabs five and six and had the buy-in refused at the door, which is the "other way round" its own note forbids. The other note in the same file, on the tile grid, said four throughout.

It says four everywhere now, and a law derives the server's answer from the migrations rather than retyping it, so the next change to either side fails in CI rather than ten days later on somebody's desktop.

## A Pin That Did Not Follow Its Own Advice

`lobbyWaitlistIsReachable` pinned the exact spelling of the whole waitlist condition, directly beneath a comment saying that a third gate had already broken that approach once and that the pin therefore "asserts that each required gate is PRESENT rather than pinning one exact spelling." The waitlist line had not been converted. The fourth gate arrived and it went red for exactly the documented reason. It asserts the gates now.

## Two Hazards Found, Neither Diamond, Both Reported

`WaitlistService` still writes `table_waitlist` directly with `.insert()` and `.update()`. Migration `20260910184439` revokes precisely those grants, and its own header records that it was probed and rolled back rather than applied. If it ever lands without the client change, waitlist join and leave break for every arena at once.

`promote_next_waitlisted_player` reads the dead plural `table_waitlists` table and inserts a `table_seats` row with `stack = 0` and no buy-in. Nothing calls it, and a test pins that nothing does, but it is live SQL that would seat a player for free at a Diamond table.

## Still Not Claimed

Line two also covers mid-hand add-ons, which are not a rounding problem: the deferred `zzz_diamond_seat_keeps_custody` trigger requires a Diamond seat's stack to EQUAL its custody balance at every commit, so money cannot be taken at request time and applied at the end of the hand the way `table_pending_addons` does for chips. That needs a holding lane of its own.

Seat changes, must-move and clusters remain honestly unavailable: Diamond tables carry no `cluster_id` and the boundary refuses one, so the game-level queue that provides must-move is unreachable by construction rather than by omission.

# The Diamond Seat Guards Know A Tournament Seat

2026-09-13. Diamond Build Programme, phase 8 of 12 (Tournament, SNG And
Heads-Up Funding). Migration
`20260913235649_the_diamond_seat_guards_know_a_tournament_seat.sql`, written
and NOT applied; law
`tests/a-tournament-stack-is-not-a-diamond.law.test.ts`.

## What was wrong

`poker_diamond_custody.purpose` has permitted `'tournament_entry'` since
`20260909065458`, and `fn_poker_diamond_reserve` has priced one since the same
day: `tournaments.buy_in_amount + COALESCE(buy_in_fee, 0)`, anything else
refused as `invalid_diamond_entry_price`, the whole branch gated on
`ca_arena_settings.tournaments_enabled` since `20260912112311`. The escrow
shape has existed for four days and nothing has ever written a row through it.

Three guards never learned that tournaments exist. All three branch on
`clubs.asset = 'diamonds'` and nothing else:

| guard                                 | fires                                                             |
| ------------------------------------- | ----------------------------------------------------------------- |
| `fn_poker_guard_chip_seat`            | BEFORE INSERT OR UPDATE OF `table_id` on `table_seats`            |
| `fn_poker_bind_diamond_seat`          | AFTER INSERT on `table_seats`                                     |
| `fn_poker_diamond_seat_keeps_custody` | DEFERRABLE INITIALLY DEFERRED constraint trigger, both directions |

Between them they assert one equation for every Diamond seat there is:

    table_seats.stack = poker_diamond_custody.balance

For cash that equation **is the product**. The stack a player sits down with
is exactly the Diamonds held for that seat, which is what makes a cash-out
correct and what lets `fn_poker_diamond_cashout` pay the stack without
arithmetic. For a tournament it is a category error. The Diamond Money
Contract is explicit: "Tournament playing stacks are nonredeemable tournament
units. Entry and prize money are diamonds. Tournament units must never become
withdrawable diamonds just because the UI uses diamond artwork." Under the old
rule a 10,000-unit starting stack would have demanded 10,000 real Diamonds in
custody, and phase 8's exit gate - "all funded tournament lifecycles close
exactly and cannot pay playing-stack units to wallets" - cannot be reached
while it stands.

## The part that matters: what was removed, and what replaced it

**"A Diamond playing stack cannot reach a wallet" was true by accident.** A
Diamond seat simply WAS its custody, so there was no such thing as a stack that
was not already real Diamonds. Breaking the equation REMOVES a guard. Doing
only that would have left the arena strictly less safe than it was, which is
the whole reason this is one migration and not two.

So the equation is not merely narrowed. It is scoped to the seats it is true
of, and replaced in the same transaction by a rule stated positively:

> A Diamond tournament seat is admitted by a FUNDED ENTRY, never by its stack.
> The stack is a play unit and bears no relation to custody. The money is the
> ENTRY: one custody row, bound to the tournament and never to a seat, holding
> exactly what was reserved for it and nothing that play produced.

### Why the replacement is at least as strong

The only channel from a playing stack to a wallet was ever _custody.balance
follows the stack, and a release pays custody.balance_. The new rules sever
that channel at both ends, and each says so by name rather than by accident.

|                                                     | old rule                                           | new rule                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a tournament entry carrying `seat_id`               | **allowed** (nothing said otherwise)               | **refused**, P0813. Nothing that looks up "the custody for this seat" can find a tournament entry, so `fn_poker_diamond_cashout` and `fn_poker_diamond_release` are closed against a playing stack by construction rather than by check                   |
| a balance that play produced                        | **required**: the balance had to BE the stack      | **refused**, P0814. An entry holds exactly the sum of the Diamond movements recorded against it. A movement is written only by the reserve and release doors, each of which journals the wallet, so a balance with no movement behind it aborts at commit |
| an entry re-pointed at another player, event or key | **allowed**                                        | **refused**, P0815                                                                                                                                                                                                                                        |
| a live tournament seat with no entry                | covered only by the stack equation                 | **refused**, P0812, at every commit, in the arm that replaced it                                                                                                                                                                                          |
| a seat carried from one event's felt to another     | covered by refusing every move (`TG_OP<>'INSERT'`) | **refused**, P0811, while balancing inside one event is allowed                                                                                                                                                                                           |

The direction of each row is the point: the old rule _required_ the coupling
that the new rules _forbid_. Nothing that the old equation would have caught is
now reachable.

### Why the balance rule is "equals its movements" and not "never changes"

Phase 8 also has to carry re-entry, rebuy and add-on, and those are real money
arriving through the reserve door. A rule of "an active entry's balance never
changes" would have been simpler to write and would have forced the next agent
to weaken it - CLAUDE.md 10.86 rule 4, the fix that leaves the same trap one
level up. "It holds only what was reserved for it" forbids exactly what play
could do and nothing that a funded, journaled movement does.

## What the migration actually does

One transaction, one `BEGIN`/`COMMIT`, per the production DDL policy. Every
redefinition slices an anchored clause out of the LIVE definition
(`pg_get_functiondef`), requires the match to be unique, and re-creates the
function, with the starting md5 of all three pinned so it aborts if the board
moved underneath it. The cash blocks are put back character for character.

1. **`fn_poker_guard_chip_seat`** branches on `tables.tournament_id`. The cash
   branch is the live text, unchanged. The tournament branch requires an
   `active` `tournament_entry` custody for that user and that tournament, in an
   arena whose `tournaments_enabled` is on, with `seat_id IS NULL`, and does not
   mention the stack (P0810); and, on a move, requires the old and new tables to
   belong to the same tournament (P0811).
2. **`fn_poker_diamond_seat_keeps_custody`** scopes both existing arms to
   `purpose='cash_seat'` and gains a third arm: a live seat at a Diamond
   tournament table must be covered by a live funded entry for that event
   (P0812). The arms are disjoint by `tables.tournament_id`, so no live Diamond
   seat lost a rule; each now has the rule that is true of it.
3. **`fn_poker_bind_diamond_seat`** returns without touching custody for a
   tournament seat, after asserting the entry (P0810). That is the mechanism,
   not an omission: there is nothing seat-shaped on the row to re-point, so one
   entry survives a table move, a balance and a re-seat.
4. **`fn_poker_diamond_entry_custody_is_the_entry`** is new: a DEFERRABLE
   INITIALLY DEFERRED constraint trigger on `poker_diamond_custody` carrying
   P0813, P0814 and P0815. Deferred because the reserve door inserts the custody
   row before the movement row that pays for it, and both are one transaction.
5. All three seat guards and the new rule go on `fn_ca_guard_watchlist` (41 ->
   44 names), and every baseline this migration moves is declared through
   `fn_ca_declare_guard_redefinition` in the same transaction, so the watcher
   has nothing to report on its next run.

Section 6 then proves, against the live definitions it just wrote, that every
cash clause survived, that neither tournament branch mentions a stack, that the
new trigger is armed and deferred and closed to a browser, that nothing left the
watchlist, and that no switch was opened and no custody row was written.

## The contract this sets for the entry door that does not exist yet

`fn_poker_diamond_reserve` writes a `tournament_entry` row in state
`'reserved'`. The guards require `'active'`. So the entry function, when it is
written, must activate the entry as part of registering the player, BEFORE any
seat exists - the tournament mirror of what `fn_poker_bind_diamond_seat` does
for cash, moved to where the money is. Until then, and while
`tournaments_enabled` is false, a Diamond tournament seat is refused by name at
three doors rather than by accident at one.

## What this is not

No repair job, sweep, backfill, healer or reconciler (10.11, 10.12): every new
rule is a refusal on the live path, at the moment the rule is broken, and its
reader is the writer. No horse branch anywhere (10.5): a horse registers, is
seated, is balanced and is paid through exactly these doors. No new wall-clock
deadline, so section 13's thaw list is unchanged. No money moves, no custody row
is written, `tournaments_enabled` and `cash_games_enabled` are both untouched,
and no cash behaviour changes.

## Evidence

Read read-only against production on 2026-09-13, before anything was written:

- `poker_diamond_custody` holds **0 rows**, of which **0** are
  `tournament_entry`;
- **0** `ca_arena_settings` rows have `tournaments_enabled`;
- `fn_ca_guard_watchlist()` returns **41** names;
- `md5(pg_get_functiondef(...))`: `fn_poker_guard_chip_seat`
  `63c4678ff882ce5712bce692a46bcc2d`, `fn_poker_bind_diamond_seat`
  `e17ef6b101b7035c71950e0ffd4bbfbc`, `fn_poker_diamond_seat_keeps_custody`
  `d92a8e88ba54a6a09f673b975e752924` - the last of which is also its recorded
  `ca_guard_defs` baseline, so nobody else has an open notice on it.

Each of the four anchors was confirmed to match its live definition **exactly
once** by a read-only `SELECT`, and the three rewrites were simulated offline
against those definitions: all three come out `IF`/`END IF` balanced, both
tournament windows come out with no occurrence of "stack", and every marker
section 6 asserts is present. No DDL was executed and no money path was called
(11.5, and the production DDL policy rules 3 and 7).

**Not applied.** It must be applied outside minute :50-:03 UTC, or the
break-window event triggers will refuse it and roll the whole transaction back.

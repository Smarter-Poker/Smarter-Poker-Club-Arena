# The Crazy Pineapple audit — three gaps the four phases left behind

**2026-09-01.** Phases 1 to 4 are all on `main` and all serving. This is the
sweep Dan asked for afterwards: every claim in
`.agent/handoffs/2026-08-31-crazy-pineapple-phases-3-and-4.md` checked against
the code that actually shipped, and against production. Three things were
wrong. None of them was a broken phase; all three were a phase that stopped one
surface short of finishing.

## 1. The hand-strength label named hands the hero cannot have

`bestFive` took any five of hole plus board for every non-Omaha variant. Crazy
Pineapple deals THREE hole cards and the discard comes AFTER the flop, so for
the entire discard window — the one moment that label matters — it was scoring
a holding that cannot survive the throw. `9h 9d 9s` on an `A K 2` flop read
**Three of a Kind** while the player was choosing which nine to throw away.

The rule is now the server's own, from `pineappleDiscardChoice.ts`: _"after the
discard the hand plays exactly like holdem"_ with the two you kept. So the
label scores the best of the three ways to keep two. It is a no-op once two
cards remain, which is every other caller — showdown included.

The preflop branch in `TablePage` had the same shape (three ranks, so `999`
printed "Three of a Kind") and is capped the same way.

Listed in the handoff §4 as found, triaged and in no phase. It was the last
pineapple item on that list that is a defect rather than a config row.

## 2. The card you threw never reached the panel at the table

Phase 4 persisted the discarded card and rendered it in the standalone replay.
The handoff asked for the replay **and** `HandHistoryPanel` — the panel that
slides out at the felt, which is the surface a player reviews the last hand on
mid-session without leaving the table. That one, and the Hand Detail modal it
opens, still printed the word `discard` and nothing else.

Same fetch, same policy, same map: `HandHistoryService` already had the
viewer's own discard in hand for the replay and simply never put it on the
action list the panel reads. It does now, keyed by the ACTION'S OWN user id
against a map that RLS guarantees holds nothing but the viewer's rows — so
there is no new privacy decision here, and no filter that can drift. Pinned
three ways in the adapter test: carried when present, undefined for an
opponent's discard, and never present in a SHARED hand.

## 3. The retention policy had no caller

`20260901093000` created `sp_prune_hand_discards` and wrote the promise into
the table's own comment: _"a row survives exactly as long as a hand_history row
for its (table_id, hand_number) does"_. Nothing kept it. Measured across the
whole repo and the whole `cron.job` table: **zero callers**. A retention policy
with no caller is a comment, and the table it describes grows forever.

Scheduled as `sp-prune-hand-discards` at `7,37 * * * *`, in the same shape as
every sibling prune in this database — advisory lock, own statement timeout,
batch limit. Twice an hour rather than the hand prune's every ten minutes,
because it only ever deletes rows whose parent hand is already gone.

## What was checked and found correct

- Both paths that remove a card emit `PINEAPPLE_DISCARDED`: the player's own
  `performDiscard` and the all-in forced discard. A missed discard is a FOLD,
  not a silent throw, so there is no third path that needs persisting.
- The private event is consumed by the engine and never forwarded to the hub.
- 46 of 46 production discard rows join to their own hand AND to that player
  inside that hand's `players` array — the `(table_id, hand_number)` key the
  client reads by is correct in the field, not just in the test.
- Zero of those cards appear in the public `hand_history` row for their hand.
- `hand_discards` RLS in production: read-own only; insert, update and delete
  denied to `authenticated`.
- Every phase artefact is wired to a caller: the discard component, the sound,
  the animation, the settle beat, the hole-card count, the tab-strip label.
- No TODO, FIXME or stub anywhere in the pineapple path.

## Still Dan's, still untouched

- `auto_start_players = 2` on every pineapple table. A config row, not code.
  Worth knowing that after the 18:42 restart the seeder put one horse on each
  of twelve pineapple tables and none reached two, so Crazy Pineapple dealt
  nothing for 33 minutes; `short_deck` and `flh` were in the same state.
- The never-shrink roster guard, deliberately not added, still needs a repro
  with the socket state captured.

# A hold that survives the deploy, a footer that stops lying, and one seat offer

2026-08-30. Follow-ups to the two reports of 2026-08-29, from the "what is left
to do" pass. Each one is a thing that would have re-opened a report Dan already
raised.

---

## 1. A cash entry hold now survives an engine restart

`waitingForBB`, `postBBWhenClear`, `postingBBToEnter` and `pendingPostToEnter`
are `Set<string>` fields on the engine process. Nothing persisted them, and
every push touching `server/**` redeploys that process
(`auto-deploy-hetzner.yml`) — it also recycles on lease changes,
`killForRestart` and the watchdog.

**What a restart cost, which is worse than "the prompt comes back."** The
dealing loop's first-iteration block adds every seated player to
`knownPlayerIds` AND `dealtInUserIds`. That is right and deliberate for someone
genuinely playing before the restart: without it `buttonEligible()` falls back
to the whole roster for a full orbit after every deploy. But it swept up held
players too, and a held player came back

- not in `waitingForBB`, so dealt in on the very next hand,
- having paid nothing — the free hand Dan reversed on 2026-08-26,
- and a button-eligible veteran, so able to take the button on what is really
  their first hand.

Three house rules, all switched off by a deploy, silently. And the standing
agreement to post (added 2026-08-29) was lost with them, so the player was asked
again — the exact report that set was written to fix, arriving by another door.

**The fix.** `table_seats.entry_hold` (`NULL` / `'waiting'` / `'posting'`) and
`table_seats.entry_post_agreed`. That table already carries the rest of a seat's
session state across restarts for precisely this reason: `is_sitting_out`
(2026-08-25) dealt cards to players who had sat out, `sit_out_at` (2026-08-28)
handed every sat-out seat a fresh five minutes on every boot so the eviction
never fired. This is the third instance of the same lesson on the same query —
the engine wrote a fact and never read it back.

`persistEntryHold()` writes on every transition (enter the hold, agree to post,
post for real, released by the big blind, debt settled). Fire-and-forget with a
`.catch()`, in the house style: the in-memory set stays authoritative for the
running process, so awaiting it would put a network round trip between a tap and
the engine acting on it, to defend against a restart landing inside a few
hundred milliseconds.

`restoreEntryHoldsFromSeats()` reads it back **once per process**, not on every
pass like the sit-out restore — the database owns sit-out state continuously,
whereas an entry hold is released by the engine itself mid-orbit, so re-reading
every pass would race the write that clears it and re-hold a player already let
in. It runs from both boot paths (the wait loop as well as the dealing loop: a
table below the minimum to deal never reaches the second one).

And the veteran seeding now skips a held player, which is the half that closes
the free-button hole.

## 2. The reserved-seat footer stops contradicting the overlay

`TablePage` printed _"Seat Reserved, You'll Be Dealt In Next Hand"_ for every
non-tournament seat, unconditionally. In Dan's screenshot from 2026-08-29 the
overlay says "Post Big Blind To Enter" and this bar promises a deal next hand,
at the same time. They cannot both be right, and the footer is the wrong one —
a player between the blinds waits for the button to pass, which is two or three
hands. It is also the one people believe, because it is not a button.

Three states now, and the sentence depends on which holds:

| State                | Footer                                                         |
| -------------------- | -------------------------------------------------------------- |
| Not held             | Seat Reserved, You'll Be Dealt In Next Hand                    |
| Held, unanswered     | Seat Reserved, Post The Big Blind Or Wait For It               |
| Held, already agreed | Posting The Big Blind, You Are Dealt In When The Button Passes |

## 3. One seat offer, one transaction

`notifyWaitlistSeatOpen` had grown to six round trips and ran on every cash-out
at every table. Cost was the smaller half. The real problem was a race the old
code could only **survive**: between reading the queue head and claiming it, a
concurrent opener could take the same row. The loser noticed (its claim was
scoped `.eq('status','waiting')`) and returned — so the seat went **unoffered**,
silently, until another seat happened to turn over.

`fn_offer_open_seat` does the whole sequence in one transaction and takes the
head with `FOR UPDATE ... SKIP LOCKED`, which hands a concurrent caller the next
person in line instead of a collision. It carries the rules that were added to
the TypeScript on 2026-08-29 — the 3-minute offer TTL, the 24-hour abandoned-row
TTL, the already-seated retirement, the human-only head — and adds one:

**Losing your place is no longer silent.** Reclaiming a lapsed offer now writes
the player a `waitlist_offer_expired` notification. It is a bell item, never an
interrupt: `data->>'_push'` is set, which is the documented signal that makes
`fn_mirror_notification_to_push_outbox` skip the row, so this cannot itself
become the next round of unwanted pushes.

The engine is now a single `supabase.rpc('fn_offer_open_seat')` call.

---

## Three guards caught this refactor, and all three were fixed rather than bent

Worth recording, because each one did exactly its job:

- **`noUnhandledRejections`** — `persistEntryHold` used `void supabase...then()`
  with no `.catch()`. A transient network blip would have taken the engine down
  to protect a durability nicety. Fixed in the code.
- **`seats.guard`** — "there is exactly ONE implementation of cashing a seat
  out" asserted over the whole file, so it really read "seats.ts calls exactly
  one RPC", which was true only while the offer path was hand-written
  TypeScript. Re-scoped to the two cash-out bodies, plus an explicit assertion
  that no other function in the file cashes a seat out. A third cash-out
  implementation still fails it.
- **`PagedReadsCannotLieAboutBeingComplete`** and
  **`WaitlistService`** — both pinned the paging loop and the table name in the
  TypeScript. The rules are unchanged, so the assertions followed them into the
  migration instead of being deleted: no ceiling on the queue walk, no ambiguous
  embed, canonical table.
- **`noFixedSizeSourceWindows`** — this is what failed CI on PR #1844, and the
  fix is in this branch. Four `.slice(at, at + N)` windows in the new tests were
  converted to `sliceEnclosingBlock` / `sliceBlockAfter`. One of them was
  additionally re-anchored: it keyed off `waitingForBBUserIds.includes(userId)`
  by occurrence index, and item 2 above added a third call site, so an
  occurrence index over a string that keeps gaining call sites is a magic number
  wearing a different hat.

## Tests

- `server/src/engine/EntryStateSurvivesRestart.test.ts` — new, 8 cases: every
  transition persists, the write is scoped to the live seat and never blocks,
  the columns are read back, the restore covers hold and agreement and debt,
  runs once per process, is reached from both boot paths, and runs before the
  veteran seeding with held players excluded.
- `tests/unit/seatOpenPushPath.test.ts` — rewritten to follow the rules into
  `fn_offer_open_seat`, including that it is not callable from a browser.
- `tests/unit/postBBAskedOnce.test.ts` — plus the footer's three states.

`npx tsc --noEmit` clean on client and server. 2528 server tests and 9193 client
tests pass. Both migrations applied to production before this branch was pushed,
and `fn_offer_open_seat` was probed against a real table inside a transaction
that was rolled back (CLAUDE.md 11.5) — it claimed the row, wrote exactly one
notification, and left nothing behind.

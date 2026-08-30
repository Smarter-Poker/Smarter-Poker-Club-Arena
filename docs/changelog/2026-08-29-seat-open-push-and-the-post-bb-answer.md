# A seat offer that was not asked for, and a post that was not remembered

2026-08-29. Two reports from Dan, one screenshot each.

---

## 1. "The seat open push notification should only occur if you are on a list waiting for a seat, not randomly"

The lock screen showed the same banner twice, stacked:
_"A Seat Just Opened At PLO4 0.50/1.00. Tap To Claim It."_

### What the data said

He WAS on that queue — `table_waitlist` row `46a1f19b`, joined 16:49:02, offered
16:53:54. So the offer itself was owed. Three separate things made it read as
random anyway, and all three are fixed here.

**The push was enqueued twice.** `notifyWaitlistSeatOpen` inserted a
`notifications` row AND a `push_outbox` row. It only ever needed the first:
`trg_mirror_notification_to_push_outbox` (AFTER INSERT ON notifications) has
mirrored notifications into `push_outbox` since before the direct insert was
written on 2026-08-26. The two rows behind that screenshot are
`7e1ba96a` and `91453e36`, 237ms apart, both delivered.

It was VISIBLE rather than merely wasteful because the two rows carried
different tags — `waitlist_seat_open:<notification id>` from the trigger and
`seat-open-<tableId>` from the engine. The tag is what lets the operating
system collapse a repeat into the banner already on screen, so two rows with
identical text and different tags are guaranteed to stack.

Fixed by deleting the direct insert. Nothing is lost with it: the trigger's row
carries the same recipient, the same body, and the same deep link
(`/hub/club-arena/table/<id>`, filled by `fn_notification_fill_action_url`), and
`push-dispatch` runs `gateDecision()` on it, so consent is respected by
construction rather than by this file remembering to check.

**An abandoned place in line was immortal.**
`20260826151500_waitlist_queue_visibility_and_gc.sql` expired human `waiting`
rows older than 24h — once, as a backlog cleanup. No recurring job took it over,
so since then a row has lived forever: join a queue, close the app, and weeks
later a seat turns over and the phone lights up about a table you have no
memory of. From the player's side that is indistinguishable from a random push.

The 24h TTL is now applied on the offer path itself (`WAITLIST_ENTRY_TTL_MS`),
which is the only place that turns a queue row into an interrupt — so a row
cannot outlive its own expiry by the width of a scheduler window.

**You could be offered a seat at a table you were already sitting at.** Nothing
retired a queue row when the player took a seat by any route other than the
offer itself. Buying in directly from the lobby left the row `waiting`, so the
next seat to turn over at that table pushed "tap to claim it" to somebody
already in it — and burnt the offer, because the queue head was `notified` and
nobody moved. Seated players' rows are now marked `seated` before the head is
chosen.

---

## 2. "You already agreed to post BB"

> "in cash games when you click POST BB but you are IN BETWEEN THE BLINDS you
> get this pop up. that shouldn't happen because you already agreed to post bb,
> it should be a pop up that says, 'You Are In Between The Blinds, And Will Be
> Dealt In When The Button Passes.' and auto post the blind then. it currently
> makes you hit the button again, or it simply won't deal you in at all."
>
> "as a hard rule, you can never be dealt into the small blind or button in a
> cash game"

### The hard rule is untouched

`postBBToEnter` refuses a post from the seat the small blind is about to reach
and from the seat the button is about to reach. It still refuses both, on this
call and on every replay, and the replay re-enters the same guarded method
rather than reaching for the sets — so the seat is re-checked on every pass
instead of being decided once at the moment of the tap.

### What was actually broken was what the refusal did to the player

The refusal threw the answer away. The player stayed in `waitingForBB`, and
TablePage renders the "Post Big Blind To Enter" overlay purely off
`waitingForBBUserIds` — so the same prompt came straight back, tapping it from
the same seat was refused again, and the only way through was to keep tapping
until the button happened to move. Hence both halves of the report: it makes you
hit the button again, or it simply won't deal you in at all.

### The repair

`postBBWhenClear` holds the agreement. A positional hold-out now returns
`{ success: true, deferred: true }` with the sentence Dan asked for, and the
dealing loop replays the agreement on every pass until one of exactly three
things ends it:

- **the seat cleared** — the post goes through and bills one live big blind
  through `postingBBToEnter`, identical to a live tap at that moment;
- **the big blind reached them first** — the natural release above takes them
  out of `waitingForBB` and they post it as their own blind. The agreement is
  dropped, never charged twice. (The replay sits AFTER that release for exactly
  this reason.)
- **they left the table** — an answer about one seat cannot outlive the seat.

Membership is deliberately NOT consumed on the attempt. Consuming it on the
first pass would discard the answer exactly as the old refusal did.

The engine publishes the set as `post_bb_deferred_user_ids`, and TablePage gates
the overlay on it, so a reload does not re-ask. A local `bbPostAgreed` flag
covers the poll between the tap and that snapshot, and is cleared the moment the
hero stops being held — a stale flag HIDES a prompt, so it must not be able to
outlive the hold.

Nothing here shortens the wait. It stops the wait from costing the player their
answer.

---

## Tests

- `tests/unit/seatOpenPushPath.test.ts` — rewritten. It used to pin the direct
  `push_outbox` insert, which is the behaviour being removed, so it is updated
  in the same commit rather than left asserting the old rule. It now pins ONE
  writer, the TTL sweep, and the already-seated gate; the OneSignal pins stay.
- `server/src/engine/EntryPostingAndButton.test.ts` — five new cases: the
  hold-out banks the answer, the held agreement never buys past either seat, the
  replay lands after the natural-BB release, membership is not consumed and
  cannot outlive the seat, and the engine publishes the set.
- `tests/unit/postBBAskedOnce.test.ts` — new. Every `/post-bb` call site reads
  `deferred` before `success`, the copy matches and carries no em dash
  (CLAUDE.md rule 7), the overlay is gated on the published agreement, the field
  survives engine → mapper → page state, an older engine falls back to ASKING
  rather than to silence, and the optimistic flag cannot outlive the hold.

`npx tsc --noEmit` clean on client and server. 2519 server tests and 9179 client
tests pass.

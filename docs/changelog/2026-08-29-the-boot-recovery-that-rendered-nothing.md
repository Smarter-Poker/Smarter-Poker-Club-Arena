# The boot recovery that rendered nothing

2026-08-29, fifth pass. Dan, from live play, after confirming the five-minute
eviction itself now works:

> "I HAVE AND ALREADY CONFIRMED IT KICKS AFTER 5 MINUTES, BUT IT DOESN'T GIVE
> YOU A 'REMOVED FROM TABLE' NOTIFICATION, AND THE 'SITTING OUT BUTTON' NEVER
> LEAVES THE TABLE."

The server side is correct and was verified before touching anything: the engine
emits `seat_left` with `reason: 'sit_out_timeout'` _before_ cashing out, and
`atomic_seat_cashout_locked` stamps `left_at` under a row lock. No cash seat in
production is sitting out past the deadline. The eviction works.

**Everything wrong here is on the client**, and it is one root cause with three
faces.

---

## The recovery ran and changed nothing

Two paths were supposed to handle this — the `seat_left` websocket event and the
ten-second `table_seats` read — and both were the same six lines, copied:

```ts
heroSeatRef.current = 0;
sittingOutIdsRef.current.delete(String(userId));
setShowSitOut(false);
setSitOutSince(null);
setSitOutNextHand(false);
setTableState((prev) => (prev.heroSeat === 0 ? prev : { ...prev, heroSeat: 0 }));
```

Every one of those six can complete **without causing a single re-render**:

- line 1 is a ref mutation — schedules nothing;
- line 2 is a `Set.delete` on a ref — schedules nothing;
- lines 3–5 are `setState` calls that were, by then, already at their target
  values — React bails on an identical value;
- and line 6 is the one that mattered. **A sitting-out player is not in the
  current hand's player list**, so `syncedHeroSeat` is 0 and
  `tableState.heroSeat` is _commonly already 0_ by the time the eviction lands.
  `prev.heroSeat === 0 ? prev` then returns `prev` and React bails again.

So the whole thing ran, correctly, and produced no render. The screen never
learned.

## Which is why the footer never changed

The sitting-out bar was gated on:

```ts
getPlayerAtSeat(tableState.heroSeat)?.status === 'sitting_out' ||
  sittingOutIdsRef.current.has(userId || '');
```

The second half is a **ref read during render**. The recovery deletes the hero
from that Set, but a ref mutation schedules nothing — and, per the above,
nothing else in the recovery forced a render either. So the bar kept saying
_"You Are Sitting Out"_, with a live I'm Back button, over a seat the player no
longer held, for the rest of the session.

This is the same defect I fixed for `heroIsSittingOut` on 2026-08-29 by
introducing `heroSitsOutPerRow` state — and I converted the derived value while
leaving the surface the player actually looks at reading the ref.

## And why the badge stayed on the felt

Nothing in either path removed the hero from `tableState.players`. Zeroing
`heroSeat` changes which seat is _claimed_; the seat object itself kept the
hero's avatar and their `status: 'sitting_out'`, so the SITTING OUT tag stayed
on the felt.

## The notice could also be lost permanently

```ts
if (!bootNoticeShownRef.current) {
  bootNoticeShownRef.current = true;          // burned FIRST
  heartbeatToastRef.current?.info?.(…);       // …then optionally dropped
}
```

The one-shot flag was set _before_ the toast was attempted, through two optional
chains. Any drop — a toast provider not yet mounted, a race on teardown — burned
the flag and **silenced the other path too**, permanently.

---

## The fix

One `applySeatRemoved(reason?)`, called by both paths, which:

- **always commits a new state object** — no `prev.heroSeat === 0 ? prev` bail,
  because that case is the common one here, not the rare one;
- **empties the seat** (`players.map(p => p.id === heroId ? null : p)`) as well
  as zeroing the claim;
- clears `heroSitsOutPerRow`, which is what the footer now reads;
- sets the one-shot flag **only once the toast has actually been dispatched**.

The footer's condition moves from the ref to `heroSitsOutPerRow`.

`BOOT_EXPLANATIONS` is hoisted to module scope so both paths quote the same
sentence — they had already drifted, and the poll's copy had no per-reason text
at all, so a five-minute eviction arriving by poll said only the generic line.
`evictionReasonRef` remembers what the socket said, so if the event arrived but
its toast was dropped, the poll fallback can still name the real reason instead
of downgrading the message.

## Tests

`tests/unit/removedFromTableIsVisible.test.ts` — 9 cases. The ones that matter
pin the properties, not the shape: that the recovery cannot return `prev`, that
it empties the seat, that the flag is burned only after the toast is dispatched,
and that the footer does not read `sittingOutIdsRef` at render time. The
now-removed six-line block is pinned as a negative, so it cannot come back by
copy-paste.

## What this says about the previous four rounds

Rounds 1–4 all touched this recovery and all four left it invisible, because
every one of them reasoned about _what the code sets_ rather than _what the
screen does next_. Three of the six lines were already no-ops when they were
written. A test that greps source could never have caught it; the assertion that
finally does is "this must produce a new object".

# 2026-08-28 — A late answer must not overwrite a newer truth

Three races on the table surface, one shape: something awaited lands after
the world moved on, and writes anyway.

## 1. loadTableInfo's tail stopped checking isMounted

The effect declares `isMounted` and checks it six times... and then stops.
Every write from the wallet read onward ran unconditionally — including a
`setTableState` that rebuilds the seat map FROM A CLEAN SLATE and resets
`heroSeat` (the ref the duplicate-seat guard reads). The bootstrap above it
is a 5-attempt 1s/2s/4s/8s backoff ladder followed by four more sequential
round trips, so that tail can legitimately land 15+ seconds late: seats snap
back to stored values, players seated in the interim vanish, and on a userId
change the previous run's tail still landed. Guarded from the first late
await to the end.

## 2. accountBalance had six writers and no fence

Three optimistic-relative (top-up debit, credit, buy-in debit) and three
awaited-absolute (loadTableInfo's tail, the BALANCE_UPDATED payload, and a
resync read fired from inside that handler). An absolute read ISSUED BEFORE
an optimistic debit could RESOLVE AFTER it and restore the pre-debit figure —
the player watches the buy-in sheet's balance snap back up. `readPlayerBalance`
is table-scoped, so a slow read could also land as another table's number.

Added a revision fence, lighter than `applyTableAppearance`'s write tail
because balances need no cross-request ordering, only "no stale absolute over
newer local truth": relative writes bump a revision; awaited absolute writes
capture it before the await and drop if it moved. The direct BALANCE_UPDATED
payload write is deliberately unfenced — no await, so it is the newest
information at the instant it arrives.

## 3. usePlayerStats: four maps, one key, last writer wins

Per-instance `useState` map + per-instance 30s flush + ONE global storage key.
With four tables mounted that is four maps that cannot see each other's hands
and four writers to the same key — opponent counters built at tables 1-3 were
silently destroyed by table 4's flush. A correctness bug wearing a
performance bug's clothes.

Now a module-level singleton read through `useSyncExternalStore`, with ONE
refcounted flush timer, `pagehide` and `visibilitychange` listener for the
document. Every table writes into the same per-opponent map, which is what a
per-opponent statistic means. Flush-on-the-way-out behaviour is preserved and
now fires when the LAST table closes.

## 4. The waitlist RPC that does not exist

`TableService.leaveTable` called an RPC named promote-next-waitlisted-player
on every cash leave. Of the 213 RPC names reachable from src/, it is the only
one with no definition in the database — so it has never once run; the failure
went into a console.warn. Removed rather than written, because the ENGINE
already owns this correctly (`notifyWaitlistSeatOpen` fires on every seat
vacate and flips the queue head to 'notified', which is the signal
GlobalWaitlistListener turns into the seat offer). It must not be revived as
written either: its notification told the player they had been seated, which
was a lie, and a client path that genuinely auto-seated someone would spend
their chips on a buy-in they never consented to.

## Pinned by

`tests/unit/lateAnswersCannotOverwriteNewerTruth.test.ts` (8) — the guards,
the fence (including "no raw relative write bypasses it"), the removed RPC,
and a live two-instance test proving the stats map is shared. The existing
`tests/unit/usePlayerStats.test.ts` (8) passes unchanged against the rewrite.

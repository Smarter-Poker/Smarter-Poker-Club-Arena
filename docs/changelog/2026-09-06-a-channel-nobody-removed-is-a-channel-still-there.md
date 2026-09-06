# A channel nobody removed is a channel still there

**2026-09-06** — branch `fix/a-channel-nobody-removed-is-a-channel-still-there`

Follow-up to `2026-09-06-the-realtime-wal-stream-was-decoding-for-nobody.md`,
found by reading that change back line by line rather than by anything going
wrong. Two of its three channel fixes carried the same leak they were written
to remove, in a smaller shape, and a third defect turned an unlucky test
invocation into twenty minutes of looking for a regression that did not exist.

## 1. `unsubscribe()` is not `removeChannel()`

`BombRequestBus` replaced one Realtime channel per bomb-pot table with a single
shared `engine:bomb-requests` channel. The engine holds ONE socket and a socket
caps at 100 channels; with 76 bomb-pot tables plus a channel per live
tournament it sat permanently over that cap — 123,219
`ChannelRateLimitReached` errors in 24 hours, about 1.4 every second, each one
retried.

It closed that shared channel with `channel.unsubscribe()`.

That leaves the socket. It does **not** remove the channel object from the
client's registry, and `supabase.channel(topic)` **appends** rather than
de-duplicating by topic. So every open/close cycle of the bus stranded one dead
entry under `engine:bomb-requests`, and the next `ensureChannel()` created a
second live channel on a topic that already had one. Bomb-pot tables open and
close all day, so that accumulates for the life of the process — against the
exact cap the file exists to stop reaching.

`TournamentManagerBase.cleanupBroadcastChannel` already went through
`supabase.removeChannel` for this reason. The bus now does the same, through
one `releaseChannel(ch)` helper. `removeChannel` unsubscribes as part of its
own work, so nothing is skipped by dropping the `unsubscribe()` call.

## 2. The same leak on the tournament broadcast's error path

`TournamentManagerBase.broadcast()` stopped joining a channel per tournament
and posts through `httpSend` instead — the fix that took 425 channels to zero.
Its `catch` then did:

```ts
this.broadcastChannel = null; // "nothing is joined, so this is one allocation"
```

`supabase.channel()` had still registered the object. Nulling the reference
leaves it there and the next call adds a second entry under
`t-break-<id>`. A tournament whose broadcasts keep failing — the only case that
branch runs at all — would grow the registry once per event for the life of the
process. It goes through `removeChannel` now.

## 3. A handle that reads as open because nothing said otherwise

The bus called `void ch.subscribe()` with no status callback, deliberately: a
retry loop against a Realtime service that is refusing joins is the behaviour
the file removes, and the durable path (`tables.bomb_pot_manual_pending`,
re-read on the throttled config refresh) fires the bomb anyway.

But one `CHANNEL_ERROR` then left `channel` non-null for the life of the
process. The bus reported itself open, nothing re-opened it, and the FAST path
to a manual bomb pot was gone until the next deploy with nothing saying so —
10.86's shape exactly, a signal answering confidently when it could not tell.

A terminal status (`CHANNEL_ERROR`, `TIMED_OUT`, `CLOSED`) now releases the
handle, so the **next table to ask** opens a fresh one. That is recovery
without a loop: `ensureChannel` is only ever reached from
`subscribeBombRequests`, which a table calls when it starts and on its
throttled config refresh. `releaseChannel` checks identity before acting, so a
late status from a channel that has already been replaced cannot tear down its
replacement, and the `CLOSED` that `removeChannel` itself causes is a no-op
rather than a double removal.

Thirteen cases in
`server/src/services/TheSharedChannelIsActuallyReleased.test.ts` pin all of it
against a fake client — including the ones that matter more than the leak:
dispatch reaches the named table and nobody else, a malformed broadcast never
throws into a dealing loop, one table's handler throwing does not stop the bus,
and a re-registration replaces the handler without opening anything.

## 4. An ENOENT that named no cause

Running the server suite as `vitest run --root server` from the repo root gave
nineteen failing files:

```
Error: ENOENT: no such file or directory, open '<repo>/src/GameServer.ts'
```

Nothing in that output says the invocation was the problem. Twenty minutes went
into asking which change had broken the tournament suite. The answer was that
nothing had: **68 files in the server suite read engine source through
`process.cwd()`**, which is correct only when vitest starts from inside
`server/` — what `.husky/pre-push` (`cd server && vitest run`) and `ci.yml`
(`working-directory: server`) both do. `--root server` moves the CONFIG root
and leaves the working directory at the repo root.

`server/src/testing/theSuiteRunsFromTheServerDirectory.ts` is a setup file that
refuses to run from anywhere else and prints the working directory it got, the
one it needed, why, and the command. It changes nothing about a correct run —
the full suite is 437 files and 6,267 tests, all passing with it in place — and
it can never make a correct run fail.

Rewriting all 68 to resolve from `import.meta.url` would also work and is
welcome one file at a time. It is 68 files across every open branch, so the
cheap half landed here and the expensive half can follow whenever those files
are touched for other reasons. `TheRecountWritesOnlyWhatChanged.test.ts`,
written yesterday, already does it the durable way and says why in its header.

## What was checked and found sound

Read back with the same suspicion, and reported here because "I looked" is
worth as much as "I changed":

- **Hero hole cards.** `table_hole_cards` is out of the publication and its
  client subscription is deleted. Three paths still deliver: the `sendToUser`
  push at deal time (sent _before_ the database write), `onResync` on every
  SUBSCRIBE including reconnect and mux join, and the bounded recovery poll
  re-armed on HAND_STARTED. Nothing anywhere in either repo subscribes to that
  table any more.
- **`tournaments` REPLICA IDENTITY FULL -> DEFAULT.** The client reads
  `payload.old.id` on a tournaments DELETE, which DEFAULT still carries. The
  table has recorded **zero** deletes, so the path is theoretical either way.
- **The bomb-pot contract end to end.** `fn_request_manual_bomb_pot` sends to
  `engine:bomb-requests` with `table_id` in the payload and `private = false`,
  which is what the bus joins and how it dispatches. The durable column is
  written in the same transaction, the engine reads it on config refresh, and
  it is cleared by a conditional `UPDATE ... WHERE bomb_pot_manual_pending =
true` so a re-read cannot fire the same bomb twice.
- **`updateTableStatus`'s conditional write.** `.eq('id', tableId)` and
  `.or(...)` combine with AND in PostgREST, so the filter narrows the row it
  already selected rather than widening it.

## Files

- `server/src/services/BombRequestBus.ts`
- `server/src/services/TheSharedChannelIsActuallyReleased.test.ts` (new, 13 cases)
- `server/src/tournament/TournamentManagerBase.ts`
- `server/src/testing/theSuiteRunsFromTheServerDirectory.ts` (new)
- `server/vitest.config.ts`

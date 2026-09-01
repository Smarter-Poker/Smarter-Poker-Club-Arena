# Phase 6 item 15 - a retry never tells a paid player they did nothing

2026-09-01. Branch `phase6/registration-retry-truth`.

## What it did

```ts
await retryAsync(
  () => supabase.rpc('fn_register_for_tournament', { p_tournament_id: tournamentId }),
  3
);
```

`retryAsync` retries on fetch, network, timeout, 503, 502 and 429. **Every one
of those can be raised for a request the server already committed** - a dropped
response is indistinguishable from a dropped request.

So: the buy-in is taken, the response is lost, the wrapper retries, the RPC
correctly answers `already_registered` because the player now IS registered,
and the client threw

> Already registered for this tournament

at somebody whose money had just moved. The product said nothing happened.

`fn_register_for_tournament(p_tournament_id, p_seat_first_internal)` has no
idempotency key to dedupe on - unlike `processRebuy`, which carries a
`p_client_token`.

## The fix

A retried write that comes back "already done" describes work THIS call
committed. Adopt it.

- `retryAsync` gains an optional `onRetry` callback. It changes no retry
  behaviour and reads may ignore it; it exists so a WRITE path can know that
  the thing it is about to interpret happened after a retry. The callback is
  wrapped in try/catch, because a caller's bookkeeping must never break the
  retry it is watching;
- registration records `didRetry`, and on `already_registered` **after a
  retry** it fetches the player's live entry and returns it exactly as the
  success path would, emitting the same `BALANCE_UPDATED` and
  `TOURNAMENT_REGISTERED` events;
- without a retry the message is unchanged. That case really is "you are
  already in this tournament", from another tab or an earlier click, and
  saying so is correct.

The adoption helper reads and never writes, and returns null rather than
throwing so the caller falls back to the ordinary error if anything is off.

## Why not a server-side idempotency key

That is the better long-term answer and it means editing a large money
function in place. It is not needed for THIS defect: the ambiguity is entirely
in the client's interpretation of a truthful server answer. A `p_client_token`
on `fn_register_for_tournament` is worth doing deliberately, not as a side
effect of a UX fix.

## Verification

- `npx tsc --noEmit`: clean.
- `tests/a-retry-never-tells-a-paid-player-they-did-nothing.law.test.ts`: 6
  tests, green. One of them pins that the retry itself is NOT removed -
  deleting the wrapper would also stop the false message and would lose the
  resilience it exists for.
- Registered in `docs/LAWS.md`.

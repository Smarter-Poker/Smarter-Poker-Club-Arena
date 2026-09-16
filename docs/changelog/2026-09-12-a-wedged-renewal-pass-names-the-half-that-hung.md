# A wedged renewal pass names the half that hung

**2026-09-12**

Round two on the lease renewal loop. The loop can no longer stop permanently —
a wedged pass is abandoned after the proof window (#4377) and a departed loop is
relaunched by its supervisor (#4386). What neither of those answers is **what
hung**, and that question cost most of a night.

## What it cost

On 2026-09-12 the renewal loop stopped for four and a half hours. Every cash
table was killed by its own twenty second proof watchdog and re-claimed, 26,129
times, three quarters of those engine lives dealing no hands, 1,483 hands
abandoned mid-play at tables holding nine of nine seats.

Telling a **hung pass** from a **departed loop** took a hand-diff of
`pg_stat_statements` against the container log — two readings of
`heartbeat_table_leases_v4` seventy-three seconds apart, against
`claim_table_lease_v2` over the same window — because the process itself said
nothing either way. Even then the answer was reached by elimination, not read.

## Why naming the half is enough

`performOwnedEngineLeaseProofRenewal` awaits exactly two things:

```ts
Promise.allSettled([
  this.renewVerifiedCashTableLeaseProofs(),
  this.renewVerifiedTournamentManagerLeaseProofs(),
]);
```

and each of those awaits exactly one thing — `heartbeatTables` and
`heartbeatTournaments`, one RPC each. Everything else in both halves is
synchronous, and the lost-engine work afterwards is fire-and-forget.

So the half still outstanding when a pass is abandoned **names the call that did
not come back**, with no third possibility left to rule out. That is the whole
value: it turns the next occurrence from an investigation into a reading.

```
sum by (half) (increase(poker_lease_renewal_outstanding_total[1h]))
```

## `finally`, not `then`

Each half clears its own flag with `.finally()`. A **rejected** half has come
back — it is not the one that hung, and blaming it would send the next reader at
the wrong RPC. `.then()` would leave a rejected half looking outstanding
forever. The test asserts exactly this, and fails on precisely that assertion if
the call is changed.

## What an increment would mean

Both halves go through a client bounded at 15s with at most three attempts, so
worst case is about 46 seconds. **Any** increment here is therefore already
surprising, and points at the bounded fetch in
`services/supabase/client.ts` rather than at the lease protocol — which is where
the search should start, and is not where this night's search started.

## Where this leaves the loop

Measured on one 90-minute engine lifetime after #4377 and #4386 deployed:

```
poker_lease_renewal_passes_total{outcome="completed"}   1060
poker_lease_renewal_passes_total{outcome="threw"}          0
poker_lease_renewal_passes_total{outcome="abandoned"}      0
cash_lease_proof_expired kills, 3 hours                    0
```

The wedge has not recurred. That is not the same as knowing it is gone, and this
is what will say which the next time it happens.

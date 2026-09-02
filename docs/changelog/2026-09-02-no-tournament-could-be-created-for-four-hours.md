# No tournament could be created for four hours

2026-09-02, found while verifying the Spin treasury work. Not a Spin defect.
The whole tournament product was down and nothing was reporting it as an
outage.

## Symptom

The last tournament of any kind to start did so at **20:44:53 UTC**. Four hours
later the count started since was **zero** - Spins, heads-ups, SNGs and MTTs
alike. The Spin board drained from 44 open boards to 0 and could not reopen.
Cash tables kept dealing throughout (436 hands in ten minutes), which is why
nothing looked obviously broken from the outside.

## Root cause

`trg_tournaments_publish_readiness` fires AFTER INSERT on every tournament and
calls `fn_tournament_management_readiness`, which contained:

```sql
jsonb_array_length(COALESCE(v_t.blind_structure,  '[]'::jsonb)) > 0
jsonb_array_length(COALESCE(v_t.payout_structure, '[]'::jsonb)) > 0
```

`tournaments.blind_structure` and `tournaments.payout_structure` are **text**.
`COALESCE(text, jsonb)` is not a coercible pair, so this raised
`42804 COALESCE types text and jsonb cannot be matched` on every evaluation -
and therefore on **every INSERT into tournaments**.

Obtained by reproduction, not inference: a real spin row was cloned inside a
transaction that was rolled back, which returned the message together with its
call site (`fn_tournament_management_readiness line 72`, via
`fn_guard_tournament_publish_readiness`). Two earlier probes with synthetic
rows produced different errors and would have sent me the wrong way; cloning a
row the platform had actually written is what made it reproducible.

## What the engine was saying, and why nobody heard it

- 458 `[ScheduledTournaments.insert_failed]` in ninety minutes
- 698 seat-first fill refusals in sixty, reported as
  `record "new" has no field "tournament_id"`
- 2,059 more refused as `tournament_full`

None of it raised an alert. The engine reported each failure at its own call
site, so the platform-wide shape - _no tournament can be created at all_ - was
only visible by asking the database when the last one started.

## The fix

`fn_safe_jsonb_array(text)` parses a text column that holds a JSON array and
never raises: null, empty, unparseable or not-an-array all read as `[]`. A bare
cast would have swapped this outage for another one the first time a row held
something unparseable. The readiness check uses it for both columns.

Verified by re-running the same clone probe: the INSERT now succeeds. Within
three minutes of the fix the platform had created 12 tournaments, 4 of them
Spin boards, having created none in the previous four hours.

## A second, independent defect found on the way

`fn_enforce_tournament_capacity` counted **every** `tournament_players` row:

```sql
SELECT count(*) INTO v_have FROM public.tournament_players
 WHERE tournament_id = NEW.tournament_id;   -- no status filter
```

so a row that reached `eliminated` or `winner` held its place forever. On a
three-handed Spin that is fatal rather than untidy: one horse leaving a
REGISTERING board makes it read 3 of 3 while two seats are live, the top-up is
refused `tournament_full`, and the board can never again reach the three paid
seats it starts on. It counts live entrants now - which is what the seat map,
the start gate and the lobby tile have always meant by capacity. That
disagreement was the bug.

## What this says about the alarms

Everything above was silent. The Spin gauges added earlier in this work read
healthy the whole time, correctly: `unbooked_spins` was 0 because no Spin was
running to be unbooked. A fleet that stops producing games looks identical to a
quiet night to every check that measures the games that exist. That gap is
recorded here rather than papered over; the honest metric is time-since-last
tournament start, and nothing watches it yet.

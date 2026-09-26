# An observation is qualified by the shape the database returns

2026-09-25. `horse_adaptive_observation_journal` holds **2,002,672** rows and
the newest was recorded at **2026-09-16 19:09:52 UTC**. Since 2026-09-17 07:00
UTC the observation capture has admitted **9,117** slices in the last seven
days with **0** observations between them, `horse_adaptive_journal_work`
batches have completed with `observations = 0`, and the horses' opponent
models have learned nothing new for eight days. Nothing alerted, because every
worker finished successfully. It captured nothing and said so in a column
nobody reads.

## What broke

PR #4726 (`3b638c020d`, merged 2026-09-17 06:05 UTC) added a recheck to
`qualifyAdaptiveHand` in `server/src/engine/HorseAdaptiveObservation.ts`:

```ts
!Number.isInteger(action.seat) ||
node.actorSeat !== action.seat ||
```

The intent is right. A persisted action must still belong to the seat whose
public node it carries; a changed actor must not inherit another seat's
position, price or stack. The check was written against the engine's own
`CompletedHandObservation`, where every controller action carries `seat`.

Production does not feed the qualifier from the engine. It feeds it from
`fn_horse_committed_observation_snapshot`, and that RPC projects every action
through a key whitelist before it crosses the service boundary (migration
`20260913195856_require_atomic_horse_observation_sources.sql`):

```sql
WHERE f.key IN ('userId','action','stage','timestamp',
                'publicNode','origin','observationIdentity')
```

There is no `seat`. There never was; the whitelist was written on 2026-09-12
to keep hole cards, names and outcomes out of the learning path, and the seat
was deliberately left to the public node ("Identity lives on the action").
Measured live on 2026-09-25: a recent hand's 17 raw `hand_history` actions all
carry `seat`; the same hand through the RPC carries `seat` on **0 of 17**. The
RPC's action keys are exactly `action, observationIdentity, origin,
publicNode, stage, timestamp, userId`.

So from the first deploy of #4726, every voluntary action in every committed
hand failed `Number.isInteger(undefined)` and was rejected as
`unavailable_public_node`. The capture worker admitted the slice with zero
observations and marked it captured; the batch worker completed the batch with
zero observations; the cursor advanced; the journal froze.

The unit tests passed throughout because the snapshot reader's test mocked the
RPC with a fixture that carried `seat`. The fixture described what the engine
produces, not what the database returns.

## What changed

`qualifyAdaptiveHand` now resolves the actor's seat from the shape the
database actually returns. The public node has no roster (its seat tuples are
numbers only, by design), and the RPC hand has no player list, so the only
ownership evidence in the projected shape is the hand itself: every captured
node names the seat that acted, and every action names the `userId` that acted.
Across one committed hand that mapping must be one actor per seat and one seat
per actor. `actorSeatsOf` builds it; a contradiction voids it for the whole
hand.

When an action carries `seat`, nothing changes: it must still be an integer
equal to `node.actorSeat`. When it does not, the seat is the one its `userId`
provably acted from in this hand, or nothing, and nothing is still rejected as
`unavailable_public_node`. An action with no resolvable actor (no `userId`, an
invalid one, or a hand whose ownership contradicts itself) is rejected exactly
as before, and the dependent public line is still excluded.

`COMMITTED_OBSERVATION_ACTION_KEYS` is now exported from the qualifier and
pinned to the migration.

Measured on a real committed cash hand projected by the live RPC
(`afddc51e-895a-4906-9d28-b16d014dcfc1`, 7 actions): before this change **0**
observations, `unavailable_public_node: 4`; after it **4** observations
(ordinals 2 to 5), `non_betting_action: 3`, no node rejections.

## What is not changed

- No migration. The RPC's whitelist is correct and stays as it is; `seat` is
  not added to it.
- The producer-side binding (`bindHorseObservationIdentity`) still requires
  `seat` and still checks it against the node before the atomic write.
- Every other qualification rule: identity, origin, time horizon, hand scope,
  street order, legal actions, deductions, tournament stage. In particular a
  tournament hand whose public node carries `tournamentStage.status =
'unavailable'` is still rejected as `unavailable_scope`; measured over the
  last two hours that is 13,031 of 83,665 captured actions (`context_incomplete`
  6,615, `invalid_public_context` 6,231, `hand_level_mismatch` 185), a
  separate matter this change does not touch. Cash hands (58,135 captured
  actions, 69%) and tournament hands with a captured stage (12,499) qualify.
- The frozen eight days are not backfilled here. `hand_history` retention for
  horse-only hands is eight days, so most of the window is already gone; what
  remains is captured by the ordinary workers once this deploys.

## How tested

- `server/src/engine/HorseAdaptiveObservation.committedShape.test.ts` (new,
  6 tests): a fixture built from the RPC's projected shape, no `seat`, exactly
  the whitelisted keys. Before the change it fails with 3 of 3 voluntary
  actions rejected `unavailable_public_node`; after it, 3 observations and no
  node rejections. It also pins the whitelist: the latest migration that
  defines `fn_horse_committed_observation_snapshot` must project exactly
  `COMMITTED_OBSERVATION_ACTION_KEYS`, and must not project `seat`.
- `server/src/services/HorseCommittedObservationSnapshot.test.ts`: the mocked
  RPC action no longer carries `seat`; the fixture is now the database's shape,
  and a new test asserts that key set and that the hand qualifies. All 45 pass.
- `server/src/engine/HorseAdaptiveObservation.test.ts`: the seat-disagreement
  cases (`null`, `0`, `2`, `1.5`) still reject; a stripped-seat replay of a
  whole controller hand qualifies identically to the seated one; a stripped
  seat whose `userId` is another seat's actor is rejected. 90 pass.
- The eleven files that import the qualifier, journal, snapshot and opponent
  model: 357 tests, all passing. `tsc --noEmit -p server` clean.

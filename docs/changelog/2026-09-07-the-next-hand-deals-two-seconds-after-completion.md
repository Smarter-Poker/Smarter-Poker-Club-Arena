# 2026-09-07 - The next hand deals two seconds after completion, and Rabbit Hunt displays and moves on

Dan, verbatim, two bugs in one message:

> "IF YOU USE 'RABBIT HUNT', IT CREATES A BUG WHERE THE NEXT HAND DELAYS FOR
> QUITE A WHILE BEFORE STARTING THE NEXT HAND ... INSTEAD OF IT JUST
> 'DISPLAYING AND MOVING ON'."

> "LOTS OF HANDS ARE NOT STARTING THE NEXT HAND 2 SECONDS AFTER THE HAND IS
> COMPLETED, MOST ARE TAKING MORE THAN 2 SECONDS, SOME UP TO 10 SECONDS+ TO
> GET THE NEXT HAND STARTED."

Branch `fix/the-next-hand-deals-two-seconds-after-completion`. Law:
`tests/the-next-hand-deals-two-seconds-after-completion.law.test.ts`; ruling
recorded in `docs/LAWS.md`.

## What was measured before anything was changed

**hand_history, production, 2026-09-07 22:30 UTC**, cash tables, the last 40
minutes, gap = the next hand's `started_at` minus this hand's `ended_at`
(`ended_at` is stamped when the hand row is written, near the top of the
completion hold; `started_at` at HAND_START):

| tables      | hands | p50   | p90   | p99   | max    | over 10s |
| ----------- | ----- | ----- | ----- | ----- | ------ | -------- |
| horse-only  | 6,445 | 11.2s | 20.6s | 46.8s | 197.7s | 3,929    |
| with humans | 25    | 12.1s | 29.3s | 48.7s | 52.2s  | 20       |

One human table, three consecutive boundaries: 26s, 12s, 18s, 29s.

**Where the seconds went**: a one-second poll of `/health.tableLiveness[].loopPhase`
for four minutes after the 02:00 restart, 329 between-hand gaps on cash
tables. Mean seconds per gap, by loop phase:

| phase                   | mean  | max   | in % of gaps |
| ----------------------- | ----- | ----- | ------------ |
| await_post_hand_tasks   | 5.88s | 16.8s | 99%          |
| post_hand_hold          | 3.06s | 19.4s | 100%         |
| load_next_hand_inputs   | 2.80s | 13.2s | 100%         |
| post_hand_rabbit_window | 1.81s | 2.8s  | 100%         |
| announce_seat_moves     | 1.53s | 5.1s  | 75%          |
| leave_pending           | 1.39s | 6.6s  | 71%          |
| rebuy_pause             | 4.29s | 5.4s  | 1%           |

p50 of the gap in that window: 15.8s. p90: 23.3s.

**Why each phase costs what it costs**: Postgres is idle (56 PostgREST
connections idle, 1 active, statements in milliseconds), but a PostgREST
round trip FROM THE ENGINE BOX is 250-700ms. Measured with a second Node
process inside the container: six `GET /rest/v1/tables?limit=1` in
633/603/350/447/643/564ms, four `POST /rest/v1/rpc/fn_platform_frozen` in
678/415/810/513ms; `curl -w` on the host shows 31ms to TLS and 200-700ms to
first byte on a kept-alive connection; ping to the API host is 1ms; a
direct `psql` statement to the pooler is ~80ms. The gateway-to-PostgREST-to-
database path costs a quarter to three quarters of a second per call, and
the engine's between-hand path was a chain of them, every one serial:

- `postHandTasks`: sync_stacks, hand_history, rake_distribution,
  bbj_contribution, leave_pending, table_unlock (two calls) - seven or eight
  round trips in one file order, 3-5s, against a completion hold of 2.1-3.5s
  (the hold was halved by #3491 earlier the same day).
- then `load_next_hand_inputs`: the roster was two round trips in series
  (seats, then profiles), the blinds and rake reads were already overlapped
  (#3592).
- then `leave_pending` again (the loop-level sweep), then
  `announce_seat_moves`, then - inside `dealHand` - the global hand number.

Every one of those ran AFTER the engine had already slept the board clear
(0.4-0.6s) and the 1.75s Rabbit Hunt rest. The 15-second CPU profile of the
live process (inspector over SIGUSR1) was 32% idle, 12% HorseEval, 10%
undici: the core is busy but it is not the bottleneck tonight; the transport
is.

## The ruling, and what "completed" means

"Completed" keeps its 2026-08-21 meaning: the winning hand shown, the pot
pushed with its total, the cards mucked - the end of `handCompletionHoldMs`.
Nothing about the animations changed. From that instant to the next deal is
now ONE number, `HAND_COMPLETION.NEXT_HAND_REST_MS = 2000`, and it is the
WHOLE gap:

- the board clear (`boardClearMs`, still the client's animation length) is
  inside it - the rest is armed as `max(NEXT_HAND_REST_MS, boardClearMs)` so
  the clear can never outlive it whatever the constants become;
- the Rabbit Hunt window (Dan 2026-09-05) IS the rest.
  `RABBIT_HUNT_WINDOW_MS` is the same number under its own name, pinned
  equal, and still at or above the client's 2s `RABBIT_MIN_VISIBLE_MS` floor;
- every piece of next-hand bookkeeping runs INSIDE it.

The five-second rebuy pause (Dan 2026-08-24, horses included under 10.5) is
untouched and remains its own beat, only when a dealt player busted.

## What changed

### 1. The rest is armed at the hand-free broadcast and awaited before the deal

`ServerTableEngineDealing.ts`. After the completion hold the engine
broadcasts the clean state (which is what shows the Rabbit Hunt button),
then `armNextHandRest(...)` records the deadline and returns. The loop goes
straight to the top of its iteration - the settlement barrier, the roster
read, the sweeps, the seat-move notice - and `awaitNextHandRest()` sleeps
whatever is left of the two seconds immediately before `dealHand`. The felt
waits for whichever finishes last. Unconditional on every hand, nothing to
branch on between the broadcast and the arming (10.5: timing is part of the
treatment).

### 2. Settlement runs as two lanes under the hold

`ServerTableEngineSettlement.ts`, `postHandTasks`. After `sync_stacks` and
the tournament conservation check, the steps fall into two lanes with no
dependency between them:

- THE RECORD: hand_history, rake_distribution, bbj_contribution,
  promo_playthrough, insurance_ledger, bbj_mini_payout, bbj_payout,
  tournament_chip_sync.
- THE SEATS: pending_addons, horse_rebuys, chip_continuity, horse_cashouts,
  deferred_sitouts, leave_pending, table_unlock.

`runStep` now files each step by NAME into its lane (`STEP_LANE`) and
returns at once; a step runs after the previous step of its own lane, in
file order, and the barrier waits for both lanes at the end. Every
`await runStep('...')` line and every step body keeps its shape, which is
also what the eight ordering laws on this function pin. A step with no lane
entry (`sync_stacks`, or anything added later without one) runs and is
awaited in place, ahead of everything after it in the file, exactly as every
step used to. A plain cash hand therefore pays the longer lane (three or
four round trips) instead of the sum. The hand row is written from
`playersForRecord`, a copy taken synchronously before either lane starts,
so a rebuy or an add-on the seats lane credits can never reach the record. **The exception is the money one**: on a jackpot or insurance hand
(`snap.bbjHit`, `snap.miniBbjHit`, `snap.insuranceSettlements`) the payouts
write `updatedStacks` onto the very seats the other lane reads, so those
hands run the lanes one after the other exactly as before. `snap` remains
the only hand state read in either lane (StaleContinuationSweep law); both
stack writes are still gated on the conservation verdict
(TournamentChipsAreConserved law).

### 3. The roster, the leave sweep and the hand number are read together

`prepareNextHand()` replaces the top-of-loop `readNextHandInputs()` call: it
starts the leave-pending sweep and the hand-number allocation, then runs the
roster/blinds/rake reads, all under the rest. The sweep races the roster read
ONLY when no add-on is pending (an add-on must credit a seat before that
seat can leave, so the serial order pending_addons then leave_pending is
kept whenever one exists); the loop's `leave_pending` step consumes the
prepared result and applies the same per-player teardown it always did.
`dealHand` takes the prepared hand number and only allocates itself when
none is held; a held number older than 15s is discarded, so the sequence
still ascends in deal order.

### 4. The roster is one round trip

`loadSeatedPlayers` embeds the profile in the seat row through
`fk_table_seats_user_id_profiles` (verified on production: 200, 434ms, the
profile object inline) - the same columns, the same alias, the same filters,
one request instead of two in series. The two-step read is kept as the
fallback and reports when it is used, so a PostgREST that cannot resolve the
embedding degrades to slower, never to empty. The avatar column rule
(`SEATED_PROFILE_SELECT`, the-felt-reads-one-avatar-column law) is
unchanged and read by both paths.

### 5. The gap is measured

`server/src/engine/NextHandGap.ts`. Every engine records completion-to-deal
and its per-phase split; `/health.nextHandGap` reports, over the last ten
minutes: samples, p50, p90, max, `over` (gaps beyond the rest plus 500ms of
slack, rebuy-paused gaps excluded and counted separately) and the p50 of
each phase. Gaps that contained an idle phase (short-handed, parked, a spin
reveal hold) are not samples of the rest and are dropped.

### 6. Rabbit Hunt displays and moves on

`src/components/table/retainedRabbitBoard.ts`, `TablePage.tsx`. The
purchase never touched the engine's schedule (the reveal handler is an HTTP
call the loop does not wait on; #3624 earlier tonight took the metadata
insert off its response). The delay Dan saw was on the client: a reveal that
landed after the next HAND_STARTED painted the PREVIOUS hand's whole board
over the next hand's preflop for up to 3s, with the new hole cards already
dealt around it - the next hand looked like it had not started.
`retainedBoardShows` now yields to a newer hand the moment it exists. What
survives the boundary is only the ghost cards themselves
(`retainedGhostsShow`): drawn in the new hand's empty preflop slots so a paid
reveal that arrived late is still readable, and gone at the flop.

## What did NOT change

- No animation is shorter. `handCompletionHoldMs` and every keyframe it
  covers are as #3491 left them (10.6).
- No money step was removed, reordered within its lane, or made
  fire-and-forget. The settlement barrier still holds the next deal until
  both lanes are done; the 5-minute liveness wait is untouched.
- Horses are players: every path here is the same for a horse and a human.
- The transport itself. A PostgREST round trip still costs 250-700ms from
  Ashburn to us-west-2; this change takes round trips off the critical path
  and overlaps the rest, it does not make them faster. The engine also
  writes ~75 `Timer event` log lines a second to a json-file docker log;
  neither is addressed here and both are worth a separate look.

## Expected numbers, and how to check them

Per hand, after this publishes (the engine adopts `main` at the :55
restart): completion to deal should be 2.0s whenever the lanes finish under
the hold and the roster read under the rest - i.e. `nextHandGap.p50Ms`
within a few hundred ms of 2000 and `over` a small fraction of `samples`.
Where the transport spikes past ~700ms per call the gap will run over by the
overrun, which is what `over` counts.

    curl -s https://engine.smarter.poker/health | python3 -c "import json,sys; print(json.load(sys.stdin)['nextHandGap'])"

and the same hand_history query as above (cash tables, 40 minutes), where the
ended_at-to-started_at gap should read hold + 2s: roughly 4-5.5s p50 on the
current cadence, against 11.2s tonight.

## Verification

- server: `tsc --noEmit` clean; NextHandInputs, ActionPacing,
  StaleContinuationSweep.law, ChipContinuity.law,
  TournamentChipsAreConserved.law, PacedAllInRunout,
  RabbitHuntReveal.behaviour, NextHandGap - 104 tests green.
- client: the law test, law-registry, rabbitHuntHasTimeToClick (rewritten
  for the new shape), handCompletionLaw, rabbitRevealIsHandSafe (rewritten
  for "display and move on"), rabbitAuditFollowups, ritTimelineParity, the
  avatar-column law and the roster-select contract tests green; full client
  suite and `tsc --noEmit` results in the PR.
- Real hardware is Dan's: sit at a cash table after the next :55 restart and
  count the seconds from the pot landing to the next cards flying.

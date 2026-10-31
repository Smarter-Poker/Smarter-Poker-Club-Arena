# Lightning is held for the engine cutover (2026-10-30)

## What was wrong

The legacy one-shot checkpoint that replaces the serving original engine
(EED `eed06fe51dea622069c661a6213d5b031ff3a9e3`) refuses with
`retained_lightning_host_census_unproven` while a single concrete
`LightningHandHost` is alive in the old process
(`server/scripts/retained-original-checkpoint-guard.mjs`). That rule is right:
a resolved `whenFinished()` can mean `settlement_unknown`, so no terminal label
substitutes for the host being gone.

But Lightning deals roughly 5,600 hands an hour across eleven Clusters, so a
host is nearly always in the air. The maintenance break parks every classic
table at a hand boundary; nothing parked Lightning, because its hands are
formed by the Clusters' workers, not by table engines. The 15:55 UTC release
attempt on 2026-10-30 was refused for exactly this, with the whole floor
already paused for nothing.

## The fix

Phase 13 already built the door: `fn_lightning_operator_control(cluster,
'pause', reason, {request_id})` holds a Cluster at its own boundary - no new
hand forms, a hand already dealing plays out and settles, a formation not yet
dealt is void with no chip moved - and `resume` returns it to exactly the mode
it was paused from. The release transaction now uses that door, with the
release's own run key as the operator and the reason.

- `server/scripts/engine-release-lightning-hold.py` (new, packaged in the
  control generation and syntax-checked before activation):
  - `pause` lists every Cluster in `cluster_mode = 'lightning'`, pauses each
    through the operator door with a request id that is `uuid5(run key,
    action, cluster)` so a retry replays rather than acts twice, and records
    WHICH CLUSTERS THIS RUN PAUSED in `<run>.lightning-hold.json` beside the
    release request. A Cluster that was already paused belongs to whoever
    paused it: recorded as `already`, never resumed by this run. A door
    refusal (`CLUSTER_BUSY` while a drain is in flight) is PARTIAL with its
    code named. An unreachable database is UNKNOWN (exit 3). The hold file is
    written after EVERY answered Cluster (a SIGTERM does not run `finally`),
    the listing includes `paused` Clusters, and request ids replay, so a
    pause killed between two Clusters strands nothing: the retry records the
    one already paused by its replayed answer and continues. A partly
    released hold is re-held under a new generation.
  - `resume` resumes exactly the held list and retires the file to
    `.released`. A refused resume keeps the file for the next reader.
  - Three outcomes (0 done, 1 partial, 3 unknown), pinned project host, no
    redirects, credentials never printed, no horse flag read.
- `engine-release-transaction.sh`: `hold_lightning_when_counting_down` runs on
  every legacy-checkpoint loop pass, before the entry clock starts, and places
  the hold once the serving engine's `/health` says the break is `active`,
  `counting_down` and `durableConfirmed` AND is a break this release may use
  - narrowed to what THIS run can consume, as the countdown narrows it: an
  owner-window release only on its `Deployment Recovery` break, a daily-floor
  release only on the daily 03:58-04:05 Chicago break inside its floor, any
  other release on the countdown's three admissions (daily, Deployment
  Recovery, the transition break). The
  serving original still announces an hourly :55 break the countdown refuses;
  a hold on those would have parked Lightning for hours while a release
  waited (caught in review before merge). Placing it at the announcement
  gives the ~2-minute warning plus the break for hands in the air to settle
  and their hosts to be collected (the supervisor reads `cluster_mode` every
  15 s). Never in a drill. `release_lightning_hold_if_break_over` gives
  Lightning back as soon as a qualifying break has passed without a cutover,
  and the next qualifying break holds again under a new hold generation
  (request ids carry the generation, because the door replays a repeated id
  instead of acting). A helper that cannot run
  says NEVER ASKED and the census guard still decides on its own; an UNKNOWN
  answer is retried on the next pass. `release_lightning_hold` runs from
  `recover_on_exit` on EVERY exit path - sealed, refused, died, interrupted -
  waits for `/health` to report the break over (bounded by the latest known
  break end plus 90 s, never more than ten minutes), then resumes with three
  attempts; on a signalled exit it makes one attempt inside what is left of a
  300 s stop clock stamped when the exit began, so systemd's 330 s budget is
  never exceeded. It is safe under `set -e` (every helper exit is caught), it
  runs after the engine lock is released, and a hold that could not be
  released is retried on every later pass while the file exists - the
  break-over check runs on every pass, not only the legacy one. A retried
  transaction (systemd restart after a signalled exit) inherits its
  predecessor's hold from the file. A refused resume (`CLUSTER_FROZEN`, say)
  is asked again under a new attempt number: the door replays a repeated
  request id with its first answer, refusals included, so a retry under the
  same id could never succeed. A partly released hold is re-held under a new
  generation at the next qualifying break, and that generation asks again
  about Clusters another operator had paused last time. A hold that still cannot be released stays on disk and says so.
- `engine-release-recover.sh --mode terminal` is the second reader: it resumes
  a hold file left behind, loudly, without blocking terminal retirement.
- `install-engine-supervisor.sh`: the helper is in `REQUIRED_FILES` and the
  Python syntax loop.

Control scripts run from main's bytes on the host, so this applies to the next
attempt without a cutover.

## What this does not do

It does not weaken the census guard, touch the certificate, the rollback
reserve or the thaw, and it does not pause `must_move`, `pending_*` or
`draining` Clusters (they form no Lightning hand; the door refuses the busy
ones on its own). It never adds a timer, watcher or repair loop: the hold is a
step of the one bounded transaction, and its second reader is the fence that
already runs for that transaction.

## Tests

- `tests/operations/engine-release-lightning-hold.test.py` - 18 unit tests
  over the helper with a scripted operator door.
- `tests/lightning-is-held-for-the-engine-cutover.law.test.ts` - packaging,
  the placement gate, the release-on-every-exit wiring, the second reader,
  the door contract, and it runs the Python suite.

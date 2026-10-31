# 2026-10-31: eed06fe5 is replaced at a drained hand boundary, not by a census that cannot fit

Owner (Dan), 2026-10-31 ~21:00 UTC: "Build a checkpoint-free cutover" - every
table drains to a hand boundary so no in-flight hand needs checkpointing - plus
a gate that refuses before any notice if the census would be needed and cannot
fit.

## What the 19:55Z attempt actually saw

Receiver 41233374402 logged, 0.7 s into the countdown:
`unparkedTables=78 unparkedReasons={'cards_in_air': 78} handsInFlightTotal=0`.

- `cards_in_air` is eed06fe5's own census (MaintenanceBreak.unparkedTables):
  a REGISTERED, running table engine whose `isBetweenHands()` is false, i.e.
  `handController !== null || pendingOriginalContinuation` - a hand still
  playing out, or a prepared/restored original waiting at the pause gate.
  Engines that are not running are skipped by that census.
- `handsInFlightTotal=0` is not a contradiction and is not evidence of a drained
  boundary. eed06fe5 counts a table only when `!paused`, and `paused` is
  `isPausedByDesign()`, which is true for every table the maintenance break is
  holding. Inside any countdown the figure is zero by construction.
- The 78 were hands still finishing after the 120 s last-hand lead. The break
  log shows the same engine opening its restart certificate 5-107 s into the
  countdown in 8 of its 13 breaks since 2026-10-29 (16-96 tables unparked at
  countdown), and never in the other 5 (including 14:55Z and 19:55Z today).

## When the legacy checkpoint was required

Before this change: purely by identity. `LEGACY_CHECKPOINT_REQUIRED=1` whenever
the sealed predecessor is one of the five pinned SHAs, and the eed06fe5 entry
opens the checkpoint at the first certified countdown read (285 s rung) whether
or not the certificate is open. So under the existing rules even a fully
parked eed06fe5 could only be replaced through the full-heap census.

## What changes

`server/scripts/engine-release-transaction.sh`:

1. **The census is measured before any notice.** `legacy_census_fits` reads the
   serving eed06fe5's own `/health` `memory.heapUsedMb` and admits the census
   only if `(heap + 1) * 12 ms <= 30300 ms` (11-12 ms/MB measured by the
   previous release agent on an application-shaped heap; 30.3 s is what the
   census request was actually granted at 19:55Z). Unreadable heap or a
   different serving SHA is "could not tell", never a fit. The decision is made
   before the wait loop, so `request_recovery_window` never announces for a
   census that cannot finish, and it is re-read at the top of every pass and
   immediately before the one-shot intent (only the rollback proof follows).
   A census that does not fit is never entered: the predecessor's main thread
   is never blocked by it.
2. **Otherwise the only route is a drained hand boundary.** The release takes
   the ordinary ladder (260000 ms admission, 245000 ms locked read, unchanged)
   with two additions: the certificate is STRICT (`readyForRestart` and zero
   unparked tables; the bounded-F06 database admission is refused, because a
   bounded preparation is a retained hand), and under the engine lock, before
   the locked certificate, `engine-release-inflight-hands.py
   --drained-predecessor` must answer QUIET. Lightning is held by the same
   `hold_lightning_when_counting_down` the checkpoint path uses.
3. **Refused before notice** when the census cannot fit and that witness cannot
   be read (for example before its migration is installed): the release dies
   before the loop, so no break is spent.

`server/scripts/engine-release-inflight-hands.py --drained-predecessor` reads
both halves before judging, and any unreadable half is UNKNOWN (exit 3):

- `public.fn_ca_release_drained_predecessor_witness` (new, read-only,
  service_role only; `supabase/migrations/20261031212432_...`): no
  `smarter_private.hand_continuations` row written in the last 120 s (every
  tournament hand anywhere in the process writes its continuation as it moves),
  and no `lightning_hand` formed in the last 600 s still unsettled;
- the existing `hand_state_snapshots` read (no incomplete snapshot in 120 s).

Movement, not existence. At 21:25Z all 272 open continuations belonged to
reserved permits; ~100 of them were 5-20 minutes old on stalled tournament
tables (19 of the 20 stalled tables /health lists). Those are durable, the
successor resumes them from that table, and gating on "no open continuation"
would have refused every cutover for ever. Their totals are logged, not gated.

## What this does not do

No ceiling moves (120 s last-hand lead, 300 s freeze, 285 s reserve, 245 s
floor, 135 s rollback, 40 s checkpoint, v3 thaw). No hand is voided,
discarded, forced or invented; no chip or seat is touched; no publisher,
watcher, timer or retry loop is added. Horses are counted exactly like
everyone else. When the census fits, the existing checkpoint path is
unchanged.

Residual, stated plainly: without the native census the release cannot see a
detached object that holds only in-memory state and writes nothing (for
example a stopped shadow's time-bank mirror). Everything a hand needs to
resume or settle is witnessed in the database.

## What the first supervised :55 attempt should expect

The migration must be installed first (`apply-merged-migration.yml` after the
merge); until it is, the release refuses before notice. At the 3.7 GB live
heap the log names `fits=False`, then "may be replaced only at a drained hand
boundary". The cutover happens only if eed06fe5's own certificate opens with
at least 260000 ms left (within ~40 s of the countdown) and the witness is
quiet. On the 13 measured breaks that timing held twice (14:55Z on 10-30 at
~35 s, and the 09:00Z daily on 10-31 at ~5 s), so a refusal that leaves the
break to thaw on its own clock is the likely outcome of any single attempt.

## Tests

- `tests/operations/eed-drained-cutover.test.py` (21 cases): the real queue
  with eed06fe5 sealed; the embedded census-fit and strict-certificate
  programs; the helper's drained mode with scripted database answers.
- `tests/eed-is-replaced-at-a-drained-hand-boundary.law.test.ts`, registered
  in `docs/laws.d/`.
- Unchanged and passing: `engine-release-window-queue.py`,
  `legacy-entry-clock.py`, `engine-release-recovery-window.py`,
  `engine-release-forward-admission.py`, `engine-drill-admission.py`,
  `engine-activation-floor.test.py`, `main-inspector-retirement-host.test.py`
  and the release law tests that read the transaction.

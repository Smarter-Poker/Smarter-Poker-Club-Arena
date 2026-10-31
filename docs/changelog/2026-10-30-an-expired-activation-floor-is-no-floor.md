# An expired activation floor is no floor (2026-10-30)

## What was wrong

`server/release/activation-floor.json` is a one-time manifest: a v1 daily
boundary or a v2 owner window names one activation and one expiry.
`engine-release-activation-floor.py` refused every fresh read of an expired
manifest with `one-time activation window expired` - `prepare` on the
receiver, `admit` in the intake and the transaction, `wait`, `publish`,
`entry-check` and `disposition` alike.

So the day after an owner window lapsed, every target on protected main still
carried that manifest and nothing could be released - not through the owner
window (gone) and not through the routine 04:00 America/Chicago route (never
consulted) - until a human edited the manifest. Diagnosed on 2026-10-30 as one
of the reasons no engine cutover had landed: the window
`2026-10-30-horse-river-model-and-heap-fix-next-55` expired at 19:40 UTC and
the next daily preparation would have been refused for every target.

## The fix

`effective(record, now)` in the helper: a record whose `expiresEpoch` has
passed is read exactly as a target with no manifest (`None`), and the helper
says so on stderr - `activation floor <schema> (<window or daily>) expired at
epoch N; the routine daily maintenance route applies`. Every fresh read goes
through it (`prepare`, `admit`, `wait`, `publish`, `entry-check`,
`disposition`, `entry`, `announcement-entry`). The in-flight owner reads keep the
exact record: `reservation`, `checkpoint-no-action`, and any entry mode where
this run already holds an activation entry (an announced owner being promoted
to runtime is judged by `check_window` against its real window, never
downgraded to `legacy`); an existing entry is also still read before any Git
work, as before.

Two behaviour changes downstream, both the pre-floor behaviour for a fresh
run and stated here: `disposition` for a run on an expired floor that never
wrote an activation entry now answers `legacy` instead of `never-entered`,
so `engine-release-recover.sh` runs its ordinary exact-desired restoration
for it (the restoration every legacy release has always had); and
`entry-check` answering `legacy` means such a run is admitted through the
legacy recovery path rather than the floor's never-entered guard. One guard
added in the transaction: a run that ANNOUNCED inside an owner window which
has since expired reads `legacy` from its fresh `admit`, and now dies by name
(`announced inside an owner window that has since expired`) instead of a
KeyError traceback on `expiresEpoch`.

Otherwise nothing downstream needed to change: a legacy record already means the
routine route everywhere. The receiver skips the pre-floor image preparation
step, the transaction waits for the daily 04:00 certificate, and
`owner_window_reason` already ignores a window whose `notAfter` has passed.
A malformed manifest is still a refusal, never a fallback.

## Tests

`tests/operations/engine-activation-floor.test.py` (run by
`tests/an-engine-activation-floor-precedes-runtime-writes.law.test.ts`):

- new `test_expired_floor_reads_as_no_floor_on_every_fresh_read`: pure
  `effective` at and after expiry for a daily and an owner record, the CLI on
  the real clock over the expired fixture floor for all eight fresh modes
  (routine JSON / `legacy`, no entry created), and a malformed manifest still
  refusing;
- the intake test now proves refusal before the installer with a floor that
  has not yet come (`FUTURE_DAILY`) and admission to the routine route, with
  the installer running, for the expired one;
- the recovery test proves an expired floor recovers as a legacy request and
  a live floor still refuses runtime restoration to a never-entered request.

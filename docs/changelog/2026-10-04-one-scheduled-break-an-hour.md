# One scheduled break an hour (2026-10-04)

Dan, from the pre-launch phone test: "THERE ARE CURRENTLY TWO SCHEDULED
MAINTENANCE BREAKS, ONE AT THE :55 AND THE NEXT ONE STARTS AT THE :11 FIGURE
OUT WHAT THE 2ND ONE IS FOR, AND REMOVE IT IF ITS NOT NECESSARY."

## What the second break was

Not a schedule. It was the off-cycle "Deployment Recovery" window
(`docs/changelog/2026-09-17-event-owned-engine-recovery.md`): the engine
release transaction could reserve one extra certified break when a release had
failed or had watched the :55 break admit nobody. The break Dan saw at 9:11 CDT
on 2026-10-03 (14:11Z) followed engine release run 37128652461 failing at
14:09Z.

## Is it necessary

For those two routine causes, no. The same release is admitted by the next :55
break, which the engine takes anyway; the extra window parked every table for
seven more minutes to ship a fix up to an hour sooner. With several failed
releases a day that is several extra platform-wide pauses a day.

It IS necessary for what cannot wait for :55: a serving engine that is dead,
stalled or wedged, a commit carrying the `Engine-Release: urgent` trailer, and
a release no scheduled break can admit before its certificate deadline.

## What changed

`server/scripts/engine-release-seal.py`, `reserve-recovery-window`: the seal
no longer derives a cause from an unshipped failed release
(`failed-release:<run>`) or from `--missed-window`
(`observed-missed-certificate`). Without a named emergency cause it answers
`unavailable`, which the transaction already handles by waiting for the
scheduled break. `--missed-window` is still accepted, so the unchanged
transaction's call is not an error. The three named causes, the one-per-
rolling-hour limit, the certificate, the admission ladder and the rollback
reserve are untouched. Nothing in the engine runtime changed.

Pinned in `tests/engine-release-seal.law.test.ts` ("reserves one recovery
window only for a named emergency, never for a failed or missed release").

## Installation

The seal is host release control, installed with the engine supervisor
generation. It takes effect when that generation is installed on the engine
host, not when this merges.

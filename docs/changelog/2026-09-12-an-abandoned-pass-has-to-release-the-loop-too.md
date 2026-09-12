# An Abandoned Pass Has To Release The Loop, Not Just The Slot

**2026-09-12** · `GameServer.runOwnershipLeaseRenewalLoop`

## Half A Fix, Measured

Earlier today the ownership lease renewal loop was found wedged: a pass that
never settled held `ownershipLeaseRenewalOperation` forever, every later tick
awaited that same hung promise, and every cash table died on its twenty second
proof and was re-claimed.

The fix added an abandon timer. It frees the slot so a new pass **can** start.

This loop is the only thing that ever starts one, and it was still awaiting the
promise the timer had just given up on. **The slot opened and nobody walked
through it.**

Production said so within three hours, on the release carrying that timer:

| Time      | `completed` | `abandoned` | `loop_running` |
| --------- | ----------- | ----------- | -------------- |
| 10:20     | 274         | 0           | 1              |
| 10:24     | 322         | 0           | 1              |
| 10:28     | 368         | 0           | 1              |
| **10:30** | **374**     | **0 → 1**   | 1              |
| 10:34     | 374         | 1           | 1              |
| 10:40     | 374         | 1           | 1              |
| 10:44     | 374         | 1           | 1              |

`completed` froze at 374 for fifteen minutes. `threw` stayed 0. `loop_running`
read 1 the whole time, so the loop was alive and had simply stopped iterating on
one await that never returned. **No second pass was ever abandoned either, which
is the proof that none was ever started.**

The cash fleet followed one minute later:

```
10:31   cash_lease_proof_expired    44
10:32   cash_lease_proof_expired   112
10:33   cash_lease_proof_expired   114
...
10:43   cash_lease_proof_expired   116
```

Only the 10:45 restart cleared it.

## The Change

The loop now races the pass against the same deadline the pass itself is held
to, plus one cadence so the abandon timer always fires first and the slot is
free by the time the next iteration asks for it.

An abandoned pass keeps running and stays identity-guarded. It just stops being
something the platform's only renewal loop waits on.

The outcome is recorded by whoever actually decided it: the timer counts
`abandoned`, and the loop counts `completed` or `threw` only when the pass really
settled, so one pass is never counted twice.

The wait is cancelled and unref'd. This runs every five seconds for the life of
the process, so a wait outliving its own pass would leave a handle per pass and
hold the event loop open at shutdown.

## Why The Instrument Earned Its Place

This was not found by reading the code. The abandon timer, the `abandoned`
outcome and the `loop_running` gauge were added this morning precisely so that
the next occurrence would name itself, and it did: one abandon, a frozen
`completed`, a loop still reporting itself alive. That triple says "stopped
iterating" and nothing else does.

## Pins

Two cases added to `GameServerLeaseRenewalWedge.test.ts`.

Proven to bite: reverting the loop fails
`starts the next pass after the abandon deadline, even though the first never
settles` with `expected 1 to be greater than 1`, in 3ms, while the other four
keep passing.

The second case is the guard against over-correcting: a healthy pass must not be
paced by the abandon deadline. Twenty-one seconds at a five second cadence is
four or five passes, never one.

The teardown is deliberately bounded. Without the fix the loop never re-reads its
admission check, so awaiting it would turn a clear assertion failure into a
file-level timeout and hide which pin broke.

# Two tests in a required gate were measuring the runner, not the code

2026-09-08. Club Arena. Two test files, no production change.

## Why this was worth a branch

Both of these sit in `Server Engine (typecheck + tests)`, which is one of the
six checks the `main` ruleset requires. A test that fails on load in a required
gate does not fail quietly: it blocks every pull request behind it. They cost
two re-runs during the phase 7 and phase 8 work alone, and the second one is a
test that had already been hardened once for exactly this.

Both failures happened while the estate was at **33 of 33 runners busy, 0 idle,
with 30 to 36 jobs queued** - which is also why the merges either side of them
were slow. One cause, three symptoms.

## 1. `clientDeadline` - a 100ms deadline against a real socket

`bounds a real SDK query whose HTTP body stops after headers` failed with
`expected +0 to be 1`. The count is of requests the test's own loopback server
received, and it received none: the deadline had fired before Node finished
connecting to `127.0.0.1`.

Every other case in that file drives the wrapper with fake timers, so the
`SUPABASE_TIMEOUT_MS=100` set in `beforeEach` costs them nothing. This one case
is real - real server, real connect, real time - and 100ms is not enough
headroom for a socket on a saturated box.

The case now re-imports the client with a 2s deadline. That changes nothing
about what is proved: the response body still never completes, so the deadline
still fires and still produces the error the case asserts. In particular
`expect(requests).toBe(1)` is **kept**, because it is what separates "the
deadline bounded a request that was sent and then stalled" from "the request
was cancelled before it left" - and the case directly above it,
`does not send an already cancelled request`, is the one that covers the other
half. Weakening that count would have deleted the distinction between the two
tests. The case timeout goes 5s to 15s to fit the 2s deadline on a slow runner.

## 2. `HorseBoardRanges` - a ratio that could still be inflated by one stall

`conditioning does not blow the latency envelope` failed at `17.72 < 12.06`,
meaning the V12 conditioning layer measured 17.72ms per decision against 4.02ms
with the layer off - 4.4x, over the 3x the rule allows.

This test had already been fixed once, on 2026-09-06, when it was an absolute
`meanMs < 25` that failed at 25.08. That fix was the right one and its comment
is worth keeping: it says raising 25 to 30 would be "the fix CLAUDE.md 10.86
rule 4 warns about: it moves the cliff and buys a few weeks", and replaced the
absolute number with a ratio against the same decision with the layer off.

The ratio was still measured in **batches**: all of `on`, then all of `off`,
twice each, taking the better batch per side. A stall that covers both `on`
batches and neither `off` batch inflates the ratio, and the minimum of two
attempts does not help when the machine is busy for the whole test.

So the two sides now alternate **inside one loop** - one conditioned decision,
one unconditioned decision, fifty times - accumulating separate totals. A stall
now lands in whichever side's turn it struck, and over fifty alternations hits
both roughly equally. `performance.now()` replaces `Date.now()` because a
per-decision sample needs sub-millisecond resolution where a 50-decision batch
did not.

**The rule itself is untouched**: `on < max(off, 2) * 3`, plus the catastrophe
ceiling of 250ms. Only the way the two numbers are gathered changed, and it
changed in the direction that makes them comparable.

## Verified against the condition that broke them

Passing on a quiet machine proves nothing here - they always did. Both files
were re-run with 2x CPU burners saturating every core:

```
load average 80.86
Test Files  2 passed (2)
     Tests  16 passed (16)
```

That is heavier than the CI box was when they failed.

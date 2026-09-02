# A Green Deploy That Deployed Nothing (2026-08-28)

Every `auto-deploy-hetzner` run was reporting success while the engine stayed
on a build from hours earlier. Found by asking the database rather than the
pipeline: `engine_leader.engine_version` had sat on `6aa60e39` for three and a
half hours across roughly fifteen merges — including the end-of-hand cadence
change, which was therefore staged on the box and not executing.

## The mechanism

The drain gate refuses to restart the engine until `handsInFlightTotal` reads
ZERO. On this platform that number is never zero: the horse fleet deals ~200
hands a minute across ~71 tables, so about seventy hands are in flight at
every instant of every day. All sixteen polls fail, every time. The gate then
falls through to a "staleness cap" that was set to six hours — so the cap was
not a rare backstop, it was the ONLY path a deploy ever took, and production
was allowed to run six-hour-old code with every run reporting green.

This is the same defect the gate's own comments record for its previous field,
`humansSeatedTotal` — "a table EMPTYING can take forever and, with horses
seated, never happens" — reproduced one level down. A condition a healthy
production fleet can never satisfy is not a gate, it is a deadlock.

## The fix

- **Staleness cap 6h → 45 minutes.** The wait loop still takes a genuinely
  quiet window when one exists; the cap now stops a busy fleet pinning
  production on stale code, security fixes included.
- **SIGTERM drain budget 8s → 18s, hard cap 20s → 30s.** The short cap is only
  safe because a restart no longer voids hands — but 8 seconds could not
  deliver that. `pauseAfterHand` parks a table at the END of its current hand
  and a hand runs ~20s, so an 8s budget expired with most tables still
  mid-hand and the drain stopped exactly the hands it exists to protect.
  `engine-up.sh` gives the container `docker stop -t 45`, so 18s of drain
  inside a 30s race leaves 12s for the state flush and finishes 15s before
  Docker would SIGKILL. The drain returns early once every table has parked,
  so a quiet fleet pays nothing for the bigger budget.
- **Both no-op paths now annotate.** A coalesced run already warned; the
  staleness-cap path now does too. An agent reading `gh run list` sees only
  "success" — the warning is what surfaces in the run header.

## Enforcement

`tests/unit/deployCannotPinStaleCode.test.ts` pins the cap as a real deploy
path, ties it to the drain that makes it safe, and asserts the drain budget
fits inside the supervisor's grace. `drainProtectsEveryHand.test.ts` was
updated in the same commit: it pinned the literal `20_000`, and now asserts
the ORDER (drain inside the cap) plus the relationships that actually matter —
budget < cap < Docker grace, and budget long enough to outlast a hand.

## Note on verification

Both sandbox disks were full of other agents' working trees at the time of
this change, so `npm ci` could not run locally and the suite was verified by
executing each assertion directly against the files (all 15 pass) rather than
through vitest. CI's required checks run the real suite on this PR.

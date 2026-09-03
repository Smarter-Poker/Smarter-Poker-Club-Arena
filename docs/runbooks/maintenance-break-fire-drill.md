# Runbook: the maintenance-break fire drill

The break-survives-restart machinery has 26 unit tests and rolled-back
production probes, but a parachute is proven by one real jump. This drill
converts "tested" into "proven" for the full sequence: announce, park, kill
the engine mid-countdown, boot-adoption re-parks the fleet, the thaw fires
exactly once, every clock comes back.

Run it ONCE after the freeze-aware engine build is serving (its `/health`
shows `maintenance.dbClockSkewMs`), then only after major changes to the
break machinery.

## Preconditions

- PR #2537 (and successors) merged and deployed; `enforce_freeze` breaks
  observed at least once without a drill (check `engine_maintenance_thaws`
  has rows).
- A low-traffic hour. The drill is designed to be invisible, but the first
  jump gets a quiet sky.
- One person watching, with this open:
  `watch -n 10 bash scripts/dev/verify-maintenance-freeze.sh`

## The drill

1.  **:50** — start the watch loop. Confirm `active=False`, no failures.
2.  **:53** — the announcement fires on its own. Confirm phase `last_hand`,
    overlay on a real table shows "Last Hand".
3.  **:55** — countdown starts. Confirm `fn_platform_frozen -> true`, and a
    browser buy-in attempt gets the Title Case break message (NOT a raw
    error). Confirm horses are not rotating (seat map static).
4.  **~:56, THE JUMP** — kill the engine mid-break, harder than a deploy
    would:

        ssh <host> docker kill club-arena-engine

    `docker kill` (not stop) on purpose: no SIGTERM, no drain, no state
    flush. This is the crash case, strictly worse than any deploy.

5.  **~:56-:58** — the supervisor restarts the container from `:current`.
    Watch for: the new engine's log shows
    `[MaintenanceBreak] Resumed a break left by the previous engine`, the
    verifier shows the countdown CONTINUOUS (no reset to 5:00), and the
    overlay in the browser never flinched.
6.  **:00** — the thaw fires. Confirm exactly ONE new row in
    `engine_maintenance_thaws` for this freeze (idempotency held), its
    `frozen_seconds` ≈ the real countdown length, and `shifted` counts look
    sane. Confirm tables resume dealing and a sat-out player from :54 still
    owns their seat.
7.  **:01** — run the verifier once more: `active=False`, no failures, clock
    skew within bounds.

## Abort criteria

Any of these means stop watching and start fixing, in this order:

- The overlay resets or disappears during step 5 → boot adoption failed;
  check `engine_maintenance_break` row and the boot log.
- Two thaw rows for one freeze → idempotency broke; clocks were shifted
  twice and `fn_thaw_platform`'s ledger needs the incident written up.
- Tables deal before :00 → a pause authority lifted the break; check
  `maintenancePaused` vs hand-for-hand interactions first.
- PLATFORM_FROZEN errors after :00 → the thaw or the self-expiry failed, or
  clock skew is past bounds; `dbClockSkewMs` is the first thing to read.

## Why `docker kill` and not a forced deploy

A forced deploy exercises the polite path (SIGTERM, drain, flush). The break
machinery's whole promise is that it survives the IMPOLITE one - a crash, an
OOM kill, a supervisor loss of patience. If the drill passes with `kill`, it
passes with everything gentler by construction.

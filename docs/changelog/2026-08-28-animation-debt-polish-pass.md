# Animation Debt — the Polish Pass (2026-08-28)

Dan: "WHAT IS LEFT TO DO? HOW ELSE CAN THIS BE IMPROVED, ENHANCED OR
OPTIMIZED STILL?" This closes the remaining tractable debt from the
2026-08-27/28 animation audits.

- **Animation-miss telemetry.** The two paths where an owed animation could
  still vanish without a trace now report to Sentry: the deal give-up (seat
  geometry never arrived inside SEAT_WAIT_MS — the hand opens with no deal)
  and a throwable whose target seat cannot be resolved (a PAID item rendering
  nothing). The behaviour is unchanged — the report makes the failure visible
  so the Animation Law can be enforced against reality, not just source shape.
- **Hidden multi-table chip flights stop burning rAF.** Background tables ran
  a full bezier rAF loop per chip nobody could see. A chip whose container has
  no client rects now lands instantly and completes on the flight's own
  wall-clock, so award sequencing stays truthful.
- **DailyChallenges confetti no longer jitters.** effects/ConfettiEffect built
  its particles with Math.random() in the render body — every parent re-render
  re-randomised the whole burst mid-fall. Memoised on burst identity.
- **Dead-and-broken animation code deleted** (dead code with known defects is
  a trap for whoever wires it in next): effects/WinSplash and the effects/
  ChipAnimation (both unmounted, both carrying the stale-closure completion
  timer bug the live canvases were cured of), table/TimerBar (never mounted),
  the deprecated getSeatPositions in useTableAnimations (invented an 800x500
  ellipse matching nothing on screen; zero callers), and six orphaned global
  keyframes in animations.css (collision bait — see the screenShake incident).

## Known remaining, deliberately not in this PR

- **The engine restart gap**: auto-deploy-hetzner runs report success but the
  running engine (`engine_leader.engine_version`) has stayed on 6aa60e39 for
  3+ hours across ~15 merges — the drain-gate/hourly-catch-up path is not
  recycling the process, so engine-side changes (including the end-of-hand
  1-second rest) sit staged but not live. Needs its own investigation on the
  deploy workflow's restart step; the #1562 watchdog sees version drift but
  has not alerted on it.
- Larger refactors listed for Dan's call: splitting TablePage's 16k lines
  (the repo's #1 merge-conflict file), unifying the three AudioContexts under
  one master gain, and extending the CSS Beat E2E to walk the full end-of-hand
  cadence frame by frame.

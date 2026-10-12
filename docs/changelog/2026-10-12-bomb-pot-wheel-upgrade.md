# Bomb-pot hand-count wheel upgrade

The bomb-pot reveal now uses the Poker Spins chrome housing, fixed pointer, glass and metal sectors, physical rotation, timed peg sounds, readable hand-count labels, a selected-count hub and a fade within its existing result hold. It reveals the engine-selected count, never a client draw, multiplier or prize. The disc and owned timers follow the existing animation-duration preference; reduced motion retains the answer.

The initial loading state no longer consumes the first-server-snapshot guard, so a cold arrival inside an existing announce window does not replay the reveal. Later authoritative outside-to-inside transitions still arm it for the hand boundary. Integer counts are validated in both consumers. Stable callback refs, strict-effect replay, timer cleanup, active-table sound gating and contained multi-table placement protect the reveal lifecycle.

Focused regressions demonstrate the first-snapshot, strict replay, fractional-count and duration bugs failing before and passing after. Actual-component browser checks cover rotation and landings at phone, landscape and desktop sizes, reduced motion and containment. Exact-candidate normal checks, protected publication and affected live proof are recorded in the task checkpoint. No engine, scheduling rule, schema, wallet or payout change is included.

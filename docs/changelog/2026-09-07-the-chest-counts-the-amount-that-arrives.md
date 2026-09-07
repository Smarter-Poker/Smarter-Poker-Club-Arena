# The chest counts the amount that arrives

The live animation audit reproduced a real display race in
`MysteryBountyChest`. A two-phase bounty starts with amount zero. If the
authoritative amount arrived during the 1.1-second count-up, the effect
responsible for late amounts deferred to the running animation, but that
animation had captured zero when it started. It finished showing zero and
no dependency changed to run the correction effect again.

Each count-up frame now reads the existing amount ref. The animation keeps
its timing and completion behavior and finishes on the amount received from
the server. This changes presentation only; it does not change an award,
payout, reveal request, or currency balance.

A rendering regression passes a 500-unit award during the lid swing, during
the count-up, and after the count-up. Before the fix, the middle case rendered
`$0` instead of `$500`; the other two passed. After the fix all three pass,
including the assertion that the celebration completes exactly once.

Local validation: 49 tests pass across the chest rendering, animation queue,
engine state recovery, and mux suites. The audit harness uses the repository's
existing canvas-confetti stub alias to isolate the canvas renderer. Full
branch CI and production visual verification remain separate gates.

The broader connection audit, including Hetzner handshake timeout diagnosis,
remains open. This fix does not establish the cause of those timeouts.

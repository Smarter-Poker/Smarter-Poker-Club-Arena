# Private Lightning gate evidence

The latency witness accepted an active pool with a positive wallet even when
its anchor stack was zero. It then spent its bounded observation period waiting
for a hand the player could not receive. The latency-specific preflight now
requires that exact player's live, positive anchor, with no sit-out or pending
leave. It reports `player_anchor_not_playable` before authentication/browser
creation. Normal financial top-up eligibility remains available at zero stack;
this change never funds a player or cancels leave/sit-out intent.

Madness timing finding 50 is independently investigated. Its original retained
25 paired-hand moments reproduce correlation 0.733988 (recorded 0.734), 45 shared
hands and one fast follow across 44 windows through 22:02Z on October 18. All
28 retained paired moments through 22:20Z instead give 0.202620. These are
measurements, not a finding of fraud or exoneration. The existing authenticated
review workflow may record only this exact finding, pair, cluster and original
evidence as reviewed. It keeps the original high-severity evidence, refuses
changed evidence and other IDs, and never clears a finding, changes gameplay,
resumes Madness or enables public rollout.

Regression: the permitted finding failed before the change; exact review and
changed-evidence refusals pass afterward. Zero, negative, invalid, departed,
sitting-out, leaving and wrong-player anchors refuse the latency preflight;
a zero stack creates no browser/session. The seven affected operator suites
pass 170 tests. Production writes and gate completion remain separate evidence.

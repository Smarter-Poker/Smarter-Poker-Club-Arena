# Throwable Materials And Player Clock

Bomb now has metal seam and fuse-collar details, a fuller blast core, and shaded smoke contours. Rose uses individually shaped outer petals, layered creases and leaf veins. Dice has shaded bevels, inset pips, and a hand with palm creases and shared skin shading. The three rigs retain their existing measured beat schedules and audio cues.

The player now pins the CSS animation-speed variable to its mount-time speed. Its phase timers and sound scheduler already captured that value. Without the inline variable, changing the global setting during a throw could change the CSS clock while the timer and audio clocks continued at the old rate.

Three component tests verify speed stability, unmount cancellation and missing-target completion. Strict scoped TypeScript passes for the player, its tests, and the three edited rigs. The spec, measured-grammar and darkroom suites are also checked. Chromium captured all 33 beat/size frames, with a further 10-frame Bomb capture after refining the blast core. The contact sheet and selected enlarged frames were inspected.

The CI publication blocker for the previous migration was a stale schema snapshot. The dedicated schema fragment declares fn_use_throwable_v2, whose live deployment and rollback tests were verified in the preceding audit. No shared snapshot or guard was relaxed.

This completes another existing-rig material batch. It does not complete the 29 legacy replacements, remaining material upgrades, missing voice recordings, real-device sound review, or authenticated checkout-to-broadcast browser verification.

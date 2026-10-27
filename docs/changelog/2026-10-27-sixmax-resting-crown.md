# Six-max crown anchoring survives animated initial poses

The final post-PR #8274 live phone reload found a 2.75px gap below the tab/action bar. The top-seat pod cached `getBoundingClientRect()` during a raised gesture, so a later resting pose inherited that gesture's offset.

The six-max anchor now projects the image's permanent bust framing from layout coordinates. Breathing, active/winner scale and gesture frames do not determine the pod's baseline. The existing folded posture shares its unchanged transform with the measurement and invalidates only that pod's cached baseline when the posture changes. Avatar size, artwork and every animation are preserved; other rings and the <=480 CSS-pixel fallback retain their existing layout.

Regression protection uses actual SeatSlot/choreography in the maintained occupied-ring browser suite: sample a raised celebration, allocate the next hand, complete the gesture, verify the same resting shift, then fold and verify that the crown still crosses the bar. The old projection fails the phase-invariance regression by about 18px. Unit tests cover static bust projection, scale, unknown art and folded-rest geometry. Existing full PLO5/PLO6 card readability, ownership, fixed-hand and wager checks remain required.

This is a client-only follow-up. Protected merge, the existing static publisher, both public provenance endpoints and post-publication live hand/reload evidence are required separately from local validation.

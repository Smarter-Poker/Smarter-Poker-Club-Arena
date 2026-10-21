# Keep genuine upward travel during live lobby reflow

The shared footer/filter scroll hook used equal scroll and content-height deltas as proof of automatic scroll anchoring. An isolated regression against the actual serving source demonstrated that a reader moving up 64px while a card below the viewport shrinks 64px leaves both controls hidden. Matching geometry alone cannot distinguish those events.

Same-frame wheel and touch input in the observed scroll direction now preserves genuine travel. Input is scoped to its actual scrollport and expires on the next animation frame; the existing 24px travel threshold, short-list behavior, end-of-page reveal and pure anchoring safeguards remain enforced. No timer, animation delay, artwork or style change was added.

The failed production footer trace also showed visibility passing before live reflow hid the bar, followed by a separate geometry read. The production check now reads the actual end, visibility and strict painted-frame edge together in one browser evaluation, retaining the approved role-specific artwork checks.

The historical production trace did not record scroll-height/event state, so the isolated counterexample establishes the guard defect without claiming to reconstruct that exact sequence. The existing production checks still supply final live verification.

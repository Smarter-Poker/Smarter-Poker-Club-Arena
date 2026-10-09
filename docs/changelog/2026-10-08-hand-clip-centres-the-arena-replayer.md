# Hand Clips Centre The Arena Replayer

The Phase 9 canary poster used the correct Club Arena hand replayer, but the
ordinary replay page frame placed it at the top of the 1080 by 1350 capture.
That left most of the lower third as unused black space.

The injected `clip=1` route now vertically centres its existing 900 pixel
replayer column between equal camera-frame insets in the portrait viewport.
The ordinary page's bottom-navigation reserve is not carried into the clip.
The replayer, its controls, its source data and its timing contract are
unchanged. Ordinary shared replay links do not receive the clip-only class and
keep their existing page flow.

Focused coverage pins both sides: a clip receives the centred camera frame,
while an ordinary replay does not. This change does not enable `hand_clip` or
alter any publication mode.

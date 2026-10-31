# Keep The Six-Max Crown Anchored Through A Retained Fold Gesture

The final live check on client27a6e5e7 found a3.377784px gap below the top bar: the seat had entered the next hand, but the prior fold animation retained its final frame. The position calculation read its semantic resting transform only from the cleared folded-seat class and anchored the upright pose.

The existing fold gesture class now carries that same resting-transform token until the gesture retires. Its animation, final transform, artwork, avatar size, plate and card lanes are unchanged. Position observes the semantic class, never an interpolated animation frame. Real-time law: the existing player_action and hand_started discrete events own seat and gesture changes; no snapshot diff or polling was added.

The actual occupied component/CSS regression reproduced the gap at3.635494px before the change. The repaired case and all existing scenes pass at600/768/1024px and short portrait (4 tests), including full PLO5/PLO6 shown hands and preserved animations.97 focused crown, choreography and source contracts passed. Production account cleanup from both previous attempts verified hard deletion and absence. Protected delivery, both published origins and a stable exact-release live check remain required; these local results do not close that gap.

WebKit also passed all6 occupied six-max cases at375/393/600/768/1024px including short portrait, zero retries. Application compilation and all four maintained copy gates passed. The existing live failure and browser red reproduction remain preserved.

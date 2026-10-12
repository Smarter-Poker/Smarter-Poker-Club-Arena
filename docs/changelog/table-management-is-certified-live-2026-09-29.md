# Table Management is certified on the live site

The section redesign was proved on a render harness and in the served bundle,
and then nothing watched it. A harness proves the code draws; only production
proves the operator sees it, and the layer that keeps paying is the one that
notices the day a frame family, the section strip or a plate label is lost to a
merge.

`tests/e2e/production-table-management.spec.ts` runs in the post-deploy sweep,
signed in through the suite's own setup and against the reserved production
fixture club. It certifies that the board draws exactly one frame on the spade
family with the section strip outside it, that the ticker is the shark frame
carrying its one Save Ticker plate, that Club Messages is the riveted frame
carrying Save Identity and Publish Banner with its switches in the kit's square
tick well rather than a text field, that the Add Table picker draws no frame
around the painted cards, and that none of the three sections scrolls sideways
at a phone width. Without management authority on the fixture club it certifies
the refusal surface instead, which is a shipped surface of its own: the shark
frame with one Return plate.

It is read-only. It navigates and reads; it clicks no plate, no save and no row
action, and it changes nothing. The suite is named in the run's own
"did it actually verify production" guard, so it cannot pass by skipping.

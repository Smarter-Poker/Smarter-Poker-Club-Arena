# The natural multirun witness samples on DOM changes

Run 39056430595 was the first natural mobile multirun observation to watch
real hands: six observer tabs saw three two-run and three three-run hands over
twenty minutes, with no award shown over a missing or animating river. It still
could not certify them. Board 1 was always first seen already complete, board 1
of every two-run hand never showed a winner label, and not one chip landing was
recorded.

The witness sampled only on `requestAnimationFrame`. The six observers share one
browser and only one tab is in front, so the others' frames can be throttled or
paused: the first sample of a hand came about 4.7 seconds after its result
packet, after board 1 had already dealt, and a payout chip lands and is removed
between samples. The ordinary payout journal (`installMobileAwardJournal`) has
always sampled on DOM mutations and records landings on real hands.

The witness now:

- samples on every relevant DOM mutation (cards, run lanes, winner labels, chip
  phase and position), keeping the frame loop as a second trigger;
- counts a chip removed within 2px of its recipient as a landing, and one
  removed anywhere else as `Payout Disappeared Before Reaching Its Recipient`;
- fails a hand with `Run N Never Named Its Winner` when the next hand is dealt
  and a board never showed its winner. That is keyed on the hand number, so a
  lane re-render inside one hand cannot end it. Run 39056430595 left this open:
  either the frame-only sampler missed the label or board 1 of a two-run hand
  really never names its winner. The next run answers it either way;
- records how many samples saw the page visible or hidden.

Every existing assertion is unchanged: each board must be seen waiting for its
river before its winner, every positive recipient needs a landing within 2px,
and both two-run and three-run coverage are required. Three new unit tests run
with animation frames that never fire; all three fail on the old witness and
pass on this one.

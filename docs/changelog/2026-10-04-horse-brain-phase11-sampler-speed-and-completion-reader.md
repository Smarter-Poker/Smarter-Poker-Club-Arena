# Horse Brain Phase 11: the variant sampler does its river work once, and the completion reader exists

**Why.** The P11.1 natural window on `885c7f9e` showed the live PLO5/PLO6/PLO8
equity sampler stopping at its 3 ms budget on 1,057 of 1,415 river samples,
and 734 eligible decisions falling back on the 4 ms budget. P11.3 admits a
pack only when at least 95% of its eligible decisions on every street are the
policy the P11.2 matrix measured, so a sampler that cannot finish in time
keeps every pack out whatever its strength.

**What changed (`omaha/OmahaVariantSampler.ts`, `OmahaVariantPolicyPack.ts`).**
The same draws, the same random stream and the same numbers, with the
repeated work removed:

- the third prior attempt is the declared uniform escape and is accepted
  without a weight test, so its weight (hand shape and made class) is no
  longer computed;
- the prior reads only the made category, now taken directly from
  `scoreOmahaHiPartial` instead of `omahaMadeClass` (which also built board
  shape and rank maps the prior never read);
- the hand-shape score comes from `omahaVariantHandQuality`, which builds the
  same integers with counting arrays and the same final expression; it is
  bit-identical to `omahaVariantHandShape(...).quality` on 200,000 random
  hands per pack (`OmahaVariantSamplerSpeed.test.ts`);
- each accepted hand's made class is kept for the showdown record instead of
  being recomputed;
- on the river the board is complete, so the hero's high and low scores are
  computed once, not per sample, and an opponent's made score is its showdown
  score (the same enumeration in the same order).

**Identity and speed.** 828 fixed-seed cases (every street, every seat count
to the tournament ceiling, folded seats) give the same sampler evidence and
the same policy receipts on main and on this branch (sha256 `27c1e10e...`).
Three-handed river evaluation, full 32-sample draw, fixed clock, 2-CPU
container: 3.76 ms on main, 1.89 ms here.

**The completion reader (P11.3's missing piece).**
`server/scripts/phase11-completion-extract.py` runs read-only on the engine
host and prints one pack's journaled receipts for one release and window;
`server/src/scripts/phase11CompletionRecord.ts` counts them with the
authority's own `horsePhase11CompletionCounts`, binds the release's policy
digest computed from that release's sources (`git show`), and writes the
`horse-phase11-completion-v1` record admission reads.

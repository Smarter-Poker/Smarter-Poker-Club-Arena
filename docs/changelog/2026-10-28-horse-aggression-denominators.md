# Match aggression evidence to the same streets

The legacy opponent-adaptation fallback could compare postflop lifetime
aggression with recent aggression counted across every street. An unchanged
preflop-aggressive, postflop-passive opponent could consequently be treated as
having changed to a postflop maniac.

Once ten postflop actions support the postflop lifetime ratio, the fallback no
longer blends incompatible all-street recent counters. Cold-start all-street
adaptation and the newer scoped opponent-read implementation retain their
existing behavior. Matching decayed postflop counters are not introduced by
this correction; established legacy postflop evidence uses its lifetime ratio.

Four regressions cover the wrong aggressive classification, dilution of an
established aggressive postflop read, the cold-start path and the ten-action
boundary. Three failed against the original source. The changed and directly
related suites passed37tests, and the server TypeScript check passed.

This is a source correctness repair. Those checks do not establish a profit
increase or production adoption; protected checks, integration and the existing
engine publication route remain separate delivery evidence.

# Exact winner-take-all tournament equity

The ICM workspace built finishing-order sampling clocks for large fields even
when only first place paid. First-place Malmuth-Harville probability is exactly
the player's chip share, so sampling added work and a nonzero uncertainty
radius to a quantity already known exactly. Repeated Phase 7 and Phase 8
candidate/future-vector pricing inherited that work.

After the existing input sanitization, a positive first prize with zero payout
tails now uses exact chip share at every field size. The workspace retains
original field length, immutable remote stacks, mutable-seat bust/revival and
detached input/result ownership. Multi-place recursion and Monte Carlo remain
unchanged. An existing exact-to-Monte-Carlo revival test now uses a two-place
curve so it still exercises that boundary and its original assertions.

Five winner-take-all regression cases failed before repair. Focused ICM and
Phase 7 checks passed, along with an independent full finishing-rank oracle
for two through ten seats, winner-take-all fields through 1,000 players and
the existing Phase 8 completion/replay checks. This removes unnecessary work;
it does not expand the three-seat future-hand domain, relax the performance
gate, activate a shadow phase or establish a tournament win-rate improvement.

# Midway rebuys, add-ons and fixed bounties

Owner follow-up: every event not explicitly designated freezeout permits rebuys;
every rebuy except Sunday 200 Deep Stack offers an add-on. None of the current
144 schedule definitions is explicitly authored as a freezeout. The generic
creator's `variant=freezeout` fallback is not an authored format.

The original Midway creator now receives authored configuration when identifying
freezeouts. Current events offer a starting-stack rebuy through late registration;
143 offer a one-time add-on of at least two starting stacks during a five-minute
break. Sunday 200 remains rebuy-only. Free Buy's one-chip purchases, 3,000 rebuy,
10,000 add-on and approved early add-on remain. Existing positive purchase prices
are retained; newly enabled paid purchases use the published total entry price.

Fixed knockout bounties round upward to multiples of five. Sunrise and Midnight
are explicit owner exceptions: 5.50 total entry = 2 bounty + 3 prize contribution

- 0.50 fee. PKO and mystery-bounty amounts are unchanged. Unfunded fixed bounty
  promises are refused. Fixed-bounty descriptions publish exact bounty, prize
  contribution and fee instead of retaining an obsolete percentage.

The qualified migration accepts the original snapshot or the previous normalized
configuration, updates full published purchase terms and only future occurrences
without entrants, entry locks or finalized pools. Registered contracts remain
unchanged. No money/player-stack writes, new timers or repair loops.

Validation: 149 actual-creator/policy cases; server TypeScript; native PostgreSQL
144 eligible/720 protected cases, exact replay, drift refusal, prior-normalized
upgrade, exact full terms/40-level ladder parity, NULL-profile refusal, injected-NULL
verifier regression, installed-config creator round trips and installed-state proof. Required hosted
checks, protected merge, containing runtime, migration and live parity are separate
remaining delivery evidence.

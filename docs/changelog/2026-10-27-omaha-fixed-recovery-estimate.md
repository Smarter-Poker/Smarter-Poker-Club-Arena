# Fixed Omaha continuation estimate

PLO4/PLO5/PLO6 maniac call-down recovery now uses its original fixed 240-request sample batch. The earlier recovery retried only estimates below the calling threshold and could replace them with a fresh estimate; a controlled .225 estimate below the .2311 gross price became an all-in call after an additional .9 estimate. Removing Omaha's outcome-selected retries preserves the existing range, selection penalty, rake, price and governor. It does not prohibit aces calls or freeze legitimate public-range repricing.

The regression uses hand 50221666's public flop price and shown own aces, with controlled reads/equity rather than claiming a historical replay. PLO4 and PLO6 use explicit variant extensions. Each variant retains a .30 correctly priced call and a decisive .05 fold, with one original batch and no opponent private cards. The original live read, equity and decision owner remain unknown. Its earlier 243-chip preflop call is separately covered by the existing authoritative priced-refusal guard only when that estimator actually refuses.

NLH's existing adaptive recovery remains unchanged and is unresolved estimator debt; this is not a universal sampler correction or live verification. No new simulations, wider budget or strategy qualification sweep is introduced by the source change.

# Omaha implied credit requires an actual draw

Omaha call pricing previously added four equity points on every flop or turn once its equity threshold was met, including hands without a flush, straight or low draw. It now requires an actual draw before granting that existing allowance. Hold’em pricing is unchanged.

Hand 46012984 supplies the public decision snapshot for the retained consumer regression. Four no-draw variant cases fail against the old source and pass with the fix; physical draw and Hold’em controls preserve their reference behavior. This corrects the invented allowance, but does not force the reported hand to fold: the current modeled betting range still prices a call. Revealed opponent cards are not used by the decision policy.

PLO4, PLO5 and PLO6 also preserve a priced weak-flush fold when a subsequent call would consume the remaining stack. Previously, the later maniac adjustment could overturn that fold using a preflop-only estimate. A real controller raise sequence reproduces the bypass across all five styles in each variant. The retained tests preserve nuts, second nuts, cheaper recovery calls, existing reference calls and PLO8 split-pot behavior. This guard adds no Monte Carlo computation or per-horse opt-in.

# Omaha implied credit requires an actual draw

Omaha call pricing previously added four equity points on every flop or turn once its equity threshold was met, including hands without a flush, straight or low draw. It now requires an actual draw before granting that existing allowance. Hold’em pricing is unchanged.

Hand 46012984 supplies the public decision snapshot for the retained consumer regression. Four no-draw variant cases fail against the old source and pass with the fix; physical draw and Hold’em controls preserve their reference behavior. This corrects the invented allowance, but does not force the reported hand to fold: the current modeled betting range still prices a call. Revealed opponent cards are not used by the decision policy.

# Mission Rails Own The Card Border

The production report for the Back-navigation follow-up passed all 481 sweep
cases but failed the Daily Missions frame check: a nominal 1px inset measured
1.0001220703125px after fractional placement. The card's 1px border made an
absolute rail with `inset: 0` sit at the padding box, exactly on the check's
maximum permitted offset.

Align the mission rail with the outer border using `inset: -1px`. Let the
existing card polygon own paint clipping, because padding-box overflow clipping
would hide that aligned rail. The existing mission board still contains scroll
overflow. Borders, padding, state colors, artwork, animations and actions remain
unchanged. The production check still requires every edge offset to be at most
1px; no assertion or test budget is relaxed.

The source regression derives the border-plus-inset relationship and checks
both clipping owners. It fails on the previous source and passes after the
repair. The real ChallengeCard and its imported styles were rendered inside the
real board styles at 393px with fractional placement: active, complete and
claimed rails all measured zero offset on every edge, remained visible, and
document width and scroll width both measured 393px.

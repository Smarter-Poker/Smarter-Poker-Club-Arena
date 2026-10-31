# Omaha continuation outlook keeps third-suit dirty cards distinct

When an Omaha turn card improves a pair or straight while completing three
cards of a suit, the old future-card classifier recorded it as good before
checking whether hero could make that flush. The high-only Omaha quality classifier now
records a scare when hero lacks the required two suited hole cards. The
existing continuation chooser still decides how to use an actual nut-flush
blocker; this correction neither forces a fold nor changes that blocker test.

The original `quality=false` algorithm remains available for paired strategy
comparisons. Shared-pair, four-straight and hi-lo classifications are unchanged.

Regression coverage includes PLO4/PLO5/PLO6 dirty pair/straight improvements,
clean improvements, real flush completion, and a deterministic actual chooser
comparison: with PLO5 Ad Ks Qh Jc Tc on 9d 4d 2s Kd, seed16, a recorded flop
barrel plan gives bet13 under the original classification and bet7 under the
corrected classification. This proves connected decision influence, not that
the lower wager earns more. No live loss attribution or playing-strength
qualification is asserted. Duplicate-deal comparison is recommended to measure playing strength; no new
profit-qualification requirement was identified for this semantic correction.
Required protected checks and delivery still apply.

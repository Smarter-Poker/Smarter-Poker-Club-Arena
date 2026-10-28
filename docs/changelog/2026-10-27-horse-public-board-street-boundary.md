# Horse public board street boundary

The worker now refuses a betting request whose public board length does not match its current street before invoking the decision policy. Previously, the single-board path checked card validity and uniqueness but accepted future cards on earlier streets. Classic and Lightning producers already copy the current controller board; this repair closes the worker validation gap without claiming an observed production leak.

The current policy registry admits only community-board variants. Pineapple's separate discard request retains its existing exact three-card board validation; unsupported draw and stud games are not assigned a new board convention. Existing multi-board physical-card validation remains in place.

Regression evidence: before the repair, four malformed street prefixes reached the decision dependency, while all four valid street prefixes passed. After the repair, all 330 worker runtime tests pass, including private-card refusal, Pineapple discard and multi-board cases. No model replay, fitting, qualification or activation was performed for this repair.

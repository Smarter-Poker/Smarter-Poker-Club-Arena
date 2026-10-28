# Opponent inspector loads the retained-plan owner

The read-only opponent inspector destructured `horseRetainedPlanContext` from
`horseDecisionJournal/review.js`, which imports that helper privately and never
exports it. The first selected FAST capture therefore called `undefined`; the
closed error boundary reported `retained_plan_refused` before validating its
plan. Both serving bf0e33 and protected 9d26 have the same exported helper in
`horseDecisionJournal/effects.js`. Load it from that existing owner.

The CLI fixture now mirrors the actual module boundary instead of inventing a
review export. It fails before the repair and passes afterward. A separate
server child-process regression executes the real effects helper: a contextless
legacy capture reaches the sanitized summary, while malformed present plan
metadata remains refused. Existing frame/context tests remain unchanged.

No schema validation, source binding, reconciliation, privacy boundary, record
limit or runtime strategy changed. The failed inspections do not establish
whether their original retained records are valid; that remains unverified
until the corrected protected inspector is executed through its existing route.

# Original cell verification follows the transferred repository

The qualification CLI still checked the former repository owner inside its
mandatory cell guard after the other provider boundaries were repaired. Valid
current repository metadata therefore failed before a held-out cell could run.

Move that existing job/run verifier mechanically into the existing qualification
authentication module so its actual boundary can be tested. Require the current
canonical repository name and immutable ID `1132369872` in the workflow context
and original API run, including that run's own ID. The CLI's memoized pre-deal
guard and the repeated private-core guard retain the same operation, cell key,
maximum attempts, job/run/attempt/name/workflow/time bindings and 20-second fetch
semantics. All independent source, admission, plan, coverage and economic gates
remain in place.

Both valid original job-time and run-time fallback fixtures failed against the
unchanged old guard before the identity correction. Focused tests retain those
positive boundaries and foreign/missing identity, original run/job/attempt/time,
permission and response-shape refusals. No qualification operation, feature
selection, historical certificate, game decision or engine activation is changed.

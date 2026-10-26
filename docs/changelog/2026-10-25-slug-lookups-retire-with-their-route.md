# Slug Lookups Retire With Their Route

The production Table Management phone sweep aborted a new navigation while the prior UUID route was being replaced by its canonical club slug. Retained diagnostics show repeated UUID-to-slug transitions and an aborted document request; this does not establish an authentication or table-creation failure.

`SlugEnforcer` now retires each asynchronous lookup when its path, query, fragment or component lifetime changes. A late result cannot replace the newer route. Current lookups still canonicalize clubs and unions with their original query and fragment.

Four delayed-result regressions failed on the predecessor and pass after the repair, alongside all six existing canonical-route tests. Production certification remains a separate gate after publication; navigation timeouts and browser assertions are unchanged.

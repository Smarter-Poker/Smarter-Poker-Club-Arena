# Member reporting initialization uses unique funding keys

The uninstalled historical initializer reached its eight-minute statement deadline on production and rolled back completely. Its interval join sorted 48 million hands and compared each hand against repeated historical occupancies for the same player and table.

Aggregate each funding history to one unique table/player key. Uniform club histories resolve directly; mixed histories retain the exact latest receipt at the hand timestamp, including pre-first-receipt fallback. Leave this aggregate inline so the planner retains its uniqueness proof and hashes the small funding side. Use transaction-local 64 MB working memory and hash aggregation to avoid sorting all source hands. Preserve the original snapshot-minus-captured-deltas initialization, concurrent additive capture, timeout, reader authorization and exact history. This migration has no installed history; the installed capture migration is unchanged.

Native PostgreSQL coverage compares mixed funding, returning funding and pre-first-receipt cases against the live scalar resolver, together with the existing regression and concurrent-snapshot tests.

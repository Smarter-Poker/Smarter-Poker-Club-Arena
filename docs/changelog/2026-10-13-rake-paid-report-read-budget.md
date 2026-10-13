# Advanced Club Data outstanding commission reads

Automatic report refresh sometimes exceeded the live eight-second request limit after historical qualification. The reader still scanned 2.78 million raw unpaid Month entries. Qualified daily earned totals now subtract explicitly paid commissions through a sparse concurrent partial index and merge overlapping settlement periods before counting their still-open entries. NULL and nonfinite recipients retain the original raw calculation, restricted to those recipients; a bounded witness preserves all-null outstanding aggregates.

No amounts, wallets, commission writers, historical markers, permissions, schedules or timeouts change. The exact predecessor and successor function hashes and index identity are checked in the short migration transaction. The existing recorded installer builds the index concurrently before that transaction.

Native qualification covers 1,424 original JSON and launch-clamp cases, including signed amounts, NULLs, nonfinite values, overlapping periods, invalidated days, searches and pagination. A separate three-million-row fixture compares exact JSON and plans; its observed improvement is scoped evidence, not a production latency guarantee. Required checks, guarded installation/readback and fresh live refresh must pass before completion.

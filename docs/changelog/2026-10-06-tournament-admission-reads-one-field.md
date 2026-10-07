# Tournament admission reads one field

A fixture reading tournament, roster, tables and seats in separate requests could combine an old unassigned roster with newly committed seats during normal launch. The isolated mixed-player admission refused this torn result before any actors were activated.

The maintained admission helper reads all four relationships in one bounded PostgREST statement. REGISTERING and ANNOUNCED remain nonacting observations. RUNNING requires the exact intended players, all active chairs and strict unique occupancy and roster coordinates; mismatches remain refusals. Required native prerequisite checks exercise completion, partial launch, mismatch, truncation and terminal refusals. The existing isolated finite caller uses this helper, preserves failed receipts and never repeats committed tournament purchases or starts.

This is fixture tooling, with no engine activation or product-wide capacity certification. Actual authenticated isolated reads of the same six-player and 22-player fields passed through the single-query relationship contract.

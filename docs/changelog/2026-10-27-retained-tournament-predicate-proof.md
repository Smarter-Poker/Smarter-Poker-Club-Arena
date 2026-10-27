# Original tournament payout/context predicate helper

A separate bounded helper evaluates original retained journal records without exporting private snapshots. It requires explicit versioned finalized payout terms and ladder, unit-grid/pool/reserve validation, complete captured context provenance, and an evidence-bearing Phase 7 MTT payout receipt bound to the original read frame. Same producer/turn, ordered intended execution, committed-hand binding and the actual whole-hand reconciler must all pass.

Inputs contain one to six original hand coordinates and an exact decision digest or null for unique discovery within at most 256 retained records per hand. Output contains only fixed statuses/reasons, booleans and digests. Missing, legacy, malformed, foreign-source or ambiguous evidence stays unknown. Bubble enabled/disabled is observed separately from whether it was captured. No settlement, calibration, GTO, V56 causality, previous-level branch, replay or fleet activation claim is made.

The helper is wired as the separate optional `tournament_cases_json` mode in the existing maintained inspector. Protected helper source travels through the same pinned SSH stdin payload; its actual installed validators and canonical private exporter run in the existing container. Parent validation and a strict exact-output sanitizer bound the read. Unavailable validators, unverified runtime health/identity or a changing instance produce unknown. No production reads or runs occurred. Original reference v1/v2 code and the separate yield/cap owner's parser functions remain byte-identical.

Focused tests use a wholly synthetic local hand and actual payout/provenance/receipt validators, execution witness, hand binder and full journal reviewer. They cover positive exact/unique selection and missing, malformed, wrong-source, wrong-hash, duplicate, bounds, ambiguous and rehashed foreign-execution failures.

## Delivery and limits

The shared parser boundary was confirmed before integrating its exact 3269d89eb93604ace0ab3c1f35049b59918c8d5c dependency. Its yield/cap functions and stream output keys are preserved. The dependency reached protected main as 22234d645c507ad99650c7bc572e8ef2f9328337; this follow-up integrates that protected source before exact-head required checks. This is diagnostic tooling using existing runtime APIs; it adds no engine deployment trigger or policy execution. The runtime/operator owner retains the separate natural observation. No live or fleet certificate follows from local synthetic tests or publication alone.

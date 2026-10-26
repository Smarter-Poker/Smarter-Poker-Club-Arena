# Inspect original worker receipt refusals privately

The existing manual read-only tournament diagnostic can inspect up to six explicitly selected original `reference_shape` cases. The optional metadata input is bounded UTF-8 JSON, tied to the expected serving source and the hash of each original table, hand number and retained submission lease. Unknown fields, duplicate keys, duplicate cases and invalid coordinates are refused before SSH.

A fixed bounded Node child imports the running image's existing canonical journal exporter, record validator, hand binding helpers and Phase 6 validator. Private records stay in memory inside the container. The public result contains only source and record hashes, allowlisted route/action names and public guard booleans. Python validates that output again before it reaches the artifact. No wagers, cards, opponent reads, raw snapshots, player IDs, stack traces or arbitrary journal data are exported. No policy is activated or modified.

Exactly one retained original hand acceptance and one matching refusal within two seconds of the observed error are required. This establishes a source-bound original-hand witness with temporal correlation, not an exact error request-ID proof. Missing, pruned, ambiguous, malformed or source-mismatched records remain explicitly unknown. A later engine release must not be held or relabeled to recover old-source records: the canonical exporter refuses records from another source.

The workflow remains the same default-branch manual diagnostic using canonical pinned SSH. Existing before/after image identity, time, byte and log limits remain. The new child has a 128 MiB heap limit and shares the existing 25-second command bound. Ordinary PLO hand selection is not a `reference_shape` case and must not be presented as V56 or tournament capture proof through this operation.

Focused tests cover the real record hash validator, original hand/source bindings, missing and ambiguous cases, strict input limits, private-output rejection and existing diagnostic invariants. This is inspection capability, not a strategy fix or live qualification.

# Observe a successful whole-stack call-off without exporting the hand

The existing read-only tournament inspector could classify only a decision that still failed `reference_shape`. After the call-off validator repair, an absent error cannot show that the intended all-in reached the controller.

Its existing optional case input now also accepts version 2: at most six original accepted-hand coordinates on the exact serving source, plus either an exact decision-record SHA-256 or null for bounded discovery. Null discovers only one qualifying call-off within that named hand's maximum 256 retained records; multiple candidates remain unknown. Version 1 refusal inputs keep their existing behavior.

The child validates record hashes, source and original coordinates, the `variant_price` unsized all-in reference and positive whole-stack call, the installed Phase 6 and decision validators, the same-producer/same-turn intended all-in execution, and the original accepted-action binding. The installed full journal reconciler must also reconcile the complete retained hand. Missing, ambiguous, refused, coerced or mismatched evidence stays unknown. Only record/decision hashes, a fixed observation name and true/false proof fields leave the child; the parent rejects extra fields. It exports no cards, amounts, actor identities or raw records, and grants no qualification or activation.

This is an explicit finite operation through the existing default-branch workflow and pinned SSH identity, with unchanged container/source checks and time/size limits. It changes no engine policy, release, migration or scheduler. Post-install observations still require actual natural accepted records on the installed source; local synthetic tests are not live proof.

# One opponent policy for people and horses

The owner explicitly extended the same poker policy to all opponents on October 27. The old Omaha default only applied when the engine roster identified a person. Remove that identity condition at HorseMind's owning read boundary and stop passing the roster as a strategy selector. Every unknown Omaha opponent now receives the same existing raise prior; measured passive evidence still withdraws it, and measured aggressive evidence remains authoritative. Hold'em's existing common prior is unchanged.

The legacy fourth scope argument remains accepted for caller/replay compatibility and has no strategy effect. New opponent-named receipts accurately describe current events; historical human-only receipt definitions remain available for old records. No private cards, cross-horse decisions, unconditional bets, or experimental-feature activation is added.

Regression coverage compares fresh and measured reads across both labels, cash/tournament modes, missing or changed roster metadata, and scope cleanup. The actual worker test requires the same aggressive read with and without roster metadata. These checks establish the intended behavior; merge, activation, and live fleet evidence remain separate.

The full pre-push suite exposed a weak-made-hand river sizing gap: the pure-bluff branch could bypass the half-pot limit already applied to value bets after two called barrels. Apply that same limit in the bluff branch without changing its betting probability. The unchanged V40 regression fails before and passes after; all 61 V40, variant-scale and V53 pressure checks pass. Historical neutrality retains its original corpus and coverage floor while isolating the deliberately replaced prior; context and style-change tests distinguish observed evidence from a zero-observation presumption.

Hosted PostgreSQL qualification exposed one remaining assertion for the replaced
unknown-Omaha policy. The same 23-test isolated PostgreSQL suite reproduces the
failure locally. Its context-isolation regression now requires the unseen PLO4
context to have the common presumed prior and zero observed samples in every
statistic, while switching back to PLO5 must preserve the imported measured
read. Malformed, stale and duplicate snapshot refusals remain asserted.

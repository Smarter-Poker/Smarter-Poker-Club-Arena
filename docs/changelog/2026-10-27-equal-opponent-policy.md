# One opponent policy for people and horses

The owner explicitly extended the same poker policy to all opponents on October 27. The old Omaha default only applied when the engine roster identified a person. Remove that identity condition at HorseMind's owning read boundary and stop passing the roster as a strategy selector. Every unknown Omaha opponent now receives the same existing raise prior; measured passive evidence still withdraws it, and measured aggressive evidence remains authoritative. Hold'em's existing common prior is unchanged.

The legacy fourth scope argument remains accepted for caller/replay compatibility and has no strategy effect. New opponent-named receipts accurately describe current events; historical human-only receipt definitions remain available for old records. No private cards, cross-horse decisions, unconditional bets, or experimental-feature activation is added.

Regression coverage compares fresh and measured reads across both labels, cash/tournament modes, missing or changed roster metadata, and scope cleanup. The actual worker test requires the same aggressive read with and without roster metadata. These checks establish the intended behavior; merge, activation, and live fleet evidence remain separate.

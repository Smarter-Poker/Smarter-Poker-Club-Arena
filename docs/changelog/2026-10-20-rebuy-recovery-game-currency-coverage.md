# Rebuy recovery across game types and currencies

The original custody proof is shared by every tournament game type. Expand its existing required native PostgreSQL check to execute the exact installed successor for NLH, PLO4, PLO5, PLO6, PLO8, Short Deck and OFC Pineapple, Fixed Limit Hold’em, Fixed Limit Omaha Hi-Lo and Pineapple, with rebuy and re-entry in both chip and Diamond fixtures (40 combinations). Each proves the complete original roster and purchase receipts. Retain fail-before/pass-after, both currency boundaries, duplicate reads and ACL refusals.

This change adds qualification coverage only. It does not change game rules, enable an unsupported tournament format, replay purchases or add a repair job. Production census found no active never-dealt rebuy block after the original migration; separately observed sealed-hand eliminations require their own evidence and are not certified by this read-helper test.

Runner-only and fixture-only changes now select the required PostgreSQL accounting job. Before this change both returned server=false, so the native tests could be edited without executing them. A regression pins the driver, whole fixture directory and source guard.

The matrix includes all nine maintained engine variants plus the historical OFC Pineapple tournament label. The source guard compares the engine variant list against the matrix, so adding a variant requires explicit recovery coverage.

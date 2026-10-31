# Cash refusal checks skip an empty finite scope

The receipt checker walked the global blocked queue and fetched each receipt before applying the requested club and week. The original DSS function read took 21.207 seconds even though no finite receipt matched. A materialized one-row existence check now proves whether that exact finite scope has any receipts before starting the original lookup. Populated scopes retain the original query; infinity handling, duplicate multiplicity, errors and returned details are unchanged.

The corrected DSS query completed in 8.215 milliseconds. Midway retained its original point lookup with a 5.124 millisecond presence check; its full query completed in 24.091 seconds. These are bounded read-only query observations, not complete weekly-close capacity proof. A rejected full materialization took 40.946 seconds for Midway and is excluded from this delivery.

The forward migration preserves the actual function metadata and restrictive ACL, exact index/statistics histories, source65/GEN72, original paid fingerprints and all 40 complete correction receipts. It moves no chips. Its function DDL is bounded to 5 seconds with a 1 second lock timeout; verification uses 15 seconds within a 60 second transaction.

The existing cash-refusal native runner invokes 16 result-parity cases, four invalid-input cases and six installer controls for authority, UTC, replay, metadata, bounded DDL and atomic rollback. Actual protected installation, full before/after paid-state verification and full weekly-close acceptance remain required.

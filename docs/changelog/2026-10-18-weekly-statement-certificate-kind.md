# The weekly statement certificate reaches its reader

The installed Round 4 chunk writes `club_statement_quality:<club UUID>`, but the certificate table still accepted only nine fixed P&L kinds. A guarded original-week diagnostic on October 18 reached a READY proof for 183,871 events and failed with SQLSTATE 23514 at that CHECK. Its forced rollback was independently verified against the complete financial-state PostgreSQL hash.

Migration `20261018142435` preserves the nine kinds and admits only the exact new key with a canonical lowercase UUID suffix. It changes no certificate rows, money, function, generation or lifetime. Admission pins the installed producer migration, current writer/reader and validated constraint preimage, and preserves operator, maintenance, freeze, scheduler ownership and replay checks.

The existing required accounting qualification now executes the actual table constraint with the current certificate writer and reader. It proves the observed failure before the correction, the two clubs' READY round trips after it, preserved legacy kinds, malformed-key refusals and the existing writer/reader gates and freshness rules. Production installation and original-week completion remain separate acceptance steps.

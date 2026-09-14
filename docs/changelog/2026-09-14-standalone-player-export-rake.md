# Standalone player exports retain their rake

The player CSV preparation function only read union rake. For a standalone
club, the union was null, so exported players showed zero rake and players
with only rake activity disappeared. The interactive player page already
read the standalone club source correctly.

The export now uses that same mutually exclusive union/standalone branch,
scoped by club, player attachment and reporting dates. No rake source,
wallet, ledger, or existing prepared export is rewritten. Existing exports
remain immutable and expire under their existing fifteen-minute contract;
new export requests receive the corrected data.

The migration checks the exact predecessor and preserves its owner,
permissions, security mode and statement budget. PostgreSQL 17 reproduces
the old zero-rake/missing-player result, then checks exact page/export row
parity for four sorts, union and standalone clubs, and owner and super-agent
viewers. It also verifies replay, expiration, cross-user access refusal,
direct-row access refusal, horse masking and permission downgrade rejection.
The required accounting job runs this proof for future changes. This is a
focused reporting qualification; it does not certify the full money-writing
or signup trigger graph.

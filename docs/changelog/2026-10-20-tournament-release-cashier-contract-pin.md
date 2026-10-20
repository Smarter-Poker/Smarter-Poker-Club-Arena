# Post-deployment conservation contract

The production cashier canary rejected the journal-origin conservation report
installed by migration `20261019185853`, because its fingerprint list still named
the two retired predecessors. Pin the qualified installed definition and require
its exact migration-history name. Unknown definitions and the retired versions
continue to fail closed; no production function or money state changes.

Validated with the native PostgreSQL journal-origin qualification, the focused
cashier certification contracts, and the full corrected read-only contract on
production. The native qualification verifies legacy equivalence, access and
replay refusals, and the exact installed fingerprint.

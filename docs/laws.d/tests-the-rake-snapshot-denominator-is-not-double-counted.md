# tests/the-rake-snapshot-denominator-is-not-double-counted.law.test.ts

The rake snapshot never divides by a double-counted total: `breakdown_total` sums `direct_rake` (each player once), never `network_rake` (which contains every level beneath it); the agent tree recursion keeps a depth cap; players with no agent are still reported; and every ungated `fn_ca_rake_*` helper stays revoked from authenticated, leaving `ca_rake_snapshot` the one door

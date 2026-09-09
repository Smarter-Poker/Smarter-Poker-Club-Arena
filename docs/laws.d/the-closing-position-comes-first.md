# tests/the-closing-position-comes-first.law.test.ts

An epoch reset must record what every account holds before it destroys it.
Pins the closing-position record: its own append-only table (not the rolling
`ca_account_snapshots`), the chip-unit constraint, service-role-only access,
and a capture covering every class the supply meter reads plus the agent player
wallet it does not - with union wallet columns and BBJ banks named
individually rather than totalled. Pins that a real capture refuses unless the
platform is frozen while a dry run stays available, and that
`fn_ca_execute_epoch3_reset` refuses without a freeze, with any seat still
occupied, or without a closing position captured in the last fifteen minutes -
applied as an asserted substitution rather than a retyped body.

# R46 native fixture source

This is a PRE-R46 catalog composition, not execution evidence. The existing
accounting runner owns the private PostgreSQL 17 cluster, candidate migration,
three native probes, six isolation cases, complete logs and disposal. Importing
`scripts/ci/mtt_unlimited_fixture.py` performs no work; `compose(root)` reads only
bound source and returns SQL, SHA256 inputs and explicit coverage limits.

The four `accounting-*.sql` files are byte-identical copies of the September 14
captured inputs in `tests/fixtures/full-weekly-accounting/{schema,access,policies,
seed-registry}.sql`, retained by the Union accounting release. Their original
source binding was checked before copying. These contain actual definitions,
constraints, triggers, policies and observed access rights, not stub payers or
an older ticket composer. The retained graph has 255 tables, 741 functions,
537 triggers and 226 policies; it is not an unrestricted production dump.

`accounting-catalog-contract.json` derives from that same capture: join
`functions.json` to `function-access.json` by OID, retain identity/owner/grants,
and calculate source-body and full-definition MD5. Copy trigger records from
`triggers-round-3.json`, non-trigger constraints from `tables.json`, and table
and schema access from their corresponding JSON files. The loader checks those
contracts in the resulting private catalog. `r46-preimages.json` carries the
39 function hashes and constraint preimages retained in the original MTT
`work/r46-sql/change-manifest.json`; none was inferred from a newer body.

The September 16 supplements are bounded, read-only `pg_catalog` captures from
Club Arena project `kuklfnapbkmacvwxktbh`, with timestamps in each record:

- `function-capture-20260916.json`: 24 absent R46 rewrite preimages and the actual
  public ticket-redemption wrapper. All 24 still match the migration's pins.
- `function-dependencies-20260916.json`: nine additional captured signatures in
  the existing entry, creation and terminal dependency graph.
- `table-capture-20260916.json`: the absent `tournament_waitlists` relation,
  including columns, constraints, indexes, original trigger absence, policies,
  ownership and grants.

Captured definitions retain security mode, volatility and configuration. Each
function supplement is absence-only and reinstalls observed ACLs, followed by
full-definition/source/owner/ACL and effective role checks. No default PUBLIC
grant is assumed. The waitlist supplement preserves the observed access rules;
R46 itself installs the new fixed-format admission trigger afterward.

`registry-capture-20260917.json` retains a bounded, read-only query of the two
`ca_chip_store_coverage` declarations required by the actual ticket ledger
triggers: `escrow` and `prize_liability`. Its timestamp, query and exact rows are
content-bound. The loader refuses existing declarations, inserts these captured
configuration rows and verifies their complete readback. It does not disable or
replace the financial guards. The original accounting registry seed did not
include this table's rows.

The catalog checks preserve each capture's identity format: original named
function arguments are matched against `pg_get_function_identity_arguments`,
while later type-only signatures use `regprocedure`. Trigger definitions use the
capture's pretty deparse mode. Constraint definitions must exactly equal one of
PostgreSQL's two native renderings of the same named constraint. Function body,
full definition, ownership and ACL checks remain exact.

The only template row seed is one clearly synthetic, zero-balance Diamond arena
and owner. Its public asset/platform flags exercise the actual classifier. No
production account rows, games, entrants, funded tickets or balances are copied.
All game and maintenance tables remain empty before individual probes seed their
own inputs. The private superuser does not reproduce the managed provider's
administrator-role topology.

`postconditions_sql(root)` verifies the composed **pre-migration** catalog and
intentionally rejects the post-R46 function hashes. The candidate must be applied
separately by the caller with normal body validation. Passing source composition
does not prove native installation, concurrent behavior, financial outcomes,
deployment or every branch of the 39 rewritten functions. Two names encountered
only in historical, unexercised branches (`fn_create_late_registration_capacity`
and `fn_ca_verify_terminal_place_batch`) were absent in the bounded installed
catalog lookup; no replacement was invented.

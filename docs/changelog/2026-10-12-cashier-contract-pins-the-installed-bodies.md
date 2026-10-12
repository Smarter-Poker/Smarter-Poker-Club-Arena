# The Cashier release contract pins the installed bodies

The post-deploy Cashier release contract
(`scripts/verification-harness/cashier-release-contract.sql`) let five
functions match either of two bodies while their replacement migrations were
waiting to be installed. Those migrations are now installed in production, so
each of the five is pinned to the body that is live, and the body it replaced is
no longer accepted.

Every value below was read from production (project `kuklfnapbkmacvwxktbh`,
`md5(pg_get_functiondef(oid))`, read-only) on 2026-10-12 before it was written.

| Function                                             | Installed by     | Now pinned to                      | No longer accepted                 |
| ---------------------------------------------------- | ---------------- | ---------------------------------- | ---------------------------------- |
| `fn_club_trade_ledger(uuid,integer,integer)`         | `20261012040542` | `1b1312459ecc90069375d8bcdb3127ca` | `d489a8b997a25320b0b4ec8b14a43587` |
| `fn_agent_wallet_reversible(uuid)`                   | `20261010005048` | `3cc86bbb6317359a7b43fc34524d5876` | `61b3478f0332f8ee7945d6eb2810bb71` |
| `fn_respond_chip_request(uuid,text)`                 | `20261010003544` | `10fb3a12f5113521a2366a98af90ecbd` | `f6b8bf0d7d035d063780b37ff614b068` |
| `fn_club_bank_ledger(uuid,integer,integer,text[])`   | `20261012040542` | `f17eb94522c177856683617945d9f371` | `39ff91f5cc60c6300942f51e4ab2c3bb` |
| `fn_ca_chip_statement_page(text,uuid,jsonb,integer)` | `20261012040542` | `d513f6f312b29835cc5e74aa8ff00ce0` | `c706109ed8dab335912f046aaa6ee215` |

The note about the private statement row query `fn_cashier_statement_rows` now
says its `20261012030847` body (`8cab96c15ba360fb34c13f0afd3378b8`) is the live
one. That helper is not in the browser-callable list, so nothing it checks
changed.

No migration, harness preimage or function behaviour changed. The contract's
two-body comparison is kept: `fn_club_cashier_can_transact` still uses it for
its own, separate Realtime repair allowance, which this change does not touch.

## Verification

- The updated contract ran against production inside a read-only transaction
  that rolled back, and passed: every function body, grant, row-level security
  rule, trigger and index matched, with no drift.
- All 68 function pins in the edited file were compared to production in one
  read-only query; every one matches its live body.
- `tests/cashier-phase5-critical-integrity.test.ts` now requires each of the five
  installed bodies as the pin and fails if a replaced body comes back, either as
  the pin or as an alternative.

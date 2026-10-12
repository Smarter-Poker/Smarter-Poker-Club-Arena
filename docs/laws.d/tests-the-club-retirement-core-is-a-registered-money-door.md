# tests/the-club-retirement-core-is-a-registered-money-door.law.test.ts

A function that writes balances is registered in `ca_money_rpc_registry` under the name it actually has. When a money door is renamed to a private `*_core_YYYYMMDD` and a wrapper takes its old name, the core is registered too, or `fn_ca_money_rpc_drift()` fails the burn-in gate.

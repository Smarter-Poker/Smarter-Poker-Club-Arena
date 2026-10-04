# Union Distribution Check Reads Daily Commission Facts — 2026-10-04

## Scope

Signed-in production verification of the Financial Admin Settlement tab found one remaining launch blocker after the Risk repair: `fn_union_distribution_check` still summed the complete `agent_commissions` journal for every load and exceeded the eight-second request budget for Midway Union. This follow-up changes only that read path and its focused PostgreSQL proof. It does not change the painted Club Arena console, authorization, accounting policy, settlement execution or any financial row.

## Read Path

- Complete UTC days now read the exact trigger-maintained `ca_club_commission_daily` facts already owned by Financial Admin.
- The arbitrary partial first UTC day remains an exact journal read through the existing `(club_id, created_at)` covering index.
- The current UTC day remains an open-ended journal read, so future-dated evidence preserves the prior function contract.
- Union scope, rake, rakeback, rounding, health arithmetic, response keys and explanatory note remain unchanged.
- The migration fails closed unless the production function preimage, security shape, daily-fact primary key and writers, all three active rollup triggers, and the exact edge index match their verified identities.

## Production Reproduction

A read-only same-snapshot comparison on the affected production union returned an exact commission match between the old direct journal expression and the daily-fact-plus-edges expression. The comparison took about 9.4 seconds because it also executed the old full scan; a separate complete distribution probe using the replacement expression returned the same accounting basis inside the signed-in request budget. No production row or schema object was changed by these probes.

## Focused Qualification

- PostgreSQL 17 fixture coverage proves exact parity for signed amounts, arbitrary lower bounds, complete UTC days, current-day and future-dated rows.
- The production-shaped scale case reuses 2.2 million commission rows and requires the distribution check to finish inside eight seconds with the exact expected total.
- The caller begins with JIT enabled; the function pins JIT off only locally and must restore the caller setting when it returns.
- Source binding pins the predecessor migrations, this migration, bootstrap and assertions as one proof bundle.

## Delivery Contract

This repair is complete only after focused source gates and PostgreSQL qualification pass, protected CI merges the exact candidate, the migration is installed exactly once through the supported workflow outside the DDL refusal window, durable production readback matches the merged postimage, normal Club Arena publication succeeds, and a fresh signed-in Settlement-tab review loads distribution and settlement evidence without timeout. No settlement or integrity mutation is part of certification.

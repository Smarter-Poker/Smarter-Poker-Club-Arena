# 2026-09-06 — Cashier request and telemetry writes are server-owned

## What changed

- `fn_request_chips` now refuses a missing `p_op_id` before it acquires the
  request lock or inserts a row. The existing four-argument RPC signature is
  unchanged, and keyed retries still return the original request after proving
  that club, caller, amount, and normalized note match.
- Cashier SLO events now go through `fn_record_cashier_operation`. The function
  derives the actor from `auth.uid()`, admits only an active staff/agent Cashier
  scope for that club, validates the bounded event fields and event/operation
  pairing, derives the sample weight, and accepts at most 120 events per actor
  per minute.
- Authenticated browser roles no longer have direct `INSERT` or sequence access
  on `cashier_operations`; the old insert policy is removed. Service-role
  analytics views and the 30-day retention job are unchanged.
- `rate_limits` is now private to definer functions and `service_role`. Its
  permissive browser insert policy and all browser table grants are removed, so
  one account cannot manufacture limiter rows for another account or inspect
  the internal throttle ledger.
- The browser telemetry adapter, the post-deploy database canary, and their unit
  contracts now exercise the RPC boundary instead of a direct table insert.

## Why

A null request key made an ambiguous retry capable of creating a second pending
chip request. Separately, the former telemetry policy checked only that
`user_id = auth.uid()`: any signed-in account could choose an unrelated club and
its sample weight, polluting operator-facing Cashier reliability data. The
internal limiter table also allowed arbitrary browser inserts. These writes now
obtain identity and authorization from the server, and the limiter has no
browser-readable or browser-writable surface.

## Verification

- Focused Vitest contracts cover request-key ordering, client RPC wiring,
  identity/scope/rate-limit SQL, direct-table revocation, telemetry field
  redaction, and rollback behavior in the production canary runner.
- The migration includes post-apply assertions for the request guard, telemetry
  definer/search-path settings and ACLs, removal of insert policies, and
  revocation of table, sequence, and rate-limiter privileges.
- The new function is declared in its own schema-manifest fragment so migration
  and phantom-schema gates see the exact server contract without editing the
  shared live snapshot.

## Rollback

Restore the request function from `20260830010000`, drop
`fn_record_cashier_operation`, recreate `cashier_operations_insert_own`, and
restore authenticated table/sequence write privileges. This rollback reopens
the two defects and is for emergency compatibility only.

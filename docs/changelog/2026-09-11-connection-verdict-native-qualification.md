# Connection Verdict Native Qualification

The connection gate now has independent PostgreSQL 17 proof for the exact RPC and TypeScript decoder in source commit `d546e00a63`. This fixture-only change does not edit the gate or apply a migration to production.

Fourteen native cases execute the installed helper source, new SQL function, and actual service decoder. They cover current seats, active/approved membership, club and union scopes, valid Diamond arenas, observer settings, active and expired bans, live IP settings, null identities, service-only execution, temporary-object shadowing, and read-only execution. The helper body remains `9fc3bbf5ebbf941e06141b3a65584ef4` before and after migration.

The concurrency case blocks the real RPC on a PostgreSQL relation lock. A second transaction revokes the seat and membership, changes both settings, and inserts a ban before releasing the lock. The blocked RPC returns all old facts; the next RPC returns all new facts. This is a coherent statement snapshot, not a guarantee that authority cannot change after a response. PostgreSQL documents this snapshot behavior for [STABLE SQL functions](https://www.postgresql.org/docs/17/xfunc-volatility.html).

Ban authority retains the established table union, owning club union, or union-shell identity. A `union_clubs` association alone does not extend blacklist inheritance. Membership continues to use the exact existing scope helper, including its association mapping.

Run from a checkout containing the final RPC/service and installed root dependencies:

```sh
python3 tests/connection-verdict/native.py --source-root "$PWD" --evidence work/connection-verdict/qualification
```

Use Node 22 on `PATH`. The runner defaults to the local PostgreSQL 17 installation; `--pg-bin` accepts another native PG17 binary directory. It creates a unique private Unix socket cluster under `/tmp`, disables TCP, discards inherited libpq/Git environment, runs with real durability enabled, and stops/removes only its own cluster. The evidence directory must be new. It records source hashes before and after execution.

The fixture reproduces only the columns and indexes used by this read-only query. It does not reproduce full production data, unrelated triggers or role defaults. RLS is enabled without granting source-table reads to the engine role; the exact security-definer RPC grants the one reviewed read operation. The TypeScript import is transpiled unchanged and linked to a native RPC test transport, so no production client or credential is imported. These cases do not certify deployed PostgREST, WebSocket concurrency, response lifetime, or later authorization freshness. Those remain separate transport checks.

The pinned machine-readable receipt is `docs/changelog/evidence/2026-09-11-connection-verdict-native.json`. No production or World Hub changes were made.

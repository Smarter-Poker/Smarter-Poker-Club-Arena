# tests/a-rolled-back-probe-must-actually-roll-back.law.test.ts

`scripts/dev/probe-rpc.sql` must keep both transports separate and never again tell an agent that a cross-call `BEGIN` / `ROLLBACK` is safe over the Supabase MCP, where one call is one transaction and the probe in the middle commits.

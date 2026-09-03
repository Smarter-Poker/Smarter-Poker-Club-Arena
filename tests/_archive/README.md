# Archived Client-Side Engine Tests

**Superseded:** 2026-04-23 — Phase U2 Stage C of `~/Documents/Smarter-Poker-World-Hub/CLUB-ARENA-OFFICIAL-UPGRADE-INTEGRATION.md`

These tests exercised the client-side engine modules in `src/engine/*` that
have been deleted as part of the server-authoritative migration. The
authoritative engine now runs on the Hetzner game server; its tests live in
`server/src/engine/*.test.ts`.

## Why preserved instead of deleted

Bible V8 compliance coverage in `engine_clientside/v8-bible/` represents hard-earned
assertions about fairness, settlement law, and state-machine correctness.
Rather than lose those test cases entirely, they are archived here so that
they can be ported to `server/src/engine/` as the authoritative test suite
grows. Do NOT run these — they will fail (their imports resolve to deleted
files).

## Excluded from CI

`vitest.config.ts` excludes `tests/_archive/**` from the include glob so these
files are not executed.

## Contents

- `engine_clientside/` — the old `tests/engine/` directory (including `v8-bible/` compliance tests)
- `engine-improvements.test.ts` — Q1 feature test pack
- `poker-engine.test.ts` — hand eval, rake, pot math

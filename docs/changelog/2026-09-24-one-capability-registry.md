# 2026-09-24 - One capability registry and accepted-event continuation

## What changed

Migration `20260924025555_one_capability_registry_and_accepted_event_continuation`
adds `public.platform_capabilities` (one row per product capability, with rule
version, scope, variants, compatibility and readiness), its append-only
history `public.platform_capability_events`, the readers
`fn_capability_available(text)` (server-side) and `fn_platform_capabilities()`
(the public projection clients read), the staff or service_role writer
`fn_set_capability_readiness`, and `fn_event_continuation`.
`src/config/platformCapabilities.ts` mirrors the registry ids for the client,
and `tests/one-capability-registry.law.test.ts` keeps the two in step.

`fn_platform_capabilities()` is SECURITY DEFINER and executable by anon, so it
is recorded everywhere a public reader must appear:
`anonPublicSurface` in `scripts/ci/definer-authorization.allowlist.json`,
`reviewedAnonReaders` in `scripts/ci/definer-exposure-baseline.json` and the
live grant manifest `docs/security/anon-executable-definers.json`, each with
what a caller with no account learns (capability ids, rule versions, titles,
scope, variants, compatibility, readiness and the available flag; no evidence,
actor, club, player or wallet data; read-only).

`ci.yml` gains the step "Capability registry and accepted-event continuation"
(`scripts/ci/test-capability-registry.py` against PostgreSQL 17). Its cash
qualification pin moves to the new bytes with a `capabilityRegistryIntegration`
note; cash SQL and immutable capture inputs are unchanged.

## Why

Product surfaces (Kill and Half-Kill first) must only be offered when the
database and engine can honour them. One registry, readable by every client and
checked by the server, replaces per-feature guesses.

## Evidence

- `scripts/ci/test-capability-registry.py` (PostgreSQL 17, in CI).
- `tests/one-capability-registry.law.test.ts` (law, registered in
  `docs/laws.d/one-capability-registry.md`).
- `tests/a-public-reader-is-recorded-where-every-audit-reads-it.law.test.ts` and
  `tests/live-definer-exposure-audit.test.ts` accept the new public reader.

## Still pending

Installation on production. The rows are seeded below `deployed` (planned,
implemented or tested; `variant.ofc` is excluded), so nothing is offered until
`fn_set_capability_readiness` records evidence that a feature has shipped.

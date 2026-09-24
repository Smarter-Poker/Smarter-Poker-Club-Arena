# 2026-09-24 - One capability registry and accepted-event continuation

## What changed

Migration `20260924025555_one_capability_registry_and_accepted_event_continuation`
adds `public.platform_capabilities` (one row per product capability, with rule
version, scope, variants, compatibility and readiness), its append-only
history `public.platform_capability_events`, the readers
`fn_capability_available(text)` (server-side) and `fn_platform_capabilities()`
(the public projection clients read), the staff or service_role writer
`fn_set_capability_readiness`, and `fn_event_continuation`.
This change is database and documentation only. The client mirror
(`src/config/platformCapabilities.ts`), the shared hook
(`src/hooks/usePlatformCapability.ts`) and the law that holds the mirror to the
database (`tests/one-capability-registry.law.test.ts`) ship with their first
consumer (Kill Pots or multi-day), byte-identical in each consumer, so no file
lands under `src/` that nothing imports
(`tests/every-file-under-src-is-reachable.law.test.ts`). For that law, this
change adds `scripts/ci/fixtures/capability-registry/seeds.json`, a JSON copy of
the migration's seed rows and its readiness and scope CHECKs, and
`tests/unit/capabilityRegistrySeedsFixture.test.ts`, which pins the copy to the
migration field by field; a consumer that lands before this migration compares
its mirror to the copy.

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
- `tests/unit/capabilityRegistrySeedsFixture.test.ts` (the seed copy equals the
  migration).
- `tests/a-public-reader-is-recorded-where-every-audit-reads-it.law.test.ts` and
  `tests/live-definer-exposure-audit.test.ts` accept the new public reader.

## Still pending

The client mirror, the hook and `tests/one-capability-registry.law.test.ts`
(with `docs/laws.d/one-capability-registry.md`) arrive with the first consumer.
Installation on production. The rows are seeded below `deployed` (planned,
implemented or tested; `variant.ofc` is excluded), so nothing is offered until
`fn_set_capability_readiness` records evidence that a feature has shipped.

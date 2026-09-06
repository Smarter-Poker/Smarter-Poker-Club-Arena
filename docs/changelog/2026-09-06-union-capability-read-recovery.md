# Union Capability Read Recovery

## Production failure

Post-deploy run `34041227887` reached the live Cashier and completed its
authoritative hydration, but the first certification still failed because
`useCanOperateUnionNetwork` emitted `TypeError: Failed to fetch`. The capability
is a read-only permission question used by the Hamburger Menu and section rail;
one transient transport rejection should not become a permanent false “no” for
the rest of that mount or a critical console error on an otherwise healthy page.

## Repair

- Both union capability hooks now use the canonical Supabase-aware retry path.
- The RPCs are safe to retry because they only read the current caller's
  allowlist result; they do not mutate state despite PostgREST transporting an
  RPC as `POST`.
- Two retries use short exponential backoff. A recovered read publishes the
  real answer without logging an error.
- If every attempt fails, both hooks still fail closed and report the final
  error once.
- Unmounting stops further attempts and suppresses stale state/error updates.
- The retry helper remains lazily imported so the global navigation hook does
  not add it to every player's entry bundle.

No database function, RLS policy, permission, route, or Cashier business rule
changed.

## Pre-publication evidence

- Capability/retry tests: 14 passed, including unmount cancellation and an
  authoritative denied answer.
- Navigation and union allowlist laws: 13 passed.
- Entry-bundle contract: passed.
- Changed-file ESLint, TypeScript `--noEmit`, and `git diff --check`: passed.

Publication and an exact-current, zero-retry post-deploy run remain required
before this recovery is complete.

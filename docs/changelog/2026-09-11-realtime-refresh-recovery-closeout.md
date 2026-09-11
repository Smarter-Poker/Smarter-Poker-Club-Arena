# Refresh recovery closeout audit (September 11, 2026)

This follows the recovered continuation in PR4195 and PR4204. Their source,
publication receipts and original worktrees remain preserved. This audit repairs
additional failures found while reviewing the shared refresh hook and the ticker
container line by line. It does not certify the full realtime programme.

## Reproduced failures and repairs

The initial mounted regression run reproduced 12 failures, with 17 cases passing.
The fixes cover the following paths:

- A coalesced refresh queued in the foreground is cancelled on hide and replayed
  once on return. The timer also checks visibility at its deadline, and a callback
  retained after unmount cannot arm another timer. Both ClubHomePage and
  GameManagementPage already call this shared hook.
- Ticker feed and settings reads allow one request in flight per active effect.
  Repeated poll/resume signals retain one trailing refresh. Hidden and retired
  effects cannot launch that follow-up.
- Account changes synchronously retire pending membership/feed/settings work,
  clear the prior account's rail and toast history, and fetch the new scope.
  Club joins and departures also invalidate scope immediately. Token renewal for
  the same account keeps confirmed content and does not repeat registration toasts.
- Returned membership errors are reported and do not become a five-minute empty
  cache. Successful empty results still clear the feed.
- Failed feed sources retain their confirmed announcements until expiry; healthy
  sources can still update. Overlays, which have no fixed closing timestamp,
  expire after two poll intervals without a successful refresh. Disabled sources
  are filtered immediately, including their registration toast timer.
- Account cache invalidation retires in-flight settings responses as well as
  clearing stored settings, so an old response cannot refill the new cache.

The existing completed-result ten-minute query bound, row limits, membership RLS,
registration status vocabulary, operator switches, navigation, design and render
remain covered by the regression suite. No migration or engine change is included.

## Verification

The six source/test files pass ESLint. The focused suite passes 218 tests across
14 files, including 14 mounted ticker recovery cases, 20 shared refresh/identity
cases, the settings cache regression, rendering, overlay predicates, dismissals,
marquee behavior, registration predicates, and the lean entry-bundle contract.
A follow-up run passes all 16 mounted ticker cases, adding explicit returned-error
coverage for operational tournament results and table openings.
`git diff --check` passes. A search of the three modified production files found
no TODO, FIXME, not-implemented stub or empty catch block.

The initial typecheck found missing native packages in the new worktree's copied
dependencies. A normal `npm ci --no-audit --no-fund` installed the committed
lockfile into that worktree only. No package or lockfile was changed. The full `npm run build` passed after a
normal fast-forward incorporated PR4235, which landed during the first build.
TypeScript, bundle generation, media optimization and provenance completed with
`behind-main=0`. The associated PR release receipt records the normal commit/push
gates and exact production publication identity before this repair is reported
as shipped.

## Programme acceptance remains open

At the live check around 05:40 UTC, public and origin served
`1a0cdc3eed19008dc375832cb557c84939437a65` (publisher run 34565887076).
The engine reported version `404948b3`, 253 stalled tables, 8 dead-stalled tables,
zero blocked settlements and zero seated humans. An `ok` liveness field is not a
loaded-fleet acceptance certificate. Engine sealing and Stage-B cutover remain
with the coordinating task; its dirty worktree and migration are untouched.

The remaining gates are the exact coordinated engine release and cash/MTT/Spin/SNG
hand/reconnect certificates, natural reconnect and physical iPad/PWA evidence,
and detailed historical Supabase caller-log/egress evidence. Desktop simulations,
a green unit suite or absent detailed logs do not satisfy these gates.

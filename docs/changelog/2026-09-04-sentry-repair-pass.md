# Sentry repair pass, and the hand-history swallow behind it

## Why

A full sweep of the Sentry wiring on 2026-09-04 found 24 integration points in
this repo, of which 9 worked. The rest either reported nowhere, or reported into
a filter that deleted the event. Separately, players could not see their previous
hands inside the live table. Those turned out to be the same story: three stacked
silent failures with no way for the UI to tell "this failed" from "you have none".

The database was never at fault. For one test player: 1,372 hands stored, 1,372
visible under real RLS as that player, and the client's exact query returns in
295 ms on the GIN index. Every hand was being written correctly the whole time.

## Privacy

`networkCaptureBodies: true` was uploading Supabase and `/api` response bodies
verbatim into session replays. Those carry emails, user ids, chip balances and
ledger rows. `maskAllText` and `maskAllInputs` mask the PAGE, not captured
network payloads. Now off.

## Filters that were deleting real errors

- `Failed to fetch` / `NetworkError` were blanket-dropped in both `beforeSend`
  and `ignoreErrors`. This is the exact class the engine stopped suppressing
  after the 2026-08-15 table-freeze incident; the client was never updated to
  match, so a total Supabase or engine outage produced zero client events.
- `aborted` as a bare substring also killed "hand aborted", "tournament
  aborted", "settlement aborted". Narrowed to the real AbortController phrasings.
- `Internal error` as a substring killed genuine PostgREST 500s. Narrowed to
  `UnknownError: Internal error`.
- Null-property errors were dropped unless the stack contained `/src/`, which
  cannot appear in a minified production bundle. That deleted 100% of production
  null-pointer crashes.

## Boundaries that reported nowhere

- `PageErrorBoundary` wraps 115 of 133 routes and wrote only to Supabase
  `client_crash_log`. Its own comment says the crash was recorded "not in
  client_crash_log, not in Sentry" and then only the first was added. Because it
  is an INNER boundary it stops propagation, so the root boundary never saw
  these either.
- `RouteErrorBoundary` was console-only.
- `TableErrorBoundary` wraps the live table surfaces including both multi-table
  mounts, and reported to a console and an in-memory bus.

While adding the first `reportError` call, TypeScript caught that a missing
import silently resolved to the DOM's built-in `window.reportError()`, which
takes one argument. Worth knowing: an unimported `reportError` does not fail to
compile, it quietly calls something else.

## The hand-history swallow

Three failures stacked, any one of which showed an empty panel:

1. `getPlayerHands` returned `[]` on a query error, making failure and empty
   identical. It now throws.
2. `mapHandHistoryRow` calls `buildReplay` unguarded, so ONE malformed row
   rejected the whole promise and discarded all fifty hands. Now guarded per row:
   a hand we cannot render is one missing hand, not an empty history.
3. `TablePage` read `if (hands.length > 0)`, so a zero-length result was a silent
   no-op with no state change and no flag.

The standalone `/hand-history` page has carried a `loadFailed` state since August
for exactly this reason, with a comment saying a failed fetch is not an empty
history. The table never got it. It has it now, threaded through
`TableModalsLayer` to both `HandHistoryPanel` and `HandDetailModal`.

Also corrected `HandDetailModal`'s "No Completed Hands Yet At This Table" — the
query is account-wide and never table-scoped, so that string was false and sent
anyone debugging this at the wrong thing.

## Not done here

Source-map upload (`publish-club-arena.yml` never sets `SENTRY_AUTH_TOKEN`, so
the maps are built and then shipped to players instead of to Sentry), release
name alignment, `WebVitals.ts`, and throttling `VoiceSignalService` and
`MasterBus`. Those are separate changes and are listed in the buildout plan.

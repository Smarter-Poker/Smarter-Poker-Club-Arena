# Table Studio durable appearance reconciliation

## Outcome

An already-open Table Studio now follows a table, scene, button, card-back, or
coordinated Look changed on another device even when Supabase Realtime drops the
individual database event. Realtime remains the instant fast path; a visible-only
two-second authoritative snapshot is the durable safety net.

## What changed

- Reconcile once when the appearance channel first reaches `SUBSCRIBED`, closing
  the initial SELECT-to-subscription gap.
- Re-read the selected game-type row on a bounded cadence while Table Studio is
  open and visible, and on browser focus or network recovery.
- Keep background reconciliation monotonic: an older in-flight snapshot cannot
  overwrite a newer local tap or Realtime event, and a refresh no longer flashes
  the Studio back into a loading state.
- Retry only transient, idempotent certification cleanup requests so a short
  PostgREST `PGRST002`/503 schema-cache incident cannot strand reserved production
  fixtures.

## Regression coverage

- Complete missed appearance event repaired from server truth.
- Stale appearance snapshot cannot roll back a newer event.
- Existing account and game-type isolation remains enforced.
- Certification cleanup retains its reserved-email destructive guard and now has
  bounded transient retry coverage.

# The engine can read the rebuy window it asks

## What broke

#5466 (serving since engine e6b9dc5d, 2026-09-27 20:56 UTC) made the bust
sweep read `fn_ca_tournament_rebuy_window` once per batch so a closed rebuy
window stops sending every busted horse to the purchase door. The engine calls
it as `service_role`; `20260909014433` created the function owner-only and no
migration ever granted it back. In production every call answered 42501
(proved 22:15 UTC with `SET LOCAL ROLE service_role`, rolled back), the
manager reads an errored policy as "unknown, keep the purchase path", and the
closed-window short-circuit never ran once.

## What it cost

- Each bust sweep of a closed-window rebuy / Free Buy event asked
  `process_tournament_rebuy` for the first busted horse with allowance left.
  One refusal ("Tournament is not accepting rebuys or re-entries") took 24.9 s
  in a rolled-back probe; a live one held 618741a5's settlement lane for
  14.8 s at 22:09:42. The 5 s sweep budget was gone before the mutation phase,
  so each scheduler turn recorded about one finish.
- The only events with real bust backlogs were closed-window Free Buy events:
  618741a5 (215 busted players still `playing` at 0), c775d008 (102), ac10f59a
  (98); every non-rebuy MTT held at most 4. Inside the maintenance freeze,
  where `tryTournamentRebuys` returns before any read, the same events
  recorded 5 finishes in 3 s (21:53:37, 21:56:58).
- Unrecorded busts hold their roster chairs, so the balancer could not
  consolidate, and each `park_requested` break source whose last hand busted
  someone was refused movement admission (`F06_MOVEMENT_ELIMINATION_UNPROVEN`,
  1,660 refusals in 30 minutes across 18 source tables). The three fields
  drained to one live player per table and stopped dealing.

## The fix

- Migration `20260927222130`: `GRANT EXECUTE` on the function to
  `service_role` only. Body, owner, `SECURITY DEFINER`, `search_path` and
  volatility asserted unchanged before and after; anon and authenticated stay
  refused. The function only reads `tournaments`; nothing is written.
- The manager names an unreadable window once per code
  (`Tournament.rebuy_window_unreadable`), so a future grant regression is
  visible in the first sweep instead of as drained fields three hours later.
  Behaviour on an unreadable window is unchanged.

## Pinned

- `tests/every-rpc-the-engine-calls-is-one-the-engine-may-execute.law.test.ts`:
  every name the engine passes to `supabase.rpc()` must not end its migration
  history with `service_role` revoked. Red on origin/main a1077c7c0c naming
  `fn_ca_tournament_rebuy_window` alone (production agrees: of 217 engine RPC
  names it is the only one `service_role` cannot execute).
- `server/src/tournament/ClosedRebuyInput.test.ts`: a 42501 read is reported
  once by its code and keeps the purchase door; a new code is reported; a read
  window says nothing. Red without the engine change.

## After merge

Apply `20260927222130` with `apply-merged-migration.yml` (outside :50-:03) and
confirm the `@live-proof`. No engine release is needed for the grant itself:
the serving engine already calls the function, and its next bust sweep reads
the closed window. The logging change rides the next engine release.

# An owner switch-off finds its request by index (2026-10-25)

## What was wrong

`fn_cash_game_switch_off`, the owner's Switch Off door, first checks whether
it has already answered the same request:

    SELECT * FROM public.cash_cluster_events e
     WHERE e.game_id = p_game_id AND e.kind = 'game_switched_off_by_owner'
       AND e.request_id = p_request_id LIMIT 1;

`cash_cluster_events` is 4 GB and about 5.0M rows. Its only index on game is
`(game_id, at DESC)`, so this lookup reads every event the game has ever
logged. The two Lightning pilot games hold about 24% and 14% of the log, or
roughly 1.2M and 680k events, so the lookup alone took more than 8 s.

`20261024213143` (switch off the pilot games) was refused twice, at 00:32Z
and 01:02Z. Both refusals were `ERROR 57014` inside that SELECT, and nothing
was committed either time. Any owner of a busy game would have hit the same
timeout from the console.

## Fix

`20261025022430` adds a partial index on exactly that lookup:

- Columns `(game_id, request_id)`, only for rows where `kind =
  'game_switched_off_by_owner'`. Only switch-off events are indexed, so it
  holds a handful of rows.
- It is built `CONCURRENTLY` through the applier's supported nonblocking
  preamble, so writers to the event log are not blocked while it scans.
- The transaction only proves the index is valid, ready and has this exact
  definition.

Once it is live, `20261024213143` is dispatched again, unchanged.

Pinned by `tests/an-owner-switch-off-finds-its-request-by-index.law.test.ts`.

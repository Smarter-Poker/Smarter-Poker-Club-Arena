# tests/a-published-table-is-a-measured-decision.law.test.ts

Every row change on a published table is decoded by wal2json and passed through
`apply_rls` once per subscriber, and the cost tracks the number of changes and,
per change, the COLUMN COUNT. On 2026-09-06 that stream was costing 22.9
seconds of database time per 15 seconds of WAL - 68% of one core, continuously

- and the publication was trimmed, then on 2026-09-08 a `SET TABLE` replaced
  the rest of its membership and silently dropped `notifications`, which was
  noticed two days later. Nobody swept the client: measured 2026-09-19, 34
  `postgres_changes` subscriptions in `src/` named tables the publication no
  longer carried, so those channels joined, reported SUBSCRIBED and received
  nothing, for ever, with no error - club chat, table chat, the waitlist
  listener, friend requests, the cashier wallet. `check-realtime-publication.mjs`
  had been correctly red the whole time, and its baseline was seeded BEFORE the
  trim, so it could not name the ones that died after it and could not catch a
  new one either. Twenty-three were restored: 35,618 writes between them, 0.06%
  of the eleven left out, every one with RLS on and a SELECT policy a subscriber
  can satisfy - checked before publishing, because a published table whose
  subscriber cannot read a row delivers nothing and looks identical to the bug.
  The eleven that stay out carry their measured cost in the baseline rather than
  an opinion: `tournament_players` at 25,280,935 writes, `tables` at 4,643,367
  over 159 columns, `profiles` at 45.29ms per change. The law pins that the
  publish list and the excluded list cannot overlap, that every excluded table
  states a number, that publishing is guarded by RLS and a readable policy, and -
  the forward guard - that no later migration may use `SET TABLE` on
  `supabase_realtime`, because replacing the whole membership is what dropped
  `notifications` without anyone deciding to.

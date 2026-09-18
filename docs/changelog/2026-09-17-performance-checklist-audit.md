# Performance Checklist Audit, 2026-09-17 (Club Arena Record)

The World Hub carries the full record at
`.agent/audits/2026-09-17-performance-checklist-audit.md` (scorecard,
Lighthouse baseline, every phase, every decision). This is the Club Arena
half: what was measured here, what shipped here, and what is recorded for
Club Arena owners.

## Measured (130 pages, 560 engine and service files, live database)

- Loading states: 88 pages with skeletons, 16 spinner-only, 12 flagged as
  none; all 12 read and found handled (parent owns the skeleton, static
  page, or `if (loading)` the scanner missed).
- Code splitting: 31 lazy routes, manualChunks for react, supabase, motion.
- Client caches: 11 modules under src/lib and src/hooks, with a stale reaper.
- Searches: 37 search inputs, all debounced or client-side filters except
  the club shop purchase ledger.
- N+1: 51 files flagged; the loops are chunked batches (ClubsService,
  HandNotesService, ChipFlowService pages), retry loops (tournament launch,
  wallet funding) and bounded background sweeps (GameServer, 15 per pass).
  One per-player update fan-out in services/supabase/tables.ts.
- Database (shared with the hub): the engine's four "registered or playing"
  sweeps and the open-tournament-tables sweep were walking history to find
  the present (see phase 1); `fn_eliminate_tournament_player_atomic` is
  confirmed fixed by #4455 (recent mean ~45 ms against a 2.7 s lifetime
  mean); `atomic_table_buyin` is ~5.5 s recent mean on its write side and
  is recorded for the cashier owner.
- Engine host: one node, `encode` absent from the engine Caddy site; the
  static origin compresses.

## Shipped here

- Phase 1, PR #4774, migration `20260917173357_the_live_rows_are_a_few_thousand_of_a_quarter_million`:
  `docs/changelog/2026-09-17-the-live-rows-are-a-few-thousand-of-a-quarter-million.md`.
- Phase 3, PR #4777: `docs/changelog/2026-09-17-one-request-per-pause-not-per-keystroke.md`.

## Recorded for Club Arena owners

- `atomic_table_buyin`: reads total ~220 ms (`fn_nit_check` 116,
  `fn_entry_purchases_frozen` 55, `fn_cash_rejoin_floor` 29,
  `fn_seat_club_for_user` 19); the remaining seconds are the `club_members`
  debit, `table_seats` insert and their triggers, or waits on the
  `table_seat:` / `table_cap:` advisory locks and the shared maintenance
  lock. `pg_stat_statements.track = top` hides the line; a short window of
  `track = all` or a rolled-back impersonated probe finds it.
- `tournament_payouts`: 480,789 sequential scans reading 95 billion rows,
  roughly one full table each, from inside the per-minute reconcile
  functions. Those are 10.12 debt; index them or retire them with their root
  fixes, not both.
- The engine Caddy `encode zstd gzip` line is an operator edit on engine-01
  plus `caddy reload`; both repo templates carry it since #4777.
- `~/Documents/Smarter-Poker-Club-Arena` is 176 commits behind origin/main
  with 443 staged or modified paths: the 10.87 shape. It holds another task's
  uncommitted work and was left alone.

# 2026-09-06 - Daily Missions Casino Realism Certification

## Changed

- Rebuilt the Daily Missions route as a responsive Club Arena casino floor with generated wide, mobile, and reward-pedestal art, clear period navigation, reward presentation, loading and failure states, and keyboard-safe dialogs.
- Kept the base ledger and cycle subpages bookmarkable through one optional route, taught both navigation audits to recognize that route shape, removed forbidden hover-only feedback, restored focus after idempotent claims, and set an accurate browser title.
- Moved the client to the server-clock version 3 dashboard contract, strict response validation, request-bound reroll receipts, atomic batch claims, server-confirmed balances, and private completion broadcasts.
- Replaced the always-on completion toast's full Daily Challenge service import with a focused Broadcast hook and payload parser, reducing the reviewed initial entry chunk from 158 KB to 153 KB gzipped.
- Preserved challenge deep links through authentication and removed the table-page pre-seed call that duplicated server assignment work on the gameplay path.
- Added exact per-pot and winning-hand threshold values to settled-hand mission projections so mixed pots, chopped pots, multi-board awards, and high/low awards advance only the challenges they actually satisfy.
- Serialized every Daily Missions state path by player and added durable reroll and per-streak entitlement ledgers, stable milestone run identity, bounded reset-notification draining, and the 00:02 UTC reset schedule.
- Bound Claim All, reroll, freeze, queued-event, and processed-event replay keys to their normalized immutable inputs, while preserving fail-closed legacy call shapes.
- Made streak reconstruction tolerate malformed legacy dates, ignore future completion rows, and map both exact and proven one-day-shifted milestone receipts onto the current stable run without double-paying.
- Ordered every multi-player lock path, converted bulk tournament-entry projection to private statement-level transition-table triggers, globally serialized outbox draining, rejected NULL drain bounds, and made dashboard period keys and `syncedAt` share one captured server timestamp across UTC rollover.
- Prelocked the live tournament event pipeline in Tournament Players, Outbox, Progress order during schema publication and aligned retention pruning to Outbox then Progress, preventing deploy, worker, and scheduled-maintenance lock inversion while retaining a four-second fail-clean lock budget.
- Kept reset notifications opt-in, routed through the canonical notification-to-push bridge, and added the supporting user lookup index.
- Removed seven superseded, unreferenced Daily Challenges image files and fixed the migration reservation script's pipefail/SIGPIPE collision check.

## Safety Contracts

- All reward and reroll mutations remain server authoritative and replay safe.
- Horses receive the same settled-hand mission facts as every other dealt player.
- New ledgers are service-only, use profile cleanup cascades, and are checked during migration apply.
- Exact threshold arrays must match their scalar occurrence counts and remain bounded.
- Request UUIDs cannot be replayed with different challenge sets, event facts, or freeze purchases.
- Migration verification rejects unsafe date parsing, unbound historical receipts, non-deterministic drains, missing NULL guards, and split dashboard clocks.
- Visible Daily Missions copy is Title Case and the page contains no banned horizontal dash characters.

## Verification

- Focused database-contract and settled-hand projection suites pass after the current-main merge.
- Full client, server, build, production E2E, publish, and exact live-SHA evidence are recorded only after those gates complete.

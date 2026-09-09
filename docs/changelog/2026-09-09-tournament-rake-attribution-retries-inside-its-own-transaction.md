# Tournament rake attribution retries inside its own transaction

2026-09-09. Phase 1 of 5 of the post-programme list. Migration `20260909202824`.

## The measurement

Seven days of `tournament_rake_settlements`: **77,627 settlements**. Every one
was eventually attributed — **435 of them only by the repair sweep**, 21.2
minutes late on average, worst 413 minutes. `fn_settle_tournament_rake` raised
"Rake settled but attribution failed" **474 times**: 336 `deadlock_detected`,
133 `lock_not_available`, 5 debugger noise. Until attribution lands, nobody in
that event has their VIP points, agent or super-agent commission, or rakeback
basis — the same harm the cash-side null hand id caused, and CLAUDE.md 10.5 by
omission.

## The cause

`fn_attribute_tournament_rake` walks the event's players in uid order so that
two settlements cannot deadlock each other — a real fix from 2026-09-06. But
the live cash path locks the same players' VIP, agent-wallet and player_stats
rows in **hand** order (`fn_award_vip_points_from_rake` fires on every
`rake_records` insert, `credit_agent_commission_from_rake` and
`apply_rakeback_player_stats` under it), and at 77k settlements a week a
200-player walk collides with live play. Postgres kills one side. When it is
the settlement, the attribution subtransaction rolled back, the alert fired,
`attributed_at` stayed NULL, and `fn_repair_tournament_rake_attribution`
picked it up on its next pass.

The subtransaction was already correct — a failed attempt rolled back cleanly
and left the settle intact. It simply never tried again.

## The fix

The attribution block is now a loop: up to four attempts, retrying **only**
`deadlock_detected` (40P01) and `lock_not_available` (55P03) — the two states
that are transient by construction — with 100/300/600 ms between them, and
`attributed_at` stamped in the same call the moment one succeeds. Any other
error fails once and alerts exactly as before. The back-off is bounded at one
second so the `club_wallets` lock the settle holds cannot stall a cash hand at
that club for longer than that.

Proven on production inside a rolled-back probe: the idempotent path on a real
settled tournament answers `already_settled` unchanged. There was no unsettled
terminal tournament to exercise the full path — which is itself the measurement
that the repair sweep had nothing left to do.

## What is expected now

The alert stays and is now expected to find nothing. `attributed_late`
(attributed more than two minutes after settled) should fall from 435 a week
toward zero; when it has held there for thirty days the sweep is deleted per
`docs/BAND-AIDS-REGISTER.md`. Pinned by
`tests/tournament-rake-attribution-retries-inside-its-own-transaction.law.test.ts`.

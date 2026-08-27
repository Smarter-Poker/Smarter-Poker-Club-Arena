# Tournament Money Conservation — Phase 3 (2026-08-27)

Third pass of the tournament-money deep audit (after
`2026-08-26-tournament-rake-deep-audit.md` and
`2026-08-27-tournament-rake-pass2-attribution.md`). This pass ran a full
per-tournament conservation sweep over 30 days of production — money in via
wallet debits vs money out via prize/bounty/refund credits plus booked rake —
and found two enormous, symmetrical holes that every existing reconciler was
blind to.

## Found

1. **Guarantee overlays were minted — 265,209.30 chips in 30 days, 1,001
   events.** `effectivePrizePool = max(pool, guarantee)` raised the pool at
   finalization and the payouts paid it, with no funding debit anywhere. The
   pool column itself was the inflated number, so
   `fn_tournament_payout_reconcile` reconciled _against the mint_ and read
   clean. Dan's decision (2026-08-27): the host club pays — the guarantee is
   the club's marketing cost.
2. **Every Heads-Up winner was underpaid a full prize share — ~230,561 chips
   retained across ~9,379 duels.** `createSNG` seats its opening horse (whose
   registration accumulates its prize share into `prize_pool`), then
   overwrote the pool with `config.buyIn × registered` where `registered = 0`
   for seat-first games. The 2026-08-23 fix caught this exact overwrite for
   `current_players` and left `prize_pool` in it. A 100 duel paid 95 instead
   of the 190 Dan's own spec prices. Dan's decision: back-pay all recorded
   winners. The same creation overwrite also priced MTT pools from the
   fee-INCLUSIVE buy-in (`config.buyIn × horses`), overstating pools by the
   fee, and pre-applied guarantees for free at creation.

## Shipped

Migration `guarantee_overlay_funding_and_conservation` (applied to prod,
self-asserting, Dan-approved):

- `tournament_guarantee_overlays` + `fn_apply_prize_guarantee` — the ONLY way
  a guarantee becomes real money. Funds the overlay from
  `clubs.chip_treasury` (negative allowed but alarmed — an advertised
  guarantee is always honoured to players), PK-claimed so replayed
  finalizations cannot fund twice.
- `fn_backpay_hu_winner_shortfalls` — evidence-based repayment of every
  underpaid HU winner from the per-event wallet-ledger delta, idempotent
  (`tourney:<id>:prize:<winner>:hu_shortfall`), bounded by a hard cutoff so
  the scan only shrinks; stamps `tournament_players.prize` and the pool so
  records match money. Self-drains from the engine loop.
- `fn_tournament_money_conservation` — the sentinel: per-event
  `|in − refunds − prizes − bounties − booked rake − funded overlay|` beyond
  tolerance files a deduped `financial_alert`. Runs every 6 hours from the
  engine. This invariant would have caught both holes above on day one.

Engine (same PR):

- The three guarantee sites in `TournamentManagerBase` (start/no-late-reg,
  late-reg close, add-on end) now call `fn_apply_prize_guarantee` instead of
  writing `max(pool, gtd)` themselves; `effectivePrizePool` no longer exists
  server-side (the client keeps its display-only copy).
- `TournamentRecurringService` stops overwriting accumulated pools at
  creation in all three creators (XMTT, club MTT, SNG) — the register RPCs
  are the single source of pool truth; the lobby already renders
  `max(prize_pool, guaranteed_prize)`.
- `GameServer` discovery loop: HU back-pay each rake-sweep pass until
  drained; conservation sentinel every 6 hours.

## Notes

- The back-pay covers events since 2026-08-01 (the seat-first HU era). Wins
  by horses are repaid too — house-to-house, keeps the books conserving.
- Historical overlays (the already-minted 265k) are recorded nowhere to
  claw from and are NOT retro-debited from clubs; the overlay ledger starts
  clean from today. The conservation sentinel treats pre-ledger events with
  a funded-overlay adjustment of zero, so old guaranteed events will flag
  once and can be resolved as known-historical.
- Spins and satellites are excluded from the sentinel v1: spins conserve
  through `spin_reserve_ledger` (their own audited loop), satellites award
  seats, not cash.

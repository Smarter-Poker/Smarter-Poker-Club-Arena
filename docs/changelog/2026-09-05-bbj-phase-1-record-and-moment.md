# 2026-09-05 - BBJ build plan, Phase 1 of 6: the record and the moment

Plan of record: `docs/BBJ-BUILD-PLAN.md`. Runbook: `docs/BBJ-RUNBOOK.md`.
Follows the audit in `2026-09-05-bbj-full-audit.md` (PR #3045).

## What this phase ships

**1.1 Every recipient is told.** `processBBJPayout` notified only the players
who had LEFT the table; a seated winner of a $13,000 share had no record
anywhere they could look once the ten-second overlay was gone. Now every
recipient gets one `notifications` row: what they won, their role (took the
beat / won the hand / dealt in), and where it landed ("added to your stack at
the table" / "credited to your wallet"), with `metadata.placed` and
`metadata.role` for anything that wants to render it. Deliberately NOT a
`chip_transactions` row for a seat credit: `fn_my_wallet_ledger` sums every
row to a player as wallet-in, so a felt credit journalled there would
double-count on the later cash-out; pot wins are not journalled to the wallet
either, and a jackpot share on the felt is the same kind of thing.

**1.2 The jackpot events survive a reconnect.** The hub retains an EVENT only
if it declares `replay_until` (D3). `bbj_hit` and `bbj_payout_complete`
declared nothing, so a player whose socket was between reconnects for the one
second either went out never received the hand names or the trigger for the
celebration, permanently. All three jackpot events (`bbj_hit`,
`bbj_payout_complete`, `bbj_hit_global`) now ask for 60 s, the hub's ceiling.
The client's identity gate already refuses a replay it has seen, so this
cannot make a celebration play twice. `BBJEventsSurviveAReconnect.test.ts`
proves the retention against a real `TableStateHub`.

**1.3 The freshness gate runs on the engine's clock.** `shouldAnnounceBbjHit`
refuses a hit older than 90 s as a replay and compared the engine's
`emittedAt` against the phone's `Date.now()`. A phone two minutes fast saw
every live jackpot as stale and refused it, silently, forever. Every EVENT
envelope from the hub now carries `ts` (engine clock at send time, the replay
instant for a replay), `EngineStateClient` feeds it and the PING `ts` into
`src/lib/serverClock.ts`, and the gate asks `serverNow()`. Until the engine
has spoken it is the device clock, so nothing is worse than before.
`tests/unit/serverClock.test.ts` pins the bug and the fix side by side.

**1.4 The BBJ page names players by arena alias.** Migration
`20260905015127_the_bbj_page_names_players_by_their_arena_alias` (applied).
`fn_bbj_recent_hits` resolved the two headline names as
`COALESCE(display_name, username, ...)`; `display_name` is a real name on 30
human profiles, and the recipients list three lines lower in the same function
already used `fn_arena_name`. Generated rewrite with a round-trip assertion.

**1.5 One open alert per condition.** `auditBBJDrift` raised a new warning
every hour for the same 3.5 chips of unlinkable rake rows: 24 identical rows a
day plus a Sentry event each, the pattern that buried the nine real alerts on
2026-08-22. `raiseOrRefreshCondition` raises once, refreshes the open row with
current figures while the condition holds, and resolves it with a note the
first cycle it clears. `AConditionIsOneAlert.test.ts`.

## Verified

- Server tsc clean, client tsc clean.
- Server suite and client suite green (new: 6 + 6 + 7 tests; updated: 17).
- Migration probed in a rolled-back transaction (names before/after read
  back against the ticker snapshot) before apply; live names confirmed after.

## Known, deliberately left

The felt names a horse by `display_name` ("RakeGhost") while `fn_arena_name`
returns its `alias` ("RunnerFox44"): 0 of 1,000 horses have the two equal. So
the celebration at the table (which reads the felt name) and the BBJ page can
still disagree on a horse. That is `loadSeatedPlayers` naming policy, not a
jackpot defect; it belongs to whoever owns the 2026-09-02 alias law.

# Second Sweep — Eight More The Player Could Feel (2026-08-28)

The table components and the engine had been swept; this pass covered the
layer between them (hooks, client services, stores, core, utils) and the
visual layer, mobile-first.

## 1. The action clock handed players time that did not exist

`serverClock` estimates the client/engine offset from a one-way sample, and
every such sample overstates the offset by its own latency:

    sample      = Date.now() - server_time_ms = trueOffset + L
    serverNow() = Date.now() - offset         = trueServerNow - L
    remaining   = deadline - serverNow()      = trueRemaining + L

So the countdown ran one latency BEHIND the engine and displayed time the
player did not have — a player acting on the last instant the ring showed
them could be folded by a deadline already passed. The file's header claimed
the opposite ("the ring never claims time the player does not have").

Smoothing cannot fix it — averaging one-way samples bakes in the AVERAGE
latency, and jitter makes that worse than the best sample. The estimator now
takes the MINIMUM sample in a rolling window (Cristian's algorithm): the
smallest latency observed is the closest a one-way sample can get to the true
offset. The window resets so genuine clock drift is still tracked, and the
value is still smoothed so one delayed packet cannot jerk the ring.
Pinned by `tests/unit/serverClockNeverGrantsTimeYouDoNotHave.test.ts`.

## 2. One consumer unmounting silenced a shared channel for everyone

`getOrCreateChannel` hands the SAME Supabase channel to every consumer of a
key; `removeRegisteredChannel` tore it down unconditionally. A player with the
tournament lobby open beside a table in the same event closed the lobby and
the table stopped receiving `t-break-<id>` break countdowns, add-on windows
and bounty reveals for the rest of the event — silently. Four consumers bind
that key and only one attempted a guard, from the wrong side ("I created it"
is not "nobody else is reading it").

MasterBus now REFCOUNTS: every handout takes a reference, every release gives
one back, teardown happens on the last one. `forceRemoveRegisteredChannel` is
kept for paths that genuinely own the surface (the waitlist reconnect wants a
fresh socket, and would otherwise just decrement and be handed the stale
channel back).

## 3. A failed VIP read was reported to the player as "not VIP"

`checkVIPStatus` collapsed `error` and `!data` into one answer: not VIP, zero
allowance. One transient blip stripped a paying member of the rabbit hunts,
time-bank seconds, emojis and tags they bought, with no retry. This repo has
already ruled against this exact shape twice in comments still in the tree
(`WalletService.getPlayerBalance` was deleted for it; `loadDiamonds` refuses
to zero a cached count). `!data` is a real answer and still returns non-VIP;
`error` is the ABSENCE of an answer and now throws, so callers keep what they
already knew. `useVIP` and `RabbitHunt` updated to hold last-known rather than
overwrite with a fiction — both start non-VIP, so nothing is granted by
accident either.

## 4. Up to 30 seconds of HUD stats lost on every exit

`usePlayerStats` persisted on a 30s interval and nothing else, so leaving the
table or having the tab reclaimed on mobile discarded that window of opponent
counters — VPIP, 3-bet, hands played — the player had already been shown. Now
flushes on `pagehide`, on `visibilitychange -> hidden`, and on unmount, the
same way `lib/walletCache.ts` already solves it.

## 5. The diamond balance could sit stale indefinitely

`loadDiamonds` was gated on `_balancesAt` — a stamp only `loadBalances` writes.
`refreshAll` fires both concurrently, so diamonds permanently inherited the
balances' freshness window and every non-forced refresh inside it was a silent
no-op. Diamonds now carry their own `_diamondsAt`/`_diamondsUserId`.

## 6. The chat chime and unread badge could double

Both ran INSIDE a `setChatMessages` updater. Under React 18 concurrent
rendering an updater can be re-invoked on a discarded or rebased render, so
one arriving message could tick the badge twice and play the chime twice. A
state updater must be pure; these are effects and now run once, on the event.

## 7. The Insurance EV-Cashout tab had no CSS at all

Nine rendered classes had zero rules anywhere: the tab switcher had NO active
state (nothing told the player which tab they were on) and "Cash Out" fell
through to a base rule that sets neither background nor color, painting as a
grey UA button beside its fully-styled Decline/Accept siblings. This is a
25-second timed decision about real money that AUTO-DECLINES on expiry, and
this file's own header documents that failure mode for a previous bug. Styled
from the existing tokens; green rather than blue so a GUARANTEED payout is
never confused with the insurance Accept; 44px tab floor.

## 8. Three mobile rules were dead, all to the same source-order trap

Each had a correct `@media (max-width: …)` rule EARLIER in its file and an
equal-specificity base rule LATER, so source order silently killed the phone
value:

- `.add-chips-icon-btn` — 44px intended, 38px on every phone, under the tap
  minimum the same file enforces eight lines above.
- `.table-tab-bar__tab-sub` — 8px intended, 9.2px + letter-spacing applied, so
  "Pot 12,500" overran its 47.25px pill; and unlike its sibling it had
  `nowrap` with no ellipsis, so it clipped mid-character. Ellipsis added.
- `.table-tab-bar__offline` — the shrunken chip is what the four-tab width
  reserve `calc((100vw - 176px) / 4)` is computed from; the base rule ran 14px
  over budget, and the comment names the consequence: the fourth table's tab
  scrolls out of reach, while the player is reconnecting.

## Verification

`tsc --noEmit` clean. Full client suite green in shards: tests/unit 347 files
/ 5,415 tests, tests/components + tests/config + top-level 167 files / 2,642
tests. (Sharded because both sandbox volumes are full of other agents'
worktrees; the toolchain is a hybrid of the mounted clone's packages with
Linux-native rollup/esbuild.) CI runs the suite whole on the PR.

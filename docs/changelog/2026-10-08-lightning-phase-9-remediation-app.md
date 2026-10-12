# Lightning Phase 9 Remediation (App): The Real Ended Contract, Reconnect Retry And Boot Reconciliation

Date: 2026-10-08
Scope: the app side of the Phase 9 deep-dive findings against the merged
reconnect work (PR #6481). The DB side (the remediated
`fn_lightning_reconnect_state` that answers an ended session's row with
`state: 'ended'` and its `exit_reason`) ships separately and later; everything
here tolerates that migration being absent, exactly like earlier phases.

## The Findings And Their Fixes

### Finding 1 (High): The Client Keyed On A State The Database Can Never Produce

`lightningReconnect.ts` derived its timeout verdict from a pool-session state
`expired`, but `lightning_pool_session` has no such state: the reaper closes
with `state: 'closed'` and `exit_reason: 'disconnect_expired'`. The timeout
title was unreachable, the seat was always null, and VIEW GAME always fell
back on the Cluster entry.

The verdict now keys on `exit_reason`:

- `disconnect_expired` → "Your Lightning Session Timed Out";
- `stop_playing` → "You Stopped Playing";
- any other reason, or none → "Your Lightning Session Has Ended".

`seat_table_id` and `seat_number` are used when present, so VIEW GAME targets
the still-occupied anchor seat (tap-only, never automatic). The tests now pin
the rows production actually writes (`state: 'closed'` / `'ended'` plus
`exit_reason`), and a pin forbids any client reference to a pool-session
state `expired` in `lightningReconnect.ts` and `lightningSession.ts`.

Degradation: a database before the remediation answers all nulls for an ended
session (or an ended row without `exit_reason`), and both degrade to today's
generic ended behavior. A database without the function at all still changes
nothing.

### Finding 2 (Medium): A Dropped Reconnect Batch Starved A Connected Player

`LightningPresenceReporter` dropped a failed batch whole. For DISCONNECT
entries that is cheap (an imprecise stamp, restated by the next transition),
but a lost RECONNECT left the session marked disconnected while the player
sat connected: the matcher skipped them every pass, and after
`disconnect_timeout_ms` the reaper exited a player who never left.

A failed flush now re-enqueues its RECONNECT entries only, for a bounded
retry: up to `LIGHTNING_PRESENCE_RECONNECT_RETRY_MAX` (3) attempts, each
backed off at least the two-second debounce window (doubling, with jitter),
abandoned when the RPC goes unavailable, and always superseded by a newer
transition for the same player. Disconnect entries stay drop-on-failure by
design. No retry storm is possible: the attempts are capped per player and
the last state per player still wins.

### Finding 5b (Low): A Restart Lost Presence State And Never Stopped The Reporter

`GameServer` now holds the reporter reference, flushes and stops it with the
other producers at shutdown, and runs ONE reconciliation pass shortly after
boot (`LightningPresenceReconciliation.ts`, 30 seconds in, so returning
sockets land first): every open pool session whose player holds no socket
here is reported disconnected through the ordinary reporter path. The
presence door is idempotent, so over-reporting an already-stamped player is
free, and a player who reconnects later is un-stamped by that socket's own
transition. The pass is one select, log-light, and a read that fails (the
table absent included) reconciles nothing and never blocks boot.

### Finding 5a (Low): A Stale Tab Ground The Retry Ladder On A Dead Session

When `fn_lightning_reconnect_state` answers with a DIFFERENT
`pool_session_id` than the tab's (the player was reaped, then re-entered from
another tab or seat), the verdict was `unknown` and the stale tab ground the
ladder down to the generic toast. The answer now ends THIS tab plainly: the
generic ended notice, no timeout words, no borrowed seat, and never an
automatic join of the new session, which belongs to the tab that opened it
(navigation only on an explicit tap).

### Also Taken (Info): One Ending, One Message

The third-4404 toast could fire while the reconnect-state question was still
in flight, and the ended notice then repeated the news. The hook now exposes
whether a question is in flight, and the toast stands down for it, releasing
its one-shot slot so a close whose question never gets an answer can still be
announced by a later 4404.

## Tests

- `tests/lightning/lightning-phase-9-reconnect-app.test.tsx`: rows rewritten
  to the real contract, the `exit_reason` verdicts, the stale-tab ending, the
  no-state-`expired` pin, the pending stand-down wiring and the degradation
  paths.
- `server/src/lightning/LightningPhase9ReconnectApp.test.ts`: the bounded
  reconnect retry (retries, disconnect-only batches, supersession, the cap,
  the deploy window), the boot reconciliation pass and the GameServer wiring.
